import { normalize, tokens, buildUnits, align, findVerses } from './match.js';
import { createRecognizer, speechSupport, speechReady, inClaude, isNative, startVoiceRecording } from './speech.js';
import { db, save, today, logDaily, streak, exportJSON, importJSON, putRecording, getRecording, deleteRecording } from './store.js';
import { JUZ, juzOf, RECITERS, audioUrl, LANGS, TOTAL_VERSES, toAr, BASMALA } from './meta.js';

const VERSION = '1.4.0';
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
  if (screen === 'home' && finder && finder.active) finder.stop();
  screen = name;
  $$('.screen').forEach((s) => (s.hidden = s.dataset.screen !== name));
  $('#dock').hidden = name !== 'read';
  $$('.nav button').forEach((b) => { if (b.dataset.go === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  if (name === 'home') renderHome();
  if (name === 'progress') renderProgress();
  if (name === 'settings') renderSettings();
  if (name === 'read' && !R.words.length && Q) { if (P.page) openPage(P.page); else if (P.s) openPassage(P.s, P.from, P.to); else openPage(1); }
  window.scrollTo({ top: 0 });
  if (name === 'read') requestAnimationFrame(fitPage);
}
$$('.nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
const AppP = plugin('App');
// Leaving the app: release the microphone so nothing keeps running in the background.
function pauseVoice() { stopRecite(); if (finder && finder.active) finder.stop(); }
function resumeUi() { setState(); fitPage(); if (screen === 'home') renderHome(); }
document.addEventListener('visibilitychange', () => (document.hidden ? pauseVoice() : resumeUi()));
if (AppP) { AppP.addListener('pause', pauseVoice); AppP.addListener('resume', resumeUi); }
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
function nextKhatmVerse() { const m = db.goal.khatmMap || ''; if (!m) return 0; const i = m.indexOf('0'); return i < 0 ? -1 : i; }

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
  const hp = $('#h-plans'); hp.textContent = '';
  db.plans.filter((p) => !planStats(p).complete).slice(0, 3).forEach((p) => hp.append(planCard(p, true)));
  $('#h-test-s').textContent = db.memo.surahs.length ? `Random places from your ${db.memo.surahs.length} memorized surah${db.memo.surahs.length === 1 ? '' : 's'}` : 'Recite from a random place in what you’ve memorized';
  renderHomeList();
}
$('#h-continue').addEventListener('click', () => {
  const lr = db.lastRead;
  if (lr) openVerse(lr.s, lr.v); else openPage(1);
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
      ul.append(v && +m[2] <= Q[s - 1][4].length ? verseItem(s, v) : v ? h('li', { class: 'empty' }, `${Q[s - 1][1]} has ${Q[s - 1][4].length} verses.`) : surahItem(s));
    } else ul.append(h('li', { class: 'empty' }, 'There are 114 surahs. Type a number from 1 to 114, or a reference like 2:255.'));
    return;
  }
  const ql = q.toLowerCase();
  Q.forEach((s, i) => { if (s[1].toLowerCase().replace(/[-']/g, '').includes(ql.replace(/[-']/g, '')) || s[2].toLowerCase().includes(ql) || normalize(s[0]).includes(normalize(q) || '\u0000')) ul.append(surahItem(i + 1)); });
  if (/[؀-ۿ]/.test(q)) {
    findVerses(QS || Q, q, 20).forEach((r) => ul.append(verseItem(r.s, r.v)));
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
  const res = findVerses(QS || Q, text, 6);
  ul.textContent = '';
  res.forEach((r) => ul.append(verseItem(r.s, r.v, null, () => { finder && finder.stop(); openVerse(r.s, r.v); })));
  if (res.length && res[0].score >= 9 && finder && finder.active) finder.stop();
}

/* ======================= READER ======================= */
// A passage is either one Mushaf page (R.page > 0) or a custom verse range in one surah (R.page = 0).
const R = { page: 1, s: 1, from: 1, to: 7, verses: [], words: [], units: [], els: [], vEls: [], finals: [], partial: '', manualWrong: new Set(), hints: new Set(), peeks: new Set(), res: null, prev: [], started: 0, elapsed: 0, listening: false, mode: 'recite', recorder: null };
let rec = null;
let PAGES = [];   // [surah, verse] where each Madinah Mushaf page starts
function pageOf(s, v) {
  const g = gIndex(s, v); let lo = 0, hi = PAGES.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (gIndex(PAGES[mid][0], PAGES[mid][1]) <= g) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
function pageVerses(p) {
  const a = gIndex(...PAGES[p - 1]); const b = p < PAGES.length ? gIndex(...PAGES[p]) : TOTAL_VERSES;
  const out = []; for (let g = a; g < b; g++) { const { s, v } = fromGlobal(g); out.push([s, v]); } return out;
}

function openVerse(s, v) { openPage(pageOf(s, v), s, v); }
function openPage(p, fs, fv) {
  p = Math.min(Math.max(1, p | 0), PAGES.length);
  R.page = p; R.verses = pageVerses(p);
  [R.s, R.from] = R.verses[0]; R.to = R.verses.filter((x) => x[0] === R.s).pop()[1];
  P.page = p; P.s = R.s; P.from = R.from; P.to = R.to; save();
  showPassage(fs, fv);
}
function openPassage(s, from, to, focus) {
  if (from == null && to == null) return openVerse(s, 1);
  const N = Q[s - 1][4].length;
  R.page = 0; R.s = s; R.from = Math.min(Math.max(1, from || 1), N); R.to = Math.min(Math.max(R.from, to || N), N);
  if (R.to - R.from > 300) R.to = R.from + 299;
  R.verses = []; for (let v = R.from; v <= R.to; v++) R.verses.push([s, v]);
  P.page = 0; P.s = R.s; P.from = R.from; P.to = R.to; save();
  showPassage(s, focus);
}
let keepMic = false;
function showPassage(fs, fv) {
  if (screen !== 'read') go('read');
  if (!keepMic) stopRecite();
  stopAudio();
  renderPassage().then(() => {
    if (fv && R.page === 0 && fv > R.from) { const el = R.vEls.find((x) => +x.dataset.s === fs && +x.dataset.v === fv); el && el.scrollIntoView({ block: 'center' }); }
    else window.scrollTo({ top: 0 });
  });
  const [ls, lv] = fv ? [fs, fv] : R.verses[0];
  db.lastRead = { s: ls, v: lv, t: Date.now() }; save();
}
function surahHeader(s) {
  const sur = Q[s - 1];
  return h('div', { class: 'sh' },
    h('div', { class: 'cartouche' }, h('div', { class: 'ar' }, 'سورة ' + sur[0]), h('div', { class: 'en' }, `${sur[2]} · ${sur[4].length} verses`)),
    s !== 1 && s !== 9 ? h('div', { class: 'basmala' }, BASMALA) : null);
}
async function renderPassage() {
  const first = R.verses[0], last = R.verses[R.verses.length - 1];
  const sur = Q[first[0] - 1];
  const surahsHere = [...new Set(R.verses.map((x) => x[0]))];
  $('#r-name').textContent = surahsHere.map((s) => Q[s - 1][1]).join(' · ');
  $('#r-sub').textContent = R.page ? `Page ${R.page} of ${PAGES.length} · Juz ${juzOf(...first)}` : `Verses ${R.from}–${R.to} of ${sur[4].length} · Juz ${juzOf(...first)}`;
  $('#pg-surah').textContent = surahsHere.map((s) => 'سورة ' + Q[s - 1][0]).join(' · ');
  $('#pg-juz').textContent = 'الجزء ' + toAr(juzOf(...first));
  $('#pg-num').textContent = R.page ? toAr(R.page) : `${toAr(R.from)}–${toAr(R.to)}`;
  $('#r-prev').disabled = R.page ? R.page === 1 : (R.s === 1 && R.from === 1);
  $('#r-next').disabled = R.page ? R.page === PAGES.length : (R.s === 114 && R.to === Q[113][4].length);
  $('#t-range').textContent = R.page ? 'Verse range' : 'Back to pages';
  const tr = P.tr ? await getTr(P.trLang).catch(() => null) : null;
  const tl = P.translit ? await getTr('translit').catch(() => null) : null;
  const box = $('#mushaf'); box.textContent = '';
  box.classList.toggle('stacked', !!(P.tr || P.translit));
  box.classList.toggle('jl', R.page > 2);
  R.words = []; R.vEls = [];
  const bm = new Set(db.bookmarks.map((b) => b.s + ':' + b.v));
  const frag = document.createDocumentFragment();
  const lineMode = !!(R.page && !P.tr && !P.translit && LINES);
  box.classList.toggle('lines', lineMode);
  box.classList.toggle('opening', lineMode && R.page <= 2);
  if (lineMode) renderLines(frag, bm);
  else for (const [s, v] of R.verses) {
    if (v === 1) frag.append(surahHeader(s));
    const vEl = h('div', { class: 'v', 'data-s': s, 'data-v': v });
    const ay = h('span', { class: 'ayah' });
    Q[s - 1][4][v - 1].forEach((t, j) => {
      const i = R.words.length; R.words.push({ text: t, s, v, j, plain: QI ? QI[s - 1][v - 1][j] : '' });
      ay.append(h('span', { class: 'w', 'data-i': i }, t), ' ');
    });
    ay.append(h('button', { class: 'vm' + (bm.has(s + ':' + v) ? ' bm' : ''), 'data-s': s, 'data-v': v, 'aria-label': `Verse ${s}:${v} options` }, toAr(v)), ' ');
    vEl.append(ay);
    if (tl) vEl.append(h('div', { class: 'tl', lang: 'en' }, tl[s - 1][v - 1]));
    if (tr) vEl.append(h('div', { class: 'tr', dir: P.trLang === 'ur' ? 'rtl' : null }, h('b', null, `${s}:${v}`), tr[s - 1][v - 1]));
    frag.append(vEl); R.vEls.push(vEl);
  }
  box.append(frag);
  R.els = $$('.w', box);
  R.units = buildUnits(R.words);
  resetSession();
  updatePlayerLabel();
  fitPage();
}

/* Draw a Mushaf page exactly as printed: the same 15 lines, with the surah headers and basmala in their place. */
function renderLines(frag, bm) {
  const p = R.page, L = LINES;
  const b = p < L.page.length ? L.page[p] : WORDS.total;
  let li = WORDS.pageLine[p - 1];
  for (; li < L.line.length && L.line[li] < b; li++) {
    const ws = L.line[li], we = Math.min(li + 1 < L.line.length ? L.line[li + 1] : WORDS.total, b);
    if (WORDS.surahStart.has(ws)) {
      const s = WORDS.s[ws];
      frag.append(h('div', { class: 'row sh-row' }, h('div', { class: 'cartouche' }, h('span', { class: 'ar' }, 'سُورَةُ ' + Q[s - 1][0]))));
      if (s !== 1 && s !== 9) frag.append(h('div', { class: 'row bas-row' }, BASMALA));
    }
    const ln = h('div', { class: 'row ln' });
    for (let g = ws; g < we; g++) {
      const s = WORDS.s[g], v = WORDS.v[g], j = WORDS.j[g];
      const i = R.words.length;
      R.words.push({ text: Q[s - 1][4][v - 1][j], s, v, j, plain: QI ? QI[s - 1][v - 1][j] : '' });
      ln.append(h('span', { class: 'w', 'data-i': i }, Q[s - 1][4][v - 1][j]));
      if (WORDS.ayahEnd.has(g)) ln.append(h('button', { class: 'vm' + (bm.has(s + ':' + v) ? ' bm' : ''), 'data-s': s, 'data-v': v, 'aria-label': `Verse ${s}:${v} options` }, toAr(v)));
    }
    frag.append(ln);
  }
}
function fitLines(box, availW, availH) {
  const rowEls = $$('.row', box); if (!rowEls.length) return;
  const root = document.documentElement;
  root.style.setProperty('--qsize', '20px');
  box.classList.add('measuring');
  const widths = $$('.ln', box).map((ln) => { let w = 0; for (const c of ln.children) w += c.getBoundingClientRect().width; return { ln, w: w + (ln.children.length - 1) * 6.6 }; });
  box.classList.remove('measuring');
  const maxW = Math.max(...widths.map((x) => x.w), 1);
  const opening = box.classList.contains('opening');
  widths.forEach(({ ln, w }) => ln.classList.toggle('short', opening || w < maxW * 0.8));
  const fw = (20 * availW) / maxW;
  const fh = availH / (rowEls.length * 1.9);
  const f = Math.max(12, Math.min(fw, fh, opening ? 34 : 40));
  root.style.setProperty('--qsize', Math.floor(f * 10) / 10 + 'px');
}

/* Fit the page's text to the screen, like a printed Mushaf page. */
function fitPage() {
  const box = $('#mushaf');
  const stacked = box.classList.contains('stacked');
  if (!P.fit || stacked || screen !== 'read') { document.documentElement.style.setProperty('--qsize', P.size + 'px'); return; }
  const page = $('#page');
  const top = page.getBoundingClientRect().top + window.scrollY;
  const dock = $('#dock').getBoundingClientRect();
  if (dock.height) document.documentElement.style.setProperty('--dock-h', Math.ceil(dock.height) + 'px');
  const bottom = (dock.height ? dock.top : innerHeight) + window.scrollY - 10;
  const chrome = page.offsetHeight - box.offsetHeight;
  const avail = bottom - top - chrome;
  if (avail < 150) { document.documentElement.style.setProperty('--qsize', P.size + 'px'); return; }
  if (box.classList.contains('lines')) { fitLines(box, box.clientWidth - 4, avail - 8); return; }
  let lo = 13, hi = 44;
  for (let k = 0; k < 9; k++) {
    const mid = (lo + hi) / 2;
    document.documentElement.style.setProperty('--qsize', mid + 'px');
    if (box.scrollHeight <= avail) lo = mid; else hi = mid;
  }
  document.documentElement.style.setProperty('--qsize', Math.floor(lo * 10) / 10 + 'px');
}
let fitT = 0;
addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitPage, 150); });
document.fonts && document.fonts.ready.then(() => fitPage());

