// Persistent vehicle-facts cache — SQLite (Node's built-in node:sqlite).
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
let db = null;
let dbUnavailable = null;
const memoryFallback = new Map(); // used only if node:sqlite cannot load

function normalizeKeyPart(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function canonicalKey({ make, model, year, market }) {
  return [make, model, year, market].map(normalizeKeyPart).map((x) => x || 'unknown').join('|');
}
function ttlMs() { return Number(process.env.VEHICLE_STABLE_CACHE_TTL_MS || DEFAULT_TTL_MS); }
function cacheDbPath() {
  return process.env.VEHICLE_CACHE_DB || path.join(__dirname, 'data', 'vehicle-cache.db');
}

function getDb() {
  if (db || dbUnavailable) return db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const file = cacheDbPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new DatabaseSync(file);
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
      CREATE INDEX IF NOT EXISTS idx_vehicle_cache_model ON vehicle_cache (make, model, year);
      CREATE INDEX IF NOT EXISTS idx_vehicle_cache_expires ON vehicle_cache (expires_at);
    `);
  } catch (err) {
    dbUnavailable = err;
    console.warn(`Vehicle cache DB unavailable (${err.message}); falling back to in-memory stable cache.`);
  }
  return db;
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

function findByQuery(query) {
  const q = normalizeKeyPart(query);
  if (!q) return null;
  const database = getDb();
  const rows = database
    ? database.prepare('SELECT * FROM vehicle_cache ORDER BY stored_at DESC LIMIT 500').all().map(rowToEntry).filter(Boolean)
    : [...memoryFallback.values()];

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
  const database = getDb();
  const now = Date.now();
  try {
    if (database) database.prepare('UPDATE vehicle_cache SET hit_count = hit_count + 1, last_accessed_at = ? WHERE canonical_key = ?').run(now, entry.key);
    else if (memoryFallback.has(entry.key)) { const e = memoryFallback.get(entry.key); e.hitCount = (e.hitCount || 0) + 1; }
  } catch { /* stats are best-effort */ }
}

function upsert({ vehicle, stable, sources, alias }) {
  const key = canonicalKey(vehicle);
  const now = Date.now();
  const expiresAt = now + ttlMs();
  const database = getDb();
  const existing = database
    ? rowToEntry(database.prepare('SELECT * FROM vehicle_cache WHERE canonical_key = ?').get(key))
    : memoryFallback.get(key);
  const aliases = [...new Set([...(existing?.aliases || []), normalizeKeyPart(alias), `${normalizeKeyPart(vehicle.make)} ${normalizeKeyPart(vehicle.model)}`].filter(Boolean))];
  const entry = { key, make: vehicle.make, model: vehicle.model, year: vehicle.year || '', market: vehicle.market || '', aliases, stable, sources, storedAt: now, expiresAt, hitCount: existing?.hitCount || 0 };
  if (database) {
    database.prepare(`INSERT INTO vehicle_cache (canonical_key, make, model, year, market, aliases_json, stable_json, sources_json, stored_at, expires_at, hit_count, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_key) DO UPDATE SET make=excluded.make, model=excluded.model, year=excluded.year, market=excluded.market,
        aliases_json=excluded.aliases_json, stable_json=excluded.stable_json, sources_json=excluded.sources_json,
        stored_at=excluded.stored_at, expires_at=excluded.expires_at, last_accessed_at=excluded.last_accessed_at`)
      .run(key, entry.make, entry.model, entry.year, entry.market, JSON.stringify(aliases), JSON.stringify(stable), JSON.stringify(sources), now, expiresAt, entry.hitCount, now);
  } else memoryFallback.set(key, entry);
  return entry;
}

function stats() {
  const database = getDb();
  try {
    if (!database) return { backend: 'memory', entries: memoryFallback.size, ttlDays: Math.round(ttlMs() / 86400000) };
    const row = database.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(hit_count),0) AS hits, MAX(stored_at) AS newest FROM vehicle_cache').get();
    return { backend: 'sqlite', entries: row.n, totalHits: row.hits, newestStoredAt: row.newest ? new Date(row.newest).toISOString() : null, ttlDays: Math.round(ttlMs() / 86400000), dbFile: path.basename(cacheDbPath()) };
  } catch { return { backend: 'unavailable', entries: 0 }; }
}

function clearExpired() {
  const database = getDb();
  try { if (database) database.prepare('DELETE FROM vehicle_cache WHERE expires_at <= ?').run(Date.now()); } catch { /* ignore */ }
}

module.exports = { findByQuery, recordHit, upsert, stats, clearExpired, canonicalKey, ttlMs };
