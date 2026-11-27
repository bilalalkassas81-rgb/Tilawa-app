// Optional voice engine: Tarteel AI's Qur'an-trained Whisper models (tarteel-ai/whisper-base-ar-quran and
// whisper-tiny-ar-quran) run on this device. In the Android app natively, with whisper.cpp (the plugin "Whisper",
// android/app/src/main/cpp); in the web app with transformers.js in a worker. The model downloads once, on first use,
// and is kept for offline use. Either way the page reads the microphone and stream.js finds the phrases.
import { createStreamer, createResampler, RATE } from './stream.js';

const Cap = typeof window === 'object' ? window.Capacitor : null;
const NW = Cap && Cap.isNativePlatform && Cap.isNativePlatform() && Cap.Plugins ? Cap.Plugins.Whisper : null;
// The Android app's models: converted to whisper.cpp's format and quantized by .github/workflows/models.yml, published
// once as assets of this repository's release models-v1. sha256 is checked after the download.
const REL = 'https://github.com/bilalalkassas81-rgb/Tilawa-app/releases/download/models-v1/';
export const NATIVE_MODELS = {
  'base-q8_0': { file: 'ggml-tarteel-base-q8_0.bin', mb: 82, sha256: '72194195f7d280adebec57acf2c6e01e209484322ec1cec21c275a3c0b1e3d77' },
  'base-q5_1': { file: 'ggml-tarteel-base-q5_1.bin', mb: 60, sha256: 'acc1f03c8b1468b674b4fab50e0b2312cff982ba0001cd16fe36ca23862b6536' },
  'tiny-q8_0': { file: 'ggml-tarteel-tiny-q8_0.bin', mb: 44, sha256: 'ef01ab441b004f9e6f1ea98d397b43452b3a45efab7c3928ab37af655dde8b52' },
  'tiny-q5_1': { file: 'ggml-tarteel-tiny-q5_1.bin', mb: 32, sha256: 'af8dfdd73c60b32e4e6d72e98e095e33fbeb04b9d39508580d051aa28202c646' },
};
// model: which of the above ('' = chosen for the phone, see pickNative). margin: the encoder hears the clip plus this
// many seconds instead of Whisper's whole 30 s window (-1 = the whole window), which makes a short phrase many times
// cheaper. beam: 1 = greedy. threads: 0 = the plugin's choice. (window.__tilawaNative overrides these, for tests.)
export const NATIVE = { model: '', margin: 1, beam: 1, threads: 0, ...(typeof window === 'object' && window.__tilawaNative) };
let NM = NATIVE_MODELS[NATIVE.model] || NATIVE_MODELS['base-q8_0'];
export const nativeAi = !!NW;
// The base model follows best; the tiny one is 2.5 times faster (both measured in tests/native and the emulator).
// Phones with at least 3 cores of 2.1 GHz or more and the ARMv8.2 dot product get base, others tiny. A model already
// downloaded is kept.
const nativePick = NW ? (async () => {
  if (NATIVE_MODELS[NATIVE.model]) return NM;
  for (const k of ['base-q8_0', 'tiny-q8_0']) {
    const c = await NW.cached({ file: NATIVE_MODELS[k].file }).catch(() => ({}));
    if (c.cached) { NM = NATIVE_MODELS[k]; AI_MB = NM.mb; return NM; }
  }
  const d = await NW.device().catch(() => ({}));
  const fast = (d.mhz || []).filter((m) => m >= 2100).length;
  const strong = fast >= 3 && (/asimddp/.test(d.features || '') || /x86/.test(d.abi || ''));
  NM = NATIVE_MODELS[strong ? 'base-q8_0' : 'tiny-q8_0'];
  AI_MB = NM.mb;
  return NM;
})() : null;
/** Resolves once the Android app has chosen its model (AI_MB is then that model's size). */
export const nativeChosen = nativePick ? nativePick.catch(() => {}) : Promise.resolve();
const ctxFor = (sec) => (NATIVE.margin < 0 ? 0 : Math.min(1500, Math.ceil((sec + NATIVE.margin) * 50)));

