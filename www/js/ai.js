// Optional voice engine: Tarteel AI's Qur'an-trained Whisper model (tarteel-ai/whisper-base-ar-quran) run on this
// device with transformers.js. The library and the model download once, on first use, and are cached for offline use.
import { createStreamer, createResampler, RATE } from './stream.js';

// Pinned: sw.js caches this exact version, and transformers.js fetches its ONNX runtime files from the same folder.
export const AI_LIB = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/transformers.min.js';
// ONNX exports of tarteel-ai/whisper-base-ar-quran, tried in order until one loads and runs. WebGPU entries are
// skipped without a GPU adapter. dtype is one value or one per file (encoder_model, decoder_model_merged).
export const AI_MODELS = [
  { id: 'yaltaieh/whisper-base-ar-quran-onnx', device: 'webgpu', dtype: 'q4' },
  { id: 'yaltaieh/whisper-base-ar-quran-onnx', device: 'wasm', dtype: 'q8' },
  { id: 'yaltaieh/whisper-base-ar-quran-onnx', device: 'wasm', dtype: { encoder_model: 'q4', decoder_model_merged: 'bnb4' } },
  { id: 'Mustanad/whisper-base-ar-quran-onnx', device: 'wasm', dtype: 'q8' },
  { id: 'Rayen0/whisper-base-ar-quran-onnx', device: 'wasm', dtype: 'q8' },
];
export const AI_MB = 100; // shown before the first download: the model (about 75 MB) and the runtime

export const aiSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof WebAssembly === 'object'
  && typeof Worker === 'function' && !!(window.AudioContext || window.webkitAudioContext);
export const aiInfo = { device: '', model: '' };

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
      if (m.type === 'ready') { Object.assign(aiInfo, { device: m.device, model: m.model }); cbs.forEach((cb) => cb(null, 1, null)); }
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
  worker = null; ready = null; files = {}; aiInfo.device = ''; aiInfo.model = '';
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
export function unloadModel(ms = 0) { if (!sessions && worker) idle(ms); }

/** Download (once) and load the model. onProgress(message, fraction) while it downloads. */
export function loadModel(onProgress) {
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

/** Is a downloaded copy of the model in the browser's cache (so it works offline)? */
export async function modelCached() {
  try {
    const keys = await (await caches.open('transformers-cache')).keys();
    return AI_MODELS.some((m) => keys.some((k) => k.url.includes('/' + m.id + '/') && /\.onnx$/.test(k.url)));
  } catch (_) { return false; }
}

function transcribe(audio) {
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
    try { s = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
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
