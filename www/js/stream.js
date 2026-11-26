// Live phrases from a model that only transcribes whole clips (Whisper): an energy VAD finds speech, the phrase so
// far is transcribed again while it grows (partials) and once more after a pause (final). No browser APIs here, so
// the tests run it under Node with a fake transcriber.
export const RATE = 16000;
const FRAME = 480; // 30 ms
const DEFAULTS = {
  preroll: 0.3,      // audio kept from just before speech is detected
  onset: 0.09,       // this much voiced audio in a row starts a phrase
  endSilence: 0.7,   // a pause this long ends it
  tail: 0.25,        // silence kept after the last word
  partialEvery: 1.0, // new audio before the phrase is transcribed again
  minSpeech: 0.25,   // less voiced audio than this is a click or a cough: never transcribed
  maxPhrase: 20,     // Whisper hears 30 s at most: a longer phrase is cut at a quiet point
  minRms: 0.008, snr: 3, floorWindow: 4,
};
const AR = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;
// what Whisper models say over silence or noise (subtitle credits, "subscribe"); none of these words is in the Qur'an
const JUNK = /اشترك|القناة|للمشاهدة|نانسي|قنقر|ترجمة|موسيقى|المترجم/;

/** The words of a transcript worth keeping: '' for nothing heard, null for an output that is clearly not what was said. */
export function clean(text, seconds) {
  const s = (text || '').trim();
  if (!s) return '';
  const letters = s.match(/\p{L}/gu) || [];
  if (letters.filter((c) => AR.test(c)).length < letters.length * 0.8 || JUNK.test(s)) return null;
  let w = s.replace(/[^\s؀-ۿݐ-ݿࢠ-ࣿ]/g, ' ').split(/\s+/).filter(Boolean);
  // the same word or few words over and over is the model stuck in a loop: keep them once and drop the rest
  loop: for (let n = 1; n <= 4; n++) for (let i = 0; i + 4 * n <= w.length; i++) {
    let k = 1;
    while (i + (k + 1) * n <= w.length && w.slice(i + k * n, i + (k + 1) * n).join(' ') === w.slice(i, i + n).join(' ')) k++;
    if (k >= 4) { w = w.slice(0, i + n); break loop; }
  }
  if (w.length > 3 + seconds * 4) return null; // more words than anyone can recite in that time
  return w.join(' ');
}

/** Resampler for microphone blocks at the device rate, keeping its place between blocks. A windowed-sinc low-pass
 *  (Blackman, cut-off just under the new Nyquist) runs first, so fricatives above 8 kHz do not fold back as noise. */
export function createResampler(from, to = RATE) {
  if (from === to) return (x) => Float32Array.from(x);
  const step = from / to, fc = 0.45 / step, K = Math.ceil(16 * step), P = 64;
  const table = Array.from({ length: P }, (_, p) => { // taps for each fractional position of the output sample
    const h = new Float32Array(2 * K); let sum = 0;
    for (let i = 0; i < 2 * K; i++) {
      const d = i - K + 1 - p / P, x = Math.PI * (d / K + 1); // x: 0..2π across the window
      const w = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
      sum += h[i] = (d ? Math.sin(2 * Math.PI * fc * d) / (Math.PI * d) : 2 * fc) * w;
    }
    return h.map((v) => v / sum);
  });
  let buf = new Float32Array(0), base = 0, k = 0; // base: stream index of buf[0]; k: next output sample
  return (x) => {
    const b = new Float32Array(buf.length + x.length); b.set(buf); b.set(x, buf.length); buf = b;
    const out = [];
    for (;;) {
      const t = k * step, n0 = Math.floor(t);
      if (n0 + K >= base + buf.length) break; // needs K samples ahead
      const h = table[Math.floor((t - n0) * P)], s0 = n0 - K + 1 - base;
      let acc = 0;
      for (let i = Math.max(0, -s0); i < 2 * K; i++) acc += buf[s0 + i] * h[i];
      out.push(acc); k++;
    }
    const drop = Math.floor(k * step) - K + 1 - base;
    if (drop > 0) { buf = buf.slice(drop); base += drop; }
    return Float32Array.from(out);
  };
}

