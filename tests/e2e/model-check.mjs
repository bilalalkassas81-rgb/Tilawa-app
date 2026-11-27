// Diagnostic (CI only, needs internet): which ONNX exports of the Qur'an Whisper models exist on Hugging Face, and what
// each one transcribes from real recitation, with timings. Then the app's own streaming (stream.js) and follow-along
// (match.js) are run on the same audio in real time with the best model, as the phone would.
// Run: AUDIO_DIR=<dir with NNN.f32 files (16 kHz mono float32), one per verse> node tests/e2e/model-check.mjs
import fs from 'fs';
import { pipeline, env } from '@huggingface/transformers';
import { AI_MODELS } from '../../www/js/ai.js';
import { createStreamer, clean, RATE } from '../../www/js/stream.js';
import { tokens, buildUnits, align } from '../../www/js/match.js';

const here = new URL('.', import.meta.url).pathname;
const Q = JSON.parse(fs.readFileSync(here + '../../www/data/quran.json'));
const QI = JSON.parse(fs.readFileSync(here + '../../www/data/imlai.json'));
const AUDIO = process.env.AUDIO_DIR;
const EXTRA = (process.env.EXTRA_MODELS || '').split(/[\s,]+/).filter(Boolean);
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
const TRY = (process.env.DTYPES || 'q8,q4').split(',');

// Al-Fatiha as the app shows it on page 1
const W = Q[0][4].flatMap((v, i) => v.map((t, j) => ({ text: t, s: 1, v: i + 1, j, plain: QI[0][i][j] })));
const U = buildUnits(W);
const score = (text) => { const r = align(U, W.length, tokens(text, true), new Set(), new Set(), { free: true }); return `${r.doneWords}/${W.length} words, ${r.mistakes} mistakes`; };
const expected = QI[0].map((v) => v.join(' '));

const api = async (p) => { const r = await fetch('https://huggingface.co/api/' + p); return r.ok ? r.json() : { error: r.status }; };
async function files(id) {
  const top = await api(`models/${id}/tree/main`);
  if (top.error) return { error: top.error };
  const onnx = await api(`models/${id}/tree/main/onnx`);
  return { top: top.map((f) => f.path), onnx: onnx.error ? [] : onnx.map((f) => `${f.path.replace('onnx/', '')} ${(f.size / 1e6).toFixed(1)}MB`) };
}

const found = new Set();
if (process.env.SEARCH) console.log('== Hugging Face search');
if (process.env.SEARCH) for (const q of ['whisper-base-ar-quran', 'whisper-tiny-ar-quran', 'whisper-small-ar-quran', 'ar-quran-onnx', 'quran onnx', 'tarteel']) {
  const r = await api(`models?search=${encodeURIComponent(q)}&limit=50`);
  if (Array.isArray(r)) for (const m of r) { console.log(`  [${q}] ${m.id} ${(m.tags || []).filter((t) => /onnx|transformers.js|whisper/.test(t)).join(',')} dl=${m.downloads}`); found.add(m.id); }
}
const cands = [...new Set([...AI_MODELS.map((m) => m.id), ...EXTRA, ...[...found].filter((id) => /onnx/i.test(id))])];
const avail = {}, test = new Set([...AI_MODELS.map((m) => m.id), ...EXTRA]);
console.log('== File lists');
for (const id of cands) {
  const f = await files(id);
  if (f.error) { console.log(`  ${id}: HTTP ${f.error}`); continue; }
  console.log(`  ${id}\n    top: ${f.top.join(' ')}\n    onnx: ${f.onnx.join(' | ')}`);
  const names = f.onnx.map((s) => s.split(' ')[0]);
  const ok = Object.keys(SUFFIX).filter((d) => names.includes(`encoder_model${SUFFIX[d]}.onnx`) && names.includes(`decoder_model_merged${SUFFIX[d]}.onnx`));
  console.log(`    dtypes with encoder + merged decoder: ${ok.join(', ') || 'none'}`);
  if (test.has(id)) avail[id] = ok;
}
if (!AUDIO) process.exit(0);