function nextPassage() {
  if (R.page) { if (R.page < PAGES.length) openPage(R.page + 1); return; }
  const N = Q[R.s - 1][4].length, len = R.to - R.from + 1;
  if (R.to < N) openPassage(R.s, R.to + 1, Math.min(N, R.to + len));
  else if (R.s < 114) openVerse(R.s + 1, 1);
}
function prevPassage() {
  if (R.page) { if (R.page > 1) openPage(R.page - 1); return; }
  const len = R.to - R.from + 1;
  if (R.from > 1) openPassage(R.s, Math.max(1, R.from - len), R.from - 1);
  else if (R.s > 1) openVerse(R.s - 1, Q[R.s - 2][4].length);
}
$('#r-prev').addEventListener('click', () => turn(-1));
$('#r-next').addEventListener('click', () => turn(1));
// Swipe like turning Mushaf pages: swipe right for the next page, left for the previous one.
let sx = 0, sy = 0, st = 0;
$('#page').addEventListener('touchstart', (e) => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; st = Date.now(); }, { passive: true });
$('#page').addEventListener('touchend', (e) => {
  const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
  if (Date.now() - st > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  turn(dx > 0 ? 1 : -1); return;
  if (dx > 0) nextPassage(); else prevPassage();
}, { passive: true });

$('#r-title').addEventListener('click', () => {
  const inp = h('input', { type: 'search', placeholder: 'Search surah, or a page number', style: 'margin:12px 12px 0;width:calc(100% - 24px);padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--paper)' });
  const ul = h('ul', { class: 'list', style: 'margin:12px;border-radius:12px' });
  const fill = () => {
    const q = inp.value.trim().toLowerCase(); ul.textContent = '';
    if (/^\d+$/.test(q) && +q >= 1 && +q <= PAGES.length) ul.append(h('li', null, h('button', { class: 'item', onclick: () => { closeDialog(); openPage(+q); } }, h('span', { class: 'n' }, q), h('span', { class: 'nm' }, h('b', null, `Page ${q}`), h('small', null, Q[PAGES[+q - 1][0] - 1][1])), h('span'))));
    Q.forEach((s, i) => { if (!q || String(i + 1) === q || s[1].toLowerCase().includes(q) || s[2].toLowerCase().includes(q)) ul.append(surahItem(i + 1, null, () => { closeDialog(); openVerse(i + 1, 1); })); });
  };
  inp.addEventListener('input', fill); fill();
  openDialog('Go to', h('div', null, inp, ul));
});
$('#t-range').addEventListener('click', () => {
  if (!R.page) { openVerse(R.s, R.from); return; }
  const s = R.s, N = Q[s - 1][4].length;
  const f = h('input', { type: 'number', min: 1, max: N, value: R.from, inputmode: 'numeric', id: 'rg-from' });
  const t = h('input', { type: 'number', min: 1, max: N, value: R.to, inputmode: 'numeric', id: 'rg-to' });
  openDialog(`Verse range · ${Q[s - 1][1]}`, h('div', { class: 'dlg-body' },
    h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { for: 'rg-from' }, 'From verse'), f), h('div', { class: 'field' }, h('label', { for: 'rg-to' }, `To verse (max ${N})`), t)),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { closeDialog(); openPassage(s, 1, N); } }, 'Whole surah'),
      h('button', { class: 'btn accent', onclick: () => { closeDialog(); openPassage(s, +f.value, +t.value); } }, 'Apply'))));
});

