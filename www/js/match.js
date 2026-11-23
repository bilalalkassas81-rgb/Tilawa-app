// Arabic normalisation and recitation alignment.
const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const LETTER = { 'ا': 'الف', 'ل': 'لام', 'م': 'ميم', 'ص': 'صاد', 'ر': 'را', 'ك': 'كاف', 'ه': 'ها', 'ي': 'يا', 'ع': 'عين', 'ط': 'طا', 'س': 'سين', 'ح': 'حا', 'ق': 'قاف', 'ن': 'نون' };

export function normalize(s) {
  return s.replace(/[\u0870-\u0882]/g, 'ا').replace(/\u0886/g, 'ي').replace(/[\u0883-\u0885\u0887-\u088E\u0890-\u0891\u0897-\u089F\u08CA-\u08FF]/g, '')
    .replace(DIAC, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^ء-ي]/g, '');
}
export function skel(n) { const s = n.replace(/[اويء]/g, ''); return s.length >= 2 ? s : n; }

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
const ratio = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

// A wrong conjunction or preposition glued to the front (واحد for أحد, فقال for قال) is a real mistake.
const PREFIX = /^[وفبلك]/;
function prefixOnly(a, b) { return a.length === b.length + 1 && PREFIX.test(a) && a.slice(1) === b; }
export function sim(r, u) {
  if (r.norm !== u.norm && (prefixOnly(r.norm, u.norm) || prefixOnly(u.norm, r.norm))) return 0.5;
  if (u.norm.length <= 2 || u.key.length <= 1) return (r.norm === u.norm || r.key === u.key) ? 1 : 0;
  return Math.max(ratio(r.key, u.key), ratio(r.norm, u.norm));
}

export function tokens(text, final, manual) {
  return (text || '').replace(DIAC, '').replace(/[^ء-ٰٟٱ\s]/g, ' ').split(/\s+/).map(normalize).filter(Boolean)
    .map((norm) => ({ norm, key: skel(norm), final, manual: !!manual }));
}

/** Is this word a disjoined-letters opener (e.g. الٓمٓ) recited letter by letter? */
export function isMuqattaat(word, verse, idx) { return verse <= 2 && idx === 0 && !/[ً-ْ]/.test(word); }

/** Units are what the recogniser should hear, in order.
 *  Disjoined-letter openers (الٓمٓ) become one unit per letter name, and also accept the letters read as one word (الم).
 *  The first word of a surah that is preceded by a basmala is flagged, so a recited basmala is not counted as a mistake. */
export function buildUnits(words) {
  const units = [];
  words.forEach((w, i) => {
    const norm = normalize(w.plain || w.text);
    const start = w.v === 1 && w.j === 0;
    const bas = start && w.s !== 1 && w.s !== 9;
    if (isMuqattaat(w.text, w.v, w.j)) {
      const first = units.length, letters = [...norm];
      letters.forEach((ch, k) => { const name = LETTER[ch] || ch; units.push({ w: i, norm: name, key: skel(name), start: start && k === 0, bas: bas && k === 0 }); });
      units[first].alt = { norm, key: skel(norm), n: letters.length };
    } else if (norm) units.push({ w: i, norm, key: skel(norm), start, bas });
  });
  return units;
}

const PREAMBLE = tokens('اعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم', true);
const isPreamble = (r) => PREAMBLE.some((p) => p.norm === r.norm || (r.norm.length > 3 && sim(r, p) >= 0.85));

/**
 * Align recognised tokens against expected units.
 * Unit states: 0 pending, 1 ok, 2 skipped, 3 fixed (wrong then right), 4 soft skip (short word the recogniser often drops), 5 wrong then skipped.
 */
/**
 * Find where the reader is: the unit where recognised tokens rec[t], rec[t+1] (and rec[t+2]) match
 * consecutive units. Returns the best unit index at or after `from` (nearest wins ties), or -1.
 */
function anchor(units, rec, t, from, to) {
  if (t + 1 >= rec.length) return -1; // need two words to be sure
  let best = -1, bestScore = 1;
  for (let i = from; i < Math.min(units.length - 1, to); i++) {
    let sc = 0;
    for (let k = 0; k < 3 && t + k < rec.length && i + k < units.length; k++) {
      const u = units[i + k], r = rec[t + k];
      if (r.manual) break;
      const need = u.norm.length <= 2 ? 1 : 0.8;
      if (sim(r, u) >= need) sc++; else break;
    }
    if (sc > bestScore) { best = i; bestScore = sc; if (sc === 3) break; }
  }
  return best;
}

/**
 * Align recognised tokens against expected units.
 * Unit states: 0 pending, 1 ok, 2 skipped, 3 fixed (wrong then right), 4 soft skip (short word the recogniser
 * often drops), 5 wrong then skipped, 6 before the place the reader started (not part of this recitation).
 * opts.free: the reader may start anywhere on the page and may jump ahead; their place is found from their words.
 */
