// Diagnostic (CI only, needs internet): the real app in Chromium with the Qur'an AI engine, the real model and real
// recitation played into a fake microphone. Logs the model load, every transcription (audio length, time, text),
// what the app shows (state, words counter, heard text, toasts) and the green/red words on Al-Fatiha.
// Run: WAV=<recitation.wav> [SECONDS=150] [URL=http://localhost:8080/] node tests/e2e/ai-browser.cjs
const { chromium } = require('playwright');

// MODELS: a JSON array to use instead of AI_MODELS in www/js/ai.js; ARGS: extra Chromium switches (e.g. for WebGPU)
const WAV = process.env.WAV, SECONDS = +(process.env.SECONDS || 150), URL = process.env.URL || 'http://localhost:8080/';
(async () => {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required', ...(process.env.ARGS || '').split(' ').filter(Boolean)];
  const browser = await chromium.launch({ args, ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}) });
  const ctx = await browser.newContext();
  if (process.env.MODELS) {
    await ctx.route('**/js/ai.js', async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/export const AI_MODELS = \[[\s\S]*?\n\];/, `export const AI_MODELS = ${process.env.MODELS};`);
      route.fulfill({ response: r, body });
    });
  }
  const page = await ctx.newPage();
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
  page.on('console', (m) => console.log(ts(), 'page', m.type(), m.text().slice(0, 500)));
  page.on('pageerror', (e) => console.log(ts(), 'PAGEERROR', e.message));
  page.on('worker', (w) => w.on('console', (m) => console.log(ts(), 'worker', m.type(), m.text().slice(0, 500))));
  page.on('requestfailed', (r) => console.log(ts(), 'REQFAILED', r.url(), r.failure() && r.failure().errorText));
  await page.addInitScript(() => {
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
  });
  await page.goto(URL);
  await page.waitForTimeout(1500);

  // Settings > Voice engine > Qur'an AI model: downloads the model with a progress bar
  await page.click('nav [data-go="settings"]');
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

  // Recite Al-Fatiha
  await page.click('nav [data-go="read"]');
  await page.waitForTimeout(1500);
  console.log(ts(), 'page words:', await page.evaluate(() => document.querySelectorAll('.w').length), 'meta:', await page.textContent('#meta'));
  await page.click('#mic');
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
  await page.click('#mic').catch(() => {});
  await page.waitForTimeout(3000);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
