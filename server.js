'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 25);

if (!process.env.DATABASE_URL) {
  console.error('ERRO: variável DATABASE_URL não configurada.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      segment TEXT,
      phone TEXT,
      city TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      osm_id TEXT,
      source TEXT DEFAULT 'overpass',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      name TEXT NOT NULL,
      segment TEXT,
      phone TEXT,
      city TEXT,
      status TEXT NOT NULL DEFAULT 'novos',
      when_iso TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      crm_id TEXT,
      name TEXT NOT NULL,
      when_iso TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function buildOverpassQuery(term, city) {
  const t = norm(term);
  const groups = [
    { match: /hamburg|burger|lanche/, filters: ['["amenity"="fast_food"]'] },
    { match: /pizz/, filters: ['["amenity"="restaurant"]["cuisine"~"pizza",i]'] },
    { match: /restaurant|comida/, filters: ['["amenity"="restaurant"]'] },
    { match: /cafe|cafeteria/, filters: ['["amenity"="cafe"]'] },
    { match: /bar|pub/, filters: ['["amenity"="bar"]', '["amenity"="pub"]'] },
    { match: /dentist|odont|dente/, filters: ['["amenity"="dentist"]', '["healthcare"="dentist"]'] },
    { match: /academia|fit|muscula|crossfit|gym/, filters: ['["leisure"="fitness_centre"]'] },
    { match: /barbear/, filters: ['["shop"="hairdresser"]'] },
    { match: /salao|beleza|estetica/, filters: ['["shop"="beauty"]'] },
    { match: /farmacia/, filters: ['["amenity"="pharmacy"]'] },
    { match: /mercado|supermercado/, filters: ['["shop"="supermarket"]'] },
    { match: /padaria/, filters: ['["shop"="bakery"]'] },
    { match: /hotel|pousada/, filters: ['["tourism"="hotel"]', '["tourism"="guest_house"]'] },
    { match: /advog|juridic/, filters: ['["office"="lawyer"]'] },
    { match: /contab/, filters: ['["office"="accountant"]'] },
    { match: /veterinar/, filters: ['["amenity"="veterinary"]'] },
    { match: /pet/, filters: ['["shop"="pet"]'] },
    { match: /auto|mecanic|oficina/, filters: ['["shop"="car_repair"]'] },
    { match: /escola/, filters: ['["amenity"="school"]'] },
  ];
  const group = groups.find((g) => g.match.test(t));
  const filters = group ? group.filters : [`["name"~"${term.replace(/["\\]/g, '')}",i]`];

  const areaClause = city
    ? `area["name"="${city.replace(/["\\]/g, '')}"]["boundary"="administrative"]->.a;`
    : '';

  const searchLines = filters.map((f) => `
    node${f}(area.a);
    way${f}(area.a);`).join('');

  return `
    [out:json][timeout:25];
    ${areaClause}
    (
      ${city ? searchLines : filters.map((f) => `node${f}; way${f};`).join('')}
    );
    out center tags ${MAX_RESULTS};
  `;
}

function pickTag(tags, keys) {
  for (const k of keys) if (tags[k]) return tags[k];
  return '';
}

function toLead(el, index, term) {
  const tags = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat) ?? null;
  const lon = el.lon ?? (el.center && el.center.lon) ?? null;
  const osmId = `${el.type}/${el.id}`;
  const name = tags.name || tags['name:pt'] || tags.brand || '';
  if (!name) return null;
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', ');
  const city = [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ');
  const phone = pickTag(tags, ['contact:phone', 'phone', 'contact:mobile', 'mobile']);
  return {
    id: `osm-${osmId.replace('/', '-')}-${index}`,
    name,
    segment: term,
    phone: phone || '',
    city: city || tags['addr:suburb'] || '',
    address: street || '',
    lat, lon,
    osm_id: osmId,
    source: 'overpass',
  };
}

app.post('/api/search', async (req, res) => {
  const { query, city } = req.body || {};
  if (!query || String(query).trim().length < 2) {
    return res.status(400).json({ error: 'Informe um termo com pelo menos 2 caracteres.' });
  }
  const ql = buildOverpassQuery(String(query), city ? String(city) : '');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'HunterPro/1.0',
      },
      body: 'data=' + encodeURIComponent(ql),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(502).json({ error: `Overpass respondeu ${response.status}.`, detail: body.slice(0, 300) });
    }
    const data = await response.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const leads = [];
    const seen = new Set();
    for (let i = 0; i < elements.length; i++) {
      const lead = toLead(elements[i], i, String(query));
      if (!lead) continue;
      if (seen.has(lead.osm_id)) continue;
      seen.add(lead.osm_id);
      leads.push(lead);
    }
    for (const r of leads) {
      await pool.query(`
        INSERT INTO leads (id, name, segment, phone, city, lat, lon, osm_id, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, city=EXCLUDED.city
      `, [r.id, r.name, r.segment, r.phone, r.city, r.lat, r.lon, r.osm_id, r.source]);
    }
    res.json({ count: leads.length, leads, attribution: '© OpenStreetMap contributors' });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Overpass demorou demais.' });
    console.error('[search]', err);
    res.status(500).json({ error: 'Falha ao consultar o Overpass.', detail: String(err.message || err) });
  }
});