export function align(units, wordCount, rec, manualWrong, hints, opts = {}) {
  const st = new Uint8Array(units.length);
  const wrong = new Set(manualWrong);
  const free = !!opts.free;
  let ptr = 0, started = !free, lost = 0;
  for (let t = 0; t < rec.length; t++) {
    const r = rec[t];
    if (ptr >= units.length) break;
    const u0 = units[ptr];
    if (r.manual) { if (!started) started = true; st[ptr] = wrong.has(ptr) ? 3 : 1; ptr++; lost = 0; continue; }
    // ta'awwudh / basmala before the first verse of the passage or of a new surah
    if ((ptr === 0 || !started || u0.bas || u0.start) && isPreamble(r) && sim(r, u0) < 0.9) continue;
    // the letters of an opener read as one word: الم, يس, حم ...
    if (u0.alt && (r.norm === u0.alt.norm || r.key === u0.alt.key)) { for (let k = 0; k < u0.alt.n; k++) st[ptr + k] = wrong.has(ptr + k) ? 3 : 1; ptr += u0.alt.n; started = true; lost = 0; continue; }
    const sCur = sim(r, u0);
    let hit = -1;
    for (let k = 0; k <= 4 && ptr + k < units.length; k++) {
      const u = units[ptr + k];
      if (k > 0 && u.norm.length < 3 && r.norm !== u.norm) continue;
      if ((k === 0 ? sCur : sim(r, u)) >= (k === 0 ? 0.67 : 0.8)) { hit = ptr + k; break; }
    }
    if (!started && hit !== ptr) hit = -1; // before the reader's place is known, only an exact start counts
    // a word repeated from just before is a repetition, unless the reader is stuck on a mistake and moving on
    if (started && hit !== ptr && !(hit > ptr && wrong.has(ptr))) {
      let rep = false;
      for (let m = Math.max(0, ptr - 4); m < ptr; m++) { const sp = sim(r, units[m]); if (sp >= 0.85 && sp > sCur) { rep = true; break; } }
      if (rep) continue;
    }
    if (hit >= 0) {
      for (let m = ptr; m < hit; m++) if (!st[m]) st[m] = wrong.has(m) ? 5 : units[m].norm.length <= 2 ? 4 : 2;
      st[hit] = wrong.has(hit) ? 3 : 1; ptr = hit + 1; started = true; lost = 0; continue;
    }
    // find the reader's place: at the start (they may begin anywhere), or after losing track (they jumped ahead)
    if (free && (!started || lost >= 2)) {
      const a = anchor(units, rec, t, started ? ptr + 1 : 0, started ? ptr + 80 : units.length);
      if (a >= 0) {
        if (!started) { for (let m = 0; m < a; m++) st[m] = 6; started = true; }
        else for (let m = ptr; m < a; m++) if (!st[m]) st[m] = wrong.has(m) ? 5 : units[m].norm.length <= 2 ? 4 : 2;
        // the words that were wrongly flagged while lost belong to the jump, not to the new place
        st[a] = 1; ptr = a + 1; lost = 0; continue;
      }
    }
    if (!started) continue; // noise before the reader starts is ignored
    if (r.final) { wrong.add(ptr); lost++; }
  }
  const wSt = new Array(wordCount).fill(null);
  units.forEach((u, idx) => {
    const s = st[idx], o = wSt[u.w] || (wSt[u.w] = { done: 0, total: 0, miss: 0, fix: 0, wrong: 0, w5: 0 });
    o.total++;
    if (s === 1 || s === 4) o.done++;
    if (s === 6) o.before = (o.before || 0) + 1;
    if (s === 2) o.miss++;
    if (s === 3) { o.fix++; o.done++; }
    if ((!s || s === 5) && wrong.has(idx)) o.wrong++;
    if (s === 5) o.w5++;
  });
  const curW = ptr < units.length ? units[ptr].w : -1;
  const cls = new Array(wordCount).fill('');
  const list = [];
  let mistakes = 0, doneWords = 0;
  for (let i = 0; i < wordCount; i++) {
    const o = wSt[i]; if (!o) { cls[i] = 'w-done'; continue; }
    let c = '';
    if (o.miss) { c = 'w-missed'; list.push({ i, kind: 'missed' }); mistakes++; }
    else if (o.wrong) { c = 'w-wrong'; list.push({ i, kind: 'wrong' }); mistakes++; }
    else if (o.fix && o.done === o.total) { c = 'w-fixed'; list.push({ i, kind: 'wrong' }); mistakes++; }
    else if (o.done === o.total) c = hints.has(i) ? 'w-hint' : 'w-done';
    if (o.done === o.total || o.miss || o.w5) doneWords++;
    if (i === curW) c += ' w-current';
    cls[i] = c.trim();
  }
  return { cls, ptr, curW, mistakes, doneWords, list, finished: ptr >= units.length };
}

/* ---------- verse finder: "which verse is this?" ---------- */
let index = null;
export function buildIndex(Q) {
  // bigram of skeleton keys -> list of [surah, verse, wordIdx]
  index = { bi: new Map(), uni: new Map() };
  Q.forEach((s, si) => s[4].forEach((toks, vi) => {
    const keys = toks.map((t) => skel(normalize(t))).filter(Boolean);
    keys.forEach((k, i) => {
      const loc = (si + 1) * 1000 + (vi + 1);
      if (i + 1 < keys.length) { const b = k + ' ' + keys[i + 1]; let a = index.bi.get(b); if (!a) index.bi.set(b, a = []); a.push(loc); }
      let u = index.uni.get(k); if (!u) index.uni.set(k, u = []); u.push(loc);
    });
  }));
}
export function findVerses(Q, text, limit = 8) {
  if (!index) buildIndex(Q);
  const keys = tokens(text, true).map((t) => t.key);
  if (!keys.length) return [];
  const score = new Map();
  const add = (arr, w) => { if (!arr) return; const seen = new Set(); for (const loc of arr) { if (seen.has(loc)) continue; seen.add(loc); score.set(loc, (score.get(loc) || 0) + w); } };
  for (let i = 0; i + 1 < keys.length; i++) add(index.bi.get(keys[i] + ' ' + keys[i + 1]), 3);
  if (keys.length < 4) keys.forEach((k) => { const a = index.uni.get(k); if (a && a.length < 4000) add(a, 1); });
  return [...score.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, limit)
    .map(([loc, sc]) => ({ s: Math.floor(loc / 1000), v: loc % 1000, score: sc }));
}