/* display options sheet */
function applyPrefs() {
  if (!P.fit) document.documentElement.style.setProperty('--qsize', P.size + 'px');
  $('#t-hide').setAttribute('aria-pressed', !!P.hide);
}
function pills(values, current, label, onPick) {
  const wrap = h('div', { class: 'pills' });
  values.forEach(([val, text]) => wrap.append(h('button', { 'aria-pressed': String(val === current), onclick: (e) => {
    $$('button', wrap).forEach((b) => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true'); onPick(val);
  } }, text)));
  return h('div', { class: 'opt-group' }, h('div', { class: 'lbl' }, label), wrap);
}
$('#r-view').addEventListener('click', () => {
  const size = h('input', { type: 'range', min: 18, max: 56, step: 1, value: P.size, id: 'v-size', disabled: P.fit && !P.tr && !P.translit ? true : null });
  size.addEventListener('input', () => { P.size = +size.value; save(); document.documentElement.style.setProperty('--qsize', P.size + 'px'); });
  const lang = h('select', { id: 'v-lang' }); LANGS.forEach(([c, n]) => lang.append(h('option', { value: c, selected: c === P.trLang }, n)));
  lang.addEventListener('change', () => { P.trLang = lang.value; save(); if (P.tr) keepState(renderPassage); });
  const body = h('div', { class: 'dlg-body' },
    pills([[true, 'Fit the page'], [false, 'Choose size']], !!P.fit, 'Text size', (v) => { P.fit = v; save(); size.disabled = v && !P.tr && !P.translit; fitPage(); }),
    h('div', { class: 'range-row' }, h('span', { class: 'small muted' }, 'A'), size, h('span', { style: 'font-size:20px' }, 'A')),
    pills([[false, 'Mushaf page'], [true, 'With translation']], !!P.tr, 'Layout', (v) => { P.tr = v; save(); keepState(renderPassage); size.disabled = P.fit && !P.tr && !P.translit; }),
    h('div', { class: 'field' }, h('label', { for: 'v-lang' }, 'Translation language'), lang),
    pills([[false, 'Off'], [true, 'On']], !!P.translit, 'Transliteration', (v) => { P.translit = v; save(); keepState(renderPassage); }));
  dlg.classList.add('sheet-dlg'); openDialog('Display', body);
});
dlg.addEventListener('close', () => dlg.classList.remove('sheet-dlg'));
$('#t-hide').addEventListener('click', () => { P.hide = !P.hide; R.peeks.clear(); save(); applyPrefs(); update(true); });
async function keepState(fn) {
  const keep = { finals: R.finals, manualWrong: R.manualWrong, hints: R.hints, elapsed: R.elapsed };
  await fn(); Object.assign(R, keep); update(true);
}

/* verse actions */
$('#mushaf').addEventListener('click', (e) => {
  const vm = e.target.closest('.vm');
  if (vm) return verseMenu(+vm.dataset.s, +vm.dataset.v);
  const w = e.target.closest('.w');
  if (w && w.classList.contains('veil')) { const i = +w.dataset.i; R.peeks.add(i); R.hints.add(i); update(); }
});
function verseMenu(s, v) {
  const bi = db.bookmarks.findIndex((b) => b.s === s && b.v === v);
  const txt = verseText(s, v);
  const item = (label, fn) => h('li', null, h('button', { onclick: () => { closeDialog(); fn(); } }, label));
  dlg.classList.add('sheet-dlg');
  openDialog(`${Q[s - 1][1]} ${s}:${v}`, h('ul', { class: 'menu' },
    item('Play from this verse', () => { setMode('listen'); playFrom(s, v); }),
    item('Recite from this verse', () => { setMode('recite'); openPassage(s, v, Math.min(Q[s - 1][4].length, v + 9)); }),
    item(bi >= 0 ? 'Remove bookmark' : 'Bookmark', () => toggleBookmark(s, v)),
    item(bi >= 0 && db.bookmarks[bi].note ? 'Edit note' : 'Add a note', () => editNote(s, v)),
    item('Copy verse', () => copy(`${txt}\n— ${Q[s - 1][1]} ${s}:${v}`)),
    navigator.share ? item('Share', () => navigator.share({ text: `${txt}\n— Qur’an ${s}:${v}` }).catch(() => {})) : null));
}
const vmEl = (s, v) => $(`.vm[data-s="${s}"][data-v="${v}"]`);
function toggleBookmark(s, v) {
  const i = db.bookmarks.findIndex((b) => b.s === s && b.v === v);
  if (i >= 0) db.bookmarks.splice(i, 1); else db.bookmarks.push({ s, v, t: Date.now(), note: '' });
  save(); const el = vmEl(s, v); el && el.classList.toggle('bm', i < 0);
  toast(i >= 0 ? 'Bookmark removed' : 'Bookmarked');
}
function editNote(s, v) {
  let b = db.bookmarks.find((x) => x.s === s && x.v === v);
  const ta = h('textarea', { rows: 4, id: 'note-ta' }); ta.value = b ? b.note : '';
  openDialog(`Note on ${s}:${v}`, h('div', { class: 'dlg-body' }, h('div', { class: 'field' }, h('label', { for: 'note-ta' }, 'Your note (saves a bookmark too)'), ta),
    h('button', { class: 'btn accent', onclick: () => {
      if (!b) { b = { s, v, t: Date.now(), note: '' }; db.bookmarks.push(b); }
      b.note = ta.value.trim(); save(); closeDialog(); const el = vmEl(s, v); el && el.classList.add('bm'); toast('Note saved');
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
  if (m === 'listen') stopRecite(); else stopAudio();
  requestAnimationFrame(fitPage);
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
  const res = R.res = align(R.units, R.words.length, rs, R.manualWrong, R.hints, { free: !T });
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
  $('#b-reveal').disabled = res.finished;
  if (res.finished && rec && rec.active && !autoTurning && T) { autoTurning = true; setTimeout(() => { nextQuestion().finally(() => { autoTurning = false; }); }, 900); }
  else if (res.finished && rec && rec.active && !autoTurning) {
    if (R.page && R.page < PAGES.length) { autoTurning = true; setTimeout(() => { turn(1).finally(() => { autoTurning = false; }); }, 700); }
    else { rec.stop(); toast('Passage complete. Press Finish to see your results.'); }
  }
  setState();
}
function micNote() {
  if (speechSupport === 'none') return 'Voice recitation needs Chrome, Safari or the Android app. You can still test yourself with Memorize and Reveal word.';
  const [s, v] = R.verses[0] || [R.s, R.from];
  return `Tap the mic and recite from ${s}:${v}`;
}
const fmt = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const elapsed = () => R.elapsed + (R.listening && R.started ? Date.now() - R.started : 0);
function renderMeta() {
  const r = R.res; if (!r) return;
  $('#meta').textContent = `${r.doneWords}/${R.words.length} · ${r.mistakes} ✗`;
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
function markMistake() { const r = R.res; if (!r || r.finished) return; R.manualWrong.add(r.ptr); update(); }
async function restartRecite() { stopRecite(); if (R.recorder) { await R.recorder.stop(); R.recorder = null; } resetSession(); }
$('#b-more').addEventListener('click', () => {
  const item = (label, fn, dis) => h('li', null, h('button', { disabled: dis || null, onclick: () => { closeDialog(); fn(); } }, label));
  const done = R.res && R.res.finished;
  dlg.classList.add('sheet-dlg');
  openDialog('Recitation', h('div', null, h('ul', { class: 'menu' },
    item('Reveal the next word', reveal, done),
    item('Mark the current word as a mistake', markMistake, done),
    item('Restart this page', restartRecite),
    item(P.hide ? 'Show the words (Memorize off)' : 'Hide the words (Memorize on)', () => $('#t-hide').click())),
    h('div', { class: 'legend', style: 'padding:4px 16px 16px' },
      h('span', null, h('i', { style: 'background:var(--ok)' }), 'Recited'), h('span', null, h('i', { style: 'background:var(--bad)' }), 'Wrong word'),
      h('span', null, h('i', { style: 'background:var(--warn)' }), 'Skipped'), h('span', null, h('i', { style: 'background:var(--gold)' }), 'Hint'))));
});
$('#b-finish').addEventListener('click', () => (T ? nextQuestion() : finish()));
document.addEventListener('keydown', (e) => {
  if (screen !== 'read' || R.mode !== 'recite' || e.target.closest('input, textarea, select, dialog')) return;
  if (e.code === 'Space') { e.preventDefault(); reveal(); }
});

// Turn the page; a recitation in progress is saved first, and the microphone keeps listening on the new page.
let autoTurning = false;
async function turn(dir) {
  const listening = !!(rec && rec.active);
  if (R.finals.length) await finish({ silent: true });
  keepMic = listening;
  try { if (dir > 0) nextPassage(); else prevPassage(); } finally { keepMic = false; }
}
async function finish(opts = {}) {
  if (!opts.silent) stopRecite();
  const res = align(R.units, R.words.length, R.finals, R.manualWrong, R.hints, { free: !T });
  const attempted = res.doneWords + res.list.filter((m) => m.kind === 'wrong' && !/w-fixed/.test(res.cls[m.i])).length;
  const acc = attempted ? Math.max(0, Math.round(((attempted - res.mistakes) / attempted) * 100)) : 0;
  // verses fully recited
  const verseDone = new Map();
  R.words.forEach((w, i) => { const ok = /w-(done|fixed|missed)/.test(res.cls[i]); /* words only revealed as hints don't count */ const k = w.s + ':' + w.v; verseDone.set(k, (verseDone.get(k) ?? true) && ok); });
  const versesRecited = [...verseDone.values()].filter(Boolean).length;
  const ms = elapsed();
  const id = 'r' + Date.now();
  const session = {
    id, t: Date.now(), page: R.page, s: R.s, from: R.from, to: R.to, words: res.doneWords, total: R.words.length, mistakes: res.mistakes,
    hints: R.hints.size, acc, ms, voice: R.finals.some((t) => !t.manual), verses: versesRecited,
    mist: res.list.map((m) => ({ s: R.words[m.i].s, v: R.words[m.i].v, j: R.words[m.i].j, text: R.words[m.i].text, kind: m.kind })),
    hidden: !!P.hide, test: !!opts.test,
  };
  if (R.recorder && !opts.silent) { try { const blob = await R.recorder.stop(); if (blob && blob.size) { await putRecording(id, blob); session.rec = true; } } catch (e) {} R.recorder = null; }
  db.history.unshift(session); if (db.history.length > 500) { db.history.pop(); }
  // khatm map
  if (db.goal.khatmDays && db.goal.khatmMap) {
    const arr = db.goal.khatmMap.split(''); let added = 0;
    verseDone.forEach((ok, k) => { if (ok) { const [vs, vv] = k.split(':').map(Number); const g = gIndex(vs, vv); if (arr[g] !== '1') { arr[g] = '1'; added++; } } });
    db.goal.khatmMap = arr.join('');
    const d = db.daily[today()] || (db.daily[today()] = { verses: 0, words: 0, ms: 0 }); d.khatm = (d.khatm || 0) + added;
  }
  applyPlans(verseDone, !!P.hide);
  logDaily(versesRecited, res.doneWords, ms);
  save();
  if (opts.silent) { if (!opts.quiet) toast(`Saved ${sessionTitle(session)}: ${acc}% · ${res.mistakes} mistake${res.mistakes === 1 ? '' : 's'}`); return session; }
  showSummary(session, res);
  return session;
}
function showSummary(ses, res) {
  const g = goalProgress();
  const body = h('div', { class: 'dlg-body' },
    h('div', { class: 'stats' }, ...[['Accuracy', ses.acc + '%'], ['Words', `${ses.words}/${ses.total}`], ['Mistakes', ses.mistakes], ['Hints', ses.hints]].map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'val' }, String(v))))),
    h('div', { class: 'muted small' }, `${ses.verses} verse${ses.verses === 1 ? '' : 's'} recited in ${fmt(ses.ms)}. Today: ${g.have} of ${g.target} ${g.unit}.`));
  const items = ses.mist.map((m) => ({ ...m }));
  R.hints.forEach((i) => { if (!items.some((x) => x.s === R.words[i].s && x.v === R.words[i].v && x.j === R.words[i].j)) items.push({ s: R.words[i].s, v: R.words[i].v, j: R.words[i].j, text: R.words[i].text, kind: 'hint' }); });
  items.sort((a, b) => a.s - b.s || a.v - b.v || a.j - b.j);
  if (items.length) body.append(h('div', { class: 'small muted' }, 'Words to review'), mistakeList(items.slice(0, 80)));
  else body.append(h('p', { class: 'muted', style: 'margin:0' }, ses.words ? 'No mistakes and no hints. Excellent.' : 'Nothing was recited in this session.'));
  if (ses.rec) body.append(h('div', { class: 'small muted' }, 'Your recording is saved in Progress → Session history.'));
  body.append(h('div', { class: 'actions' },
    h('button', { class: 'btn', onclick: () => { closeDialog(); resetSession(); } }, 'Recite again'),
    h('button', { class: 'btn accent', onclick: () => { closeDialog(); nextPassage(); } }, R.page ? 'Next page' : 'Next passage')));
  openDialog(sessionTitle(ses), body);
}
function sessionTitle(x) {
  return (x.test ? 'Test · ' : '') + (x.page ? `Page ${x.page} · ${Q[x.s - 1][1]}` : `${Q[x.s - 1][1]} ${x.from}–${x.to}`);
}
function mistakeList(items) {
  return h('ul', { class: 'mlist' }, items.map((m) => h('li', null,
    h('span', { class: 'tag ' + (m.kind === 'wrong' ? 'bad' : m.kind === 'missed' ? 'warn' : 'hint') }, m.kind === 'wrong' ? 'Wrong' : m.kind === 'missed' ? 'Skipped' : 'Hint'),
    h('button', { class: 'btn', style: 'padding:3px 8px', onclick: () => { closeDialog(); setMode('recite'); openVerse(m.s, m.v); } }, `${m.s}:${m.v}`),
    h('span', { class: 'ar', lang: 'ar' }, m.text))));
}

/* ======================= LISTEN (audio player) ======================= */
const audio = $('#audio');
const A = { i: -1, ayahLeft: 1, rangeLeft: 1, playing: false }; // i = index into R.verses
const reciter = () => RECITERS.find((r) => r[0] === P.reciter) || RECITERS[0];
// the reciter's family name, without "ال", e.g. العفاسي → ع
const initial = (ar) => { const w = ar.replace(/[()]/g, '').trim().split(/\s+/); const last = (w[0] === 'الحصري' ? w[0] : w[w.length - 1]).replace(/^ال/, ''); return last[0] || ar[0]; };
function speedLabel(x) { return x + '×'; }
function playerSummary() {
  const rep = P.repeatAyah === 1 ? 'each verse once' : P.repeatAyah === 0 ? 'repeat each verse forever' : `each verse ×${P.repeatAyah}`;
  const rng = P.repeatRange === 1 ? '' : P.repeatRange === 0 ? ' · loop forever' : ` · loop ×${P.repeatRange}`;
  return `${speedLabel(P.speed)} · ${rep}${rng}`;
}
function updatePlayerLabel() {
  const r = reciter();
  $('#p-rec').textContent = r[1]; $('#p-av').textContent = initial(r[2]);
  const cur = R.verses[A.i];
  $('#p-now').textContent = (cur ? `${cur[0]}:${cur[1]}` : (R.page ? `Page ${R.page}` : `${R.from}–${R.to}`)) + ' · ' + playerSummary();

}
function playIndex(i, keepRange) {
  if (inClaude) { toast('Reciter audio can’t play on this preview link. It plays in the Android app and the installed web app.', 6000); return; }
  if (i < 0 || i >= R.verses.length) return;
  A.i = i; A.ayahLeft = P.repeatAyah || Infinity;
  if (!keepRange) A.rangeLeft = P.repeatRange || Infinity;
  const [s, v] = R.verses[i];
  audio.src = audioUrl(P.reciter, s, v); audio.playbackRate = P.speed;
  audio.play().then(() => setPlaying(true)).catch(() => { setPlaying(false); toast('Could not play audio. Check your internet connection.'); });
  highlightVerse();
}
function playFrom(s, v) { const i = R.verses.findIndex((x) => x[0] === s && x[1] === v); playIndex(i < 0 ? 0 : i); }
function highlightVerse() {
  const cur = R.verses[A.i];
  R.vEls.forEach((el) => el.classList.toggle('playing', !!cur && +el.dataset.s === cur[0] && +el.dataset.v === cur[1] && A.playing));
  // in the Mushaf line layout a verse spans several lines, so highlight its words
  let first = null;
  R.els.forEach((el, i) => { const w = R.words[i]; const on = !!cur && A.playing && w.s === cur[0] && w.v === cur[1]; el.classList.toggle('playing', on); if (on && !first) first = el; });
  const el = (cur && R.vEls[A.i]) || first;
  if (el && A.playing) { const r = el.getBoundingClientRect(); if (r.top < 110 || r.bottom > innerHeight - 220) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  updatePlayerLabel();
}
function setPlaying(p) {
  A.playing = p;
  $('#p-ico').innerHTML = p ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  $('#p-play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  highlightVerse();
  const cur = R.verses[A.i];
  if ('mediaSession' in navigator && Q && cur) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: `${Q[cur[0] - 1][1]} ${cur[0]}:${cur[1]}`, artist: reciter()[1], album: 'Tilawa' });
  }
}
let listenStart = 0;
audio.addEventListener('play', () => { listenStart = Date.now(); });
audio.addEventListener('pause', () => { if (listenStart) { logDaily(0, 0, Date.now() - listenStart); listenStart = 0; } });
audio.addEventListener('ended', () => {
  if (listenStart) { logDaily(0, 0, Date.now() - listenStart); listenStart = 0; }
  if (--A.ayahLeft > 0) { audio.currentTime = 0; audio.play(); return; }
  if (A.i < R.verses.length - 1) { playIndex(A.i + 1, true); return; }
  if (--A.rangeLeft > 0) { playIndex(0, true); return; }
  // continue onto the next page when playing a page once through
  if (R.page && R.page < PAGES.length && P.repeatRange === 1) { openPage(R.page + 1); setMode('listen'); playIndex(0); return; }
  setPlaying(false); A.i = -1; highlightVerse();
});
audio.addEventListener('error', () => { if (A.playing) { setPlaying(false); toast('This recitation could not load. Try another reciter or check your connection.', 5000); } });
$('#p-play').addEventListener('click', () => {
  if (A.playing) { audio.pause(); setPlaying(false); }
  else if (A.i >= 0 && audio.src) { audio.play().then(() => setPlaying(true)).catch(() => toast('Could not play audio.')); }
  else playIndex(0);
});
$('#p-fwd').addEventListener('click', () => playIndex(Math.min(R.verses.length - 1, A.i + 1), true));
$('#p-back').addEventListener('click', () => playIndex(Math.max(0, A.i - 1), true));
function stopAudio() { if (!audio.paused) audio.pause(); setPlaying(false); A.i = -1; }
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => $('#p-play').click());
  navigator.mediaSession.setActionHandler('pause', () => $('#p-play').click());
  navigator.mediaSession.setActionHandler('nexttrack', () => $('#p-fwd').click());
  navigator.mediaSession.setActionHandler('previoustrack', () => $('#p-back').click());
}
function openPlayerSheet() {
  const list = h('div', { class: 'rlist' });
  RECITERS.forEach(([id, en, ar]) => list.append(h('button', { 'aria-pressed': String(id === P.reciter), onclick: (e) => {
    P.reciter = id; save(); $$('button', list).forEach((b) => b.setAttribute('aria-pressed', 'false')); e.currentTarget.setAttribute('aria-pressed', 'true');
    updatePlayerLabel(); if (A.playing) playIndex(A.i, true);
  } }, h('span', { class: 'avatar' }, initial(ar)), h('span', { class: 'nm' }, h('b', null, en), h('small', null, ar)), h('span', { class: 'check' }, '✓'))));
  const body = h('div', { class: 'dlg-body' },
    pills([[0.5, '0.5×'], [0.75, '0.75×'], [1, '1×'], [1.25, '1.25×'], [1.5, '1.5×']], P.speed, 'Speed', (v) => { P.speed = v; audio.playbackRate = v; save(); updatePlayerLabel(); }),
    pills([[1, '1'], [2, '2'], [3, '3'], [5, '5'], [7, '7'], [10, '10'], [0, '∞']], P.repeatAyah, 'Repeat each verse', (v) => { P.repeatAyah = v; A.ayahLeft = v || Infinity; save(); updatePlayerLabel(); }),
    pills([[1, 'Once'], [2, '2'], [3, '3'], [5, '5'], [10, '10'], [0, '∞']], P.repeatRange, R.page ? 'Repeat the whole page' : 'Repeat the whole range', (v) => { P.repeatRange = v; A.rangeLeft = v || Infinity; save(); updatePlayerLabel(); }),
    h('div', { class: 'opt-group' }, h('div', { class: 'lbl' }, 'Reciter'), list));
  dlg.classList.add('sheet-dlg'); openDialog('Playback', body);
}
$('#p-open').addEventListener('click', openPlayerSheet);
$('#p-tune').addEventListener('click', openPlayerSheet);

