// Runs the Qur'an speech model away from the page so the Mushaf stays smooth. Started only for the Qur'an AI engine.
let asr = null, info = null, extra = {}, loading = null, abort = null;
const post = (m) => self.postMessage(m);
// An error thrown outside a call (inside the runtime) must not leave anyone waiting for ever: while a model is being
// tried it fails that try (the next one is tried), otherwise the page is told.
const fatal = (e) => { if (abort) abort(e instanceof Error ? e : new Error(String((e && e.message) || e || 'error'))); else post({ type: 'fatal', message: String((e && e.message) || e || 'error') }); };
self.addEventListener('error', (e) => { e.preventDefault(); fatal(e.error || e.message); }); // handled here, not by the page's onerror
self.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fatal(e.reason); });

self.onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    loading = loading || load(m).catch((e) => { loading = null; throw e; });
    loading.then(() => post({ type: 'ready', ...info }), (e) => post({ type: 'error', message: String((e && e.message) || e), kind: e && e.kind }));
  } else if (m.type === 'run') {
    try { post({ type: 'result', id: m.id, text: await run(asr, m.audio) }); }
    catch (e) { post({ type: 'result', id: m.id, error: String((e && e.message) || e) }); }
  }
};

// Hugging Face sometimes answers a file request with a passing error (seen: 405, 429, 5xx) or drops it: try again
// before giving up on a model. The library fetches through the global fetch, so this covers the model files too.
const net = self.fetch.bind(self);
const RETRY = [405, 408, 425, 429, 500, 502, 503, 504];
self.fetch = async (url, opts) => {
  for (let i = 0; ; i++) {
    let r = null, err = null;
    try { r = await net(url, opts); } catch (e) { err = e; }
    if ((r && !RETRY.includes(r.status)) || i >= 3) { if (r) return r; throw err; }
    await new Promise((res) => setTimeout(res, 800 * 2 ** i));
  }
};

// The library and the ONNX runtime are kept in the Cache API (as the model files are by the library), so the engine
// works offline after first use, also in the Android app, where no service worker runs.
async function cached(url) {
  const c = await caches.open('tilawa-ai').catch(() => null);
  let r = c && (await c.match(url));
  if (!r) {
    r = await fetch(url).catch((e) => { throw Object.assign(new Error(`Download failed: ${url}`), { kind: 'download', cause: e }); });
    if (!r.ok) throw Object.assign(new Error(`Download failed (${r.status}): ${url}`), { kind: 'download' });
    if (c) await c.put(url, r.clone()).catch(() => {});
  }
  return r;
}
// Run as a blob: URL, a module's import.meta.url is that blob, against which no relative path resolves (the runtime's
// glue builds its .wasm path that way even when it is given the binary), so it is set back to the real address.
const script = async (url) => URL.createObjectURL(new Blob([(await (await cached(url)).text()).replaceAll('import.meta.url', JSON.stringify(url))], { type: 'text/javascript' }));

async function load({ lib, models }) {
  const dir = lib.slice(0, lib.lastIndexOf('/') + 1);
  const { pipeline, env } = await import(await script(lib)).catch((e) => { throw Object.assign(e, { kind: e.kind || 'run' }); });
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = { mjs: await script(dir + 'ort-wasm-simd-threaded.jsep.mjs') };
  env.backends.onnx.wasm.wasmBinary = await (await cached(dir + 'ort-wasm-simd-threaded.jsep.wasm')).arrayBuffer();
  let gpu = false;
  try { gpu = !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) {}
  let err = null, ran = false;
  for (const c of models) {
    if (c.device === 'webgpu' && !gpu) continue;
    let p = null, x = {}, gone = false, ms = 0;
    try {
      await Promise.race([new Promise((_, rej) => (abort = rej)), (async () => {
        const q = await pipeline('automatic-speech-recognition', c.id, {
          device: c.device, dtype: c.dtype,
          progress_callback: (e) => { if (e.status === 'progress' && !gone) post({ type: 'progress', name: e.name, file: e.file, loaded: e.loaded, total: e.total }); },
        });
        if (gone) { q.dispose().catch(() => {}); return; } // this try was given up while it loaded
        p = q;
        // Some exports carry an old generation config without the language tokens: give them from the tokenizer.
        const g = p.model.generation_config || {}, ids = p.tokenizer.model.tokens_to_ids;
        if (!(g.lang_to_id && g.lang_to_id['<|ar|>'] != null)) x = { is_multilingual: true, lang_to_id: { '<|ar|>': ids.get('<|ar|>') }, task_to_id: { transcribe: ids.get('<|transcribe|>') }, no_timestamps_token_id: g.no_timestamps_token_id ?? ids.get('<|notimestamps|>') };
        await run(p, new Float32Array(16000), x); // compiles the model now, and fails here rather than mid-recitation
        const t = performance.now(); await run(p, new Float32Array(16000), x); ms = Math.round(performance.now() - t);
      })()]);
      asr = p; extra = x; info = { device: c.device, model: c.id, dtype: c.dtype, ms, threads: env.backends.onnx.wasm.numThreads, isolated: !!self.crossOriginIsolated };
      return;
    } catch (e) {
      gone = true; err = e; console.warn('Tilawa: could not use', c.id, 'on', c.device, e);
      if (!downloadError(e)) ran = true; // its files came, but it would not run
      if (p) p.dispose().catch(() => {});
    } finally { abort = null; }
  }
  throw Object.assign(err || new Error('No model could be loaded.'), { kind: ran ? 'run' : 'download' });
}
// transformers.js reports a failed download as a fetch TypeError or as its HTTP-status message ending in the file's URL
const downloadError = (e) => !!e && (e.kind === 'download' || e instanceof TypeError || /^(Could not locate file|Unauthorized access to file|Forbidden access to file|.* occurred while trying to load file): "https?:/.test(e.message));

// Plain transcription. The expected verse is deliberately not given to the model as a prompt: it would then hear
// the right word when the reader says a wrong one, hiding the very mistakes the app is there to show.
async function run(p, audio, x = extra) {
  if (!p) throw new Error('The model is not loaded.');
  const out = await p(audio, { language: 'arabic', task: 'transcribe', max_new_tokens: Math.min(440, 20 + Math.ceil((audio.length / 16000) * 25)), ...x });
  return ((out && out.text) || '').trim();
}
