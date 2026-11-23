import { tokens, buildUnits, align } from '../www/js/match.js';
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname;
let failed = 0;
const Q = JSON.parse(fs.readFileSync(here + '../www/data/quran.json'));
const pages = JSON.parse(fs.readFileSync(here + '../www/data/pages.json'));
const QI = JSON.parse(fs.readFileSync(here + '../www/data/imlai.json'));
function words(list) { const w = []; for (const [s, v] of list) Q[s-1][4][v-1].forEach((t, j) => w.push({ text: t, s, v, j, plain: QI[s-1][v-1][j] })); return w; }
function run(name, list, said, expMist, opts = {}) {
  const W = words(list), U = buildUnits(W);
  const r = align(U, W.length, tokens(said, true), new Set(), new Set(), opts);
  const ok = expMist < 0 ? r.mistakes > 0 : r.mistakes === expMist; if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL'), name, 'mistakes', r.mistakes, 'expected', expMist, 'done', r.doneWords + '/' + W.length, r.list.map(m => m.kind + ':' + W[m.i].text).join(' '));
}
run('fatiha', [[1,1],[1,2],[1,3],[1,4]], 'بسم الله الرحمن الرحيم الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين', 0);
run('repeat', [[1,2],[1,3],[1,4]], 'الحمد لله رب العالمين رب العالمين الرحمن الرحيم مالك يوم الدين', 0);
run('112 w/ basmala', [[112,1],[112,2]], 'بسم الله الرحمن الرحيم قل هو الله احد الله الصمد', 0);
run('112 isti+basmala', [[112,1]], 'اعوذ بالله من الشيطان الرجيم بسم الله الرحمن الرحيم قل هو الله احد', 0);
run('2:1 الم', [[2,1],[2,2]], 'بسم الله الرحمن الرحيم الم ذلك الكتاب لا ريب فيه هدى للمتقين', 0);
run('2:1 letters', [[2,1],[2,2]], 'الف لام ميم ذلك الكتاب لا ريب فيه هدى للمتقين', 0);
run('36:1 يس', [[36,1],[36,2]], 'يس والقران الحكيم', 0);
run('wrong word', [[112,1],[112,2]], 'قل هو الله واحد الله الصمد', 1);
run('wrong first', [[112,1]], 'بل هو الله احد', 1);
run('skip word', [[112,1],[112,2],[112,3]], 'قل هو الله احد الله الصمد لم يلد ولم', 0);
run('skip long word', [[112,1],[112,2]], 'قل هو الله احد الصمد', 1);
run('page 604 boundary', [[112,4],[113,1]], 'ولم يكن له كفوا احد بسم الله الرحمن الرحيم قل اعوذ برب الفلق', 0);
// follow-along: start anywhere on the page, jump ahead
const page50 = []; { const p = pages[49], n = pages[50]; for (let v = p[1]; v < n[1]; v++) page50.push([3, v]); }
run('free: start at verse 3', page50, 'نزل عليك الكتاب بالحق مصدقا لما بين يديه', 0, { free: true });
run('free: noise before start', page50, 'السلام عليكم نزل عليك الكتاب بالحق مصدقا', 0, { free: true });
run('free: jump ahead counts skipped', page50, 'نزل عليك الكتاب بالحق هو الذي يصوركم في الارحام كيف يشاء', -1, { free: true });
run('strict (tests): wrong first word', [[112,1]], 'بل هو الله احد', 1);
// perf
const W = words(Array.from({length: 286}, (_, i) => [2, i+1])); const U = buildUnits(W);
const said = tokens(W.map(w => w.plain || w.text).join(' '), true); let t = Date.now(); const r = align(U, W.length, said, new Set(), new Set());
console.log('baqarah full', r.mistakes, 'mistakes', Date.now() - t, 'ms', r.doneWords, W.length);
if (r.mistakes !== 0) failed++;
if (failed) { console.error(failed + ' test(s) failed'); process.exit(1); }
console.log('all recitation-matching tests passed');