/* ======================= MEMORIZATION PLANS ======================= */
// A plan covers a portion (surahs, juz or pages) by a deadline. Memorize and Review plans only count verses
// recited while the words were hidden; Recite plans count any recitation. The daily target recalculates
// from what is left and the days remaining.
const PLAN_TYPES = { memorize: 'Memorize', review: 'Review', recite: 'Recite' };
const DAY = 864e5;
const startOfDay = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function scopeVerses(sc, reverse) {
  let a, b;
  if (sc.kind === 'juz') { a = gIndex(...JUZ[sc.a - 1]); b = sc.b < 30 ? gIndex(...JUZ[sc.b]) : TOTAL_VERSES; }
  else if (sc.kind === 'pages') { a = gIndex(...PAGES[sc.a - 1]); b = sc.b < PAGES.length ? gIndex(...PAGES[sc.b]) : TOTAL_VERSES; }
  else { a = OFFS[sc.a - 1]; b = sc.b < 114 ? OFFS[sc.b] : TOTAL_VERSES; }
  const out = []; for (let g = a; g < b; g++) { const { s, v } = fromGlobal(g); out.push([s, v]); }
  if (!reverse) return out;
  // reverse order goes surah by surah from the end (e.g. An-Nas first), verses inside a surah stay in order
  const groups = []; for (const x of out) { if (!groups.length || groups[groups.length - 1][0][0] !== x[0]) groups.push([]); groups[groups.length - 1].push(x); }
  return groups.reverse().flat();
}
function scopeLabel(sc) {
  if (sc.kind === 'juz') return sc.a === sc.b ? `Juz ${sc.a}` : `Juz ${sc.a}–${sc.b}`;
  if (sc.kind === 'pages') return sc.a === sc.b ? `Page ${sc.a}` : `Pages ${sc.a}–${sc.b}`;
  return sc.a === sc.b ? Q[sc.a - 1][1] : `${Q[sc.a - 1][1]} – ${Q[sc.b - 1][1]}`;
}
const planCache = new Map();
function planVerses(p) {
  const key = p.id + (p.reverse ? 'r' : '');
  if (!planCache.has(key)) { const list = scopeVerses(p.scope, p.reverse); const idx = new Map(list.map(([s, v], i) => [s + ':' + v, i])); planCache.set(key, { list, idx }); }
  return planCache.get(key);
}
function planStats(p) {
  const { list } = planVerses(p);
  const done = (p.done.match(/1/g) || []).length, total = list.length, left = total - done;
  const daysLeft = Math.max(1, Math.ceil((startOfDay(p.deadline) - startOfDay()) / DAY) + 1);
  const doneToday = p.day && p.day.d === today() ? p.day.n : 0;
  const target = left + doneToday > 0 ? Math.ceil((left + doneToday) / daysLeft) : 0;
  const expected = Math.min(total, Math.round(total * Math.min(1, (Date.now() - p.created) / Math.max(DAY, p.deadline - p.created))));
  return { done, total, left, daysLeft, doneToday, target, behind: done < expected - target, complete: left === 0, overdue: Date.now() > p.deadline + DAY && left > 0 };
}
function applyPlans(verseDone, hidden) {
  let changed = false;
  for (const p of db.plans) {
    if (p.type !== 'recite' && !hidden) continue;
    const { idx } = planVerses(p); const arr = p.done.split(''); let n = 0;
    verseDone.forEach((ok, k) => { const i = idx.get(k); if (ok && i != null && arr[i] !== '1') { arr[i] = '1'; n++; } });
    if (!n) continue;
    p.done = arr.join('');
    if (!p.day || p.day.d !== today()) p.day = { d: today(), n: 0 };
    p.day.n += n; changed = true;
    if (p.type === 'memorize' && !p.done.includes('0')) {
      // a finished memorization plan adds its surahs to "memorized" (whole surahs only)
      const surahs = new Set(planVerses(p).list.map((x) => x[0]));
      surahs.forEach((s) => { const inPlan = planVerses(p).list.filter((x) => x[0] === s).length; if (inPlan === Q[s - 1][4].length && !db.memo.surahs.includes(s)) db.memo.surahs.push(s); });
      toast(`Plan complete: ${PLAN_TYPES[p.type]} ${scopeLabel(p.scope)}. Alhamdulillah!`, 5000);
    }
  }
  return changed;
}
function continuePlan(p) {
  const { list } = planVerses(p); const st = planStats(p);
  let i = p.done.indexOf('0');
  if (i < 0) { toast('This plan is complete.'); return; }
  const want = Math.max(1, Math.min(st.target - st.doneToday > 0 ? st.target - st.doneToday : st.target, 20));
  const [s, v] = list[i]; let e = v;
  while (e - v + 1 < want && i + 1 < list.length && list[i + 1][0] === s && list[i + 1][1] === e + 1 && p.done[i + 1] === '0') { i++; e++; }
  if (p.type !== 'recite' && !P.hide) { P.hide = true; save(); applyPrefs(); }
  if (p.type === 'recite' && P.hide) { P.hide = false; save(); applyPrefs(); }
  setMode('recite');
  openPassage(s, v, e);
  toast(p.type === 'recite' ? `Recite ${Q[s - 1][1]} ${v}–${e}` : `Memorize is on. Recite ${Q[s - 1][1]} ${v}–${e} from memory; tap a hidden word to peek.`, 4500);
}
function planCard(p, compact) {
  const st = planStats(p);
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  const deadline = new Date(p.deadline).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(p.deadline).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
  const todayTxt = st.complete ? 'Complete' : st.doneToday >= st.target ? `Today’s ${st.target} done ✓` : `Today: ${st.doneToday} of ${st.target} verses`;
  return h('div', { class: 'plan' },
    h('div', { class: 'plan-top' },
      h('span', { class: 'plan-type ' + p.type }, PLAN_TYPES[p.type]),
      h('span', { class: 'ttl' }, h('b', null, scopeLabel(p.scope) + (p.reverse ? ' (reverse)' : '')), h('small', null, `${st.done}/${st.total} verses · ${pct}% · by ${deadline}`)),
    ),
    h('div', { class: 'bar-track' }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'plan-meta' },
      h('span', { class: 'today' }, h('b', null, todayTxt), h('br'), h('span', { class: st.overdue || st.behind ? 'behind' : '' }, st.complete ? '' : st.overdue ? 'Past the deadline' : `${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left${st.behind ? ' · behind, target raised' : ''}`)),
      compact ? h('button', { class: 'btn accent', onclick: () => continuePlan(p), disabled: st.complete || null }, 'Continue') : null),
    compact ? null : h('div', { class: 'actions' },
      h('button', { class: 'btn accent', onclick: () => continuePlan(p), disabled: st.complete || null }, 'Continue'),
      h('button', { class: 'btn', onclick: () => editPlan(p) }, 'Edit'),
      h('button', { class: 'btn danger', onclick: () => {
        openDialog('Delete this plan?', h('div', { class: 'dlg-body' }, h('p', { style: 'margin:0' }, `${PLAN_TYPES[p.type]} ${scopeLabel(p.scope)} and its progress will be removed.`),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: closeDialog }, 'Cancel'),
            h('button', { class: 'btn danger', onclick: () => { db.plans = db.plans.filter((x) => x.id !== p.id); save(); closeDialog(); renderProgress(); } }, 'Delete'))));
      } }, 'Delete')));
}
function surahSelect(id, val) { const sel = h('select', { id }); Q.forEach((s, i) => sel.append(h('option', { value: i + 1, selected: i + 1 === val }, `${i + 1}. ${s[1]}`))); return sel; }
function numSelect(id, n, val, label) { const sel = h('select', { id }); for (let i = 1; i <= n; i++) sel.append(h('option', { value: i, selected: i === val }, `${label} ${i}`)); return sel; }
function editPlan(existing) {
  const p = existing ? structuredClone(existing) : { type: 'memorize', scope: { kind: 'juz', a: 30, b: 30 }, reverse: true, deadline: startOfDay() + 90 * DAY };
  const scopeBox = h('div', { class: 'row2' });
  const drawScope = () => {
    scopeBox.textContent = '';
    let A, B;
    if (p.scope.kind === 'surah') { A = surahSelect('pl-a', p.scope.a); B = surahSelect('pl-b', p.scope.b); }
    else if (p.scope.kind === 'juz') { A = numSelect('pl-a', 30, p.scope.a, 'Juz'); B = numSelect('pl-b', 30, p.scope.b, 'Juz'); }
    else { A = h('input', { id: 'pl-a', type: 'number', min: 1, max: 604, value: p.scope.a, inputmode: 'numeric' }); B = h('input', { id: 'pl-b', type: 'number', min: 1, max: 604, value: p.scope.b, inputmode: 'numeric' }); }
    const sync = () => {
      const max = p.scope.kind === 'surah' ? 114 : p.scope.kind === 'juz' ? 30 : 604;
      p.scope.a = Math.min(max, Math.max(1, +A.value || 1)); p.scope.b = Math.min(max, Math.max(p.scope.a, +B.value || p.scope.a)); B.value = p.scope.b; summary();
    };
    A.addEventListener('change', sync); B.addEventListener('change', sync);
    scopeBox.append(h('div', { class: 'field' }, h('label', { for: 'pl-a' }, 'From'), A), h('div', { class: 'field' }, h('label', { for: 'pl-b' }, 'To'), B));
  };
  const dateIn = h('input', { type: 'date', id: 'pl-date' });
  const setDate = (t) => { p.deadline = t; const d = new Date(t); dateIn.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; summary(); };
  dateIn.addEventListener('change', () => { const [y, m, d] = dateIn.value.split('-').map(Number); if (y) { p.deadline = new Date(y, m - 1, d).getTime(); summary(); } });
  const note = h('div', { class: 'muted small' });
  const summary = () => {
    const n = scopeVerses(p.scope, false).length;
    const days = Math.max(1, Math.ceil((startOfDay(p.deadline) - startOfDay()) / DAY) + 1);
    note.textContent = `${n.toLocaleString()} verses in ${days} day${days === 1 ? '' : 's'}: about ${Math.ceil(n / days)} a day.` +
      (p.type === 'recite' ? ' Any recitation counts.' : ' Only verses you recite with the words hidden (Memorize on) count.');
  };
  const body = h('div', { class: 'dlg-body' },
    pills([['memorize', 'Memorize'], ['review', 'Review'], ['recite', 'Recite']], p.type, 'Plan type', (v) => { p.type = v; summary(); }),
    pills([['surah', 'Surahs'], ['juz', 'Juz'], ['pages', 'Pages']], p.scope.kind, 'Portion', (v) => {
      p.scope = v === 'surah' ? { kind: v, a: 78, b: 114 } : v === 'juz' ? { kind: v, a: 30, b: 30 } : { kind: v, a: 582, b: 604 }; drawScope(); summary();
    }),
    scopeBox,
    pills([[false, 'In order'], [true, 'Reverse (from An-Nas back)']], !!p.reverse, 'Order', (v) => { p.reverse = v; }),
    h('div', { class: 'opt-group' }, h('div', { class: 'lbl' }, 'Finish by'),
      h('div', { class: 'pills' }, ...[[14, '2 weeks'], [30, '1 month'], [90, '3 months'], [180, '6 months'], [365, '1 year']].map(([d, t]) => h('button', { onclick: () => setDate(startOfDay() + d * DAY) }, t))),
      dateIn),
    note,
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: closeDialog }, 'Cancel'),
      h('button', { class: 'btn accent', onclick: () => {
        if (p.deadline < startOfDay()) { note.textContent = 'Choose a date from today onwards.'; return; }
        if (existing) {
          const changedScope = JSON.stringify(existing.scope) !== JSON.stringify(p.scope) || existing.reverse !== p.reverse;
          Object.assign(existing, { type: p.type, scope: p.scope, reverse: p.reverse, deadline: p.deadline });
          if (changedScope) { planCache.clear(); existing.done = '0'.repeat(planVerses(existing).list.length); existing.day = null; }
        } else {
          const np = { id: 'p' + Date.now(), type: p.type, scope: p.scope, reverse: !!p.reverse, deadline: p.deadline, created: Date.now(), day: null };
          np.done = '0'.repeat(planVerses(np).list.length); db.plans.push(np);
        }
        save(); closeDialog(); renderProgress(); toast(existing ? 'Plan updated' : 'Plan created. Find it on the home screen.');
      } }, existing ? 'Save' : 'Create plan')));
  drawScope(); setDate(p.deadline);
  dlg.classList.add('sheet-dlg'); openDialog(existing ? 'Edit plan' : 'New memorization plan', body);
}
$('#p-plan-new').addEventListener('click', () => editPlan(null));