const clips = fs.readdirSync(AUDIO).filter((f) => f.endsWith('.f32')).sort().map((f) => {
  const b = fs.readFileSync(AUDIO + '/' + f); return { name: f, audio: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
});
console.log(`== Audio: ${clips.map((c) => `${c.name} ${(c.audio.length / RATE).toFixed(1)}s`).join(', ')}`);

// as asr-worker.js
function langExtra(p) {
  const g = p.model.generation_config || {}, ids = p.tokenizer.model.tokens_to_ids;
  if (g.lang_to_id && g.lang_to_id['<|ar|>'] != null) return {};
  return { is_multilingual: true, lang_to_id: { '<|ar|>': ids.get('<|ar|>') }, task_to_id: { transcribe: ids.get('<|transcribe|>') }, no_timestamps_token_id: g.no_timestamps_token_id ?? ids.get('<|notimestamps|>') };
}
const run = async (p, x, audio) => (((await p(audio, { language: 'arabic', task: 'transcribe', max_new_tokens: Math.min(440, 20 + Math.ceil((audio.length / 16000) * 25)), ...x })) || {}).text || '').trim();

const results = [];
console.log('== Per-verse transcription (Node, onnxruntime-node CPU)');
for (const id of Object.keys(avail)) for (const dtype of avail[id].filter((d) => TRY.includes(d))) {
  let p;
  const t0 = Date.now();
  try { p = await pipeline('automatic-speech-recognition', id, { dtype }); } catch (e) { console.log(`  ${id} ${dtype}: LOAD FAILED ${e.message}`); continue; }
  const x = langExtra(p);
  console.log(`  ${id} ${dtype}: loaded in ${Date.now() - t0} ms; generation_config has <|ar|>: ${!Object.keys(x).length}`);
  const all = []; let ms = 0;
  for (const [i, c] of clips.entries()) {
    const t = Date.now(); let text;
    try { text = await run(p, x, c.audio); } catch (e) { text = 'ERROR ' + e.message; }
    const d = Date.now() - t; ms += d; all.push(text);
    console.log(`    ${c.name} ${d} ms: ${text}\n      clean: ${JSON.stringify(clean(text, c.audio.length / RATE))}${expected[i] ? '\n      expect: ' + expected[i] : ''}`);
  }
  const s = score(all.join(' '));
  console.log(`    => ${s}; ${ms} ms total`);
  results.push({ id, dtype, s, ms, p, x, done: +s.split('/')[0] });
}

// The app's streaming on the whole recitation, fed in real time in 40 ms blocks, with the best model.
results.sort((a, b) => b.done - a.done || a.ms - b.ms);
for (const best of results.slice(0, +(process.env.STREAM_MODELS || 2))) {
  console.log(`== Streaming simulation with ${best.id} ${best.dtype}`);
  const whole = new Float32Array(clips.reduce((n, c) => n + c.audio.length, 0)); let o = 0;
  for (const c of clips) { whole.set(c.audio, o); o += c.audio.length; }
  const finals = []; let partial = ''; const t0 = Date.now(); const times = [];
  const st = createStreamer({
    transcribe: async (a, { final }) => { const t = Date.now(); const r = await run(best.p, best.x, a); times.push(Date.now() - t); console.log(`    ${((Date.now() - t0) / 1000).toFixed(1)}s ${final ? 'FINAL  ' : 'partial'} ${(a.length / RATE).toFixed(1)}s audio, ${Date.now() - t} ms: ${r}`); return r; },
    onPartial: (t) => { partial = t; },
    onFinal: (t) => { finals.push(t); partial = ''; },
  });
  const B = 640;
  for (let i = 0; i < whole.length; i += B) { st.push(whole.subarray(i, i + B)); await new Promise((r) => setTimeout(r, 40)); }
  await st.flush();
  console.log(`    finals: ${JSON.stringify(finals)}\n    => ${score(finals.join(' '))}; ${times.length} calls, mean ${Math.round(times.reduce((a, b) => a + b, 0) / Math.max(1, times.length))} ms, max ${Math.max(0, ...times)} ms`);
}
process.exit(0);
