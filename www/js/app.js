import { normalize, tokens, buildUnits, align, findVerses } from './match.js';
import { createRecognizer, speechSupport, speechReady, inClaude, isNative, startVoiceRecording } from './speech.js';
import { db, save, today, logDaily, streak, exportJSON, importJSON, putRecording, getRecording, deleteRecording } from './store.js';
import { JUZ, juzOf, RECITERS, audioUrl, LANGS, TOTAL_VERSES, toAr } from './meta.js';

const VERSION = '1.0.0';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
}
const P = db.prefs;
const Cap = window.Capacitor;
const plugin = (n) => (Cap && Cap.Plugins && Cap.Plugins[n]) || null;

/* ---------------- toast & dialog ---------------- */
let toastT = 0;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const dlg = $('#dlg');
function openDialog(title, body) { $('#dlg-title').textContent = title; const b = $('#dlg-body'); b.textContent = ''; b.append(body); if (!dlg.open) dlg.showModal(); }
function closeDialog() { if (dlg.open) dlg.close(); }
$$('[data-close]').forEach((b) => b.addEventListener('click', closeDialog));
dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); });

/* ---------------- theme ---------------- */
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const dark = P.theme === 'dark' || (P.theme === 'system' && mq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').content = dark ? '#0B1210' : '#EEF3F0';
  const SB = plugin('StatusBar');
  if (SB) { SB.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {}); SB.setBackgroundColor && SB.setBackgroundColor({ color: dark ? '#0B1210' : '#EEF3F0' }).catch(() => {}); }
}
mq.addEventListener && mq.addEventListener('change', applyTheme);
applyTheme();

/* ---------------- data ---------------- */
let Q = null;           // [[nameAr, translit, meaning, type, [[words...] per verse]] ...]
let OFFS = [];          // global verse offset per surah
const TR = {};          // lang -> [[...]]
async function getTr(lang) {
  if (TR[lang]) return TR[lang];
  const r = await fetch(`data/tr/${lang}.json`); if (!r.ok) throw new Error('translation');
  return (TR[lang] = await r.json());
}
const gIndex = (s, v) => OFFS[s - 1] + v - 1;
function fromGlobal(g) { let s = 1; while (s < 114 && OFFS[s] <= g) s++; return { s, v: g - OFFS[s - 1] + 1 }; }
const verseText = (s, v) => Q[s - 1][4][v - 1].join(' ');