/* ---------- memorized surahs ---------- */
function editMemorized(after) {
  const sel = new Set(db.memo.surahs);
  const grid = h('div', { class: 'sgrid' });
  const draw = () => { grid.textContent = ''; Q.forEach((s, i) => grid.append(h('button', { 'aria-pressed': String(sel.has(i + 1)), onclick: (e) => { sel.has(i + 1) ? sel.delete(i + 1) : sel.add(i + 1); e.currentTarget.setAttribute('aria-pressed', String(sel.has(i + 1))); count(); } }, h('i', null, String(i + 1)), h('span', null, s[1])))); };
  const cnt = h('div', { class: 'muted small' });
  const count = () => { const v = [...sel].reduce((a, s) => a + Q[s - 1][4].length, 0); cnt.textContent = `${sel.size} surah${sel.size === 1 ? '' : 's'} · ${v.toLocaleString()} verses`; };
  const juzSurahs = (j) => { const out = []; for (let s = 1; s <= 114; s++) { const sj = juzOf(s, 1); const ej = juzOf(s, Q[s - 1][4].length); if (sj >= j && ej <= j) out.push(s); } return out; };
  const preset = (list) => { list.forEach((s) => sel.add(s)); draw(); count(); };
  draw(); count();
  dlg.classList.add('sheet-dlg');
  openDialog('Surahs I’ve memorized', h('div', { class: 'dlg-body' },
    h('div', { class: 'pills' },
      h('button', { onclick: () => preset([1]) }, 'Al-Fatihah'),
      h('button', { onclick: () => preset(juzSurahs(30)) }, 'Juz 30'),
      h('button', { onclick: () => preset(juzSurahs(29)) }, 'Juz 29'),
      h('button', { onclick: () => { sel.clear(); draw(); count(); } }, 'Clear')),
    grid, cnt,
    h('button', { class: 'btn accent', onclick: () => { db.memo.surahs = [...sel].sort((a, b) => a - b); save(); closeDialog(); renderProgress(); if (screen === 'home') renderHome(); after && after(); } }, 'Save')));
}
$('#p-memo-edit').addEventListener('click', () => editMemorized());

