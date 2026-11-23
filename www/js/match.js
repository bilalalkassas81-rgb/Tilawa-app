// Arabic normalisation and recitation alignment.
const DIAC = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const LETTER = { 'ا': 'الف', 'ل': 'لام', 'م': 'ميم', 'ص': 'صاد', 'ر': 'را', 'ك': 'كاف', 'ه': 'ها', 'ي': 'يا', 'ع': 'عين', 'ط': 'طا', 'س': 'سين', 'ح': 'حا', 'ق': 'قاف', 'ن': 'نون' };

// A final hamza is often left out by recognisers (شي for شيء, السما for السماء), so it is not compared.
export function normalize(s) {
  return s.replace(/[ࡰ-ࢂ]/g, 'ا').replace(/ࢆ/g, 'ي').replace(/[ࢃ-ࢅࢇ-ࢎ࢐-࢑ࢗ-࢟࣊-ࣿ]/g, '')
    .replace(DIAC, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^ء-ي]/g, '').replace(/ء+$/, '');
}
/** The consonant skeleton. The first letter is kept: a leading و, ي or ت is a conjunction or a verb prefix, not a vowel. */
export function skel(n) { if (!n) return n; const s = n[0] + n.slice(1).replace(/[اويء]/g, ''); return s.length >= 2 ? s : n; }

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
function ratio(a, b) {
  const m = Math.max(a.length, b.length, 1), d = Math.abs(a.length - b.length);
  if (d / m > 0.4) return 1 - d / m; // upper bound, already far below every threshold
  return 1 - lev(a, b) / m;
}

// A wrong conjunction or preposition glued to the front (واحد for أحد, فقال for قال) is a real mistake.
const PREFIX = /^[وفبلك]/;
function prefixOnly(a, b) { return a.length === b.length + 1 && PREFIX.test(a) && a.slice(1) === b; }
const VOWEL = 'اوي', PERSON = 'يتنا';
const SUFFIX = ['كما', 'هما', 'كم', 'هم', 'كن', 'هن', 'نا', 'ني', 'ها', 'ك', 'ه', 'ي', ''];
/** Spellings that look alike but are different words: a long vowel changed (قال/قيل, نودي/نادى), the person of a
 *  verb (يعلمون/تعلمون) or the pronoun suffix (ربكم/ربهم, عليك/عليكم). Spelling variants (hamza seats, ة/ه, ى/ي,
 *  a written or dagger alif: السموات/السماوات) are not caught here: they differ by insertion, not substitution. */
function distinct(a, b) {
  if (a.length === b.length) {
    let first = -1, n = 0, vow = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { n++; if (first < 0) first = i; if (!VOWEL.includes(a[i]) || !VOWEL.includes(b[i])) vow = false; }
    if (n && vow) return true;
    if (n === 1 && PERSON.includes(a[first]) && PERSON.includes(b[first]) && a.length - first >= 3 && /^[وفلس]{0,2}$/.test(a.slice(0, first))) return true;
  }
  for (const sa of SUFFIX) {
    if (!a.endsWith(sa)) continue;
    const stem = a.slice(0, a.length - sa.length);
    if (!stem || !b.startsWith(stem)) continue;
    const sb = b.slice(stem.length);
    if (sb !== sa && SUFFIX.includes(sb)) return true;
  }
  return false;
}
const simMemo = new Map(); // align re-runs on every partial result: remember word comparisons
export function sim(r, u) {
  if (r.norm === u.norm) return 1;
  const id = r.norm + ' ' + u.norm;
  let v = simMemo.get(id);
  if (v === undefined) { if (simMemo.size > 200000) simMemo.clear(); simMemo.set(id, v = sim0(r, u)); }
  return v;
}
function sim0(r, u) {
  if (prefixOnly(r.norm, u.norm) || prefixOnly(u.norm, r.norm)) return 0.5;
  if (u.norm.length <= 2 || u.key.length <= 1) return r.key === u.key && !distinct(r.norm, u.norm) ? 1 : 0;
  const s = Math.max(ratio(r.key, u.key), ratio(r.norm, u.norm));
  return s >= 0.6 && distinct(r.norm, u.norm) ? 0.4 : s;
}
// two words heard as one (الحمدلله, يومالدين)
const merged = (r, u, u1) => !!u1 && !u.alt && !u1.alt && r.norm.length > u.norm.length + 1 && ratio(r.norm, u.norm + u1.norm) >= 0.85;
const match = (r, u) => (u.alt && (r.norm === u.alt.norm || r.key === u.alt.key)) || sim(r, u) >= (u.norm.length <= 2 ? 1 : 0.8);