/* ---------------- navigation ---------------- */
let screen = 'home';
const stack = [];
function go(name, push = true) {
  if (name === screen) return;
  if (push) stack.push(screen);
  if (screen === 'read') { stopRecite(); }
  screen = name;
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  $('#dock').hidden = name !== 'read';
  $$('.nav button').forEach((b) => { if (b.dataset.go === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (name === 'home') renderHome();
  if (name === 'progress') renderProgress();
  if (name === 'settings') renderSettings();
  if (name === 'read' && !R.words.length && Q) openPassage(P.s, P.from, P.to);
  window.scrollTo({ top: 0 });
}
$$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
const AppP = plugin('App');
if (AppP) AppP.addListener('backButton', () => {
  if (dlg.open) return closeDialog();
  if (stack.length) go(stack.pop(), false); else if (screen !== 'home') go('home', false); else AppP.exitApp();
});

/* ======================= HOME ======================= */
let homeTab = 'surah';
function goalProgress() {
  const d = db.daily[today()] || { verses: 0, words: 0, ms: 0 };
  const g = db.goal;
  const have = g.type === 'minutes' ? Math.floor(d.ms / 60000) : g.type === 'words' ? d.words : d.verses;
  let target = g.daily;
  const kt = khatmDailyTarget();
  if (g.type === 'verses' && kt) target = Math.max(target, kt);
  return { have, target, unit: g.type };
}
function khatmDone() { return (db.goal.khatmMap || '').split('').reduce((a, c) => a + (c === '1'), 0); }
function khatmDailyTarget() {
  const g = db.goal; if (!g.khatmDays) return 0;
  const daysGone = Math.floor((Date.now() - g.khatmStart) / 864e5);
  const left = Math.max(1, g.khatmDays - daysGone);
  const doneBeforeToday = khatmDone() - ((db.daily[today()] || {}).khatm || 0);
  return Math.ceil(Math.max(0, TOTAL_VERSES - doneBeforeToday) / left);
}
function nextKhatmVerse() { const m = db.goal.khatmMap || ''; const i = m.indexOf('0'); return i < 0 ? -1 : i; }

function renderHome() {
  if (!Q) return;
  const lr = db.lastRead || { s: 1, v: 1 };
  const sur = Q[lr.s - 1];
  $('#h-cont-k').textContent = db.lastRead ? 'Continue' : 'Start here';
  $('#h-cont-t').textContent = sur[1];
  $('#h-cont-s').textContent = `Verse ${lr.v} · Juz ${juzOf(lr.s, lr.v)}`;
  $('#h-cont-ar').textContent = sur[0];
  const g = goalProgress();
  const pct = Math.min(1, g.have / Math.max(1, g.target));
  $('#h-ring').style.strokeDashoffset = 169.6 * (1 - pct);
  $('#h-ring-t').textContent = Math.round(pct * 100) + '%';
  $('#h-goal-t').textContent = pct >= 1 ? 'Goal reached today' : 'Today’s goal';
  $('#h-goal-s').textContent = `${g.have} of ${g.target} ${g.unit}`;
  const st = streak();
  $('#h-streak').textContent = st ? `${st}-day streak` : 'Recite today to start a streak';
  const k = db.goal.khatmDays;
  $('#h-khatm').hidden = !k;
  if (k) {
    const done = khatmDone();
    $('#h-khatm-p').textContent = `${Math.round((done / TOTAL_VERSES) * 100)}%`;
    $('#h-khatm-bar').style.width = (done / TOTAL_VERSES) * 100 + '%';
    const nx = nextKhatmVerse();
    const daysGone = Math.floor((Date.now() - db.goal.khatmStart) / 864e5);
    $('#h-khatm-s').textContent = nx < 0 ? 'Khatm complete. Alhamdulillah.' :
      `${done.toLocaleString()} of ${TOTAL_VERSES.toLocaleString()} verses · day ${daysGone + 1} of ${k} · about ${khatmDailyTarget()} verses a day · next: ${Q[fromGlobal(nx).s - 1][1]} ${fromGlobal(nx).v}`;
  }
  renderHomeList();
}
$('#h-continue').addEventListener('click', () => {
  const lr = db.lastRead;
  if (lr) openVerse(lr.s, lr.v); else openPassage(1, 1, 7);
});
$('#h-khatm').addEventListener('click', () => {
  const nx = nextKhatmVerse(); if (nx < 0) return;
  const { s, v } = fromGlobal(nx);
  const n = Math.max(1, khatmDailyTarget());
  openPassage(s, v, Math.min(Q[s - 1][4].length, v + Math.min(n, 40) - 1));
});
$('#h-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  homeTab = b.dataset.t; $$('#h-tabs button').forEach((x) => x.setAttribute('aria-selected', x === b));
  renderHomeList();
});
$('#h-search').addEventListener('input', () => renderHomeList());

function surahItem(n, sub, onclick) {
  const s = Q[n - 1];
  return h('li', null, h('button', { class: 'item', onclick: onclick || (() => openPassage(n)) },
    h('span', { class: 'n' }, String(n)),
    h('span', { class: 'nm' }, h('b', null, s[1]), h('small', null, sub || `${s[2]} · ${s[4].length} verses · ${s[3] === 'm' ? 'Meccan' : 'Medinan'}`)),
    h('span', { class: 'ar', lang: 'ar' }, s[0])));
}
function verseItem(s, v, extra, onclick) {
  return h('li', null, h('button', { class: 'item', onclick: onclick || (() => openVerse(s, v)) },
    h('span', { class: 'n' }, `${s}:${v}`),
    h('span', { class: 'nm', style: 'min-width:0' }, h('b', null, `${Q[s - 1][1]} ${v}`), extra ? h('small', null, extra) : null,
      h('span', { class: 'snip', lang: 'ar' }, verseText(s, v))),
    h('span')));
}
async function renderHomeList() {
  const ul = $('#h-list'); const q = $('#h-search').value.trim();
  ul.textContent = '';
  if (q) return renderSearch(q, ul);
  if (homeTab === 'surah') Q.forEach((_, i) => ul.append(surahItem(i + 1)));
  else if (homeTab === 'juz') JUZ.forEach(([s, v], i) => ul.append(h('li', null, h('button', { class: 'item', onclick: () => openVerse(s, v) },
    h('span', { class: 'n' }, String(i + 1)), h('span', { class: 'nm' }, h('b', null, `Juz ${i + 1}`), h('small', null, `Starts at ${Q[s - 1][1]} ${v}`)), h('span', { class: 'ar' }, toAr(i + 1))))));
  else {
    if (!db.bookmarks.length) { ul.append(h('li', { class: 'empty' }, 'No bookmarks yet. In the reader, tap a verse number to bookmark it or add a note.')); return; }
    db.bookmarks.slice().sort((a, b) => b.t - a.t).forEach((b) => ul.append(verseItem(b.s, b.v, b.note || null)));
  }
}
async function renderSearch(q, ul) {
  const m = q.match(/^(\d{1,3})(?:\s*[:.\s]\s*(\d{1,3}))?$/);
  if (m) {
    const s = +m[1]; if (s >= 1 && s <= 114) {
      const v = m[2] ? Math.min(+m[2], Q[s - 1][4].length) : 0;
      ul.append(v ? verseItem(s, v) : surahItem(s));
    }
    return;
  }
  const ql = q.toLowerCase();
  Q.forEach((s, i) => { if (s[1].toLowerCase().replace(/[-']/g, '').includes(ql.replace(/[-']/g, '')) || s[2].toLowerCase().includes(ql) || normalize(s[0]).includes(normalize(q) || '\u0000')) ul.append(surahItem(i + 1)); });
  if (/[؀-ۿ]/.test(q)) {
    findVerses(Q, q, 20).forEach((r) => ul.append(verseItem(r.s, r.v)));
  } else if (q.length >= 3) {
    const lang = P.trLang;
    const tr = await getTr(lang).catch(() => null); if (!tr || $('#h-search').value.trim() !== q) return;
    let n = 0;
    outer: for (let s = 0; s < tr.length; s++) for (let v = 0; v < tr[s].length; v++) {
      if (tr[s][v].toLowerCase().includes(ql)) { ul.append(verseItem(s + 1, v + 1, tr[s][v].slice(0, 120))); if (++n >= 40) break outer; }
    }
  }
  if (!ul.children.length) ul.append(h('li', { class: 'empty' }, 'Nothing found. Try a surah name, a number like 2:255, or a few words of a verse.'));
}

/* voice verse finder */
let finder = null, finderText = '';
$('#h-voice').addEventListener('click', async () => {
  const note = $('#h-voice-note');
  if (finder && finder.active) { finder.stop(); return; }
  if (speechSupport === 'none') { note.hidden = false; note.textContent = 'Voice search needs Chrome, Safari or the Android app.'; return; }
  finderText = '';
  finder = createRecognizer({
    onPartial: (p) => showFinder(finderText + ' ' + p),
    onFinal: (f) => { finderText += ' ' + f; showFinder(finderText); },
    onState: (s) => { $('#h-voice').classList.toggle('on', s !== 'idle'); if (s === 'listening') { note.hidden = false; note.textContent = 'Listening… recite a few words of any verse.'; } if (s === 'idle' && !finderText.trim()) note.hidden = true; },
    onError: (e) => { note.hidden = false; note.textContent = e.message; },
  });
  finder.start().catch((e) => { note.hidden = false; note.textContent = e.message; });
});
function showFinder(text) {
  const ul = $('#h-list'); const note = $('#h-voice-note');
  const toks = tokens(text, true);
  if (toks.length < 2) return;
  note.hidden = false; note.textContent = 'Heard: ' + toks.map((t) => t.norm).join(' ');
  const res = findVerses(Q, text, 6);
  ul.textContent = '';
  res.forEach((r) => ul.append(verseItem(r.s, r.v, null, () => { finder && finder.stop(); openVerse(r.s, r.v); })));
  if (res.length && res[0].score >= 9 && finder && finder.active) finder.stop();
}

/* ======================= READER ======================= */
const R = { s: 1, from: 1, to: 7, words: [], units: [], els: [], vEls: [], finals: [], partial: '', manualWrong: new Set(), hints: new Set(), peeks: new Set(), res: null, prev: [], started: 0, elapsed: 0, listening: false, mode: 'recite', recorder: null };
let rec = null;

function openVerse(s, v) {
  const N = Q[s - 1][4].length;
  // whole surah for short ones, a page-sized window otherwise
  if (N <= 60) openPassage(s, 1, N, v);
  else { const from = Math.max(1, v); openPassage(s, from, Math.min(N, from + 19), v); }
}
function openPassage(s, from, to, focus) {
  const N = Q[s - 1][4].length;
  R.s = s; R.from = Math.min(Math.max(1, from || 1), N); R.to = Math.min(Math.max(R.from, to || N), N);
  if (R.to - R.from > 300) R.to = R.from + 300 - 1; // keep very long surahs smooth
  Object.assign(P, { s: R.s, from: R.from, to: R.to }); save();
  if (screen !== 'read') go('read');
  stopRecite(); stopAudio();
  renderPassage();
  if (focus && focus > R.from) requestAnimationFrame(() => { const el = R.vEls[focus - R.from]; el && el.scrollIntoView({ block: 'center' }); });
  db.lastRead = { s, v: focus || R.from, t: Date.now() }; save();
}
async function renderPassage() {
  const sur = Q[R.s - 1], N = sur[4].length;
  $('#r-name').textContent = `${R.s}. ${sur[1]}`;
  $('#r-sub').textContent = `Verses ${R.from}–${R.to} of ${N} · Juz ${juzOf(R.s, R.from)}`;
  $('#c-ar').textContent = 'سورة ' + sur[0];
  $('#c-en').textContent = `${sur[2]} · ${sur[3] === 'm' ? 'Meccan' : 'Medinan'} · ${N} verses`;
  $('#basmala').hidden = !(R.from === 1 && R.s !== 1 && R.s !== 9);
  $('#r-prev').disabled = R.s === 1 && R.from === 1; $('#r-next').disabled = R.s === 114 && R.to === N;
  const tr = P.tr ? await getTr(P.trLang).catch(() => null) : null;
  const tl = P.translit ? await getTr('translit').catch(() => null) : null;
  const box = $('#mushaf'); box.textContent = '';
  box.classList.toggle('stacked', !!(P.tr || P.translit));
  R.words = []; R.vEls = [];
  const bm = new Set(db.bookmarks.filter((b) => b.s === R.s).map((b) => b.v));
  const frag = document.createDocumentFragment();
  for (let v = R.from; v <= R.to; v++) {
    const vEl = h('div', { class: 'v', 'data-v': v });
    const ay = h('span', { class: 'ayah' });
    sur[4][v - 1].forEach((t, j) => {
      const i = R.words.length; R.words.push({ text: t, v, j });
      ay.append(h('span', { class: 'w', 'data-i': i }, t), ' ');
    });
    ay.append(h('button', { class: 'vm' + (bm.has(v) ? ' bm' : ''), 'data-v': v, 'aria-label': `Verse ${v} options` }, toAr(v)), ' ');
    vEl.append(ay);
    if (tl) vEl.append(h('div', { class: 'tl', lang: 'en' }, tl[R.s - 1][v - 1]));
    if (tr) vEl.append(h('div', { class: 'tr', dir: ['ur'].includes(P.trLang) ? 'rtl' : null }, h('b', null, `${R.s}:${v}`), tr[R.s - 1][v - 1]));
    frag.append(vEl); R.vEls.push(vEl);
  }
  box.append(frag);
  R.els = $$('.w', box);
  R.units = buildUnits(R.words);
  resetSession();
  updatePlayerLabel();
}
$('#r-prev').addEventListener('click', () => {
  if (R.from > 1) { const len = R.to - R.from + 1; openPassage(R.s, Math.max(1, R.from - len), R.from - 1); }
  else if (R.s > 1) { const N = Q[R.s - 2][4].length; openPassage(R.s - 1, N <= 60 ? 1 : Math.max(1, N - 19), N); }
});
$('#r-next').addEventListener('click', nextPassage);
function nextPassage() {
  const N = Q[R.s - 1][4].length, len = R.to - R.from + 1;
  if (R.to < N) openPassage(R.s, R.to + 1, Math.min(N, R.to + len));
  else if (R.s < 114) { const M = Q[R.s][4].length; openPassage(R.s + 1, 1, M <= 60 ? M : 20); }
}
$('#r-title').addEventListener('click', () => {
  const inp = h('input', { type: 'search', placeholder: 'Search surah', style: 'margin:12px 12px 0;width:calc(100% - 24px);padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--paper)' });
  const ul = h('ul', { class: 'list', style: 'margin:12px;border-radius:12px' });
  const fill = () => { const q = inp.value.trim().toLowerCase(); ul.textContent = ''; Q.forEach((s, i) => { if (!q || String(i + 1) === q || s[1].toLowerCase().includes(q) || s[2].toLowerCase().includes(q)) ul.append(surahItem(i + 1, null, () => { closeDialog(); openPassage(i + 1); })); }); };
  inp.addEventListener('input', fill); fill();
  openDialog('Choose a surah', h('div', null, inp, ul));
});
$('#t-range').addEventListener('click', () => {
  const N = Q[R.s - 1][4].length;
  const f = h('input', { type: 'number', min: 1, max: N, value: R.from, inputmode: 'numeric', id: 'rg-from' });
  const t = h('input', { type: 'number', min: 1, max: N, value: R.to, inputmode: 'numeric', id: 'rg-to' });
  openDialog('Verse range', h('div', { class: 'dlg-body' },
    h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { for: 'rg-from' }, 'From verse'), f), h('div', { class: 'field' }, h('label', { for: 'rg-to' }, `To verse (max ${N})`), t)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { closeDialog(); openPassage(R.s, 1, N); } }, 'Whole surah'),
      h('button', { class: 'btn accent', onclick: () => { closeDialog(); openPassage(R.s, +f.value, +t.value); } }, 'Apply'))));
});

