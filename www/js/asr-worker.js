// Runs the Qur'an speech model away from the page so the Mushaf stays smooth. Started only for the Qur'an AI engine.
let asr = null, info = null, extra = {}, loading = null;
const post = (m) => self.postMessage(m);
// an error thrown outside a call (inside the runtime) must not leave the page waiting for ever
const fatal = (e) => post({ type: 'fatal', message: String((e && e.message) || e || 'error') });
self.addEventListener('error', (e) => fatal(e.error || e.message));
self.addEventListener('unhandledrejection', (e) => fatal(e.reason));

self.onmessage = async ({ data: m }) => {
  if (m.type === 'load') {
    loading = loading || load(m).catch((e) => { loading = null; throw e; });
    loading.then(() => post({ type: 'ready', ...info }), (e) => post({ type: 'error', message: String((e && e.message) || e) }));
  } else if (m.type === 'run') {
    try { post({ type: 'result', id: m.id, text: await run(asr, m.audio) }); }
    catch (e) { post({ type: 'result', id: m.id, error: String((e && e.message) || e) }); }
  }
};

// The library and the ONNX runtime are kept in the Cache API (as the model files are by the library), so the engine
// works offline after first use, also in the Android app, where no service worker runs.
async function cached(url) {
  const c = await caches.open('tilawa-ai').catch(() => null);
  let r = c && (await c.match(url));
  if (!r) {
    r = await fetch(url);
    if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
    if (c) await c.put(url, r.clone()).catch(() => {});
  }
  return r;
}
// Run as a blob: URL, a module's import.meta.url is that blob, against which no relative path resolves (the runtime's
// glue builds its .wasm path that way even when it is given the binary), so it is set back to the real address.
const script = async (url) => URL.createObjectURL(new Blob([(await (await cached(url)).text()).replaceAll('import.meta.url', JSON.stringify(url))], { type: 'text/javascript' }));

async function load({ lib, models }) {
  const dir = lib.slice(0, lib.lastIndexOf('/') + 1);
  const { pipeline, env } = await import(await script(lib));
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = { mjs: await script(dir + 'ort-wasm-simd-threaded.jsep.mjs') };
  env.backends.onnx.wasm.wasmBinary = await (await cached(dir + 'ort-wasm-simd-threaded.jsep.wasm')).arrayBuffer();
  let gpu = false;
  try { gpu = !!(self.navigator.gpu && (await self.navigator.gpu.requestAdapter())); } catch (_) {}
  let err = null;
  for (const c of models) {
    if (c.device === 'webgpu' && !gpu) continue;
    let p = null;
    try {
      p = await pipeline('automatic-speech-recognition', c.id, {
        device: c.device, dtype: c.dtype,
        progress_callback: (x) => { if (x.status === 'progress') post({ type: 'progress', name: x.name, file: x.file, loaded: x.loaded, total: x.total }); },
      });
      // Some exports carry an old generation config without the language tokens: give them from the tokenizer.
      const g = p.model.generation_config || {}, ids = p.tokenizer.model.tokens_to_ids;
      extra = g.lang_to_id && g.lang_to_id['<|ar|>'] != null ? {}
        : { is_multilingual: true, lang_to_id: { '<|ar|>': ids.get('<|ar|>') }, task_to_id: { transcribe: ids.get('<|transcribe|>') }, no_timestamps_token_id: g.no_timestamps_token_id ?? ids.get('<|notimestamps|>') };
      await run(p, new Float32Array(16000)); // compiles the model now, and fails here rather than mid-recitation
      asr = p; info = { device: c.device, model: c.id };
      return;
    } catch (e) {
      err = e; console.warn('Tilawa: could not use', c.id, 'on', c.device, e);
      if (p) p.dispose().catch(() => {});
    }
  }
  throw err || new Error('No model could be loaded.');
}

// Plain transcription. The expected verse is deliberately not given to the model as a prompt: it would then hear
// the right word when the reader says a wrong one, hiding the very mistakes the app is there to show.
async function run(p, audio) {
  if (!p) throw new Error('The model is not loaded.');
  const out = await p(audio, { language: 'arabic', task: 'transcribe', max_new_tokens: Math.min(440, 20 + Math.ceil((audio.length / 16000) * 25)), ...extra });
  return ((out && out.text) || '').trim();
}
