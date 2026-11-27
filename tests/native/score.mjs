// Scores benchmark transcripts of Al-Fatiha (one JSON line per verse, from tests/native/bench.cpp) the way the app
// would: all verses' text through match.js against page 1. Prints words green out of 29 and mistakes.
// Run: node tests/native/score.mjs <label> < bench-output.jsonl
import { tokens, buildUnits, align } from '../../www/js/match.js';
import fs from 'fs';
const here = new URL('.', import.meta.url).pathname;
const Q = JSON.parse(fs.readFileSync(here + '../../www/data/quran.json'));
const QI = JSON.parse(fs.readFileSync(here + '../../www/data/imlai.json'));
const W = Q[0][4].flatMap((v, vi) => v.map((t, j) => ({ text: t, s: 1, v: vi + 1, j, plain: QI[0][vi][j] })));
const U = buildUnits(W);
const rows = fs.readFileSync(0, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).sort((a, b) => a.file.localeCompare(b.file));
const text = rows.map((r) => r.text.trim()).join(' ');
const r = align(U, W.length, tokens(text, true), new Set(), new Set(), { free: true });
const green = r.cls.filter((c) => c === 'w-done').length;
const ms = rows.map((r) => r.ms), sec = rows.reduce((a, r) => a + r.sec, 0), tot = ms.reduce((a, b) => a + b, 0);
console.log(`SCORE ${process.argv[2] || ''}: green ${green}/${W.length}, mistakes ${r.mistakes} [${r.list.map((m) => m.kind + ':' + W[m.i].plain).join(', ')}]; ${rows.length} verses, ${sec.toFixed(1)} s audio, ${tot} ms (${(tot / sec * 1000 / 1000).toFixed(0)} ms per s of audio); tokens max ${Math.max(...rows.map((r) => r.tokens))}`);
console.log(`TEXT ${text}`);