export function tokens(text, final, manual) {
  const ws = (text || '').replace(DIAC, '').replace(/[^ء-ٰٟٱ\s]/g, ' ').split(/\s+/).map(normalize).filter(Boolean);
  const out = [];
  for (let i = 0; i < ws.length; i++) {
    let n = ws[i];
    // the vocative يا (and ها) is one word with what follows in the Mushaf (ياأيها, يابني, هاأنتم); recognisers split it
    if ((n === 'يا' || n === 'ها') && i + 1 < ws.length) n += ws[++i];
    out.push({ norm: n, key: skel(n), final, manual: !!manual });
  }
  return out;
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
    const v = w.s * 1000 + w.v;
    if (isMuqattaat(w.text, w.v, w.j)) {
      const first = units.length, letters = [...norm];
      letters.forEach((ch, k) => { const name = LETTER[ch] || ch; units.push({ w: i, v, norm: name, key: skel(name), start: start && k === 0, bas: bas && k === 0 }); });
      units[first].alt = { norm, key: skel(norm), n: letters.length };
    } else if (norm) units.push({ w: i, v, norm, key: skel(norm), start, bas });
  });
  return units;
}

const PREAMBLE = tokens('اعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم', true);
const isPreamble = (r) => PREAMBLE.some((p) => p.norm === r.norm || (r.norm.length > 3 && sim(r, p) >= 0.85));

/**
 * How well do the recognised tokens from rec[t] follow the units from units[i]? The first token must match; after
 * that one slip at a time is allowed (a word left out, an extra word, a wrong word). Looks at most L tokens ahead;
 * rec[tail], a word still being spoken, counts only when it matches exactly.
 * Returns { sc: score (exact match 1, close match 0.8, slip -0.3), n: tokens matched }.
 */
function follow(units, rec, t, i, L, tail = -1) {
  let sc = 0, n = 0, slip = false, k = t, j = i;
  const end = rec.length;
  while (k < end && j < units.length && k - t < L) {
    const r = rec[k], u = units[j];
    if (r.manual) break;
    if (k === tail) { if (r.norm === u.norm && r.norm.length >= 3) { sc++; n++; } break; } // a word still being spoken counts only when exact
    if (u.alt && (r.norm === u.alt.norm || r.key === u.alt.key)) { sc++; n++; k++; j += u.alt.n; slip = false; continue; }
    if (merged(r, u, units[j + 1])) { sc += 1.6; n += 2; k++; j += 2; slip = false; continue; }
    const s = sim(r, u);
    if (s >= (u.norm.length <= 2 ? 1 : 0.8)) { sc += r.norm === u.norm ? 1 : 0.8; n++; k++; j++; slip = false; continue; }
    if (k === t || slip) break;
    slip = true; sc -= 0.3;
    const r1 = k + 1 < end && k + 1 !== tail && rec[k + 1], u1 = units[j + 1], r1ok = r1 && !r1.manual;
    if (u1 && match(r, u1)) j++; // a word left out
    else if (r1ok && match(r1, u)) k++; // an extra word
    else if (r1ok && u1 && match(r1, u1)) { k++; j++; } // a wrong word
    else break;
  }
  return { sc, n };
}

/**
 * Align recognised tokens against expected units.
 * Unit states: 0 pending, 1 ok, 2 skipped, 3 fixed (wrong then right), 4 soft skip (short word the recogniser
 * often drops), 5 wrong then skipped, 6 before the place the reader started (not part of this recitation).
 * opts.free: the reader may start anywhere on the page and may jump ahead; their place is found from their words.
 * Going back (repeating a word, restarting the verse or an earlier one) is never a mistake.
 */