/* reading prefs */
function applyPrefs() {
  document.documentElement.style.setProperty('--qsize', P.size + 'px');
  $('#t-tr').setAttribute('aria-pressed', !!P.tr); $('#t-tl').setAttribute('aria-pressed', !!P.translit); $('#t-hide').setAttribute('aria-pressed', !!P.hide);
}
$('#t-tr').addEventListener('click', () => { P.tr = !P.tr; save(); applyPrefs(); keepState(renderPassage); });
$('#t-tl').addEventListener('click', () => { P.translit = !P.translit; save(); applyPrefs(); keepState(renderPassage); });
$('#t-hide').addEventListener('click', () => { P.hide = !P.hide; R.peeks.clear(); save(); applyPrefs(); update(true); });
$('#t-smaller').addEventListener('click', () => { P.size = Math.max(20, P.size - 3); save(); applyPrefs(); });
$('#t-bigger').addEventListener('click', () => { P.size = Math.min(60, P.size + 3); save(); applyPrefs(); });
async function keepState(fn) {
  const keep = { finals: R.finals, manualWrong: R.manualWrong, hints: R.hints, elapsed: R.elapsed };
  await fn(); Object.assign(R, keep); update(true);
}

/* verse actions */
$('#mushaf').addEventListener('click', (e) => {
  const vm = e.target.closest('.vm');
  if (vm) return verseMenu(R.s, +vm.dataset.v);
  const w = e.target.closest('.w');
  if (w && w.classList.contains('veil')) { const i = +w.dataset.i; R.peeks.add(i); R.hints.add(i); update(); }
});
function verseMenu(s, v) {
  const bi = db.bookmarks.findIndex((b) => b.s === s && b.v === v);
  const txt = verseText(s, v);
  const item = (label, fn) => h('li', null, h('button', { onclick: () => { closeDialog(); fn(); } }, label));
  openDialog(`${Q[s - 1][1]} ${s}:${v}`, h('ul', { class: 'menu' },
    item('Play from this verse', () => { setMode('listen'); playFrom(v); }),
    item('Recite from this verse', () => { setMode('recite'); openPassage(s, v, Math.min(Q[s - 1][4].length, Math.max(R.to, v))); }),
    item(bi >= 0 ? 'Remove bookmark' : 'Bookmark', () => toggleBookmark(s, v)),
    item(bi >= 0 && db.bookmarks[bi].note ? 'Edit note' : 'Add a note', () => editNote(s, v)),
    item('Copy verse', () => copy(`${txt}\n— ${Q[s - 1][1]} ${s}:${v}`)),
    navigator.share ? item('Share', () => navigator.share({ text: `${txt}\n— Qur’an ${s}:${v}` }).catch(() => {})) : null));
}
function toggleBookmark(s, v) {
  const i = db.bookmarks.findIndex((b) => b.s === s && b.v === v);
  if (i >= 0) db.bookmarks.splice(i, 1); else db.bookmarks.push({ s, v, t: Date.now(), note: '' });
  save(); const el = $(`.vm[data-v="${v}"]`); el && el.classList.toggle('bm', i < 0);
  toast(i >= 0 ? 'Bookmark removed' : 'Bookmarked');
}
function editNote(s, v) {
  let b = db.bookmarks.find((x) => x.s === s && x.v === v);
  const ta = h('textarea', { rows: 4, id: 'note-ta' }); ta.value = b ? b.note : '';
  openDialog(`Note on ${s}:${v}`, h('div', { class: 'dlg-body' }, h('div', { class: 'field' }, h('label', { for: 'note-ta' }, 'Your note (saves a bookmark too)'), ta),
    h('button', { class: 'btn accent', onclick: () => {
      if (!b) { b = { s, v, t: Date.now(), note: '' }; db.bookmarks.push(b); }
      b.note = ta.value.trim(); save(); closeDialog(); const el = $(`.vm[data-v="${v}"]`); el && el.classList.add('bm'); toast('Note saved');
    } }, 'Save note')));
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch (e) { const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); toast('Copied'); } catch (_) { toast('Copy is not available here'); } ta.remove(); }
}