app.get('/api/crm', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM crm ORDER BY created_at DESC`);
  res.json(rows.map((r) => ({
    id: r.id, leadId: r.lead_id, name: r.name, segment: r.segment,
    phone: r.phone, city: r.city, status: r.status, when: r.when_iso,
  })));
});

app.post('/api/crm', async (req, res) => {
  const { id, leadId, name, segment, phone, city, status, when } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id e name são obrigatórios.' });
  await pool.query(`
    INSERT INTO crm (id, lead_id, name, segment, phone, city, status, when_iso)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, when_iso=EXCLUDED.when_iso
  `, [id, leadId || null, name, segment || '', phone || '', city || '', status || 'novos', when || null]);
  res.json({ ok: true });
});

app.patch('/api/crm/:id', async (req, res) => {
  const updates = []; const values = [];
  if ('status' in (req.body || {})) { updates.push(`status = $${values.length + 1}`); values.push(req.body.status); }
  if ('when' in (req.body || {})) { updates.push(`when_iso = $${values.length + 1}`); values.push(req.body.when); }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  values.push(req.params.id);
  await pool.query(`UPDATE crm SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  res.json({ ok: true });
});

app.delete('/api/crm/:id', async (req, res) => {
  await pool.query(`DELETE FROM crm WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/meetings', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM meetings ORDER BY when_iso ASC`);
  res.json(rows.map((r) => ({ id: r.id, crmId: r.crm_id, name: r.name, when: r.when_iso })));
});

app.post('/api/meetings', async (req, res) => {
  const { id, crmId, name, when } = req.body || {};
  if (!id || !name || !when) return res.status(400).json({ error: 'id, name e when são obrigatórios.' });
  await pool.query(`INSERT INTO meetings (id, crm_id, name, when_iso) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET when_iso=EXCLUDED.when_iso`,
    [id, crmId || null, name, when]);
  res.json({ ok: true });
});

app.delete('/api/meetings/:id', async (req, res) => {
  await pool.query(`DELETE FROM meetings WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`HunterPro rodando em http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Falha ao inicializar banco:', err);
  process.exit(1);
});'use strict';

const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 25);

if (!process.env.DATABASE_URL) {
  console.error('ERRO: variável DATABASE_URL não configurada.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      segment TEXT,
      phone TEXT,
      city TEXT,
      lat DOUBLE PRECISION,
      lon DOUBLE PRECISION,
      osm_id TEXT,
      source TEXT DEFAULT 'overpass',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      name TEXT NOT NULL,
      segment TEXT,
      phone TEXT,
      city TEXT,
      status TEXT NOT NULL DEFAULT 'novos',
      when_iso TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      crm_id TEXT,
      name TEXT NOT NULL,
      when_iso TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function buildOverpassQuery(term, city) {
  const t = norm(term);
  const groups = [
    { match: /hamburg|burger|lanche/, filters: ['["amenity"="fast_food"]'] },
    { match: /pizz/, filters: ['["amenity"="restaurant"]["cuisine"~"pizza",i]'] },
    { match: /restaurant|comida/, filters: ['["amenity"="restaurant"]'] },
    { match: /cafe|cafeteria/, filters: ['["amenity"="cafe"]'] },
    { match: /bar|pub/, filters: ['["amenity"="bar"]', '["amenity"="pub"]'] },
    { match: /dentist|odont|dente/, filters: ['["amenity"="dentist"]', '["healthcare"="dentist"]'] },
    { match: /academia|fit|muscula|crossfit|gym/, filters: ['["leisure"="fitness_centre"]'] },
    { match: /barbear/, filters: ['["shop"="hairdresser"]'] },
    { match: /salao|beleza|estetica/, filters: ['["shop"="beauty"]'] },
    { match: /farmacia/, filters: ['["amenity"="pharmacy"]'] },
    { match: /mercado|supermercado/, filters: ['["shop"="supermarket"]'] },
    { match: /padaria/, filters: ['["shop"="bakery"]'] },
    { match: /hotel|pousada/, filters: ['["tourism"="hotel"]', '["tourism"="guest_house"]'] },
    { match: /advog|juridic/, filters: ['["office"="lawyer"]'] },
    { match: /contab/, filters: ['["office"="accountant"]'] },
    { match: /veterinar/, filters: ['["amenity"="veterinary"]'] },
    { match: /pet/, filters: ['["shop"="pet"]'] },
    { match: /auto|mecanic|oficina/, filters: ['["shop"="car_repair"]'] },
    { match: /escola/, filters: ['["amenity"="school"]'] },
  ];
  const group = groups.find((g) => g.match.test(t));
  const filters = group ? group.filters : [`["name"~"${term.replace(/["\\]/g, '')}",i]`];

  const areaClause = city
    ? `area["name"="${city.replace(/["\\]/g, '')}"]["boundary"="administrative"]->.a;`
    : '';

  const searchLines = filters.map((f) => `
    node${f}(area.a);
    way${f}(area.a);`).join('');

  return `
    [out:json][timeout:25];
    ${areaClause}
    (
      ${city ? searchLines : filters.map((f) => `node${f}; way${f};`).join('')}
    );
    out center tags ${MAX_RESULTS};
  `;
}

function pickTag(tags, keys) {
  for (const k of keys) if (tags[k]) return tags[k];
  return '';
}

function toLead(el, index, term) {
  const tags = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat) ?? null;
  const lon = el.lon ?? (el.center && el.center.lon) ?? null;
  const osmId = `${el.type}/${el.id}`;
  const name = tags.name || tags['name:pt'] || tags.brand || '';
  if (!name) return null;
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', ');
  const city = [tags['addr:city'], tags['addr:state']].filter(Boolean).join(', ');
  const phone = pickTag(tags, ['contact:phone', 'phone', 'contact:mobile', 'mobile']);
  return {
    id: `osm-${osmId.replace('/', '-')}-${index}`,
    name,
    segment: term,
    phone: phone || '',
    city: city || tags['addr:suburb'] || '',
    address: street || '',
    lat, lon,
    osm_id: osmId,
    source: 'overpass',
  };
}

