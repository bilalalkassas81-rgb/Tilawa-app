// Follow-along regressions: free start anywhere on a page, repetition, jumps, recogniser spellings, real
// substitutions, partial results, and the native recogniser's phrase hand-over at a page turn.
// Run: node tests/followalong.test.mjs  (exits non-zero on failure)
import { tokens, buildUnits, align } from '../www/js/match.js';
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname;
const Q = JSON.parse(fs.readFileSync(here + '../www/data/quran.json'));
const QI = JSON.parse(fs.readFileSync(here + '../www/data/imlai.json'));
const PAGES = JSON.parse(fs.readFileSync(here + '../www/data/pages.json'));
let failed = 0;
const check = (ok, name, info = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', name, info); };

function pageWords(p) {
  const w = []; let [s, v] = PAGES[p - 1]; const end = p < 604 ? PAGES[p] : [115, 1];
  while (s < end[0] || (s === end[0] && v < end[1])) {
    Q[s - 1][4][v - 1].forEach((t, j) => w.push({ text: t, s, v, j, plain: QI[s - 1][v - 1][j] }));
    v++; if (v > Q[s - 1][4].length) { s++; v = 1; } if (s > 114) break;
  }
  return w;
}
const cache = {};
const setup = (p) => cache[p] || (cache[p] = (() => { const W = pageWords(p); return { W, U: buildUnits(W) }; })());
const said = (W, from, to) => W.slice(from, to).map((w) => w.plain).join(' ');
const idxOf = (W, s, v, j = 0) => W.findIndex((w) => w.s === s && w.v === v && w.j === j);
const at = (W, i) => (i >= 0 ? `${W[i].s}:${W[i].v}:${W[i].j}` : 'END');
const run = (p, text, opts = { free: true }) => { const { W, U } = setup(p); return align(U, W.length, tokens(text, true), new Set(), new Set(), opts); };
// expMistakes: exact count, or -1 for "at least one"; expCur: the current word starts with this s:v[:j]
function t(id, p, text, expMistakes, expCur) {
  const { W } = setup(p); const r = run(p, text);
  const cur = at(W, r.curW);
  const ok = (expMistakes < 0 ? r.mistakes > 0 : r.mistakes === expMistakes) && (!expCur || cur === expCur || cur.startsWith(expCur + ':'));
  check(ok, `${id} p${p}`, `mistakes ${r.mistakes} (exp ${expMistakes}) cur ${cur}${expCur ? ' (exp ' + expCur + ')' : ''} ${r.list.slice(0, 4).map((m) => m.kind + ':' + W[m.i].plain).join(' ')}`);
}

// R1 the vocative written as two words by recognisers (يا أيها, يا بني)
t('R1a mid-page يا ايها', 106, 'يا ايها الذين امنوا اوفوا بالعقود احلت لكم بهيمه الانعام الا ما يتلى عليكم غير محلي الصيد وانتم حرم ان الله يحكم ما يريد يا ايها الذين امنوا لا تحلوا شعائر الله', 0);
{ const { W } = setup(7); t('R1b يا بني', 7, said(W, 0, idxOf(W, 2, 40)) + ' يا بني اسرائيل اذكروا نعمتي التي انعمت عليكم', 0); }
{ const r = run(77, 'يا ايها الناس اتقوا ربكم'); check(/w-done/.test(r.cls[0]), 'R1c start of page "يا ايها الناس" credits the first word', JSON.stringify(r.cls[0])); }
// R2 starting mid-page when the first word equals the page's first word
t('R2a', 604, 'قل اعوذ برب الناس ملك الناس اله الناس', 0, '114:4');
t('R2b', 604, 'قل اعوذ برب الفلق من شر ما خلق', 0, '113:3');
t('R2c', 8, 'واذ فرقنا بكم البحر فانجيناكم واغرقنا ال فرعون وانتم تنظرون', 0, '2:51');
// R3 a phrase that occurs earlier on the page; skeleton look-alikes (ومن/آمن)
t('R3a', 293, 'الحمد لله الذي انزل على عبده الكتاب ولم يجعل له عوجا', 0, '18:2');
t('R3b', 3, 'واذا قيل لهم امنوا كما امن الناس قالوا انؤمن كما امن السفهاء', 0, '2:13:12');
t('R3c', 3, 'ومن الناس يقول امنا بالله وباليوم الاخر وما هم بمؤمنين', 0, '2:9');
// R4 restarting a verse (or several) from further back is repetition, not a mistake
t('R4a', 1, 'صراط الذين انعمت عليهم غير صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين', 0);
t('R4b', 293, 'قل ادعوا الله او ادعوا الرحمن قل ادعوا الله او ادعوا الرحمن ايا ما تدعوا فله الاسماء الحسنى', 0);
t('R4c', 604, 'قل هو الله احد الله الصمد لم يلد ولم يولد قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد', 0, '113:1');
// R5 the previous page's last phrase arriving on the new page must not move the reader
t('R5', 107, 'الله إن الله شديد العقاب حرمت عليكم الميتة والدم ولحم الخنزير وما أهل لغير الله به', 0, '5:3:11');
// R6 final hamza dropped by the recogniser (شي, السما, سو)
t('R6a', 50, 'ان الله لا يخفى عليه شي في الارض ولا في السما', 0);
t('R6b', 377, 'وادخل يدك في جيبك تخرج بيضاء من غير سو في تسع ايات', 0);
// R7 a dropped 3-letter word is one skip, and does not eat the next word
t('R7', 77, 'ولا تؤتوا السفهاء اموالكم التي جعل الله لكم قياما وارزقوهم فيها واكسوهم وقولوا قولا معروفا', 1);
// R8 a jump ahead marks the skipped words, not a wrong word where the reader left off
{ const { W } = setup(500); const r = run(500, 'ولقد اتينا بني اسرائيل الكتاب والحكم والنبوه ورزقناهم من الطيبات وفضلناهم على العالمين ثم جعلناك على شريعه من الامر فاتبعها ولا تتبع اهواء الذين لا يعلمون');
  check(r.list.filter((m) => m.kind === 'wrong').length === 0 && r.list.some((m) => m.kind === 'missed'), 'R8 jump 45:16 -> 45:18: skips only', r.list.map((m) => m.kind + ':' + W[m.i].plain).join(' ')); }
// R9 real substitutions are mistakes
t('R9a قال->قيل', 377, 'اذ قيل موسى لاهله اني انست نارا', 1);
t('R9b يعلمون->تعلمون', 500, 'ثم جعلناك على شريعه من الامر فاتبعها ولا تتبع اهواء الذين لا تعلمون', 1);
t('R9c ربكم->ربهم', 77, 'يا ايها الناس اتقوا ربهم الذي خلقكم', 1);
t('R9d عليك->عليكم', 50, 'الله لا اله الا هو الحي القيوم نزل عليكم الكتاب بالحق', 1);
t('R9e قلوبهم->قلوبكم', 3, 'ختم الله على قلوبكم وعلى سمعهم وعلى ابصارهم غشاوه ولهم عذاب عظيم', 1);
t('R9f نودي->نادى', 377, 'اذ قال موسى لاهله اني انست نارا ساتيكم منها بخبر او اتيكم بشهاب قبس لعلكم تصطلون فلما جاءها نادى ان بورك من في النار', 1);
// R10 a word still being spoken (partial result) never flags words
{ const { W, U } = setup(500); const i = idxOf(W, 45, 16, 12);
  const fin = tokens(said(W, 0, i), true);
  let flagged = 0;
  for (const part of ['وآتيناهم', 'وآتيناهم بينات', 'وآتيناهم بينات من', 'وآتيناهم بينات من الأ']) {
    const r = align(U, W.length, fin.concat(tokens(part, false)), new Set(), new Set(), { free: true });
    flagged += r.cls.filter((c) => /w-missed|w-wrong/.test(c)).length;
  }
  check(flagged === 0, 'R10 partial results flag nothing', 'flagged ' + flagged); }
// R11 every word has a standard spelling
{ let empty = 0; QI.forEach((s) => s.forEach((v) => v.forEach((w) => { if (!w) empty++; }))); check(empty === 0, 'R11 imlai.json has no empty words', 'empty ' + empty); }

// more starts, refrains and spelling variants
t('start 2:4', 2, 'وما انزل من قبلك وبالاخره هم يوقنون اولئك على هدى من ربهم', 0);
t('start 2:3 then restart verse', 2, 'الذين يؤمنون بالغيب ويقيمون الذين يؤمنون بالغيب ويقيمون الصلاه ومما رزقناهم ينفقون', 0, '2:4:0');
t('start 3:2 الاه', 50, 'الله لا الاه الا هو الحي القيوم نزل عليك الكتاب بالحق', 0);
t('start 3:5 (إن الله also at 3:9)', 50, 'ان الله لا يخفى عليه شيء في الارض ولا في السماء', 0, '3:6:0');
t('start 14:5', 255, 'ولقد ارسلنا موسى باياتنا ان اخرج قومك من الظلمات الى النور وذكرهم بايام الله', 0);
t('start 78:5 ثم كلا سيعلمون', 582, 'ثم كلا سيعلمون الم نجعل الارض مهادا والجبال اوتادا', 0, '78:8:0');
t('start 78:10 وجعلنا', 582, 'وجعلنا الليل لباسا وجعلنا النهار معاشا', 0, '78:12:0');
t('start 113:3 ومن شر', 604, 'ومن شر غاسق اذا وقب ومن شر النفاثات في العقد', 0, '113:5:0');
t('ta\'awwudh then start', 1, 'اعوذ بالله من الشيطان الرجيم اياك نعبد واياك نستعين اهدنا الصراط المستقيم', 0, '1:7:0');
t('3:66 standard spelling ها انتم', 58, 'ها انتم هؤلاء حاججتم فيما لكم به علم فلم تحاجون فيما ليس لكم به علم والله يعلم وانتم لا تعلمون', 0);
t('36:22 وما لي', 441, 'وما لي لا اعبد الذي فطرني واليه ترجعون', 0);
t('merged words وخلقمنها', 77, 'ياايها الناس اتقوا ربكم الذي خلقكم من نفس واحده وخلقمنها زوجها وبث منهما رجالا كثيرا', 0);
{ const { W } = setup(1); const r = run(1, 'الحمدلله رب العالمين الرحمنالرحيم مالك يومالدين');
  const ok = r.mistakes === 0 && at(W, r.curW) === '1:5:0' && W.every((w, i) => (w.v >= 2 && w.v <= 4) === /w-done/.test(r.cls[i]));
  check(ok, 'F3a merged words (fast reading) credit both words', `cur ${at(W, r.curW)} ${r.cls.join('|')}`); }
t('السماوات modern spelling', 500, 'وخلق الله السماوات والارض بالحق ولتجزى كل نفس بما كسبت وهم لا يظلمون', 0);
t('one wrong word فقال', 377, 'اذ فقال موسى لاهله اني انست نارا', 1);
t('skip a word in 114:5', 604, 'قل اعوذ برب الناس ملك الناس اله الناس من شر الوسواس الخناس الذي في صدور الناس', -1);
t('go back one verse', 582, said(setup(582).W, 0, idxOf(setup(582).W, 78, 11)) + ' وجعلنا نومكم سباتا وجعلنا الليل لباسا وجعلنا النهار معاشا', 0);
{ const { W } = setup(374); const i = idxOf(W, 26, 178); t('refrain verse started later (26:178)', 374, said(W, i, W.length), 0); }
t('strict: wrong first word still counts', 377, 'اذ فقال موسى لاهله', 1);
{ const r = run(604, 'بل هو الله احد', {}); check(r.mistakes === 1, 'strict (tests): wrong first word', 'mistakes ' + r.mistakes); }

// sweeps over every page: whole page from the top (also with recogniser spellings) and starting at each verse
{
  const rx = (w) => w.replace(/^يا(?=[أاإب-ي])/, 'يا ').replace(/ء$/, '').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[أإآ]/g, 'ا');
  let top = 0, spell = 0, starts = 0, startBad = 0;
  const t0 = Date.now();
  for (let p = 1; p <= 604; p++) {
    const { W, U } = setup(p);
    const A = (text) => align(U, W.length, tokens(text, true), new Set(), new Set(), { free: true });
    let r = A(said(W, 0, W.length)); if (r.mistakes || !r.finished) top++;
    r = A(W.map((w) => rx(w.plain)).join(' ')); if (r.mistakes) spell++;
    for (let i = 1; i < W.length; i++) if (W[i].j === 0) { starts++; r = A(said(W, i, W.length)); if (r.mistakes || !r.finished) startBad++; }
  }
  check(top === 0, 'sweep: every page from the top, no false mistakes', `${top} pages`);
  check(spell === 0, 'sweep: every page in recogniser spelling, no false mistakes', `${spell} pages`);
  // a refrain verse started at the very end of a page cannot be told from its earlier copies: allow a handful
  check(startBad <= 10, 'sweep: start at any verse start', `${startBad} of ${starts} fail (${Date.now() - t0} ms)`);
}

