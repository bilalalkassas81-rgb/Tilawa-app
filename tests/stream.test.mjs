// The Qur'an AI engine's phrase streaming: partials while speaking, a final after a pause, the 20 s cap, cut() at a
// page turn, stop(), silence and noise never transcribed, and hallucinated output dropped.
// Synthetic audio: each "word" is a tone burst whose pitch says which word it is, so the fake transcriber can
// "hear" exactly the words in the clip it is given. Run: node tests/stream.test.mjs  (exits non-zero on failure)
import { createStreamer, createResampler, clean, RATE } from '../www/js/stream.js';
let failed = 0;
const check = (ok, name, info = '') => { if (!ok) failed++; console.log(ok ? 'PASS' : 'FAIL', name, info); };

const WORDS = 'بسم الله الرحمن الرحيم الحمد لله رب العالمين الرحمن الرحيم مالك يوم الدين اياك نعبد واياك نستعين اهدنا الصراط المستقيم صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين'.split(' ');
const freq = (i) => 300 + 40 * i;
let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const noise = (s, a = 0.002) => Float32Array.from({ length: Math.round(s * RATE) }, () => a * rnd());
const tone = (i, s, a = 0.2) => Float32Array.from({ length: Math.round(s * RATE) }, (_, n) => a * Math.sin((2 * Math.PI * freq(i) * n) / RATE) + 0.002 * rnd());
const cat = (...xs) => { const a = new Float32Array(xs.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of xs) { a.set(x, o); o += x.length; } return a; };
const speech = (from, to, word = 0.4, gap = 0.1) => cat(...Array.from({ length: to - from }, (_, k) => cat(tone(from + k, word), noise(gap))));

// sign changes of the loud samples only, between the first and the last one, so the noise around a burst is ignored
function pitch(seg) {
  let sign = 0, n = 0, first = -1, lastAt = -1;
  for (let i = 0; i < seg.length; i++) {
    if (Math.abs(seg[i]) < 0.05) continue;
    const s = seg[i] > 0 ? 1 : -1;
    if (sign && s !== sign) { n++; if (first < 0) first = i; lastAt = i; }
    sign = s;
  }
  return n > 1 ? ((n - 1) / 2) / ((lastAt - first) / RATE) : 0;
}
// The fake model: finds the bursts and names each by its pitch. Each run "takes" `latency` seconds of audio time.
function fakeModel({ latency = 0.4, out } = {}) {
  const m = { calls: [], pending: [], now: 0 };
  m.transcribe = (audio, { final }) => {
    m.calls.push({ final, sec: audio.length / RATE });
    const words = []; const F = 480;
    let start = -1;
    for (let f = 0; f <= audio.length / F; f++) {
      const x = audio.subarray(f * F, (f + 1) * F); let e = 0; for (const v of x) e += v * v;
      const on = x.length && Math.sqrt(e / x.length) > 0.05;
      if (on && start < 0) start = f;
      if (!on && start >= 0) {
        if (f - start >= 3) words.push(WORDS[Math.round((pitch(audio.subarray(start * F, f * F)) - 300) / 40)]);
        start = -1;
      }
    }
    const text = out ? out(words, final) : words.join(' ');
    return new Promise((res) => m.pending.push({ due: m.now + latency, res: () => res(text) }));
  };
  m.tick = (s) => { m.now += s; const due = m.pending.filter((p) => p.due <= m.now + 1e-9); m.pending = m.pending.filter((p) => p.due > m.now + 1e-9); due.forEach((p) => p.res()); };
  m.drain = () => { m.pending.splice(0).forEach((p) => p.res()); };
  return m;
}
const tickle = () => new Promise((r) => setImmediate(r));
// Feed audio in 20 ms blocks as a microphone would, letting the fake model finish runs as time passes.
async function feed(st, m, audio, hooks = {}) {
  const B = 320;
  for (let i = 0; i < audio.length; i += B) {
    st.push(audio.subarray(i, i + B)); m.tick(B / RATE);
    await tickle();
    if (hooks.each) hooks.each(i / RATE);
  }
}
function setup(model, extra = {}) {
  const log = { partials: [], finals: [] };
  const st = createStreamer({ transcribe: model.transcribe, onPartial: (t) => log.partials.push(t), onFinal: (t) => log.finals.push(t), ...extra });
  return { st, log };
}
async function finish(st, m) { const p = st.flush(); for (let k = 0; k < 50; k++) { m.drain(); await tickle(); } await p; }