/* ======================= TEST MODE ======================= */
// Questions start at random verses inside the chosen surahs. The first words are shown as a cue,
// the rest is hidden and scored by the same matcher as normal recitation.
let T = null;
function testSetup(presetSurahs) {
  const st = { scope: db.memo.surahs.length ? 'memo' : 'pick', pick: new Set(presetSurahs || []), count: 5, len: 2 };
  const pickBtn = h('div');
  const err = h('div', { class: 'small', style: 'color:var(--bad)' });
  const drawPick = () => {
    pickBtn.textContent = '';
    if (st.scope === 'memo') { pickBtn.append(h('div', { class: 'muted small' }, db.memo.surahs.length ? `${db.memo.surahs.length} memorized surah${db.memo.surahs.length === 1 ? '' : 's'}: ` + db.memo.surahs.slice(0, 6).map((s) => Q[s - 1][1]).join(', ') + (db.memo.surahs.length > 6 ? '…' : '') : 'You haven’t marked any surahs as memorized yet.'), h('button', { class: 'btn', style: 'margin-top:6px', onclick: () => editMemorized(() => testSetup()) }, 'Edit memorized surahs')); }
    else { const sel = surahSelect('ts-s', [...st.pick][0] || 67); st.pick = new Set([+sel.value]); sel.addEventListener('change', () => (st.pick = new Set([+sel.value]))); pickBtn.append(h('div', { class: 'field' }, h('label', { for: 'ts-s' }, 'Surah'), sel)); }
  };
  drawPick();
  dlg.classList.add('sheet-dlg');
  openDialog('Test my memorization', h('div', { class: 'dlg-body' },
    pills([['memo', 'My memorized surahs'], ['pick', 'One surah']], st.scope, 'Test me on', (v) => { st.scope = v; drawPick(); }),
    pickBtn,
    pills([[3, '3'], [5, '5'], [10, '10']], st.count, 'Questions', (v) => (st.count = v)),
    pills([[1, '1 verse'], [2, '2 verses'], [3, '3 verses'], [5, '5 verses']], st.len, 'Recite this much each time', (v) => (st.len = v)),
    h('div', { class: 'muted small' }, 'Each question opens at a random verse with the words hidden. The first two words are shown; recite from there. Tap a hidden word to peek (counts as a hint).'),
    err,
    h('button', { class: 'btn accent', onclick: () => {
      const surahs = st.scope === 'memo' ? db.memo.surahs : [...st.pick];
      if (!surahs.length) { err.textContent = 'Choose at least one surah first.'; return; }
      closeDialog(); startTest(surahs, st.count, st.len);
    } }, 'Start test')));
}
$('#h-test').addEventListener('click', () => testSetup());
$('#p-test').addEventListener('click', () => testSetup());
function startTest(surahs, count, len) {
  const pool = []; surahs.forEach((s) => { const n = Q[s - 1][4].length; for (let v = 1; v <= n; v++) pool.push([s, v]); });
  const qs = []; const used = new Set();
  for (let k = 0; k < count && used.size < pool.length; k++) {
    let x, tries = 0;
    do { x = pool[Math.floor(Math.random() * pool.length)]; tries++; } while ((used.has(x[0] + ':' + x[1]) || (qs.length && qs[qs.length - 1].s === x[0] && Math.abs(qs[qs.length - 1].v - x[1]) < len + 2 && tries < 20)) && tries < 50);
    used.add(x[0] + ':' + x[1]);
    qs.push({ s: x[0], v: x[1], e: Math.min(Q[x[0] - 1][4].length, x[1] + len - 1) });
  }
  T = { qs, i: 0, results: [], prevHide: !!P.hide, started: Date.now() };
  showQuestion();
}
function showQuestion(keep) {
  const q = T.qs[T.i];
  P.hide = true; applyPrefs(); setMode('recite');
  keepMic = !!keep;
  try { openPassage(q.s, q.v, q.e); } finally { keepMic = false; }
  // cue: the first two words of the question stay visible (not counted as hints)
  setTimeout(() => { for (let i = 0; i < Math.min(2, R.words.length); i++) R.peeks.add(i); update(true); }, 0);
  $('#test-bar').hidden = false;
  $('#tb-q').textContent = `Question ${T.i + 1} of ${T.qs.length}`;
  $('#tb-s').textContent = `Continue from ${Q[q.s - 1][1]} ${q.s}:${q.v}` + (q.e > q.v ? ` (to ${q.e})` : '');
  $('#tb-next').textContent = T.i + 1 < T.qs.length ? 'Next' : 'Finish';
  requestAnimationFrame(fitPage);
}
async function nextQuestion() {
  if (!T || T.busy) return; T.busy = true;
  try {
    const q = T.qs[T.i];
    const listening = !!(rec && rec.active);
    const ses = R.finals.length ? await finish({ silent: true, quiet: true, test: true }) : null;
    T.results.push(ses ? { ...q, acc: ses.acc, mistakes: ses.mistakes, hints: ses.hints, words: ses.words, total: ses.total, mist: ses.mist } : { ...q, skipped: true, acc: 0, mistakes: 0, hints: 0, words: 0, total: R.words.length, mist: [] });
    T.i++;
    if (T.i < T.qs.length) showQuestion(listening);
    else endTest();
  } finally { if (T) T.busy = false; }
}
function endTest(cancelled) {
  if (!T) return;
  stopRecite();
  const t = T; T = null;
  P.hide = t.prevHide; save(); applyPrefs(); update(true);
  $('#test-bar').hidden = true;
  if (cancelled && !t.results.length) return;
  const answered = t.results.filter((r) => !r.skipped);
  const score = t.results.length ? Math.round(t.results.reduce((a, r) => a + (r.skipped ? 0 : r.acc), 0) / t.results.length) : 0;
  db.history.forEach((x) => { if (x.testRun === undefined && x.t >= t.started) x.testRun = t.started; });
  save();
  const body = h('div', { class: 'dlg-body' },
    h('div', { class: 'stats' }, ...[['Score', score + '%'], ['Answered', `${answered.length}/${t.results.length}`], ['Mistakes', answered.reduce((a, r) => a + r.mistakes, 0)], ['Hints', answered.reduce((a, r) => a + r.hints, 0)]]
      .map(([k, v]) => h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'val' }, String(v))))),
    ...t.results.map((r, i) => h('div', { class: 'qres' }, h('span', { class: 'n' }, String(i + 1)),
      h('span', null, h('b', null, `${Q[r.s - 1][1]} ${r.s}:${r.v}${r.e > r.v ? '–' + r.e : ''}`), h('div', { class: 'ref' }, r.skipped ? 'Skipped' : `${r.mistakes} mistake${r.mistakes === 1 ? '' : 's'} · ${r.hints} hint${r.hints === 1 ? '' : 's'}`)),
      h('span', { class: 'sc' }, r.skipped ? '—' : r.acc + '%'))),
    h('div', { class: 'muted small' }, score >= 90 ? 'Excellent. Your memorization of these places is strong.' : score >= 70 ? 'Good. Review the questions with mistakes.' : 'Keep going: practise the places below with Memorize on, then test again.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { closeDialog(); const weak = t.results.filter((r) => r.skipped || r.acc < 90); if (weak[0]) { P.hide = true; save(); applyPrefs(); openPassage(weak[0].s, weak[0].v, weak[0].e); } } }, 'Practise weak spots'),
      h('button', { class: 'btn accent', onclick: () => { closeDialog(); startTest([...new Set(t.qs.map((q) => q.s))].length > 1 ? (db.memo.surahs.length ? db.memo.surahs : [...new Set(t.qs.map((q) => q.s))]) : [t.qs[0].s], t.qs.length, t.qs[0].e - t.qs[0].v + 1); } }, 'New test')));
  openDialog('Test results', body);
}
$('#tb-next').addEventListener('click', nextQuestion);
$('#tb-end').addEventListener('click', () => endTest(true));

