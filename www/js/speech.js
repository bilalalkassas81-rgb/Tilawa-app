// Speech recognition: native plugin inside the Android/iOS app, Web Speech API in browsers.
// Exposes one interface: start(), stop(), active, onPartial/onFinal/onState callbacks.

const Cap = window.Capacitor;
const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const NativeSR = isNative ? Cap.Plugins.SpeechRecognition : null;
const WebSR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Inside a Claude artifact the frame blocks the browser's own mic; the host offers `dictation` instead.
export const inClaude = !!(window.claude && window.claude.use);
let dictation = null;
export let speechSupport = NativeSR ? 'native' : inClaude ? 'none' : WebSR ? 'web' : 'none';
export const speechReady = inClaude
  ? Promise.resolve(window.claude.use('dictation')).catch(() => null).then((d) => { dictation = d || null; if (d) speechSupport = 'dictation'; return speechSupport; })
  : Promise.resolve(speechSupport);
export { isNative };

export function createRecognizer({ lang = 'ar-SA', onPartial, onFinal, onState, onError }) {
  let want = false, state = 'idle', rec = null, lastPartial = '';
  const set = (s) => { state = s; onState && onState(s); };

  async function startNative() {
    const ok = await NativeSR.available().catch(() => ({ available: false }));
    if (!ok.available) throw Object.assign(new Error('Speech recognition is not available on this device.'), { code: 'unavailable' });
    const perm = await NativeSR.checkPermissions().catch(() => ({}));
    if (perm.speechRecognition !== 'granted') {
      const r = await NativeSR.requestPermissions();
      if (r.speechRecognition !== 'granted') throw Object.assign(new Error('Microphone permission was denied.'), { code: 'not_granted' });
    }
    await NativeSR.removeAllListeners();
    // Android's recogniser hears one phrase at a time. It reports "stopped" at the end of speech and only
    // then delivers the final text; on silence it ends with an error and sends no event at all.
    // So: wait for the final text before restarting, and a watchdog restarts it whenever it has gone quiet.
    NativeSR.addListener('partialResults', (d) => {
      const t = (d.matches && d.matches[0]) || '';
      if (!t || t === lastCommitted) return; // the final copy of a phrase already committed
      lastPartial = t; onPartial(t);
    });
    NativeSR.addListener('listeningState', (d) => {
      if (d.status === 'started') set('listening');
      if (d.status === 'stopped' && want) scheduleRestart(900);
    });
    await beginNative();
    fails = 0;
    watchdog = setInterval(async () => {
      if (!want || restarting || document.hidden) return;
      const r = await NativeSR.isListening().catch(() => ({ listening: false }));
      if (r.listening) { fails = 0; return; }
      // back off when restarts keep failing, so the phone's recogniser isn't hammered
      if (++fails > 3 && fails % Math.min(8, fails - 2) !== 0) return;
      scheduleRestart(0);
    }, 1500);
  }
  let watchdog = 0, restarting = false, lastCommitted = '', fails = 0;
  function commitNative() {
    if (lastPartial) { lastCommitted = lastPartial; onFinal(lastPartial); lastPartial = ''; onPartial(''); }
  }
  function scheduleRestart(delay) {
    if (restarting) return; restarting = true;
    setTimeout(async () => { commitNative(); if (want) await beginNative(); restarting = false; }, delay);
  }
  async function beginNative() {
    try {
      await NativeSR.start({ language: lang, maxResults: 1, partialResults: true, popup: false });
      set('listening');
    } catch (e) { /* busy or no speech: the watchdog tries again */ }
  }

  function startWeb() {
    rec = new WebSR();
    rec.lang = lang; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) onFinal(r[0].transcript); else interim += r[0].transcript + ' ';
      }
      onPartial(interim.trim());
    };
    rec.onstart = () => set('listening');
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { want = false; onError && onError({ code: 'not_granted', message: 'Microphone permission was denied.' }); }
      else if (e.error === 'language-not-supported') { want = false; onError && onError({ code: 'unavailable', message: 'Arabic recognition is not supported in this browser.' }); }
    };
    rec.onend = () => { onPartial(''); if (want) { try { rec.start(); } catch (_) { set('idle'); } } else set('idle'); };
    rec.start();
    set('starting');
  }

  let unsubs = [];
  function startDictation() {
    // must run synchronously inside the click: start() is called before anything is awaited
    const p = dictation.start({ language: 'ar' });
    unsubs = [
      dictation.onPartial(({ text }) => onPartial(text)),
      dictation.onFinal(({ text }) => onFinal(text)),
      dictation.onState(({ state: s, reason }) => {
        if (s === 'idle') {
          want = false; unsubs.forEach((u) => u()); unsubs = []; set('idle');
          if (reason === 'unavailable') onError && onError({ code: 'unavailable', message: 'Arabic voice recognition is not available for your account here. Use the Android app or the web version.' });
          else if (reason === 'not_granted') onError && onError({ code: 'not_granted', message: 'Microphone access is off for this page. Turn it on in the page’s Permissions menu.' });
          else if (reason === 'upstream_error' || reason === 'rate_limited') onError && onError({ code: reason, message: 'Listening stopped. Tap the microphone to continue.' });
        } else set(s);
      }),
    ];
    return p.catch((e) => {
      want = false; unsubs.forEach((u) => u()); unsubs = []; set('idle');
      const msg = e && e.code === 'unavailable' ? 'Arabic voice recognition is not available for your account here.'
        : e && e.code === 'not_granted' ? 'Microphone access is off for this page. Turn it on in the page’s Permissions menu.'
        : 'Could not start listening. Try again.';
      throw Object.assign(new Error(msg), { code: e && e.code });
    });
  }

  return {
    get active() { return want; },
    get state() { return state; },
    async start() {
      if (want) return; want = true;
      if (speechSupport === 'dictation') return startDictation();
      try {
        if (speechSupport === 'native') await startNative();
        else if (speechSupport === 'web') startWeb();
        else throw Object.assign(new Error('Voice recognition is not supported here. Try Chrome, Safari, or the Android app.'), { code: 'unavailable' });
      } catch (e) { want = false; set('idle'); throw e; }
    },
    async stop() {
      want = false;
      if (speechSupport === 'dictation') { set('finishing'); await dictation.stop().catch(() => {}); return; }
      if (speechSupport === 'native') {
        clearInterval(watchdog); watchdog = 0; restarting = false; set('finishing');
        // the plugin's stop() never answers on Android, so don't wait on it for more than a moment
        await Promise.race([NativeSR.stop().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
        await new Promise((r) => setTimeout(r, 700)); // let the last phrase arrive
        commitNative();
        await NativeSR.removeAllListeners().catch(() => {});
        set('idle');
      }
      else if (rec) { set('finishing'); try { rec.stop(); } catch (_) { set('idle'); } }
    },
  };
}

/* Optional: record the reciter's own voice (browsers only; the native recogniser owns the mic in the app). */
export async function startVoiceRecording() {
  if (isNative || !navigator.mediaDevices || !window.MediaRecorder) return null;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream);
  const chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.start(1000);
  return {
    stop: () => new Promise((res) => {
      mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); res(new Blob(chunks, { type: mr.mimeType || 'audio/webm' })); };
      if (mr.state !== 'inactive') mr.stop(); else mr.onstop();
    }),
  };
}
