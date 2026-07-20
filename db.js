'use strict';
/*
 * Buzzword Bingo — SQLite persistence (better-sqlite3, synchronous).
 *
 * Everything is keyed by the player's UUID (the cookie). A reload re-reads the
 * card + marks from here, so state never clears. PII (email/phone) lives here
 * server-side and is never broadcast to public pages.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function init(dir) {
  const dataDir = dir || process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  db = new Database(path.join(dataDir, 'bingo.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      uuid       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cards (
      uuid         TEXT PRIMARY KEY REFERENCES players(uuid) ON DELETE CASCADE,
      layout_json  TEXT NOT NULL,
      positive_pct INTEGER NOT NULL,
      negative_pct INTEGER NOT NULL,
      locked       INTEGER NOT NULL DEFAULT 1,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_state (
      uuid        TEXT PRIMARY KEY REFERENCES players(uuid) ON DELETE CASCADE,
      marked_json TEXT NOT NULL DEFAULT '[]',
      won_at      INTEGER,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS claims (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid        TEXT NOT NULL REFERENCES players(uuid) ON DELETE CASCADE,
      pattern     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
      claimed_at  INTEGER NOT NULL,
      reviewed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Migrations: a "round" ties a card to the current speaker/game.
  ensureColumn('cards', 'round', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('game_state', 'round', 'INTEGER NOT NULL DEFAULT 1');
  return db;
}

function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
function currentRound() { return parseInt(db.prepare("SELECT value FROM meta WHERE key='round'").get()?.value || '1', 10); }
// Start a fresh game for a new speaker: bump the round, wipe cards/marks/claims
// (players keep their registration and get a new card on their next load).
function newRound() {
  const r = currentRound() + 1;
  db.prepare(`INSERT INTO meta (key,value) VALUES ('round',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(r));
  db.exec('DELETE FROM cards; DELETE FROM game_state; DELETE FROM claims;');
  return r;
}

const now = () => Date.now();

// ---- players --------------------------------------------------------------
function upsertPlayer(p) {
  db.prepare(`
    INSERT INTO players (uuid, name, email, phone, created_at)
    VALUES (@uuid, @name, @email, @phone, @created_at)
    ON CONFLICT(uuid) DO UPDATE SET name=@name, email=@email, phone=@phone
  `).run({ uuid: p.uuid, name: p.name, email: p.email || null, phone: p.phone || null, created_at: now() });
}
function getPlayer(uuid) {
  return db.prepare('SELECT * FROM players WHERE uuid = ?').get(uuid) || null;
}
function playerCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
}

// ---- cards ----------------------------------------------------------------
// Persist a freshly drawn card for a given round, and (re)start its game state.
function saveCard(uuid, card, round) {
  round = round || currentRound();
  db.prepare(`
    INSERT INTO cards (uuid, layout_json, positive_pct, negative_pct, locked, round, created_at)
    VALUES (@uuid, @layout, @pos, @neg, 1, @round, @created_at)
    ON CONFLICT(uuid) DO UPDATE SET layout_json=@layout, positive_pct=@pos, negative_pct=@neg, round=@round, created_at=@created_at
  `).run({ uuid, layout: JSON.stringify(card), pos: card.positivePct, neg: card.negativePct, round, created_at: now() });
  db.prepare(`INSERT INTO game_state (uuid, marked_json, won_at, round, updated_at)
              VALUES (?, '[]', NULL, ?, ?)
              ON CONFLICT(uuid) DO UPDATE SET marked_json='[]', won_at=NULL, round=?, updated_at=?`)
    .run(uuid, round, now(), round, now());
}
function getCard(uuid) {
  const row = db.prepare('SELECT * FROM cards WHERE uuid = ?').get(uuid);
  if (!row) return null;
  return { ...JSON.parse(row.layout_json), positivePct: row.positive_pct, negativePct: row.negative_pct, locked: !!row.locked, round: row.round };
}

// ---- game state -----------------------------------------------------------
function getState(uuid) {
  const row = db.prepare('SELECT * FROM game_state WHERE uuid = ?').get(uuid);
  if (!row) return { marked: [], wonAt: null };
  return { marked: JSON.parse(row.marked_json), wonAt: row.won_at || null };
}
function setMarked(uuid, marked) {
  db.prepare(`INSERT INTO game_state (uuid, marked_json, updated_at) VALUES (?,?,?)
              ON CONFLICT(uuid) DO UPDATE SET marked_json=excluded.marked_json, updated_at=excluded.updated_at`)
    .run(uuid, JSON.stringify(marked), now());
}
function setWon(uuid, ts) {
  db.prepare('UPDATE game_state SET won_at = ? WHERE uuid = ?').run(ts, uuid);
}

// ---- claims (operator review queue) ---------------------------------------
function createClaim(uuid, pattern) {
  // Avoid duplicate pending claims from the same player.
  const existing = db.prepare("SELECT id FROM claims WHERE uuid=? AND status='pending'").get(uuid);
  if (existing) return existing.id;
  const r = db.prepare('INSERT INTO claims (uuid, pattern, claimed_at) VALUES (?,?,?)').run(uuid, pattern, now());
  return r.lastInsertRowid;
}
function getClaim(id) {
  return db.prepare('SELECT * FROM claims WHERE id = ?').get(id) || null;
}
function listClaims(status) {
  const q = status
    ? db.prepare(`SELECT c.*, p.name, p.email FROM claims c JOIN players p ON p.uuid=c.uuid WHERE c.status=? ORDER BY c.claimed_at`)
    : db.prepare(`SELECT c.*, p.name, p.email FROM claims c JOIN players p ON p.uuid=c.uuid ORDER BY c.claimed_at DESC`);
  return status ? q.all(status) : q.all();
}
function reviewClaim(id, status) {
  db.prepare('UPDATE claims SET status=?, reviewed_at=? WHERE id=?').run(status, now(), id);
}

// ---- meta (round settings) ------------------------------------------------
function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setMeta(key, value) {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value));
}

// ---- aggregates -----------------------------------------------------------
// Live room buzz: sum positive/negative across every player's blotted words.
function roomSentiment() {
  const rows = db.prepare(`
    SELECT c.layout_json, g.marked_json
    FROM cards c JOIN game_state g ON g.uuid = c.uuid
  `).all();
  let pos = 0, neg = 0;
  for (const row of rows) {
    const cells = JSON.parse(row.layout_json).cells;
    for (const idx of JSON.parse(row.marked_json)) {
      const cell = cells[idx];
      if (!cell || cell.free) continue;
      if (cell.polarity === 'positive') pos++;
      else if (cell.polarity === 'negative') neg++;
    }
  }
  const total = pos + neg;
  return { positive: pos, negative: neg, total,
    positivePct: total ? Math.round((pos / total) * 100) : 0,
    negativePct: total ? Math.round((neg / total) * 100) : 0 };
}
function winners() {
  return db.prepare(`SELECT p.name, p.email, g.won_at FROM game_state g
                     JOIN players p ON p.uuid=g.uuid WHERE g.won_at IS NOT NULL
                     ORDER BY g.won_at`).all();
}

module.exports = {
  init, upsertPlayer, getPlayer, playerCount,
  saveCard, getCard, getState, setMarked, setWon,
  createClaim, getClaim, listClaims, reviewClaim,
  getMeta, setMeta, roomSentiment, winners,
  currentRound, newRound,
};
