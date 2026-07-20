'use strict';
/*
 * Buzzword Bingo — control server.
 *   Player app  (/)         : register -> locked card -> tap to blot -> claim BINGO
 *   Operator    (/operator) : set the winning pattern, review claims, watch buzz
 *
 * Real-time via Socket.IO; persistence via SQLite (db.js). Identity is a UUID in
 * an HttpOnly cookie, so reloads restore the exact card + marks.
 */

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const db = require('./db');
const bingo = require('./bingo');
const { POSITIVE, NEGATIVE, NAMES } = require('./buzzwords');

// ---- tiny .env loader (no dependency) -------------------------------------
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* ignore */ }
})();

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
let OPERATOR_KEY = process.env.OPERATOR_KEY || '';
if (!OPERATOR_KEY) {
  OPERATOR_KEY = crypto.randomBytes(16).toString('hex');
  console.warn('[warn] OPERATOR_KEY not set — generated a temporary one: ' + OPERATOR_KEY);
}

db.init();
if (!db.getMeta('activePattern')) db.setMeta('activePattern', 'any_line');
if (!db.getMeta('eventName')) db.setMeta('eventName', 'Buzzword Bingo');

let publicUrl = process.env.PUBLIC_URL || '';
let qrDataUrl = '';

// ---- helpers --------------------------------------------------------------
function sanitizeText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
}
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function keyOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(OPERATOR_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function activePattern() { return db.getMeta('activePattern', 'any_line'); }
// A round stays open until a winner is declared; then it's over for that speaker
// until the operator starts the next round. (Winners exist only for this round —
// newRound() clears game_state.)
function roundOpen() { return db.winners().length === 0; }

// Base word pools + any buzzwords the operator has added live.
function mergedPools() {
  const pos = POSITIVE.slice(), neg = NEGATIVE.slice(), nm = NAMES.slice();
  for (const r of db.listBuzzwords()) {
    const arr = r.category === 'positive' ? pos : r.category === 'negative' ? neg : r.category === 'name' ? nm : null;
    if (arr && !arr.includes(r.word)) arr.push(r.word);
  }
  return { positive: pos, negative: neg, names: nm };
}

// The registered player's card for the CURRENT round — regenerated fresh (new
// seed) whenever the operator advances to a new speaker, so winners play again.
function cardFor(uuid) {
  const player = db.getPlayer(uuid);
  if (!player) return null;
  const round = db.currentRound();
  let card = db.getCard(uuid);
  if (!card || card.round !== round) {
    card = bingo.generateCard(uuid + ':r' + round, mergedPools());
    db.saveCard(uuid, card, round);
    card = db.getCard(uuid);
  }
  return card;
}

async function regenQr() {
  if (!publicUrl) { qrDataUrl = ''; return; }
  try { qrDataUrl = await QRCode.toDataURL(publicUrl.replace(/\/+$/, '') + '/', { margin: 1, width: 512 }); }
  catch (_) { qrDataUrl = ''; }
}
if (publicUrl) regenQr();

// ---- app + security headers -----------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---- cookie-based UUID identity -------------------------------------------
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  let uuid = cookies.bb_uuid;
  if (!uuid || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    uuid = crypto.randomUUID();
    // 30 days; HttpOnly so JS can't read it; Secure because we're behind TLS (cloudflared).
    const secure = (req.headers['x-forwarded-proto'] === 'https') ? ' Secure;' : '';
    res.setHeader('Set-Cookie', `bb_uuid=${uuid}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax;${secure}`);
  }
  req.uuid = uuid;
  next();
});

// ---- pages ----------------------------------------------------------------
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'play.html')));
app.get('/operator', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'operator.html')));
app.get('/stage', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'stage.html')));
app.get('/api/public', (_req, res) => res.json(publicState()));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(PUBLIC_DIR, { index: false }));

// ---- player API -----------------------------------------------------------
// Everything the player app needs on load — drives reload persistence.
app.get('/api/me', (req, res) => {
  const player = db.getPlayer(req.uuid);
  const card = cardFor(req.uuid);
  const state = db.getState(req.uuid);
  const pattern = activePattern();
  res.json({
    registered: !!player,
    name: player ? player.name : null,
    card,
    marked: state.marked,
    wonAt: state.wonAt,
    pattern,
    complete: card ? bingo.evaluate(card, state.marked, pattern).complete : false,
    sentiment: card ? bingo.sentiment(card, state.marked) : null,
    eventName: db.getMeta('eventName'),
    roundClosed: !roundOpen(),
  });
});

