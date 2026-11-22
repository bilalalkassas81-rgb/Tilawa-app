// Local data: settings, history, bookmarks, goals in localStorage; voice recordings in IndexedDB.
const KEY = 'tilawa.app.v1';
const defaults = {
  prefs: {
    theme: 'system', size: 30, fit: true, page: 1, tr: false, trLang: 'en', translit: false, hide: false,
    reciter: 'Alafasy_128kbps', speed: 1, repeatAyah: 1, repeatRange: 1, record: false,
    reminder: '', s: 1, from: 1, to: 7,
  },
  goal: { type: 'verses', daily: 10, khatmDays: 0, khatmStart: 0, khatmPos: 0 },
  history: [],       // {id,t,s,from,to,words,total,mistakes,hints,acc,ms,voice,mist:[{s,v,text,kind}],rec?:bool}
  bookmarks: [],     // {s,v,t,note}
  lastRead: null,    // {s,v,t}
  daily: {},         // 'YYYY-MM-DD' -> {verses, words, ms}
};

let data;
try { data = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { data = null; }
data = data || {};
for (const k of Object.keys(defaults)) {
  if (data[k] == null) data[k] = structuredClone(defaults[k]);
  else if (!Array.isArray(defaults[k]) && typeof defaults[k] === 'object') data[k] = Object.assign(structuredClone(defaults[k]), data[k]);
}
export const db = data;
export function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }

export const today = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export function logDaily(verses, words, ms) {
  const k = today(); const d = db.daily[k] || (db.daily[k] = { verses: 0, words: 0, ms: 0 });
  d.verses += verses; d.words += words; d.ms += ms; save();
}
export function streak() {
  let n = 0; const d = new Date();
  if (!db.daily[today(d)]) d.setDate(d.getDate() - 1);
  while (db.daily[today(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

export function exportJSON() { return JSON.stringify(db); }
export function importJSON(txt) {
  const p = JSON.parse(txt);
  if (!p || typeof p !== 'object' || !p.prefs) throw new Error('This is not a Tilawa backup.');
  for (const k of Object.keys(defaults)) if (p[k] != null) db[k] = p[k];
  save();
}

/* IndexedDB for recordings */
let idb;
function openIdb() {
  if (idb) return idb;
  idb = new Promise((res, rej) => {
    const r = indexedDB.open('tilawa', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('rec');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return idb;
}
export async function putRecording(id, blob) {
  const d = await openIdb();
  return new Promise((res, rej) => { const tx = d.transaction('rec', 'readwrite'); tx.objectStore('rec').put(blob, id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
export async function getRecording(id) {
  const d = await openIdb();
  return new Promise((res, rej) => { const q = d.transaction('rec').objectStore('rec').get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function deleteRecording(id) {
  const d = await openIdb();
  return new Promise((res) => { const tx = d.transaction('rec', 'readwrite'); tx.objectStore('rec').delete(id); tx.oncomplete = res; tx.onerror = res; });
}
