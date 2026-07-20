'use strict';
/*
 * Buzzword Bingo — core algorithm (pure, no dependencies).
 *
 *  - generateCard(seed)  deterministic from the player's UUID: same UUID always
 *                        yields the identical card (so a card can be re-derived,
 *                        and the DB copy is just a fast cache).
 *  - evaluate(card, marked, target)  detects traditional bingo patterns.
 *  - sentiment(card, marked)  positive-vs-negative % of blotted words.
 *
 * A card is { size, freeCenter, cells:[{word,polarity,free}], counts,
 *             positivePct, negativePct }. Cells are row-major (index = r*size+c).
 */

const { POSITIVE, NEGATIVE, NAMES } = require('./buzzwords');

// ---- deterministic RNG (xmur3 seed -> mulberry32) -------------------------
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFrom(seed) {
  return mulberry32(xmur3(String(seed))());
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- card generation ------------------------------------------------------
function generateCard(seed, opts = {}) {
  const size = opts.size || 5;
  const freeCenter = opts.freeCenter !== false && size % 2 === 1;
  const freeLabel = opts.freeLabel || 'ClueCon';
  const pos = opts.positive || POSITIVE;
  const neg = opts.negative || NEGATIVE;
  const names = opts.names || NAMES;
  const rng = rngFrom(seed);

  const totalCells = size * size;
  const wordCells = totalCells - (freeCenter ? 1 : 0);

  // Reserve some cells for neutral AI name-drops (default ~30% of the card).
  const namesRatio = opts.namesRatio == null ? 0.3 : opts.namesRatio;
  let nNames = Math.min(Math.round(wordCells * namesRatio), names.length);

  // Split the remaining cells positive vs negative (default: proportional to pools).
  const rest = wordCells - nNames;
  let ratio = opts.positiveRatio;
  if (ratio == null) ratio = pos.length / (pos.length + neg.length);
  let nPos = Math.round(rest * ratio);
  let nNeg = rest - nPos;
  if (nPos > pos.length) { nNeg += nPos - pos.length; nPos = pos.length; }
  if (nNeg > neg.length) { nPos += nNeg - neg.length; nNeg = neg.length; }
  // If pos+neg pools are maxed and still short, backfill from names.
  if (nPos + nNeg + nNames < wordCells) {
    nNames = Math.min(nNames + (wordCells - (nPos + nNeg + nNames)), names.length);
  }
  if (nPos + nNeg + nNames < wordCells) {
    throw new Error(`not enough buzzwords: need ${wordCells}, have ${pos.length + neg.length + names.length}`);
  }

  const picked = [
    ...shuffle(pos, rng).slice(0, nPos).map((w) => ({ word: w, polarity: 'positive' })),
    ...shuffle(neg, rng).slice(0, nNeg).map((w) => ({ word: w, polarity: 'negative' })),
    ...shuffle(names, rng).slice(0, nNames).map((w) => ({ word: w, polarity: 'name' })),
  ];
  const laid = shuffle(picked, rng);

  const centerIdx = freeCenter ? Math.floor(totalCells / 2) : -1;
  const cells = [];
  let k = 0;
  for (let i = 0; i < totalCells; i++) {
    if (i === centerIdx) cells.push({ word: freeLabel, polarity: 'free', free: true });
    else cells.push({ ...laid[k++], free: false });
  }

  // Composition % is positive-vs-negative only (name-drops are neutral).
  const buzz = nPos + nNeg;
  const positivePct = buzz ? Math.round((nPos / buzz) * 100) : 0;
  return {
    size,
    freeCenter,
    cells,
    counts: { positive: nPos, negative: nNeg, names: nNames, total: wordCells },
    positivePct,
    negativePct: buzz ? 100 - positivePct : 0,
  };
}

// ---- winning patterns -----------------------------------------------------
function lineGroups(size) {
  const groups = [];
  for (let r = 0; r < size; r++) {
    groups.push({ name: `row ${r + 1}`, cells: Array.from({ length: size }, (_, c) => r * size + c) });
  }
  for (let c = 0; c < size; c++) {
    groups.push({ name: `column ${c + 1}`, cells: Array.from({ length: size }, (_, r) => r * size + c) });
  }
  groups.push({ name: 'diagonal ↘', cells: Array.from({ length: size }, (_, i) => i * size + i) });
  groups.push({ name: 'diagonal ↙', cells: Array.from({ length: size }, (_, i) => i * size + (size - 1 - i)) });
  return groups;
}
function border(size) {
  const s = new Set();
  for (let i = 0; i < size; i++) { s.add(i); s.add((size - 1) * size + i); s.add(i * size); s.add(i * size + size - 1); }
  return [...s];
}
// Named target patterns → list of candidate groups (complete if ANY is complete).
function patternGroups(size, target) {
  const mid = Math.floor(size / 2);
  switch (target) {
    case 'any_line': return lineGroups(size);
    case 'four_corners':
      return [{ name: 'four corners', cells: [0, size - 1, size * (size - 1), size * size - 1] }];
    case 'x': {
      const s = new Set();
      for (let i = 0; i < size; i++) { s.add(i * size + i); s.add(i * size + (size - 1 - i)); }
      return [{ name: 'X', cells: [...s] }];
    }
    case 'plus': {
      const s = new Set();
      for (let i = 0; i < size; i++) { s.add(mid * size + i); s.add(i * size + mid); }
      return [{ name: 'plus', cells: [...s] }];
    }
    case 'frame': return [{ name: 'frame', cells: border(size) }];
    case 'blackout':
      return [{ name: 'blackout', cells: Array.from({ length: size * size }, (_, i) => i) }];
    default: return lineGroups(size);
  }
}
const TARGETS = ['any_line', 'four_corners', 'x', 'plus', 'frame', 'blackout'];

function groupComplete(cells, markedSet, card) {
  return cells.every((i) => markedSet.has(i) || (card.cells[i] && card.cells[i].free));
}

// Is `target` satisfied by the marked cells? Returns which named groups completed.
function evaluate(card, markedIndices, target = 'any_line') {
  const marked = new Set(markedIndices);
  const groups = patternGroups(card.size, target);
  const done = groups.filter((g) => groupComplete(g.cells, marked, card));
  return { target, complete: done.length > 0, completedPatterns: done.map((g) => g.name) };
}

// Every traditional pattern currently satisfied (for the operator's review view).
function completedPatterns(card, markedIndices) {
  const out = [];
  for (const t of TARGETS) {
    const r = evaluate(card, markedIndices, t);
    if (r.complete) out.push(...r.completedPatterns);
  }
  return [...new Set(out)];
}

// ---- sentiment ------------------------------------------------------------
function sentiment(card, markedIndices) {
  const marked = new Set(markedIndices);
  let pos = 0, neg = 0;
  for (const i of marked) {
    const c = card.cells[i];
    if (!c || c.free) continue;
    if (c.polarity === 'positive') pos++;
    else if (c.polarity === 'negative') neg++;
  }
  const total = pos + neg;
  return {
    positive: pos,
    negative: neg,
    total,
    positivePct: total ? Math.round((pos / total) * 100) : 0,
    negativePct: total ? Math.round((neg / total) * 100) : 0,
  };
}

module.exports = { generateCard, evaluate, completedPatterns, sentiment, patternGroups, TARGETS };