// Register + draw + LOCK the card. Idempotent: if you already have a card, you
// get it back (no reshuffle) — the card is locked into the play deck.
app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const name = sanitizeText(b.name, 40);
  const email = sanitizeText(b.email, 120);
  const phone = sanitizeText(b.phone, 30);
  if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
  if (!isEmail(email)) return res.status(400).json({ ok: false, error: 'A valid email is required.' });
  if (phone && !/^[0-9+()\-.\s]{5,30}$/.test(phone)) return res.status(400).json({ ok: false, error: 'That phone number looks off.' });

  db.upsertPlayer({ uuid: req.uuid, name, email, phone });
  const card = cardFor(req.uuid);
  const state = db.getState(req.uuid);
  broadcastOverview();
  res.json({ ok: true, name, card, marked: state.marked, wonAt: state.wonAt, pattern: activePattern() });
});

const markLimiter = new Map(); // uuid -> last mark ts (light rate limit)
app.post('/api/mark', (req, res) => {
  const card = cardFor(req.uuid);
  if (!card) return res.status(400).json({ ok: false, error: 'Draw a card first.' });
  if (!roundOpen()) return res.status(409).json({ ok: false, error: 'This round is over — a winner was declared.' });
  const idx = Number(req.body && req.body.index);
  const on = !!(req.body && req.body.on);
  if (!Number.isInteger(idx) || idx < 0 || idx >= card.cells.length) return res.status(400).json({ ok: false, error: 'bad cell' });
  if (card.cells[idx].free) return res.status(400).json({ ok: false, error: 'free cell' });

  const last = markLimiter.get(req.uuid) || 0;
  if (Date.now() - last < 120) return res.status(429).json({ ok: false, error: 'slow down' });
  markLimiter.set(req.uuid, Date.now());

  const set = new Set(db.getState(req.uuid).marked);
  if (on) set.add(idx); else set.delete(idx);
  const marked = [...set].sort((a, z) => a - z);
  db.setMarked(req.uuid, marked);

  const pattern = activePattern();
  const evalr = bingo.evaluate(card, marked, pattern);
  broadcastOverview();
  res.json({ ok: true, marked, complete: evalr.complete, sentiment: bingo.sentiment(card, marked) });
});

// Claim BINGO. Server re-validates the active pattern (never trusts the client),
// then queues the claim for operator review.
app.post('/api/claim', (req, res) => {
  const card = cardFor(req.uuid);
  if (!card) return res.status(400).json({ ok: false, error: 'Draw a card first.' });
  if (!roundOpen()) return res.status(409).json({ ok: false, error: 'This round is over — a winner was declared.' });
  const pattern = activePattern();
  const evalr = bingo.evaluate(card, db.getState(req.uuid).marked, pattern);
  if (!evalr.complete) return res.status(400).json({ ok: false, error: 'No bingo yet — keep blotting!' });

  const id = db.createClaim(req.uuid, pattern);
  const player = db.getPlayer(req.uuid);
  io.to('operators').emit('claim', {
    id, name: player ? player.name : 'Player', pattern,
    patterns: bingo.completedPatterns(card, db.getState(req.uuid).marked),
  });
  res.json({ ok: true, status: 'pending' });
});

// ---- operator API (key-gated) ---------------------------------------------
function requireOperator(req, res, next) {
  if (!keyOk(req.headers['x-operator-key'])) return res.status(403).json({ ok: false, error: 'forbidden' });
  next();
}
app.get('/api/operator/overview', requireOperator, (_req, res) => res.json(overview()));
app.get('/api/operator/claims', requireOperator, (_req, res) => {
  const claims = db.listClaims('pending').map((c) => {
    const card = db.getCard(c.uuid);
    const marked = db.getState(c.uuid).marked;
    const markedWords = marked.map((i) => card.cells[i] && card.cells[i].word).filter(Boolean);
    return { id: c.id, name: c.name, pattern: c.pattern, claimedAt: c.claimed_at,
      card, marked, markedWords, completed: bingo.completedPatterns(card, marked) };
  });
  res.json({ claims, activePattern: activePattern(), targets: bingo.TARGETS });
});
app.post('/api/operator/review', requireOperator, (req, res) => {
  const id = Number(req.body && req.body.id);
  const decision = req.body && req.body.decision;
  const claim = db.getClaim(id);
  if (!claim) return res.status(404).json({ ok: false, error: 'no such claim' });
  if (decision === 'approve') {
    const wonAt = Date.now();
    db.reviewClaim(id, 'approved');
    db.setWon(claim.uuid, wonAt);
    const player = db.getPlayer(claim.uuid);
    const name = player ? player.name : 'A player';
    db.logWinner(db.currentRound(), name, wonAt);   // permanent cross-round history
    io.to('player:' + claim.uuid).emit('result', { approved: true, pattern: claim.pattern, wonAt: wonAt });
    // The round is now over for this speaker — tell everyone and lock their boards.
    io.emit('roundover', { winner: name, at: wonAt, pattern: claim.pattern });
  } else {
    db.reviewClaim(id, 'rejected');
    io.to('player:' + claim.uuid).emit('result', { approved: false });
  }
  broadcastOverview();
  res.json({ ok: true });
});
// Operator-managed buzzwords (added words apply to newly drawn cards / next round).
app.get('/api/operator/buzzwords', requireOperator, (_req, res) => {
  const p = mergedPools();
  res.json({ custom: db.listBuzzwords(), counts: { positive: p.positive.length, negative: p.negative.length, names: p.names.length } });
});
app.post('/api/operator/buzzwords', requireOperator, (req, res) => {
  const word = sanitizeText(req.body && req.body.word, 40);
  const category = req.body && req.body.category;
  if (!word) return res.status(400).json({ ok: false, error: 'Enter a word.' });
  if (!['positive', 'negative', 'name'].includes(category)) return res.status(400).json({ ok: false, error: 'bad category' });
  db.addBuzzword(word, category);
  res.json({ ok: true });
});
app.post('/api/operator/buzzwords/remove', requireOperator, (req, res) => {
  const id = Number(req.body && req.body.id);
  if (Number.isInteger(id)) db.removeBuzzword(id);
  res.json({ ok: true });
});

