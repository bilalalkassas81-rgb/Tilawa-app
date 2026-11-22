// Arabic normalisation and recitation alignment.
const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const LETTER = { 'ا': 'الف', 'ل': 'لام', 'م': 'ميم', 'ص': 'صاد', 'ر': 'را', 'ك': 'كاف', 'ه': 'ها', 'ي': 'يا', 'ع': 'عين', 'ط': 'طا', 'س': 'سين', 'ح': 'حا', 'ق': 'قاف', 'ن': 'نون' };

export function normalize(s) {
  return s.replace(DIAC, '')
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

export function sim(r, u) {
  if (u.norm.length <= 2 || u.key.length <= 1) return (r.norm === u.norm || r.key === u.key) ? 1 : 0;
  return Math.max(ratio(r.key, u.key), ratio(r.norm, u.norm));
}

export function tokens(text, final, manual) {
  return (text || '').replace(/[^ء-ٰٟٱ\s]/g, ' ').split(/\s+/).map(normalize).filter(Boolean)
    .map((norm) => ({ norm, key: skel(norm), final, manual: !!manual }));
}

/** Is this word a disjoined-letters opener (e.g. الٓمٓ) recited letter by letter? */
export function isMuqattaat(word, verse, idx) { return verse <= 2 && idx === 0 && !/[ً-ْ]/.test(word); }

/** Units are what the recogniser should hear, in order. */
export function buildUnits(words) {
  const units = [];
  words.forEach((w, i) => {
    const norm = normalize(w.text);
    if (isMuqattaat(w.text, w.v, w.j)) for (const ch of norm) { const name = LETTER[ch] || ch; units.push({ w: i, norm: name, key: skel(name) }); }
    else if (norm) units.push({ w: i, norm, key: skel(norm) });
  });
  return units;
}

/**
 * Align recognised tokens against expected units.
 * Returns per-word classes plus counters.
 */
export function align(units, wordCount, rec, manualWrong, hints) {
  const st = new Uint8Array(units.length); // 0 pending, 1 ok, 2 missed, 3 fixed, 4 soft-skip
  const wrong = new Set(manualWrong);
  let ptr = 0;
  for (const r of rec) {
    if (ptr >= units.length) break;
    if (r.manual) { st[ptr] = wrong.has(ptr) ? 3 : 1; ptr++; continue; }
    let hit = -1;
    for (let k = 0; k <= 4 && ptr + k < units.length; k++) {
      const u = units[ptr + k];
      if (k > 0 && u.norm.length < 3) continue;
      if (sim(r, u) >= (k === 0 ? 0.55 : 0.8)) { hit = ptr + k; break; }
    }
    if (hit >= 0) {
      for (let m = ptr; m < hit; m++) if (!st[m]) st[m] = units[m].norm.length <= 2 ? 4 : 2;
      st[hit] = wrong.has(hit) ? 3 : 1; ptr = hit + 1; continue;
    }
    let rep = false;
    for (let m = Math.max(0, ptr - 4); m < ptr; m++) if (sim(r, units[m]) >= 0.7) { rep = true; break; }
    if (rep || ptr === 0) continue;
    if (r.final) wrong.add(ptr);
  }
  const wSt = new Array(wordCount).fill(null);
  units.forEach((u, idx) => {
    const s = st[idx], o = wSt[u.w] || (wSt[u.w] = { done: 0, total: 0, miss: 0, fix: 0, wrong: 0 });
    o.total++;
    if (s === 1 || s === 4) o.done++;
    if (s === 2) o.miss++;
    if (s === 3) { o.fix++; o.done++; }
    if (!s && wrong.has(idx)) o.wrong++;
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
    if (o.done === o.total || o.miss) doneWords++;
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
