// Persistent vehicle-facts caches — ONE SQLite DB PER MARKET.
//
// Each market (US, CA, and any future market) gets its own cache file:
//   data/vehicle-cache-us.db
//   data/vehicle-cache-ca.db   <- created automatically the first time
//                                 the Canada market is used
// Markets never share or pollute each other's cached facts (Canadian
// trims/pricing context stays out of the US cache and vice versa).
// A new market's cache is created lazily by ensureMarket()/first lookup.
//
// Only STABLE, model-year-bound facts live here: core vehicle identity,
// trims (names/highlights), colours, interiors, options/features and
// performance specs. Anything that moves — pricing, sentiment, common
// issues, watch-outs — is deliberately NOT stored and is pulled live on
// every interaction by vehicleGrounding.js.
//
// Entries expire after a TTL (default 30 days) so cached facts refresh
// roughly monthly, or immediately when a request asks to refresh them.
const fs = require('fs');
const path = require('path');

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ~1 month
const databases = new Map(); // marketCode -> DatabaseSync
const unavailableMarkets = new Set();
const memoryFallback = new Map(); // marketCode -> Map(key -> entry), only if node:sqlite cannot load

function normalizeKeyPart(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function canonicalKey({ make, model, year, market }) {
  return [make, model, year, market].map(normalizeKeyPart).map((x) => x || 'unknown').join('|');
}
function ttlMs() { return Number(process.env.VEHICLE_STABLE_CACHE_TTL_MS || DEFAULT_TTL_MS); }

const MARKET_NAME_TO_CODE = {
  'united states': 'US', usa: 'US', america: 'US', canada: 'CA', 'united kingdom': 'GB', britain: 'GB', england: 'GB',
  australia: 'AU', 'new zealand': 'NZ', 'south africa': 'ZA', germany: 'DE', france: 'FR', spain: 'ES', italy: 'IT',
  netherlands: 'NL', ireland: 'IE', switzerland: 'CH', japan: 'JP', india: 'IN', 'united arab emirates': 'AE', uae: 'AE',
  singapore: 'SG', brazil: 'BR', mexico: 'MX', 'south korea': 'KR', china: 'CN', sweden: 'SE', norway: 'NO', denmark: 'DK', poland: 'PL',
};
function marketCodeOf(market) {
  if (market && typeof market === 'object') market = market.code || market.country || market.market || '';
  const raw = String(market || '').trim();
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  const named = MARKET_NAME_TO_CODE[normalizeKeyPart(raw)];
  if (named) return named;
  // Unknown markets still get their own cache file under a safe slug.
  return normalizeKeyPart(raw).replace(/ /g, '-').slice(0, 24) || 'global';
}

function cacheDbPathFor(marketCode) {
  const code = marketCodeOf(marketCode).toLowerCase();
  if (process.env.VEHICLE_CACHE_DB) {
    const custom = process.env.VEHICLE_CACHE_DB;
    if (custom.includes('{market}')) return custom.replace('{market}', code);
    const ext = path.extname(custom);
    return custom.slice(0, custom.length - ext.length) + `-${code}` + (ext || '.db');
  }
  return path.join(__dirname, 'data', `vehicle-cache-${code}.db`);
}

function migrateLegacyDb(targetFile) {
  // One-time: the pre-per-market single DB becomes the US cache.
  try {
    const legacy = path.join(__dirname, 'data', 'vehicle-cache.db');
    if (targetFile !== legacy && fs.existsSync(legacy) && !fs.existsSync(targetFile)) {
      fs.renameSync(legacy, targetFile);
      for (const suffix of ['-wal', '-shm']) if (fs.existsSync(legacy + suffix)) fs.renameSync(legacy + suffix, targetFile + suffix);
    }
  } catch { /* migration is best-effort */ }
}

function getDb(marketCode = 'US') {
  const code = marketCodeOf(marketCode);
  if (databases.has(code)) return databases.get(code);
  if (unavailableMarkets.has(code)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const file = cacheDbPathFor(code);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (code === 'US') migrateLegacyDb(file);
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vehicle_cache (
        canonical_key TEXT PRIMARY KEY,
        make TEXT NOT NULL,
        model TEXT NOT NULL,
        year TEXT,
        market TEXT,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        stable_json TEXT NOT NULL,
        sources_json TEXT NOT NULL DEFAULT '[]',
        stored_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX IF NOT EXISTS idx_vehicle_cache_model ON vehicle_cache (make, model, year);
      CREATE INDEX IF NOT EXISTS idx_vehicle_cache_expires ON vehicle_cache (expires_at);
    `);
    db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('market', code);
    db.prepare('INSERT INTO cache_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run('created_at', new Date().toISOString());
    databases.set(code, db);
    if (!memoryFallback.has(code)) memoryFallback.set(code, new Map());
    return db;
  } catch (err) {
    unavailableMarkets.add(code);
    if (!memoryFallback.has(code)) memoryFallback.set(code, new Map());
    console.warn(`Vehicle cache DB unavailable for market ${code} (${err.message}); falling back to in-memory stable cache.`);
    return null;
  }
}

// Create (if needed) and return stats for a market's own cache. Called
// when a new market is detected/selected so its cache exists before the
// first vehicle analysis in that market.
function ensureMarket(marketCode) {
  const code = marketCodeOf(marketCode);
  getDb(code);
  return stats(code);
}

function rowToEntry(row) {
  if (!row) return null;
  try {
    return {
      key: row.canonical_key, make: row.make, model: row.model, year: row.year || '', market: row.market || '',
      aliases: JSON.parse(row.aliases_json || '[]'), stable: JSON.parse(row.stable_json),
      sources: JSON.parse(row.sources_json || '[]'),
      storedAt: row.stored_at, expiresAt: row.expires_at, hitCount: row.hit_count || 0,
    };
  } catch { return null; }
}

function entriesFor(code) {
  const database = getDb(code);
  return database
    ? database.prepare('SELECT * FROM vehicle_cache ORDER BY stored_at DESC LIMIT 500').all().map(rowToEntry).filter(Boolean)
    : [...(memoryFallback.get(code)?.values() || [])];
}

function findByQuery(query, marketCode = 'US') {
  const code = marketCodeOf(marketCode);
  const q = normalizeKeyPart(query);
  if (!q) return null;
  const rows = entriesFor(code); // this market's cache only — never cross-market

  // 1) Exact alias match.
  let entry = rows.find((e) => e.aliases.includes(q));
  // 2) Make + model (+ year if the query names one) match.
  if (!entry) {
    const yearInQuery = (q.match(/\b(19|20)\d{2}\b/) || [])[0] || '';
    const scored = rows.map((e) => {
      const makeTokens = normalizeKeyPart(e.make).split(' ').filter(Boolean);
      const modelTokens = normalizeKeyPart(e.model).split(' ').filter((t) => t.length > 1);
      let score = 0;
      if (makeTokens.every((t) => q.split(' ').includes(t))) score += 2;
      score += modelTokens.filter((t) => q.split(' ').includes(t)).length * 2;
      if (yearInQuery && e.year && normalizeKeyPart(e.year).includes(yearInQuery)) score += 2;
      if (yearInQuery && e.year && !normalizeKeyPart(e.year).includes(yearInQuery)) score -= 3;
      return { e, score };
    }).filter((x) => x.score >= 4).sort((a, b) => b.score - a.score);
    entry = scored[0]?.e || null;
  }
  if (!entry) return null;
  return { ...entry, fresh: Date.now() < entry.expiresAt };
}

function recordHit(entry) {
  const code = marketCodeOf(entry.market);
  const database = getDb(code);
  const now = Date.now();
  try {
    if (database) database.prepare('UPDATE vehicle_cache SET hit_count = hit_count + 1, last_accessed_at = ? WHERE canonical_key = ?').run(now, entry.key);
    else if (memoryFallback.get(code)?.has(entry.key)) { const e = memoryFallback.get(code).get(entry.key); e.hitCount = (e.hitCount || 0) + 1; }
  } catch { /* stats are best-effort */ }
}

function upsert({ vehicle, stable, sources, alias, marketCode = '' }) {
  const code = marketCodeOf(marketCode || vehicle.market);
  const market = code;
  const key = canonicalKey({ ...vehicle, market });
  const now = Date.now();
  const expiresAt = now + ttlMs();
  const database = getDb(code);
  const existing = database
    ? rowToEntry(database.prepare('SELECT * FROM vehicle_cache WHERE canonical_key = ?').get(key))
    : memoryFallback.get(code)?.get(key);
  const aliases = [...new Set([...(existing?.aliases || []), normalizeKeyPart(alias), `${normalizeKeyPart(vehicle.make)} ${normalizeKeyPart(vehicle.model)}`].filter(Boolean))];
  const entry = { key, make: vehicle.make, model: vehicle.model, year: vehicle.year || '', market, aliases, stable, sources, storedAt: now, expiresAt, hitCount: existing?.hitCount || 0 };
  if (database) {
    database.prepare(`INSERT INTO vehicle_cache (canonical_key, make, model, year, market, aliases_json, stable_json, sources_json, stored_at, expires_at, hit_count, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_key) DO UPDATE SET make=excluded.make, model=excluded.model, year=excluded.year, market=excluded.market,
        aliases_json=excluded.aliases_json, stable_json=excluded.stable_json, sources_json=excluded.sources_json,
        stored_at=excluded.stored_at, expires_at=excluded.expires_at, last_accessed_at=excluded.last_accessed_at`)
      .run(key, entry.make, entry.model, entry.year, entry.market, JSON.stringify(aliases), JSON.stringify(stable), JSON.stringify(sources), now, expiresAt, entry.hitCount, now);
  } else memoryFallback.get(code)?.set(key, entry);
  return entry;
}

function stats(marketCode) {
  if (marketCode) {
    const code = marketCodeOf(marketCode);
    const database = getDb(code);
    try {
      if (!database) return { market: code, backend: 'memory', entries: memoryFallback.get(code)?.size || 0, ttlDays: Math.round(ttlMs() / 86400000), dbFile: path.basename(cacheDbPathFor(code)) };
      const row = database.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hit_count),0) AS hits, MAX(stored_at) AS newest FROM vehicle_cache').get();
      const created = database.prepare("SELECT value FROM cache_meta WHERE key='created_at'").get();
      return { market: code, backend: 'sqlite', entries: row.n, totalHits: row.hits, newestStoredAt: row.newest ? new Date(row.newest).toISOString() : null, createdAt: created?.value || null, ttlDays: Math.round(ttlMs() / 86400000), dbFile: path.basename(cacheDbPathFor(code)) };
    } catch { return { market: code, backend: 'unavailable', entries: 0 }; }
  }
  // All markets: ones already opened in this process + DB files on disk.
  const codes = new Set(databases.keys());
  try {
    const dir = path.join(__dirname, 'data');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^vehicle-cache-([a-z0-9]+)\.db$/i);
      if (m) codes.add(m[1].toUpperCase());
    }
  } catch { /* ignore */ }
  if (!codes.size) codes.add('US');
  const markets = {};
  let entries = 0;
  for (const code of codes) { markets[code] = stats(code); entries += markets[code].entries || 0; }
  return { backend: 'sqlite-per-market', entries, ttlDays: Math.round(ttlMs() / 86400000), markets };
}

function clearExpired(marketCode) {
  const codes = marketCode ? [marketCodeOf(marketCode)] : [...databases.keys()];
  for (const code of codes) {
    const database = getDb(code);
    try { if (database) database.prepare('DELETE FROM vehicle_cache WHERE expires_at <= ?').run(Date.now()); } catch { /* ignore */ }
  }
}

module.exports = { findByQuery, recordHit, upsert, stats, clearExpired, ensureMarket, canonicalKey, ttlMs, marketCodeOf, cacheDbPathFor };