const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };
const join = (fr) => { const a = new Float32Array(fr.length * FRAME); fr.forEach((f, i) => a.set(f, i * FRAME)); return a; };
const count = (fl) => fl.reduce((a, b) => a + b, 0);
const nwords = (t) => (t || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * transcribe(Float32Array at 16 kHz, {final}) -> Promise<string>. Feed audio with push(); onPartial(text) gets the
 * whole phrase so far, onFinal(text) commits it. cut(): the words sent so far in this phrase have been used, so
 * they are not sent again. flush() ends the phrase in progress and resolves once everything is transcribed.
 */
export function createStreamer({ transcribe, onPartial, onFinal, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const F = (s) => Math.max(1, Math.round((s * RATE) / FRAME));
  let rest = new Float32Array(0);
  let frames = [], flags = [], levels = []; // the phrase (or, between phrases, the pre-roll), frame by frame
  const recent = [];                         // levels of the last few seconds, for the background noise level
  let speaking = false, run = 0, sil = 0, id = 0, asked = 0, closed = false;
  let last = { id: -1, text: '', n: 0 };     // the latest partial sent: its phrase, its text, the frames it covered
  const queue = []; let cur = null, idle = [];

  function floor() {
    const a = recent.slice().sort((x, y) => x - y);
    return a.length ? a[Math.floor(a.length * 0.05)] : 0; // speech always has short dips; steady noise does not
  }
  function frame(x) {
    const e = rms(x);
    const v = e > Math.max(o.minRms, floor() * o.snr) ? 1 : 0;
    recent.push(e); if (recent.length > F(o.floorWindow)) recent.shift();
    frames.push(x); flags.push(v); levels.push(e);
    if (!speaking) {
      run = v ? run + 1 : 0;
      if (run >= F(o.onset)) { speaking = true; sil = 0; id++; asked = 0; }
      else { const keep = F(o.preroll) + F(o.onset); if (frames.length > keep) { frames.splice(0, frames.length - keep); flags.splice(0, flags.length - keep); levels.splice(0, levels.length - keep); } }
      return;
    }
    sil = v ? 0 : sil + 1;
    if (sil >= F(o.endSilence)) {
      finalize(frames.length - sil + F(o.tail));
      speaking = false; run = 0;
      const keep = F(o.preroll); frames = frames.slice(-keep); flags = flags.slice(-keep).fill(0); levels = levels.slice(-keep);
    } else if (frames.length >= F(o.maxPhrase)) {
      let at = frames.length - F(0.5), lo = Infinity; // the quietest moment of the last few seconds
      for (let i = frames.length - F(4); i < frames.length - F(0.5); i++) if (levels[i] < lo) { lo = levels[i]; at = i + 1; }
      finalize(at);
      frames = frames.slice(at); flags = flags.slice(at); levels = levels.slice(at); id++; asked = 0;
    } else maybePartial();
  }
  function maybePartial() {
    if (!speaking || cur || queue.length || frames.length - asked < F(o.partialEvery) || count(flags) < F(o.minSpeech)) return;
    asked = frames.length;
    enqueue({ id, final: false, n: frames.length, audio: join(frames) });
  }
  function finalize(end) {
    const fl = flags.slice(0, end);
    if (count(fl) < F(o.minSpeech) && last.id !== id) return;
    enqueue({ id, final: true, audio: join(frames.slice(0, end)), strip: 0 });
  }
  function enqueue(job) { queue.push(job); next(); }
  function next() {
    if (cur || !queue.length) { if (!cur && !queue.length) { idle.forEach((r) => r()); idle = []; } return; }
    const job = cur = queue.shift();
    const sec = job.audio.length / RATE;
    Promise.resolve().then(() => transcribe(job.audio, { final: job.final })).then((t) => clean(t, sec), () => null).then((t) => {
      cur = null;
      if (!job.final) {
        if (t !== null && job.id === id) { last = { id: job.id, text: t, n: job.n }; onPartial(t); }
      } else {
        if (t === null) t = last.id === job.id ? last.text : '';
        if (job.strip) t = t.split(/\s+/).filter(Boolean).slice(job.strip).join(' ');
        if (last.id === job.id) last = { id: -1, text: '', n: 0 };
        if (t) onFinal(t); else onPartial('');
      }
      next(); maybePartial();
    });
  }

  return {
    get speaking() { return speaking; },
    push(chunk) {
      if (closed || !chunk || !chunk.length) return;
      let a = chunk;
      if (rest.length) { a = new Float32Array(rest.length + chunk.length); a.set(rest); a.set(chunk, rest.length); }
      let i = 0;
      for (; i + FRAME <= a.length; i += FRAME) frame(a.slice(i, i + FRAME));
      rest = a.slice(i);
    },
    cut() {
      if (!last.text) return;
      const pending = (cur && cur.final && cur.id === last.id) ? cur : queue.find((j) => j.final && j.id === last.id);
      if (pending) pending.strip = nwords(last.text); // the phrase has ended: its final text loses those words
      else if (speaking && last.id === id) {           // still speaking: drop the audio those words came from
        frames = frames.slice(last.n); flags = flags.slice(last.n); levels = levels.slice(last.n); id++; asked = 0;
      }
      last = { id: -1, text: '', n: 0 };
    },
    flush() {
      if (!closed) {
        closed = true;
        if (speaking) { finalize(frames.length - Math.max(0, sil - F(o.tail))); speaking = false; }
      }
      return new Promise((r) => { idle.push(r); next(); });
    },
  };
}