// Pinned: sw.js caches this exact version, and transformers.js fetches its ONNX runtime files from the same folder.
export const AI_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js';
// ONNX exports, tried in order until one loads and runs. dtype is one value or one per file (encoder_model,
// decoder_model_merged). Checked with real recitation in Chromium (tests/e2e): Whisper always hears a 30 s window, so
// every run costs about the same however short the clip: on one desktop core (WebAssembly in a page runs on one thread)
// about 3.5 s for base and 2.3 s for tiny, and about four times that in an Android emulator's WebView. Phones get the
// tiny model, which follows nearly as well and keeps up. Exports whose encoder has quantized convolutions
// (ConvInteger) do not run in the browser runtime. WebGPU (desktop only) runs the encoder at full precision.
const BASE = [
  { id: 'yaltaieh/whisper-base-ar-quran-onnx', device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  { id: 'yaltaieh/whisper-base-ar-quran-onnx', device: 'wasm', dtype: 'q8' },
  { id: 'Mustanad/whisper-base-ar-quran-onnx', device: 'wasm', dtype: 'q8' },
];
const TINY = [
  { id: 'Sharjeelbaig/whisper-tiny-ar-quran-onnx', device: 'wasm', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' } },
  { id: 'omartariq612/whisper-tiny-ar-quran-onnx', device: 'wasm', dtype: 'q4' },
];
const phone = typeof navigator === 'object' && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || '')));
export const AI_MODELS = phone ? [...TINY, ...BASE.filter((m) => m.device === 'wasm')] : [...BASE, ...TINY];
// shown before the first download: the model (and in the web app the runtime, about 22 MB)
export let AI_MB = NW ? NM.mb : phone ? 85 : 100; // native: updated once the model for this phone is chosen

export const aiSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && !!(window.AudioContext || window.webkitAudioContext)
  && (!!NW || (typeof WebAssembly === 'object' && typeof Worker === 'function'));
export const aiInfo = { device: '', model: '', ms: 0 };
/** For the version line: e.g. "native, base q8_0, 0.21 s". */
export function aiLabel() {
  if (!aiInfo.device) return '';
  const m = (aiInfo.model.match(/(base|tiny)-(q\w+|f16)/) || [])[0];
  return `${aiInfo.device}, ${m ? m.replace('-', ' ') : /tiny/.test(aiInfo.model) ? 'tiny' : 'base'}, ${(aiInfo.ms / 1000).toFixed(aiInfo.ms < 1000 ? 2 : 1)} s`;
}
// One pass of the warm-up taking longer than this: too slow to follow recitation. The web engine always hears 30 s;
// the native one times 2 s of audio (most phrases are a few seconds): slower than that falls behind the reader.
const SLOW_MS = NW ? 2000 : 3000;
export const aiTooSlow = () => aiInfo.ms > SLOW_MS;
const diag = (o) => { if (typeof window === 'object' && window.__tilawaDiag) console.log('DIAG run', JSON.stringify(o)); };

let worker = null, ready = null, loadCbs = [], jobs = new Map(), seq = 0, files = {}, crashCbs = new Set();
let sessions = 0, idleT = 0;
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    if (m.type === 'progress') {
      files[m.name + '/' + m.file] = m; let a = 0, b = 0;
      for (const f of Object.values(files)) if (f.name === m.name && f.total) { a += f.loaded; b += f.total; }
      const msg = b && a < b ? `Downloading the Qur’an model… ${Math.round(a / 1e6)} of ${Math.round(b / 1e6)} MB` : 'Preparing the Qur’an model…';
      loadCbs.forEach((cb) => cb(msg, b ? a / b : 0));
    } else if (m.type === 'ready' || m.type === 'error') {
      const cbs = loadCbs; loadCbs = []; files = {};
      if (m.type === 'ready') { Object.assign(aiInfo, { device: m.device, model: m.model, ms: m.ms }); cbs.forEach((cb) => cb(null, 1, null)); }
      else cbs.forEach((cb) => cb(null, 0, m.message, m.kind));
      if (!sessions) idle(IDLE_MS);
    } else if (m.type === 'fatal') { // an error outside any call: only matters if something is waiting on the worker
      if (loadCbs.length || jobs.size) crash(new Error(m.message)); else console.warn('Tilawa: Qur’an model worker:', m.message);
    } else if (m.type === 'result') {
      const j = jobs.get(m.id); jobs.delete(m.id);
      if (j) { if (m.error) j.rej(new Error(m.error)); else j.res(m.text); }
    }
  };
  worker.onerror = (e) => { e.preventDefault && e.preventDefault(); crash(new Error((e && e.message) || 'The Qur’an model stopped.')); };
  return worker;
}
function reset() {
  clearTimeout(idleT); idleT = 0;
  if (worker) worker.terminate();
  if (NW && aiInfo.device) NW.unload().catch(() => {});
  worker = null; ready = null; files = {}; Object.assign(aiInfo, { device: '', model: '', ms: 0 });
}
// The worker died or threw outside a call. While loading, that is a failed load (the caller falls back to the phone
// engine); with the model loaded, the sessions using it are told it stopped.
function crash(err) {
  const cbs = loadCbs; loadCbs = [];
  reset();
  jobs.forEach((j) => j.rej(err)); jobs.clear();
  if (cbs.length) cbs.forEach((cb) => cb(null, 0, err.message, 'run'));
  else crashCbs.forEach((cb) => cb(err));
}
// The model takes hundreds of MB: let it go when no session has used it for a while.
const IDLE_MS = 10 * 60000;
function idle(ms) {
  clearTimeout(idleT);
  idleT = setTimeout(() => { idleT = 0; if (!sessions && !loadCbs.length && !jobs.size) reset(); }, ms);
}
/** Free the model now (the setting is back on the phone engine) or after `ms` (the app is in the background). Never during a session. */
export function unloadModel(ms = 0) { if (!sessions && (worker || (NW && aiInfo.device))) idle(ms); }