// speed: a whole Al-Baqarah range, free mode, cold and with a word still being spoken
{
  const W = []; for (let v = 1; v <= 286; v++) Q[1][4][v - 1].forEach((x, j) => W.push({ text: x, s: 2, v, j, plain: QI[1][v - 1][j] }));
  const U = buildUnits(W); const rec = tokens(W.map((w) => w.plain).join(' '), true);
  let t0 = performance.now(); let r = align(U, W.length, rec, new Set(), new Set(), { free: true }); const cold = performance.now() - t0;
  t0 = performance.now(); align(U, W.length, rec.concat(tokens('ولا', false)), new Set(), new Set(), { free: true }); const warm = performance.now() - t0;
  check(r.mistakes === 0 && r.finished && cold < 150 && warm < 50, 'Al-Baqarah free alignment', `cold ${cold.toFixed(1)} ms, again ${warm.toFixed(1)} ms`);
}

// speech.js with a fake Android plugin: final text committed as soon as it arrives, and cut() at a page turn
{
  const L = {}; let listening = false;
  const emit = (ev, d) => (L[ev] || []).forEach((f) => f(d));
  const SR = {
    available: async () => ({ available: true }), checkPermissions: async () => ({ speechRecognition: 'granted' }),
    requestPermissions: async () => ({ speechRecognition: 'granted' }),
    removeAllListeners: async () => { for (const k in L) L[k] = []; },
    addListener: (ev, f) => { (L[ev] ||= []).push(f); return Promise.resolve({ remove() {} }); },
    start: async () => { listening = true; }, stop: () => new Promise(() => {}), isListening: async () => ({ listening }),
  };
  globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { SpeechRecognition: SR } } };
  globalThis.document = { hidden: false };
  const { createRecognizer } = await import('../www/js/speech.js');
  const finals = []; let partial = '';
  const rec = createRecognizer({ onPartial: (p) => (partial = p), onFinal: (f) => finals.push(f), onState() {} });
  await rec.start();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  emit('partialResults', { matches: ['شديد'] }); emit('partialResults', { matches: ['شديد العقاب'] });
  rec.cut(); // the page is complete: the app keeps "شديد العقاب"
  emit('partialResults', { matches: ['شديد العقاب حرمت'] });
  const p1 = partial;
  emit('partialResults', { matches: ['شديد العقاب حرمت عليكم'] });
  listening = false; emit('listeningState', { status: 'stopped' }); await sleep(50);
  emit('partialResults', { matches: ['شديد العقاب حرمت عليكم'] }); // the final text
  await sleep(20);
  check(p1 === 'حرمت' && finals.length === 1 && finals[0] === 'حرمت عليكم' && listening, 'native: words kept by the old page are not sent again; final committed and listening again at once', JSON.stringify({ p1, finals, listening }));
  emit('listeningState', { status: 'started' });
  emit('partialResults', { matches: ['حرمت عليكم'] }); // the same words said again in a new phrase are not dropped
  listening = false; emit('listeningState', { status: 'stopped' }); await sleep(450); // no final text: committed after a short wait
  check(finals.length === 2 && finals[1] === 'حرمت عليكم', 'native: phrase without a final text is committed after the short wait', JSON.stringify(finals));
  rec.stop();
}

if (failed) { console.error(failed + ' follow-along test(s) failed'); process.exit(1); }
console.log('all follow-along tests passed');
process.exit(0);