// S1 one phrase: partials grow while speaking, one final after the pause
{
  const m = fakeModel(); const { st, log } = setup(m);
  await feed(st, m, cat(noise(0.6), speech(0, 7), noise(1.2)));
  const want = WORDS.slice(0, 7).join(' ');
  const growing = log.partials.filter(Boolean).every((p, i, a) => want.startsWith(p) && (!i || p.length >= a[i - 1].length));
  check(log.partials.filter(Boolean).length >= 2 && growing, 'S1 partials arrive while speaking and grow', JSON.stringify(log.partials));
  check(log.finals.length === 1 && log.finals[0] === want, 'S1 one final after the pause with every word', JSON.stringify(log.finals));
  await finish(st, m);
  check(log.finals.length === 1, 'S1 stop() after the final adds nothing');
}
// S2 two phrases separated by a pause; never more than one run at a time
{
  const m = fakeModel({ latency: 1.5 }); const { st, log } = setup(m);
  let most = 0;
  await feed(st, m, cat(noise(0.5), speech(0, 4), noise(1.0), speech(4, 9), noise(1.2)), { each: () => (most = Math.max(most, m.pending.length)) });
  await finish(st, m);
  check(log.finals.length === 2 && log.finals[0] === WORDS.slice(0, 4).join(' ') && log.finals[1] === WORDS.slice(4, 9).join(' '), 'S2 two phrases, two finals in order', JSON.stringify(log.finals));
  check(most <= 2, 'S2 a slow model is never sent a new partial while busy (only a final may wait)', 'max pending ' + most);
}
// S3 silence, background noise and a click are never transcribed
{
  const m = fakeModel(); const { st, log } = setup(m);
  const click = tone(3, 0.03, 0.5);
  await feed(st, m, cat(noise(3), click, noise(2), noise(5, 0.006)));
  await finish(st, m);
  check(m.calls.length === 0 && !log.finals.length, 'S3 silence, noise and a click: nothing sent to the model', JSON.stringify(m.calls));
  // a loud steady background (a fan) is learnt as the noise level; speech over it is still found
  const m2 = fakeModel(); const s2 = setup(m2);
  await feed(s2.st, m2, cat(noise(6, 0.05), speech(0, 4).map((v, i) => v + 0.05 * rnd()), noise(1.5, 0.05)));
  await finish(s2.st, m2);
  check(m2.calls.every((c) => c.sec < 4) && s2.log.finals.join(' ') === WORDS.slice(0, 4).join(' '), 'S3 loud steady noise is not speech; speech over it is', JSON.stringify({ calls: m2.calls.length, finals: s2.log.finals }));
}
// S4 a phrase longer than 20 s is cut at a quiet point and finalized; nothing is lost
{
  const m = fakeModel(); const { st, log } = setup(m);
  const long = cat(speech(0, 30, 0.6, 0.12), speech(0, 30, 0.6, 0.12)); // ~43 s with no pause long enough to end a phrase
  await feed(st, m, cat(noise(0.5), long, noise(1.2)));
  await finish(st, m);
  const all = log.finals.join(' ').split(' ');
  const exp = WORDS.slice(0, 30).concat(WORDS.slice(0, 30));
  check(log.finals.length >= 3 && m.calls.every((c) => c.sec <= 20.01), 'S4 long phrase cut into clips of at most 20 s', `${log.finals.length} finals, longest clip ${Math.max(...m.calls.map((c) => c.sec)).toFixed(1)} s`);
  check(all.join(' ') === exp.join(' '), 'S4 every word kept across the cuts, in order', `${all.length}/${exp.length}`);
}
// S5 cut() while speaking: the words already used are not sent again, and none after them is lost
{
  const m = fakeModel({ latency: 0.2 }); const { st, log } = setup(m);
  let used = null;
  await feed(st, m, cat(noise(0.5), speech(0, 10), noise(1.2)), {
    each: () => { const p = log.partials.at(-1); if (!used && p && p.split(' ').length >= 4) { used = p; st.cut(); } },
  });
  await finish(st, m);
  const n = used.split(' ').length;
  const rest = log.finals.join(' ').split(' ');
  const exp = WORDS.slice(n, 10);
  const ok = rest.join(' ') === exp.join(' ') || rest.join(' ') === [WORDS[n - 1]].concat(exp).join(' ');
  check(!!used && log.finals.length === 1 && ok, 'S5 cut() mid-phrase: the final has only the words after the cut', JSON.stringify({ used, finals: log.finals }));
  const after = log.partials.slice(log.partials.indexOf(used) + 1).filter(Boolean);
  check(after.length && after.every((p) => !p.startsWith(used)), 'S5 later partials do not repeat the used words', JSON.stringify(after));
}
// S6 cut() after the pause, while the final is still being transcribed: the final loses those words
{
  // partials here lag behind (three words at most), so the final has words the app has not seen yet
  const m = fakeModel({ latency: 0.5, out: (w, final) => (final ? w : w.slice(0, 3)).join(' ') }); const { st, log } = setup(m);
  await feed(st, m, cat(noise(0.5), speech(0, 5), noise(0.75)));
  const p = log.partials.at(-1);
  check(m.pending.length === 1 && m.calls.at(-1).final, 'S6 the final is being transcribed');
  st.cut();
  await feed(st, m, noise(1.5));
  await finish(st, m);
  const left = WORDS.slice(p.split(' ').length, 5).join(' ');
  check(!!p && log.finals.join('|') === left, 'S6 cut() while the final is pending strips the used words', JSON.stringify({ p, finals: log.finals, left }));
}
// S7 stop() in the middle of a phrase finalizes it
{
  const m = fakeModel({ latency: 2 }); const { st, log } = setup(m);
  await feed(st, m, cat(noise(0.5), speech(0, 6)));
  check(!log.finals.length, 'S7 no final while still speaking');
  await finish(st, m);
  check(log.finals.length === 1 && log.finals[0] === WORDS.slice(0, 6).join(' '), 'S7 stop() finalizes the phrase in progress', JSON.stringify(log.finals));
  st.push(speech(0, 3)); await tickle();
  check(m.pending.length === 0 && log.finals.length === 1, 'S7 audio after stop() is ignored');
}
// S8 a hallucinated final falls back to the last good partial; hallucinated partials are not shown
{
  const loop = (w, final) => (final ? 'الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله الله' : w.join(' '));
  const m = fakeModel({ out: (w, final) => (final ? 'Thank you for watching!' : w.join(' ')) }); const { st, log } = setup(m);
  await feed(st, m, cat(noise(0.5), speech(0, 6), noise(1.2)));
  await finish(st, m);
  const lastP = log.partials.filter(Boolean).at(-1);
  check(log.finals.length === 1 && log.finals[0] === lastP, 'S8 non-Arabic final replaced by the last partial', JSON.stringify(log.finals));
  const m2 = fakeModel({ out: loop }); const s2 = setup(m2);
  await feed(s2.st, m2, cat(noise(0.5), speech(0, 3), noise(1.2)));
  await finish(s2.st, m2);
  check(s2.log.finals[0] === 'الله', 'S8 a repetition loop is cut to one', JSON.stringify(s2.log.finals));
  const m3 = fakeModel({ out: () => 'English words here' }); const s3 = setup(m3);
  await feed(s3.st, m3, cat(noise(0.5), speech(0, 5), noise(1.2)));
  await finish(s3.st, m3);
  check(!s3.log.partials.some(Boolean) && !s3.log.finals.length, 'S8 nothing shown when every output is hallucinated', JSON.stringify(s3.log));
}