/** Download (once) and load the model. onProgress(message, fraction) while it downloads. */
export function loadModel(onProgress) {
  if (!ready && NW) ready = loadNative();
  if (!ready) {
    ready = new Promise((res, rej) => {
      loadCbs.push((msg, frac, err, kind) => { if (msg === null) (err ? rej(Object.assign(new Error(err), { kind })) : res(aiInfo)); });
      getWorker().postMessage({ type: 'load', lib: AI_LIB, models: AI_MODELS });
    }).catch((e) => {
      reset();
      const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
      console.warn('Tilawa: Qur’an model not loaded:', e);
      throw Object.assign(new Error(offline ? 'The Qur’an AI model needs an internet connection the first time, to download.'
        : e.kind === 'run' ? 'The Qur’an AI model could not run on this device.'
        : 'The Qur’an AI model could not be downloaded. Check your internet connection.'), { code: 'model' });
    });
  }
  if (onProgress) {
    const cb = (msg, frac) => { if (msg !== null) onProgress(msg, frac); };
    loadCbs.push(cb);
    ready.then(() => {}, () => {}).then(() => { loadCbs = loadCbs.filter((x) => x !== cb); });
  }
  return ready;
}
export const modelLoaded = () => !!aiInfo.device;

// The Android app: the model is downloaded by the plugin into the app's own files.
function loadNative() {
  let sub = null;
  return (async () => {
    sub = await NW.addListener('progress', (e) => {
      const a = e.loaded || 0, b = e.total > 0 ? e.total : NM.mb * 1e6;
      const msg = a < b ? `Downloading the Qur’an model… ${Math.round(a / 1e6)} of ${Math.round(b / 1e6)} MB` : 'Preparing the Qur’an model…';
      loadCbs.forEach((cb) => cb(msg, a / b));
    });
    loadCbs.forEach((cb) => cb('Preparing the Qur’an model…', 0));
    await nativePick;
    const r = await NW.load({ url: REL + NM.file, file: NM.file, sha256: NM.sha256, warmCtx: ctxFor(2), threads: NATIVE.threads || 0 });
    // (a phone too slow even for this model falls back to the phone's recogniser: see aiTooSlow)
    Object.assign(aiInfo, { device: 'native', model: NM.file, ms: r.ms, threads: r.threads });
    console.log('Tilawa: Qur’an model (native):', JSON.stringify({ ...r, margin: NATIVE.margin, beam: NATIVE.beam }));
    const cbs = loadCbs; loadCbs = []; cbs.forEach((cb) => cb(null, 1, null));
    if (!sessions) idle(IDLE_MS);
    return aiInfo;
  })().catch((e) => {
    ready = null; loadCbs = [];
    Object.assign(aiInfo, { device: '', model: '', ms: 0 });
    const offline = typeof navigator.onLine === 'boolean' && !navigator.onLine;
    console.warn('Tilawa: Qur’an model (native) not loaded:', e && (e.code || ''), e && e.message);
    throw Object.assign(new Error(offline && e.code === 'download' ? 'The Qur’an AI model needs an internet connection the first time, to download.'
      : e.code === 'download' ? (e.message || 'The Qur’an AI model could not be downloaded. Check your internet connection.')
      : 'The Qur’an AI model could not run on this phone.'), { code: 'model' });
  }).finally(() => { if (sub) sub.remove(); });
}

// int16 PCM as base64, for the bridge to the native engine
function pcm16(audio) {
  const b = new Uint8Array(audio.length * 2), v = new DataView(b.buffer);
  for (let i = 0; i < audio.length; i++) v.setInt16(i * 2, Math.max(-1, Math.min(1, audio[i])) * 32767, true);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
async function transcribeNative(audio) {
  const sec = audio.length / RATE, t = performance.now();
  if (NATIVE.dry) { await new Promise((r) => setTimeout(r, NATIVE.dry)); return ''; } // diagnostics: the engine without the model
  const r = await Promise.race([
    NW.transcribe({ audio: pcm16(audio), audioCtx: ctxFor(sec), beam: NATIVE.beam }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('The Qur’an model took too long.')), 60000)),
  ]);
  diag({ audio: +sec.toFixed(2), ms: Math.round(performance.now() - t), native: r.ms, ctx: r.audioCtx, tokens: r.tokens, text: r.text });
  return r.text || '';
}