/* mode switch */
$('#r-mode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
function setMode(m) {
  R.mode = m;
  $$('#r-mode button').forEach((b) => b.setAttribute('aria-selected', b.dataset.m === m));
  $('#dock-recite').hidden = m !== 'recite'; $('#dock-listen').hidden = m !== 'listen';
  $('#legend').hidden = m !== 'recite';
  if (m === 'listen') stopRecite(); else stopAudio();
}

/* ======================= RECITE SESSION ======================= */
function resetSession() {
  R.finals = []; R.partial = ''; R.manualWrong = new Set(); R.hints = new Set(); R.peeks = new Set();
  R.started = 0; R.elapsed = 0; R.prev = [];
  update(true);
}
let lastCur = -1;
function update(force) {
  if (!R.units) return;
  const rs = R.finals.concat(tokens(R.partial, false));
  const res = R.res = align(R.units, R.words.length, rs, R.manualWrong, R.hints);
  const any = rs.length > 0;
  for (let i = 0; i < R.els.length; i++) {
    let c = res.cls[i];
    if (!any && !P.hide) c = '';
    const revealed = /w-(done|hint|fixed|wrong|missed)/.test(c) || R.peeks.has(i);
    if (P.hide && !revealed) c += ' veil';
    c = 'w ' + c.trim();
    if (force || R.prev[i] !== c) { R.els[i].className = c; R.prev[i] = c; }
  }
  if (res.curW !== lastCur && res.curW >= 0 && R.listening) {
    const el = R.els[res.curW]; const r = el.getBoundingClientRect();
    if (r.top < 110 || r.bottom > innerHeight - 260) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  lastCur = res.curW;
  $('#prog').style.width = (R.words.length ? (res.doneWords / R.words.length) * 100 : 0) + '%';
  renderMeta();
  const heard = $('#heard'); heard.textContent = '';
  const said = R.finals.filter((t) => !t.manual).slice(-14).map((t) => t.norm).join(' ');
  if (said || R.partial) { heard.append(said + ' '); if (R.partial) heard.append(h('i', null, R.partial)); }
  else heard.append(h('span', { class: 'note' }, micNote()));
  $('#b-finish').disabled = !R.finals.length;
  $('#b-reveal').disabled = res.finished; $('#b-flag').disabled = res.finished;
  if (res.finished && rec && rec.active) { rec.stop(); toast('Passage complete. Press Finish to see your results.'); }
  setState();
}
function micNote() {
  if (speechSupport === 'none') return 'Voice recitation needs Chrome, Safari or the Android app. You can still test yourself with Memorize and Reveal word.';
  return `Tap the microphone and recite from verse ${R.from}. Tap a word marker to bookmark, play or share.`;
}
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const elapsed = () => R.elapsed + (R.listening && R.started ? Date.now() - R.started : 0);
function renderMeta() {
  const r = R.res; if (!r) return;
  $('#meta').textContent = `${r.doneWords}/${R.words.length} words · ${r.mistakes} mistake${r.mistakes === 1 ? '' : 's'} · ${fmt(elapsed())}`;
}
setInterval(() => { if (R.listening) renderMeta(); }, 1000);
function setState(s) {
  const st = s || (rec && rec.state) || 'idle';
  const on = st !== 'idle';
  const m = $('#mic'); m.classList.toggle('on', on); m.classList.toggle('off', speechSupport === 'none');
  m.setAttribute('aria-label', on ? 'Stop reciting' : 'Start reciting');
  $('#st').textContent = st === 'listening' ? 'Listening…' : st === 'starting' ? 'Starting…' : st === 'finishing' ? 'Finishing…' : (R.res && R.res.finished ? 'Passage complete' : R.finals.length ? 'Paused' : 'Ready');
}
$('#mic').addEventListener('click', async () => {
  if (speechSupport === 'none') { toast('Voice recitation is not supported in this browser. Try Chrome, Safari or the Android app.', 5000); return; }
  if (rec && rec.active) { stopRecite(); return; }
  if (R.res && R.res.finished) resetSession();
  rec = createRecognizer({
    lang: 'ar-SA',
    onPartial: (p) => { R.partial = p; update(); },
    onFinal: (f) => { R.finals.push(...tokens(f, true)); R.partial = ''; update(); },
    onState: (s) => {
      const was = R.listening; R.listening = s === 'listening';
      if (R.listening && !was) R.started = Date.now();
      if (!R.listening && was) { R.elapsed += Date.now() - R.started; R.started = 0; }
      setState(s);
    },
    onError: (e) => toast(e.message, 5000),
  });
  try {
    await rec.start();
    if (P.record && !isNative && !R.recorder) startVoiceRecording().then((r) => (R.recorder = r)).catch(() => {});
  } catch (e) { toast(e.message, 5000); }
});
function stopRecite() { if (rec && rec.active) rec.stop(); }
function reveal() {
  const r = R.res; if (!r || r.finished) return;
  const u = R.units[r.ptr]; R.hints.add(u.w);
  let p = r.ptr;
  while (p < R.units.length && R.units[p].w === u.w) { R.finals.push({ norm: R.units[p].norm, key: R.units[p].key, final: true, manual: true }); p++; }
  update();
}
$('#b-reveal').addEventListener('click', reveal);
$('#b-flag').addEventListener('click', () => { const r = R.res; if (!r || r.finished) return; R.manualWrong.add(r.ptr); update(); });
$('#b-reset').addEventListener('click', async () => { stopRecite(); if (R.recorder) { await R.recorder.stop(); R.recorder = null; } resetSession(); });
$('#b-finish').addEventListener('click', finish);
document.addEventListener('keydown', (e) => {
  if (screen !== 'read' || R.mode !== 'recite' || e.target.closest('input, textarea, select, dialog')) return;
  if (e.code === 'Space') { e.preventDefault(); reveal(); }
});

async function finish() {
  stopRecite();
  const res = align(R.units, R.words.length, R.finals, R.manualWrong, R.hints);
  const attempted = res.doneWords + res.list.filter((m) => m.kind === 'wrong' && !/w-fixed/.test(res.cls[m.i])).length;
  const acc = attempted ? Math.max(0, Math.round(((attempted - res.mistakes) / attempted) * 100)) : 0;
  // verses fully recited
  const verseDone = new Map();
  R.words.forEach((w, i) => { const ok = /w-(done|fixed|hint|missed)/.test(res.cls[i]); verseDone.set(w.v, (verseDone.get(w.v) ?? true) && ok); });
  const versesRecited = [...verseDone.values()].filter(Boolean).length;
  const ms = elapsed();
  const id = 'r' + Date.now();
  const session = {
    id, t: Date.now(), s: R.s, from: R.from, to: R.to, words: res.doneWords, total: R.words.length, mistakes: res.mistakes,
    hints: R.hints.size, acc, ms, voice: R.finals.some((t) => !t.manual), verses: versesRecited,
    mist: res.list.map((m) => ({ s: R.s, v: R.words[m.i].v, j: R.words[m.i].j, text: R.words[m.i].text, kind: m.kind })),
  };
  if (R.recorder) { try { const blob = await R.recorder.stop(); if (blob && blob.size) { await putRecording(id, blob); session.rec = true; } } catch (e) {} R.recorder = null; }
  db.history.unshift(session); if (db.history.length > 500) { db.history.pop(); }
  // khatm map
  if (db.goal.khatmDays && db.goal.khatmMap) {
    const arr = db.goal.khatmMap.split(''); let added = 0;
    verseDone.forEach((ok, v) => { if (ok) { const g = gIndex(R.s, v); if (arr[g] !== '1') { arr[g] = '1'; added++; } } });
    db.goal.khatmMap = arr.join('');
    const d = db.daily[today()] || (db.daily[today()] = { verses: 0, words: 0, ms: 0 }); d.khatm = (d.khatm || 0) + added;
  }
  logDaily(versesRecited, res.doneWords, ms);
  save();
  showSummary(session, res);
}
function showSummary(ses, res) {
  const g = goalProgress();
  const body = h('div', { class: 'dlg-body' },
    h('div', { class: 'stats' }, ...[['Accuracy', ses.acc + '%'], ['Words', `${ses.words}/${ses.total}`], ['Mistakes', ses.mistakes], ['Hints', ses.hints]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'val' }, String(v))))),
    h('div', { class: 'muted small' }, `${ses.verses} verse${ses.verses === 1 ? '' : 's'} recited in ${fmt(ses.ms)}. Today: ${g.have} of ${g.target} ${g.unit}.`));
  const items = ses.mist.map((m) => ({ ...m }));
  R.hints.forEach((i) => { if (!items.some((x) => x.v === R.words[i].v && x.j === R.words[i].j)) items.push({ s: R.s, v: R.words[i].v, j: R.words[i].j, text: R.words[i].text, kind: 'hint' }); });
  items.sort((a, b) => a.v - b.v || a.j - b.j);
  if (items.length) body.append(h('div', { class: 'small muted' }, 'Words to review'), mistakeList(items.slice(0, 80)));
  else body.append(h('p', { class: 'muted', style: 'margin:0' }, ses.words ? 'No mistakes and no hints. Excellent.' : 'Nothing was recited in this session.'));
  if (ses.rec) body.append(h('div', { class: 'small muted' }, 'Your recording is saved in Progress → Session history.'));
  body.append(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => { closeDialog(); resetSession(); } }, 'Recite again'),
    h('button', { class: 'btn accent', onclick: () => { closeDialog(); nextPassage(); } }, 'Next passage')));
  openDialog(`${Q[ses.s - 1][1]} ${ses.from}–${ses.to}`, body);
}
function mistakeList(items) {
  return h('ul', { class: 'mlist' }, items.map((m) => h('li', null,
    h('span', { class: 'tag ' + (m.kind === 'wrong' ? 'bad' : m.kind === 'missed' ? 'warn' : 'hint') }, m.kind === 'wrong' ? 'Wrong' : m.kind === 'missed' ? 'Skipped' : 'Hint'),
    h('button', { class: 'btn', style: 'padding:3px 8px', onclick: () => { closeDialog(); setMode('recite'); openVerse(m.s, m.v); } }, `${m.s}:${m.v}`),
    h('span', { class: 'ar', lang: 'ar' }, m.text))));
}