/* ======================= PROGRESS ======================= */
function renderProgress() {
  if (!Q) return;
  const H = db.history;
  const words = H.reduce((a, x) => a + x.words, 0);
  const avg = H.length ? Math.round(H.reduce((a, x) => a + (x.acc || 0), 0) / H.length) : null;
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
  // memorization
  const mv = db.memo.surahs.reduce((a, s) => a + Q[s - 1][4].length, 0);
  $('#p-memo-s').textContent = db.memo.surahs.length ? `${db.memo.surahs.length} surah${db.memo.surahs.length === 1 ? '' : 's'} · ${mv.toLocaleString()} of ${TOTAL_VERSES.toLocaleString()} verses (${((mv / TOTAL_VERSES) * 100).toFixed(1)}%)` : 'None marked yet. Mark them to test yourself on them.';
  $('#p-memo-bar').style.width = (mv / TOTAL_VERSES) * 100 + '%';
  const pp = $('#p-plans'); pp.textContent = '';
  db.plans.forEach((p) => pp.append(planCard(p, false)));
  if (!db.plans.length) pp.append(h('div', { class: 'empty' }, 'No memorization plans yet. A plan sets a portion (surahs, juz or pages) and a deadline, and gives you a daily target that adjusts if you fall behind.'));
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
      h('div', null, h('b', null, sessionTitle(x)),
        h('div', { class: 'ref' }, `${new Date(x.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${x.words}/${x.total} words · ${x.mistakes} mistakes · ${x.hints} hints · ${fmt(x.ms)}`)),
      h('span', { class: 'acc' }, (x.acc || 0) + '%'));
    const acts = h('div', { class: 'acts' },
      h('button', { class: 'btn', onclick: () => { setMode('recite'); if (x.page) openPage(x.page); else openPassage(x.s, x.from, x.to); } }, 'Recite again'),
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
  const sr = $('#s-reciter'); sr.textContent = ''; RECITERS.forEach(([id, en]) => sr.append(h('option', { value: id, selected: id === P.reciter }, en)));
  $('#s-record').checked = !!P.record; $('#s-record').disabled = isNative;
  $('#s-reminder').value = P.reminder || '';
  $('#s-rem-note').textContent = plugin('LocalNotifications') ? 'A notification at this time each day.' : 'Daily notifications work in the Android app. Here, add the page to your home screen and set a phone alarm.';
  $('#s-ver').textContent = `Version ${VERSION} · ${isNative ? 'Android app' : 'Web app'} · voice: ${speechSupport}`;
}
$('#s-theme').addEventListener('change', (e) => { P.theme = e.target.value; save(); applyTheme(); });
$('#s-lang').addEventListener('change', (e) => { P.trLang = e.target.value; save(); });
$('#s-reciter').addEventListener('change', (e) => { P.reciter = e.target.value; save(); updatePlayerLabel(); });
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
// Word-level index of the Mushaf: which surah/verse each word belongs to, where lines and pages start.
let LINES = null, QI = null, QS = null;
const WORDS = { total: 0 };
function setupLines(ln, im) {
  if (im) { QI = im; QS = Q.map((s, i) => [s[0], s[1], s[2], s[3], im[i].map((v, vi) => v.map((w, j) => w || s[4][vi][j]))]); }
  if (!ln) return;
  LINES = ln;
  const total = Q.reduce((a, s) => a + s[4].reduce((b, v) => b + v.length, 0), 0);
  WORDS.total = total;
  WORDS.s = new Uint8Array(total); WORDS.v = new Uint16Array(total); WORDS.j = new Uint16Array(total);
  let g = 0;
  Q.forEach((sur, si) => sur[4].forEach((words, vi) => words.forEach((_, j) => { WORDS.s[g] = si + 1; WORDS.v[g] = vi + 1; WORDS.j[g] = j; g++; })));
  WORDS.ayahEnd = new Set(ln.ayah.slice(1).map((x) => x - 1).concat([total - 1]));
  WORDS.surahStart = new Set(ln.surah);
  WORDS.pageLine = []; let li = 0;
  ln.page.forEach((ps) => { while (li < ln.line.length && ln.line[li] < ps) li++; WORDS.pageLine.push(li); });
}
applyPrefs();
speechReady.then(() => { if (R.units && R.units.length) update(); });
fetch('data/quran.json').then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((data) => {
  Q = data; OFFS = []; let o = 0; Q.forEach((s) => { OFFS.push(o); o += s[4].length; });
  R.s = P.s; R.from = P.from; R.to = P.to;
  return Promise.all([fetch('data/pages.json').then((r) => r.json()), fetch('data/lines.json').then((r) => r.json()), fetch('data/imlai.json').then((r) => r.json()).catch(() => null)])
    .then(([pg, ln, im]) => { PAGES = pg; setupLines(ln, im); renderHome(); });
}).catch(() => { $('#h-list').replaceChildren(h('li', { class: 'empty' }, 'The Qur’an text could not load. Close and reopen the app.')); });

if ('serviceWorker' in navigator && !isNative && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