/** Is a downloaded copy of the model kept (so it works offline)? */
export async function modelCached() {
  if (NW) { try { await nativePick; return !!(await NW.cached({ file: NM.file })).cached; } catch (_) { return false; } }
  try {
    const keys = await (await caches.open('transformers-cache')).keys();
    return AI_MODELS.some((m) => keys.some((k) => k.url.includes('/' + m.id + '/') && /\.onnx$/.test(k.url)));
  } catch (_) { return false; }
}

function transcribe(audio) {
  if (NW) return transcribeNative(audio);
  return new Promise((res, rej) => {
    const id = ++seq;
    const t = setTimeout(() => { if (jobs.delete(id)) rej(new Error('The Qur’an model took too long.')); }, 60000);
    jobs.set(id, { res: (x) => { clearTimeout(t); res(x); }, rej: (e) => { clearTimeout(t); rej(e); } });
    try { getWorker().postMessage({ type: 'run', id, audio }, [audio.buffer]); } catch (e) { jobs.delete(id); rej(e); }
  });
}

/** The recogniser for speech.js: the same partial/final contract as the phone engines. */
export function createAiEngine({ onPartial, onFinal, onError, onLoad }) {
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, stream = null, nodes = [], streamer = null, stopped = false, counted = false;
  const onCrash = () => { if (!stopped && onError) onError({ code: 'model', message: 'The Qur’an AI model stopped. Tap the microphone to continue.' }); };
  function release() {
    stopped = true; crashCbs.delete(onCrash);
    if (counted) { counted = false; if (!--sessions) idle(IDLE_MS); }
    nodes.forEach((n) => { try { n.disconnect(); } catch (_) {} }); nodes = [];
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close().catch(() => {});
    ctx = null; stream = null;
  }
  async function openMic() {
    let s;
    // No echo cancellation or noise suppression: nothing is played back to cancel, and both are made for calls, where
    // they flatten held, sung vowels (and on Android put the phone in call mode). Whisper copes with room noise itself.
    try { s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } }); }
    catch (e) {
      throw Object.assign(new Error(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'Microphone permission was denied.' : 'The microphone could not be opened.'), { code: e && e.name === 'NotAllowedError' ? 'not_granted' : 'mic' });
    }
    if (stopped) { s.getTracks().forEach((t) => t.stop()); return false; } // stopped while the permission prompt was open
    stream = s;
    let src;
    try { src = ctx.createMediaStreamSource(stream); }
    catch (_) { ctx.close().catch(() => {}); ctx = new AC(); src = ctx.createMediaStreamSource(stream); } // this browser can't resample the mic itself
    const resample = createResampler(ctx.sampleRate, RATE);
    const feed = (x) => { if (!stopped) streamer.push(resample(x)); };
    let node;
    try {
      await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url));
      if (stopped) return false; // release() has already stopped the stream and closed the context
      node = new AudioWorkletNode(ctx, 'tilawa-mic'); node.port.onmessage = (e) => feed(e.data);
    } catch (_) {
      node = ctx.createScriptProcessor(4096, 1, 1); node.onaudioprocess = (e) => feed(Float32Array.from(e.inputBuffer.getChannelData(0)));
    }
    const mute = ctx.createGain(); mute.gain.value = 0; // keeps the graph running without playing the mic back
    src.connect(node); node.connect(mute); mute.connect(ctx.destination);
    nodes = [src, node, mute];
    stream.getAudioTracks().forEach((t) => (t.onended = () => { if (!stopped && onError) onError({ code: 'mic', message: 'The microphone was turned off.' }); }));
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return !stopped;
  }
  return {
    get stream() { return stopped ? null : stream; },
    /** Resolves true once listening, false if stop() came first. */
    async start() {
      // made inside the tap, before anything is awaited, so the browser lets it run
      try { ctx = new AC({ sampleRate: RATE }); } catch (_) { ctx = new AC(); }
      ctx.resume().catch(() => {});
      streamer = createStreamer({ transcribe, onPartial, onFinal });
      sessions++; counted = true; clearTimeout(idleT); idleT = 0;
      try {
        await loadModel(onLoad);
        if (stopped) return false;
        crashCbs.add(onCrash); // from here a dead worker ends the session; before, it is a failed load
        return await openMic();
      } catch (e) { release(); throw e; }
    },
    cut() { streamer && streamer.cut(); },
    async stop() {
      if (stopped && !streamer) return;
      release();
      const s = streamer; streamer = null;
      if (s) await s.flush();
    },
  };
}