/* ======================= LISTEN (audio player) ======================= */
const audio = $('#audio');
const A = { v: 0, ayahLeft: 1, rangeLeft: 1, playing: false };
function fillReciters(sel) { sel.textContent = ''; RECITERS.forEach(([id, name]) => sel.append(h('option', { value: id, selected: id === P.reciter }, name))); }
fillReciters($('#p-reciter'));
$('#p-reciter').addEventListener('change', (e) => { P.reciter = e.target.value; save(); updatePlayerLabel(); if (A.playing) playFrom(A.v); });
$('#p-speed').value = String(P.speed);
$('#p-speed').addEventListener('change', (e) => { P.speed = +e.target.value; audio.playbackRate = P.speed; save(); });
$('#p-rep-a').value = String(P.repeatAyah); $('#p-rep-r').value = String(P.repeatRange);
$('#p-rep-a').addEventListener('change', (e) => { P.repeatAyah = +e.target.value; A.ayahLeft = P.repeatAyah || Infinity; save(); });
$('#p-rep-r').addEventListener('change', (e) => { P.repeatRange = +e.target.value; A.rangeLeft = P.repeatRange || Infinity; save(); });
function updatePlayerLabel() {
  const name = (RECITERS.find((r) => r[0] === P.reciter) || RECITERS[0])[1];
  $('#p-rec').textContent = name;
  $('#p-now').textContent = A.v ? `${Q[R.s - 1][1]} ${R.s}:${A.v}` : `${Q[R.s - 1][1]} from verse ${R.from}`;
}
function playFrom(v, keepRange) {
  if (inClaude) { toast('Reciter audio can’t play on this preview link. It plays in the Android app and the installed web app.', 6000); return; }
  A.v = Math.min(Math.max(v, R.from), R.to); A.ayahLeft = P.repeatAyah || Infinity;
  if (!keepRange) A.rangeLeft = P.repeatRange || Infinity;
  audio.src = audioUrl(P.reciter, R.s, A.v); audio.playbackRate = P.speed;
  audio.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); toast('Could not play audio. Check your internet connection.'); });
  highlightVerse();
}
function highlightVerse() {
  R.vEls.forEach((el) => el.classList.toggle('playing', +el.dataset.v === A.v && A.playing));
  const el = R.vEls[A.v - R.from];
  if (el && A.playing) { const r = el.getBoundingClientRect(); if (r.top < 110 || r.bottom > innerHeight - 260) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  updatePlayerLabel();
}
function setPlaying(p) {
  A.playing = p;
  $('#p-ico').innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  $('#p-play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  highlightVerse();
  if ('mediaSession' in navigator && Q) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: `${Q[R.s - 1][1]} ${R.s}:${A.v}`, artist: $('#p-rec').textContent, album: 'Tilawa' });
  }
}
let listenStart = 0;
audio.addEventListener('play', () => { listenStart = Date.now(); });
audio.addEventListener('pause', () => { if (listenStart) { logDaily(0, 0, Date.now() - listenStart); listenStart = 0; } });
audio.addEventListener('ended', () => {
  if (listenStart) { logDaily(0, 0, Date.now() - listenStart); listenStart = 0; }
  if (--A.ayahLeft > 0) { audio.currentTime = 0; audio.play(); return; }
  if (A.v < R.to) { playFrom(A.v + 1, true); return; }
  if (--A.rangeLeft > 0) { playFrom(R.from, true); return; }
  setPlaying(false); A.v = 0; highlightVerse();
});
audio.addEventListener('error', () => { if (A.playing) { setPlaying(false); toast('This recitation could not load. Try another reciter or check your connection.', 5000); } });
$('#p-play').addEventListener('click', () => {
  if (A.playing) { audio.pause(); setPlaying(false); }
  else if (A.v && audio.src) { audio.play().then(() => setPlaying(true)).catch(() => toast('Could not play audio.')); }
  else playFrom(R.from);
});
$('#p-fwd').addEventListener('click', () => playFrom(Math.min(R.to, (A.v || R.from) + 1), true));
$('#p-back').addEventListener('click', () => playFrom(Math.max(R.from, (A.v || R.from) - 1), true));
function stopAudio() { if (!audio.paused) audio.pause(); setPlaying(false); A.v = 0; }
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => $('#p-play').click());
  navigator.mediaSession.setActionHandler('pause', () => $('#p-play').click());
  navigator.mediaSession.setActionHandler('nexttrack', () => $('#p-fwd').click());
  navigator.mediaSession.setActionHandler('previoustrack', () => $('#p-back').click());
}