// Label the current round with the speaker/topic.
app.post('/api/operator/speaker', requireOperator, (req, res) => {
  const speaker = sanitizeText(req.body && req.body.speaker, 80);
  db.setSpeaker(db.currentRound(), speaker);
  broadcastOverview();
  res.json({ ok: true, speaker });
});

// Next speaker → fresh game: everyone (winners included) gets a new card.
// Optionally label the new round with the speaker in the same step.
app.post('/api/operator/round', requireOperator, (req, res) => {
  const r = db.newRound();
  const speaker = sanitizeText(req.body && req.body.speaker, 80);
  if (speaker) db.setSpeaker(r, speaker);
  io.emit('round', { round: r });   // players refetch and get a fresh card
  broadcastOverview();
  res.json({ ok: true, round: r, speaker });
});
app.post('/api/operator/pattern', requireOperator, (req, res) => {
  const p = req.body && req.body.pattern;
  if (!bingo.TARGETS.includes(p)) return res.status(400).json({ ok: false, error: 'bad pattern' });
  db.setMeta('activePattern', p);
  io.emit('pattern', { pattern: p });      // tell every player the target changed
  broadcastOverview();
  res.json({ ok: true, pattern: p });
});

// ---- public URL (loopback only) — set by the cloudflared launcher ----------
app.post('/api/public-url', express.json(), async (req, res) => {
  const ra = req.socket.remoteAddress || '';
  if (!/^(::1|::ffff:127\.|127\.)/.test(ra)) return res.status(403).json({ ok: false });
  const url = sanitizeText(req.body && req.body.url, 200);
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ ok: false });
  publicUrl = url;
  await regenQr();
  broadcastOverview();
  res.json({ ok: true });
});

// ---- overview / aggregates ------------------------------------------------
function overview() {
  return {
    eventName: db.getMeta('eventName'),
    players: db.playerCount(),
    activePattern: activePattern(),
    round: db.currentRound(),
    speaker: db.getSpeaker(db.currentRound()),
    sentiment: db.roomSentiment(),
    winners: db.winners(),
    pendingClaims: db.listClaims('pending').length,
    publicUrl,
    qr: qrDataUrl,
  };
}
// PII-safe view for the public Stage screen — winner NAMES only, never emails.
function publicState() {
  return {
    eventName: db.getMeta('eventName'),
    players: db.playerCount(),
    activePattern: activePattern(),
    round: db.currentRound(),
    roundClosed: !roundOpen(),
    speaker: db.getSpeaker(db.currentRound()),
    speakers: db.speakers(),
    sentiment: db.roomSentiment(),
    winners: db.winners().map((w) => ({ name: w.name, wonAt: w.won_at })),
    history: db.winnersLog().map((w) => ({ round: w.round, name: w.name, wonAt: w.won_at })),
    publicUrl,
    qr: qrDataUrl,
  };
}
// Operators get the full overview; everyone (incl. the Stage) gets the safe view.
function broadcastOverview() {
  io.to('operators').emit('overview', overview());
  io.emit('public', publicState());
}

// ---- sockets --------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

io.on('connection', (socket) => {
  // Players identify by their cookie UUID (read from the handshake).
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const uuid = cookies.bb_uuid;
  if (uuid && /^[0-9a-f-]{36}$/i.test(uuid)) socket.join('player:' + uuid);
  socket.emit('public', publicState());  // Stage/any client gets initial state

  socket.on('operator-auth', (msg, ack) => {
    if (keyOk(msg && msg.key)) {
      socket.join('operators');
      socket.emit('overview', overview());
      if (typeof ack === 'function') ack({ ok: true });
    } else if (typeof ack === 'function') ack({ ok: false });
  });
});

server.listen(PORT, () => {
  console.log('='.repeat(52));
  console.log('  BUZZWORD BINGO — server LIVE');
  console.log('='.repeat(52));
  console.log('  Play      →  http://localhost:' + PORT + '/');
  console.log('  Operator  →  http://localhost:' + PORT + '/operator   (key: ' + OPERATOR_KEY + ')');
  console.log('='.repeat(52));
});