// clean(): the hallucination filter on its own
check(clean('', 2) === '' && clean('   ', 2) === '', 'C1 empty stays empty');
check(clean('بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ.', 3) === 'بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ', 'C2 diacritics kept, punctuation dropped');
check(clean('Subscribe to the channel', 3) === null && clean('الحمد لله Thank you very much for watching', 4) === null, 'C3 mostly non-Arabic text rejected');
check(clean('اشتركوا في القناة', 3) === null && clean('ترجمة نانسي قنقر', 3) === null, 'C4 Whisper silence phrases rejected');
check(clean('رب العالمين رب العالمين رب العالمين رب العالمين رب العالمين', 20) === 'رب العالمين', 'C5 a phrase looped four times or more is kept once');
check(clean('رب العالمين رب العالمين الرحمن', 3) === 'رب العالمين رب العالمين الرحمن', 'C6 a reader repeating a phrase once is kept');
check(clean(WORDS.join(' '), 1) === null && clean(WORDS.slice(0, 8).join(' '), 3) !== null, 'C7 more words than the audio could hold rejected');

// resampler: 48 kHz to 16 kHz keeps length and pitch across uneven blocks
{
  const rs = createResampler(48000);
  const x = Float32Array.from({ length: 48000 }, (_, n) => Math.sin((2 * Math.PI * 440 * n) / 48000));
  const parts = []; for (let i = 0; i < x.length; i += 997) parts.push(rs(x.subarray(i, i + 997)));
  const y = cat(...parts); let zc = 0; for (let i = 1; i < y.length; i++) if ((y[i - 1] < 0) !== (y[i] < 0)) zc++;
  check(Math.abs(y.length - 16000) <= 1 && Math.abs(zc / 2 - 440) <= 2, 'R1 48 kHz → 16 kHz', `${y.length} samples, ${zc / 2} Hz`);
  const r44 = createResampler(44100); const z = r44(new Float32Array(44100));
  check(Math.abs(z.length - 16000) <= 1, 'R2 44.1 kHz → 16 kHz', z.length + ' samples');
}

if (failed) { console.error(failed + ' stream test(s) failed'); process.exit(1); }
console.log('all stream tests passed');
process.exit(0);