/* ======================= PROGRESS ======================= */
function renderProgress() {
  if (!Q) return;
  const H = db.history;
  const words = H.reduce((a, x) => a + x.words, 0);
  const avg = H.length ? Math.round(H.reduce((a, x) => a + x.acc, 0) / H.length) : null;
  const mins = Math.round(Object.values(db.daily).reduce((a, d) => a + (d.ms || 0), 0) / 60000);
  $('#p-stats').replaceChildren(...[['Day streak', streak()], ['Words recited', words.toLocaleString()], ['Avg accuracy', avg == null ? '—' : avg + '%'], ['Minutes', mins.toLocaleString()]]
    .map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'val' }, String(v)))));
  // chart
  const svg = $('#p-chart'); svg.textContent = '';
  const days = []; for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); days.push(d); }
  const metric = (d) => { const x = db.daily[today(d)] || {}; return db.goal.type === 'minutes' ? Math.round((x.ms || 0) / 60000) : db.goal.type === 'words' ? (x.words || 0) : (x.verses || 0); };
  const vals = days.map(metric); const goal = goalProgress().target;
  const max = Math.max(goal, ...vals, 1) * 1.1;
  const W = 340, Ht = 150, top = 8, bot = 20, bw = W / 14;
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (t, a) => { const e = document.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
  vals.forEach((v, i) => {
    const hh = ((Ht - top - bot) * v) / max;
    svg.append(mk('rect', { class: 'b' + (i === 13 ? ' today' : ''), x: i * bw + 4, y: Ht - bot - hh, width: bw - 8, height: Math.max(hh, v ? 2 : 0), rx: 3 }));
    const lab = mk('text', { x: i * bw + bw / 2, y: Ht - 6, 'text-anchor': 'middle' }); lab.textContent = days[i].getDate(); svg.append(lab);
  });
  const gy = Ht - bot - ((Ht - top - bot) * goal) / max;
  svg.append(mk('line', { class: 'goal', x1: 0, x2: W, y1: gy, y2: gy }));
  const gl = mk('text', { x: W - 2, y: gy - 4, 'text-anchor': 'end' }); gl.textContent = `goal ${goal} ${db.goal.type}`; svg.append(gl);
  // goals form
  $('#g-type').value = db.goal.type; $('#g-daily').value = db.goal.daily; $('#g-khatm').value = String(db.goal.khatmDays || 0);
  $('#g-note').textContent = db.goal.khatmDays ? `Khatm plan started ${new Date(db.goal.khatmStart).toLocaleDateString()}. ${khatmDone()} of ${TOTAL_VERSES} verses recited so far. Your daily verse goal rises to keep you on schedule.` : 'Choose a khatm plan to get a daily target that finishes the whole Qur’an on time.';
  // weak words
  const weak = new Map();
  H.forEach((x) => (x.mist || []).forEach((m) => { const k = `${m.s}:${m.v}:${m.j}`; const o = weak.get(k) || { ...m, n: 0 }; o.n++; weak.set(k, o); }));
  const top10 = [...weak.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  const wbox = $('#p-weak'); wbox.textContent = '';
  if (!top10.length) wbox.append(h('div', { class: 'empty' }, 'Words you get wrong or skip will collect here so you can practise them.'));
  else {
    wbox.append(h('ul', { class: 'mlist' }, top10.map((m) => h('li', null,
      h('span', { class: 'tag bad' }, `${m.n}×`),
      h('button', { class: 'btn', style: 'padding:3px 8px', onclick: () => { setMode('recite'); openVerse(m.s, m.v); } }, `${Q[m.s - 1][1]} ${m.s}:${m.v}`),
      h('span', { class: 'ar', lang: 'ar' }, m.text)))));
    wbox.append(h('button', { class: 'btn accent', style: 'margin-top:8px;width:100%', onclick: practiceWeak }, 'Practise these verses'));
  }
  // grid
  const best = {}; H.forEach((x) => { if (x.words) best[x.s] = Math.max(best[x.s] ?? 0, x.acc); });
  $('#p-grid').replaceChildren(...Q.map((s, i) => {
    const a = best[i + 1];
    return h('button', { class: a == null ? '' : a >= 95 ? 'a4' : a >= 85 ? 'a3' : a >= 70 ? 'a2' : 'a1', title: `${s[1]}${a != null ? ` · best ${a}%` : ''}`, onclick: () => openPassage(i + 1) }, String(i + 1));
  }));
  // history
  const ul = $('#p-hist'); ul.textContent = '';
  if (!H.length) { ul.append(h('li', { class: 'empty', style: 'display:block' }, 'No sessions yet. Recite a passage and press Finish.')); return; }
  H.slice(0, 40).forEach((x) => {
    const li = h('li', null,
      h('div', null, h('b', null, `${Q[x.s - 1][1]} ${x.from}–${x.to}`),
        h('div', { class: 'ref' }, `${new Date(x.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${x.words}/${x.total} words · ${x.mistakes} mistakes · ${x.hints} hints · ${fmt(x.ms)}`)),
      h('span', { class: 'acc' }, x.acc + '%'));
    const acts = h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => { setMode('recite'); openPassage(x.s, x.from, x.to); } }, 'Recite again'),
      x.mist && x.mist.length ? h('button', { class: 'btn', onclick: () => openDialog('Mistakes', h('div', { class: 'dlg-body' }, mistakeList(x.mist))) }, `Mistakes (${x.mist.length})`) : null,
      x.rec ? h('button', { class: 'btn', onclick: async (e) => {
        const blob = await getRecording(x.id).catch(() => null);
        if (!blob) { toast('Recording not found on this device.'); return; }
        const au = h('audio', { controls: true, src: URL.createObjectURL(blob) }); e.target.replaceWith(au); au.play().catch(() => {});
      } }, 'Play my recitation') : null,
      h('button', { class: 'btn danger', onclick: async () => { db.history = db.history.filter((y) => y.id !== x.id); save(); if (x.rec) await deleteRecording(x.id); renderProgress(); } }, 'Delete'));
    li.append(acts); ul.append(li);
  });
}
function practiceWeak() {
  const H = db.history; const weak = new Map();
  H.forEach((x) => (x.mist || []).forEach((m) => { const k = `${m.s}:${m.v}`; weak.set(k, (weak.get(k) || 0) + 1); }));
  const top = [...weak.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return;
  const [s, v] = top[0].split(':').map(Number);
  setMode('recite'); P.hide = true; save(); applyPrefs(); openPassage(s, v, v);
  toast('Memorize mode is on. Recite this verse from memory.');
}
$('#g-type').addEventListener('change', (e) => { db.goal.type = e.target.value; db.goal.daily = { verses: 10, minutes: 15, words: 150 }[db.goal.type]; save(); renderProgress(); });
$('#g-daily').addEventListener('change', (e) => { db.goal.daily = Math.max(1, +e.target.value || 1); save(); renderProgress(); });
$('#g-khatm').addEventListener('change', (e) => {
  const d = +e.target.value;
  db.goal.khatmDays = d; db.goal.khatmStart = Date.now(); db.goal.khatmMap = d ? '0'.repeat(TOTAL_VERSES) : '';
  if (d) db.goal.type = 'verses';
  save(); renderProgress(); toast(d ? `Khatm plan set: about ${Math.ceil(TOTAL_VERSES / d)} verses a day.` : 'Khatm plan removed');
});

/* ======================= SETTINGS ======================= */
function renderSettings() {
  $('#s-theme').value = P.theme;
  const lang = $('#s-lang'); lang.textContent = ''; LANGS.forEach(([c, n]) => lang.append(h('option', { value: c, selected: c === P.trLang }, n)));
  fillReciters($('#s-reciter'));
  $('#s-record').checked = !!P.record; $('#s-record').disabled = isNative;
  $('#s-reminder').value = P.reminder || '';
  $('#s-rem-note').textContent = plugin('LocalNotifications') ? 'A notification at this time each day.' : 'Daily notifications work in the Android app. Here, add the page to your home screen and set a phone alarm.';
  $('#s-ver').textContent = `Version ${VERSION} · ${isNative ? 'Android app' : 'Web app'} · voice: ${speechSupport}`;
}
$('#s-theme').addEventListener('change', (e) => { P.theme = e.target.value; save(); applyTheme(); });
$('#s-lang').addEventListener('change', (e) => { P.trLang = e.target.value; save(); });
$('#s-reciter').addEventListener('change', (e) => { P.reciter = e.target.value; $('#p-reciter').value = P.reciter; save(); });
$('#s-record').addEventListener('change', (e) => { P.record = e.target.checked; save(); });
$('#s-reminder').addEventListener('change', async (e) => { P.reminder = e.target.value; save(); await scheduleReminder(); });
$('#s-export').addEventListener('click', () => copy(exportJSON()));
$('#s-import').addEventListener('click', () => {
  const ta = h('textarea', { rows: 6, id: 'imp', placeholder: 'Paste the backup text here' });
  const err = h('div', { class: 'small', style: 'color:var(--bad)' });
  openDialog('Restore backup', h('div', { class: 'dlg-body' }, h('div', { class: 'field' }, h('label', { for: 'imp' }, 'This replaces the data on this device.'), ta), err,
    h('button', { class: 'btn accent', onclick: () => { try { importJSON(ta.value); closeDialog(); toast('Backup restored'); applyTheme(); applyPrefs(); renderSettings(); } catch (x) { err.textContent = x.message || 'That backup could not be read.'; } } }, 'Restore')));
});
$('#s-wipe').addEventListener('click', () => {
  openDialog('Erase all data?', h('div', { class: 'dlg-body' }, h('p', { style: 'margin:0' }, 'This deletes your history, goals, bookmarks and settings on this device. It cannot be undone.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'btn danger', onclick: () => { try { localStorage.clear(); indexedDB.deleteDatabase('tilawa'); } catch (e) {} location.reload(); } }, 'Erase everything'))));
});
async function scheduleReminder() {
  const LN = plugin('LocalNotifications'); if (!LN) return;
  try {
    await LN.cancel({ notifications: [{ id: 1 }] }).catch(() => {});
    if (!P.reminder) { toast('Reminder off'); return; }
    const perm = await LN.requestPermissions();
    if (perm.display !== 'granted') { toast('Notifications are turned off for Tilawa in your phone settings.'); return; }
    const [hh, mm] = P.reminder.split(':').map(Number);
    await LN.schedule({ notifications: [{ id: 1, title: 'Time for your recitation', body: 'Keep your streak going. A few verses today.', schedule: { on: { hour: hh, minute: mm }, repeats: true, allowWhileIdle: true } }] });
    toast(`Reminder set for ${P.reminder} every day`);
  } catch (e) { toast('Could not set the reminder.'); }
}

/* ======================= BOOT ======================= */
applyPrefs();
speechReady.then(() => { if (R.units && R.units.length) update(); });
fetch('data/quran.json').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((data) => {
  Q = data; OFFS = []; let o = 0; Q.forEach((s) => { OFFS.push(o); o += s[4].length; });
  R.s = P.s; R.from = P.from; R.to = P.to;
  renderHome();
}).catch(() => { $('#h-list').replaceChildren(h('li', { class: 'empty' }, 'The Qur’an text could not load. Close and reopen the app.')); });

if ('serviceWorker' in navigator && !isNative && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
