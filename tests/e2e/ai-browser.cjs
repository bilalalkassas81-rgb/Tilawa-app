// Diagnostic (CI only, needs internet): the real app in Chromium with the Qur'an AI engine, the real model and real
// recitation played into a fake microphone. Logs the model load, every transcription (audio length, time, text),
// what the app shows (state, words counter, heard text, toasts) and the green/red words on Al-Fatiha.
// Run: WAV=<recitation.wav> [SECONDS=150] [URL=http://localhost:8080/] node tests/e2e/ai-browser.cjs
const { chromium } = require('playwright');

// MODELS: a JSON array to use instead of AI_MODELS in www/js/ai.js; ARGS: extra Chromium switches (e.g. for WebGPU)
const WAV = process.env.WAV, SECONDS = +(process.env.SECONDS || 150), URL = process.env.URL || 'http://localhost:8080/';
// ANDROID=1: the app in an Android emulator's WebView instead (a debug build, already installed); FAKE_MIC=<url in the
// app> then plays that recording as the microphone, since the emulator's own microphone hears nothing.
const PKG = 'app.tilawa.quran';
(async () => {
  let page, browser = null;
  if (process.env.ANDROID) {
    const { _android } = require('playwright');
    const [device] = await _android.devices();
    console.log('device', device.model(), device.serial());
    await device.shell(`am force-stop ${PKG}`);
    await device.shell(`am start -n ${PKG}/.MainActivity`);
    const wv = await device.webView({ pkg: PKG }, { timeout: 60000 });
    page = await wv.page();
  } else {
    const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', ...(process.env.ARGS || '').split(' ').filter(Boolean)];
    browser = await chromium.launch({ args, ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}) });
    // UA: e.g. a phone's, so the app picks what it would pick on a phone
    page = await (await browser.newContext(process.env.UA ? { userAgent: process.env.UA } : {})).newPage();
  }
  if (process.env.MODELS) {
    await page.route('**/js/ai.js', async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/export const AI_MODELS = \[[\s\S]*?\n\];/, `export const AI_MODELS = ${process.env.MODELS};`);
      route.fulfill({ response: r, body });
    });
  }
  const tap = (sel) => page.$eval(sel, (el) => el.click()).catch((e) => console.log('tap failed', sel, e.message)); // as a finger would, whatever overlaps it
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  page.on('console', (m) => console.log(ts(), 'page', m.type(), m.text().slice(0, 500)));
  page.on('pageerror', (e) => console.log(ts(), 'PAGEERROR', e.message));
  page.on('worker', (w) => w.on('console', (m) => console.log(ts(), 'worker', m.type(), m.text().slice(0, 500))));
  page.on('requestfailed', (r) => console.log(ts(), 'REQFAILED', r.url(), r.failure() && r.failure().errorText));
  await page.addInitScript(({ fake, native }) => {
    window.__tilawaDiag = true; // ai.js logs every pass of the native engine
    if (native) window.__tilawaNative = native;
    localStorage.setItem('tilawa.app.v1', JSON.stringify({ prefs: { voice: 'phone', page: 1 } }));
    // time every transcription the app asks of the model worker
    const Base = window.Worker;
    window.Worker = class extends Base {
      constructor(u, o) {
        super(u, o); const t = (this.__t = new Map());
        this.addEventListener('message', ({ data: m }) => {
          if (m.type === 'result') { const s = t.get(m.id) || {}; console.log('DIAG run', JSON.stringify({ id: m.id, audio: s.sec, ms: Math.round(performance.now() - s.t), text: m.text, error: m.error })); }
          else if (m.type !== 'progress') console.log('DIAG worker ' + m.type, JSON.stringify(m));
        });
      }
      postMessage(m, tr) {
        if (m && m.type === 'run') this.__t.set(m.id, { t: performance.now(), sec: +(m.audio.length / 16000).toFixed(2) });
        else if (m && m.type === 'load') console.log('DIAG load', JSON.stringify(m.models));
        return super.postMessage(m, tr);
      }
    };
    if (fake && navigator.mediaDevices) {
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.__realMic = real;
      navigator.mediaDevices.getUserMedia = async (c) => {
        try { // the real permission path first (the WebView asks the app, the app asks Android)
          const s = await real(c);
          console.log('DIAG real mic', JSON.stringify(s.getAudioTracks().map((t) => [t.label, t.readyState, t.getSettings()])));
          s.getTracks().forEach((t) => t.stop());
        } catch (e) { console.log('DIAG real mic failed', e.name, e.message); }
        const ctx = new AudioContext(); await ctx.resume();
        const buf = await ctx.decodeAudioData(await (await fetch(fake)).arrayBuffer());
        const src = ctx.createBufferSource(); src.buffer = buf; const d = ctx.createMediaStreamDestination(); src.connect(d); src.start();
        console.log('DIAG fake mic playing', ctx.sampleRate, buf.duration.toFixed(1), ctx.state);
        return d.stream;
      };
    }
  }, { fake: process.env.FAKE_MIC || '', native: process.env.NATIVE ? JSON.parse(process.env.NATIVE) : null });
  if (process.env.ANDROID) await page.reload(); else await page.goto(URL);
  await page.waitForTimeout(2500);
  console.log(ts(), 'env', JSON.stringify(await page.evaluate(async () => ({ ua: navigator.userAgent, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, isolated: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, gpu: !!navigator.gpu, adapter: navigator.gpu ? !!(await navigator.gpu.requestAdapter().catch(() => null)) : false, worklet: typeof AudioWorkletNode, voice: document.querySelector('#s-ver') && document.querySelector('#s-ver').textContent }))));

  // The phone engine first (PHONE=1): what tapping the mic does with the default setting
  const snap = () => page.evaluate(() => ({ st: document.querySelector('#st').textContent, meta: document.querySelector('#meta').textContent, mic: document.querySelector('#mic').className, toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent }));
  if (process.env.PHONE) {
    await tap('nav [data-go="read"]'); await page.waitForTimeout(1000);
    await tap('#mic');
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(1000); console.log(ts(), 'phone engine:', JSON.stringify(await snap())); }
    await tap('#mic'); await page.waitForTimeout(2000);
    console.log(ts(), 'phone engine stopped:', JSON.stringify(await snap()));
  }

  // Settings > Voice engine > Qur'an AI model: downloads the model with a progress bar
  await tap('nav [data-go="settings"]');
  await page.waitForTimeout(500);
  console.log(ts(), 'voice note:', await page.textContent('#s-voice-note'));
  const tl = Date.now();
  await page.selectOption('#s-voice', 'ai');
  let lastMsg = '';
  for (let i = 0; i < 600; i++) {
    const s = await page.evaluate(() => ({ dl: !document.querySelector('#s-dl').hidden, msg: document.querySelector('#s-dl-msg').textContent, toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent }));
    if (s.msg !== lastMsg && (!/Downloading/.test(s.msg) || i % 10 === 0)) { console.log(ts(), 'settings:', s.msg); lastMsg = s.msg; }
    if (!s.dl || /could not|needs an internet/i.test(s.msg)) { console.log(ts(), `settings done after ${((Date.now() - tl) / 1000).toFixed(1)} s; toast: ${s.toast}; version line: ${await page.textContent('#s-ver')}`); break; }
    await page.waitForTimeout(500);
  }

  // CLIPS=1 (Android app): time the native engine directly on 1, 5 and 15 s of the recording, with the encoder sized
  // to the clip and with Whisper's full 30 s window (median of 3)
  if (process.env.CLIPS && process.env.FAKE_MIC) {
    const clips = await page.evaluate(async ({ fake, margin }) => {
      const W = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Whisper;
      if (!W) return 'no native engine';
      const data = await (await fetch(fake)).arrayBuffer();
      const x = (await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(data)).getChannelData(0);
      const b64 = (a) => { const b = new Uint8Array(a.length * 2), v = new DataView(b.buffer); a.forEach((f, i) => v.setInt16(i * 2, Math.max(-1, Math.min(1, f)) * 32767, true)); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
      const out = [];
      for (const sec of [1, 5, 15]) for (const m of [margin, -1]) {
        const audio = b64(x.subarray(3 * 16000, (3 + sec) * 16000)), ms = []; let r = null;
        for (let k = 0; k < 3; k++) { r = await W.transcribe({ audio, audioCtx: m < 0 ? 0 : Math.min(1500, Math.ceil((sec + m) * 50)), beam: 1 }); ms.push(r.ms); }
        out.push(`${sec} s, ${m < 0 ? 'full window' : 'ctx ' + r.audioCtx}: ${ms.sort((a, b) => a - b)[1]} ms "${r.text}"`);
      }
      return out;
    }, { fake: process.env.FAKE_MIC, margin: process.env.NATIVE ? JSON.parse(process.env.NATIVE).margin ?? 1 : 1 });
    console.log('CLIPS', JSON.stringify(clips, null, 1));
  }
  // STRESS=<seconds>: the native engine back to back on 5 s clips, without the microphone
  if (process.env.STRESS && process.env.FAKE_MIC) {
    const t1 = Date.now();
    while (Date.now() - t1 < +process.env.STRESS * 1000) {
      const r = await page.evaluate(async (fake) => {
        const W = window.Capacitor.Plugins.Whisper;
        if (!window.__clip) {
          const x = (await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(await (await fetch(fake)).arrayBuffer())).getChannelData(0).subarray(3 * 16000, 8 * 16000);
          const b = new Uint8Array(x.length * 2), v = new DataView(b.buffer); x.forEach((f, i) => v.setInt16(i * 2, f * 32767, true));
          let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
          window.__clip = btoa(s);
        }
        return W.transcribe({ audio: window.__clip, audioCtx: 300, beam: 1 });
      }, process.env.FAKE_MIC);
      console.log(ts(), 'STRESS', r.ms, 'ms', r.text);
    }
  }

  // Recite Al-Fatiha
  await tap('nav [data-go="read"]');
  await page.waitForTimeout(1500);
  console.log(ts(), 'page words:', await page.evaluate(() => document.querySelectorAll('.w').length), 'meta:', await page.textContent('#meta'));
  await tap('#mic');
  const tm = Date.now();
  let last = '', best = { done: 0, green: 0, red: 0 }, fatihaDone = 0;
  for (let i = 0; i < SECONDS; i++) {
    await page.waitForTimeout(1000);
    const s = await page.evaluate(() => ({
      st: document.querySelector('#st').textContent, meta: document.querySelector('#meta').textContent, heard: document.querySelector('#heard').textContent,
      toast: document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent,
      green: document.querySelectorAll('.w.w-done').length, red: document.querySelectorAll('.w.w-wrong, .w.w-missed').length,
    }));
    const line = `${s.st} | ${s.meta} | green ${s.green} red ${s.red} | ${s.heard}${s.toast ? ' | TOAST: ' + s.toast : ''}`;
    if (line !== last) console.log(ts(), 'recite:', line);
    last = line;
    const m = s.meta.match(/^(\d+)\/29 /);
    if (m && +m[1] >= best.done) best = { done: +m[1], green: s.green, red: s.red, at: ((Date.now() - tm) / 1000).toFixed(0) };
    if (m && +m[1] === 29 && !fatihaDone) fatihaDone = (Date.now() - tm) / 1000;
    if (/\/(?!29 )\d+ /.test(s.meta) && fatihaDone) { console.log(ts(), 'the page turned after Al-Fatiha was complete'); break; }
  }
  console.log(`RESULT Al-Fatiha: best ${best.done}/29 words (green ${best.green}, red ${best.red}) at ${best.at}s; complete: ${fatihaDone ? fatihaDone.toFixed(0) + ' s after the mic was tapped' : 'no'}`);
  await tap('#mic');
  await page.waitForTimeout(3000);
  if (browser) await browser.close();
  process.exit(0); // the Android device connection would keep Node running
})().catch((e) => { console.error(e); process.exit(1); });