app.post('/api/search', async (req, res) => {
  const { query, city } = req.body || {};
  if (!query || String(query).trim().length < 2) {
    return res.status(400).json({ error: 'Informe um termo com pelo menos 2 caracteres.' });
  }
  const ql = buildOverpassQuery(String(query), city ? String(city) : '');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'HunterPro/1.0',
      },
      body: 'data=' + encodeURIComponent(ql),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return res.status(502).json({ error: `Overpass respondeu ${response.status}.`, detail: body.slice(0, 300) });
    }
    const data = await response.json();
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const leads = [];
    const seen = new Set();
    for (let i = 0; i < elements.length; i++) {
      const lead = toLead(elements[i], i, String(query));
      if (!lead) continue;
      if (seen.has(lead.osm_id)) continue;
      seen.add(lead.osm_id);
      leads.push(lead);
    }
    for (const r of leads) {
      await pool.query(`
        INSERT INTO leads (id, name, segment, phone, city, lat, lon, osm_id, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, city=EXCLUDED.city
      `, [r.id, r.name, r.segment, r.phone, r.city, r.lat, r.lon, r.osm_id, r.source]);
    }
    res.json({ count: leads.length, leads, attribution: '© OpenStreetMap contributors' });
  } catch (err) {
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Overpass demorou demais.' });
    console.error('[search]', err);
    res.status(500).json({ error: 'Falha ao consultar o Overpass.', detail: String(err.message || err) });
  }
});

app.get('/api/crm', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM crm ORDER BY created_at DESC`);
  res.json(rows.map((r) => ({
    id: r.id, leadId: r.lead_id, name: r.name, segment: r.segment,
    phone: r.phone, city: r.city, status: r.status, when: r.when_iso,
  })));
});

app.post('/api/crm', async (req, res) => {
  const { id, leadId, name, segment, phone, city, status, when } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id e name são obrigatórios.' });
  await pool.query(`
    INSERT INTO crm (id, lead_id, name, segment, phone, city, status, when_iso)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, when_iso=EXCLUDED.when_iso
  `, [id, leadId || null, name, segment || '', phone || '', city || '', status || 'novos', when || null]);
  res.json({ ok: true });
});

app.patch('/api/crm/:id', async (req, res) => {
  const updates = []; const values = [];
  if ('status' in (req.body || {})) { updates.push(`status = $${values.length + 1}`); values.push(req.body.status); }
  if ('when' in (req.body || {})) { updates.push(`when_iso = $${values.length + 1}`); values.push(req.body.when); }
  if (!updates.length) return res.status(400).json({ error: 'Nada para atualizar.' });
  values.push(req.params.id);
  await pool.query(`UPDATE crm SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  res.json({ ok: true });
});

app.delete('/api/crm/:id', async (req, res) => {
  await pool.query(`DELETE FROM crm WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/meetings', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM meetings ORDER BY when_iso ASC`);
  res.json(rows.map((r) => ({ id: r.id, crmId: r.crm_id, name: r.name, when: r.when_iso })));
});

app.post('/api/meetings', async (req, res) => {
  const { id, crmId, name, when } = req.body || {};
  if (!id || !name || !when) return res.status(400).json({ error: 'id, name e when são obrigatórios.' });
  await pool.query(`INSERT INTO meetings (id, crm_id, name, when_iso) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET when_iso=EXCLUDED.when_iso`,
    [id, crmId || null, name, when]);
  res.json({ ok: true });
});

app.delete('/api/meetings/:id', async (req, res) => {
  await pool.query(`DELETE FROM meetings WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`HunterPro rodando em http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Falha ao inicializar banco:', err);
  process.exit(1);
});