const candMemo = new WeakMap();
export function align(units, wordCount, rec, manualWrong, hints, opts = {}) {
  const st = new Uint8Array(units.length);
  const wrong = new Set(manualWrong);
  const free = !!opts.free;
  const N = units.length, last = rec.length - 1;
  const tailIdx = last >= 0 && !rec[last].final ? last : -1; // the word still being spoken: too unsure to place the reader
  const end = tailIdx >= 0 ? tailIdx : rec.length;
  const fol = (t, i, L) => follow(units, rec, t, i, L, tailIdx);
  let ptr = 0, started = !free, lost = 0, lostMarks = [], rp = -1, hits = 0, startAt = 0, fresh = -1;
  let cands = candMemo.get(units);
  if (!cands) candMemo.set(units, cands = new Map()); // norm -> units it matches (for finding the start)
  const candidates = (r) => {
    let a = cands.get(r.norm);
    if (!a) { a = []; for (let i = 0; i < N; i++) if (match(r, units[i]) || merged(r, units[i], units[i + 1])) a.push(i); cands.set(r.norm, a); }
    return a;
  };
  // Where does the reader start? The best-followed place for the next few tokens; tokens skipped to get there
  // (noise, the end of the previous page) cost a little, a ta'awwudh or basmala nothing.
  const runAt = []; // best place for the reader's words from rec[t2] on
  const findStart = (t) => {
    let best = null, pen = 0;
    for (let t2 = t; t2 < Math.min(end, t + 8); t2++) {
      if (rec[t2].manual) break;
      if (t2 > t && !isPreamble(rec[t2 - 1])) pen += 1;
      let b = runAt[t2];
      if (b === undefined) {
        b = runAt[t2] = null;
        for (const i of candidates(rec[t2])) { const x = fol(t2, i, 16); if (x.n >= 2 && x.sc > (b ? b.sc : 1.5)) b = runAt[t2] = { i, sc: x.sc }; }
      }
      if (b && b.sc - pen > (best ? best.s : 1.5)) best = { t: t2, i: b.i, s: b.sc - pen };
    }
    return best;
  };
  const skipTo = (a) => { for (let m = ptr; m < a; m++) if (!st[m]) st[m] = wrong.has(m) ? 5 : units[m].norm.length <= 2 ? 4 : 2; };
  const hitAt = (a) => { st[a] = wrong.has(a) ? 3 : 1; ptr = a + 1; lost = 0; lostMarks = []; hits++; };

  for (let t = 0; t < rec.length; t++) {
    const r = rec[t];
    if (ptr >= N) break;
    if (r.manual) { started = true; rp = -1; hitAt(ptr); continue; }
    if (!started) {
      const b = findStart(t);
      if (!b) continue; // noise before the reader starts is ignored
      for (let m = 0; m < b.i; m++) st[m] = 6;
      ptr = startAt = b.i; started = true; fresh = b.t; t = b.t - 1; continue;
    }
    const u0 = units[ptr];
    // repeating words already recited: follow along without marking anything
    if (rp >= 0) {
      if (rp < ptr && match(r, units[rp])) { rp += units[rp].alt && r.norm === units[rp].alt.norm ? units[rp].alt.n : 1; if (rp >= ptr) rp = -1; continue; }
      rp = -1;
    }
    // ta'awwudh / basmala before the first verse of the passage or of a new surah
    if (t !== fresh && (hits === 0 || u0.bas || u0.start) && isPreamble(r) && sim(r, u0) < 0.9) continue;
    // the letters of an opener read as one word: الم, يس, حم ...
    if (u0.alt && (r.norm === u0.alt.norm || r.key === u0.alt.key)) { for (let k = 1; k < u0.alt.n; k++) st[ptr + k] = wrong.has(ptr + k) ? 3 : 1; hitAt(ptr); ptr += u0.alt.n - 1; continue; }
    const sCur = sim(r, u0);
    const tail = !r.final && t === last; // a word still being spoken: only the next word can match it
    let hit = -1;
    for (let k = 0; k <= (tail ? 0 : 4) && ptr + k < N; k++) {
      const u = units[ptr + k];
      if (k > 0 && u.norm.length < 3 && r.norm !== u.norm) continue;
      if ((k === 0 ? sCur : sim(r, u)) >= (k === 0 ? 0.7 : 0.8)) { hit = ptr + k; break; }
    }
    if (hit !== ptr) {
      // one word heard as two (يا أيها, ها أنتم), or two words heard as one
      const r1 = rec[t + 1];
      if (r1 && !r1.manual && (r1.final || t + 1 < last)) {
        const j = r.norm + r1.norm;
        if (sim({ norm: j, key: skel(j) }, u0) >= 0.85) { hitAt(ptr); t++; continue; }
      }
      const u1 = units[ptr + 1];
      if (merged(r, u0, u1)) { const a = ptr; hitAt(a); hitAt(a + 1); continue; }
    }
    // going back: a word repeated from just before, or a restart from earlier in this verse or the ones before.
    // Not when the reader is stuck on a mistake and moving on.
    if (hit !== ptr && !(hit > ptr && wrong.has(ptr))) {
      const fs = hit >= 0 ? fol(t, hit, 6).sc : -Infinity;
      let back = -1, bs = -Infinity;
      for (let m = ptr - 1; m >= Math.max(0, ptr - 4); m--) {
        const sp = sim(r, units[m]);
        if (sp >= 0.85 && sp > sCur) { const x = fol(t, m, 6); if (x.sc > bs) { bs = x.sc; back = m; } }
      }
      if (ptr > 4) {
        let vs = ptr - 1; const cur = units[vs].v;
        while (vs > 0 && units[vs - 1].v === cur) vs--;
        if (vs > 0) { const pv = units[vs - 1].v; while (vs > 0 && units[vs - 1].v === pv) vs--; }
        const lo = Math.max(0, Math.min(vs, ptr - 30));
        for (let m = ptr - 5; m >= lo; m--) {
          if (!match(r, units[m])) continue;
          const x = fol(t, m, 6);
          if (x.n >= 2 && x.sc > Math.max(bs, 1.5)) { bs = x.sc; back = m; }
        }
      }
      if (back >= 0 && bs < fs) back = -1;
      if (back >= 0) { rp = back + 1; if (rp >= ptr) rp = -1; continue; }
    }
    if (hit >= 0) { if (r.final) skipTo(hit); hitAt(hit); continue; } // words still being spoken may change: no skips yet
    // the reader jumped ahead: find their new place from this and the next words
    if (free && !tail) {
      // the same words come again later (a refrain): the reader was there all along
      let shift = 0;
      for (const i of candidates(r)) {
        const d = i - ptr;
        if (d <= 0 || fol(t, i, 4).n < 2) continue;
        let same = true;
        for (let m = startAt; m < ptr && same; m++) same = units[m].norm === units[m + d].norm;
        if (same) { shift = d; break; }
      }
      if (shift) {
        for (const m of lostMarks) wrong.delete(m);
        for (let m = ptr - 1; m >= startAt; m--) { st[m + shift] = st[m]; if (wrong.has(m)) { wrong.delete(m); wrong.add(m + shift); } }
        for (let m = startAt; m < startAt + shift; m++) st[m] = 6;
        startAt += shift; ptr += shift; lost = 0; lostMarks = []; t--; continue;
      }
      let best = -1, bs = lost >= 2 ? 1.5 : 2.3;
      for (let i = ptr + 1; i < Math.min(N, ptr + 80); i++) {
        if (!match(r, units[i])) continue;
        const x = fol(t, i, 8);
        if (x.n >= (lost >= 2 ? 2 : 3) && x.sc > bs) { bs = x.sc; best = i; }
      }
      if (best >= 0) {
        // the words flagged wrong while lost belong to the jump, not to the new place
        for (const m of lostMarks) wrong.delete(m);
        if (hits < 3) { for (let m = startAt; m < best; m++) st[m] = 6; startAt = best; } // the start was never confirmed
        else skipTo(best);
        ptr = best; lost = 0; lostMarks = []; t--; continue;
      }
    }
    if (r.final) { if (!wrong.has(ptr)) { wrong.add(ptr); lostMarks.push(ptr); } lost++; }
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
  const curW = started && ptr < units.length ? units[ptr].w : -1; // no place until the reader's start is known
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
