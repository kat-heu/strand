// Your own music files. The files stay on this device (in the browser's storage for
// Strand); only their song details go into your library, so other devices show the
// songs and play them from a streaming service instead.
import { library, saveLibrary } from './store.js';

const DB = 'strand-local', STORE = 'files', ART = 'art';
let dbp = null;
function db() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); r.result.createObjectStore(ART); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('storage full?'));
  });
}
const put = (store, k, v) => tx(store, 'readwrite', s => s.put(v, k));
const get = (store, k) => tx(store, 'readonly', s => s.get(k));
const del = (store, k) => tx(store, 'readwrite', s => s.delete(k));
const keys = store => tx(store, 'readonly', s => s.getAllKeys());

// ---- which files are on this device (known synchronously after init) ----------
const here = new Set();
const artUrls = new Map();          // id -> object URL for its cover, made this session
export const isLocalHere = t => !!t?.ids?.local && here.has(t.ids.local);
export const localArt = id => artUrls.get(id) || '';
export const isLiveBlob = u => [...artUrls.values()].includes(u);
export const LOCAL_ID = 'local';

export async function initLocal() {
  try {
    (await keys(STORE)).forEach(k => here.add(k));
    for (const k of await keys(ART)) { const b = await get(ART, k); if (b) artUrls.set(k, URL.createObjectURL(b)); }
    // Show covers: point local songs in the library at this session's cover URLs.
    const fix = t => { if (t?.ids?.local) t.artwork = artUrls.get(t.ids.local) || ''; };
    library.playlists.forEach(p => p.tracks.forEach(fix)); library.liked.forEach(fix); library.recent.forEach(fix);
  } catch (e) { console.warn('Local music unavailable', e); }
}
export async function localFile(id) { return get(STORE, id); }

// ---- tags ----------------------------------------------------------------------
const dec = (bytes, enc = 0) => {
  try {
    if (enc === 1 || enc === 2) return new TextDecoder(enc === 2 ? 'utf-16be' : 'utf-16').decode(bytes).replace(/\0+$/g, '');
    return new TextDecoder(enc === 3 ? 'utf-8' : 'latin1').decode(bytes).replace(/\0+$/g, '');
  } catch { return ''; }
};
const syncsafe = (b, i) => (b[i] << 21) | (b[i + 1] << 14) | (b[i + 2] << 7) | b[i + 3];
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

function id3(b) {
  if (!(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return null;
  const ver = b[3], size = syncsafe(b, 6) + 10, out = {};
  let i = 10;
  if (b[5] & 0x40) i += ver === 4 ? syncsafe(b, 10) : u32(b, 10) + 4;   // extended header
  while (i + 10 < size && i + 10 < b.length) {
    const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4 ? syncsafe(b, i + 4) : u32(b, i + 4);
    const f = b.subarray(i + 10, i + 10 + len);
    if (id === 'TIT2') out.title = dec(f.subarray(1), f[0]);
    else if (id === 'TPE1') out.artist = dec(f.subarray(1), f[0]);
    else if (id === 'TALB') out.album = dec(f.subarray(1), f[0]);
    else if (id === 'APIC' && !out.pic) {
      const enc = f[0]; let j = 1;
      while (j < f.length && f[j]) j++;
      const mime = dec(f.subarray(1, j)) || 'image/jpeg'; j += 2;            // mime, NUL, picture type
      if (enc === 1 || enc === 2) { while (j + 1 < f.length && (f[j] || f[j + 1])) j += 2; j += 2; }
      else { while (j < f.length && f[j]) j++; j++; }
      out.pic = new Blob([f.subarray(j)], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
    }
    i += 10 + len;
  }
  return out;
}

function mp4(b) {
  const out = {};
  const walk = (s, e, depth) => {
    let i = s;
    while (i + 8 <= e) {
      let size = u32(b, i); const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      if (size < 8) { if (size === 0) size = e - i; else break; }
      const body = i + 8, end = Math.min(i + size, e);
      if (['moov', 'udta', 'ilst'].includes(type)) walk(body, end, depth + 1);
      else if (type === 'meta') walk(body + 4, end, depth + 1);
      else if (['©nam', '©ART', '©alb', 'covr', 'aART'].includes(type)) {
        // child 'data' atom: size, 'data', type(4), locale(4), payload
        if (u32(b, body) >= 16 && String.fromCharCode(...b.subarray(body + 4, body + 8)) === 'data') {
          const kind = u32(b, body + 8), payload = b.subarray(body + 16, end);
          if (type === 'covr') out.pic = out.pic || new Blob([payload], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
          else { const v = dec(payload, 3); if (type === '©nam') out.title = v; if (type === '©ART') out.artist = v; if (type === 'aART' && !out.artist) out.artist = v; if (type === '©alb') out.album = v; }
        }
      }
      i += size;
    }
  };
  if (String.fromCharCode(...b.subarray(4, 8)) !== 'ftyp') return null;
  walk(0, b.length, 0);
  return out;
}

function flac(b) {
  if (String.fromCharCode(...b.subarray(0, 4)) !== 'fLaC') return null;
  const out = {}; let i = 4, last = false;
  const le32 = j => b[j] | (b[j + 1] << 8) | (b[j + 2] << 16) | (b[j + 3] << 24);
  while (!last && i + 4 <= b.length) {
    last = !!(b[i] & 0x80); const type = b[i] & 0x7f, len = (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3], s = i + 4;
    if (type === 4) {                                                      // VORBIS_COMMENT
      let j = s + 4 + le32(s); const n = le32(j); j += 4;
      for (let k = 0; k < n && j < s + len; k++) {
        const l = le32(j); const c = dec(b.subarray(j + 4, j + 4 + l), 3); j += 4 + l;
        const [key, ...v] = c.split('='); const val = v.join('=');
        if (/^title$/i.test(key)) out.title = val; if (/^artist$/i.test(key)) out.artist = val; if (/^album$/i.test(key)) out.album = val;
      }
    } else if (type === 6 && !out.pic) {                                  // PICTURE
      let j = s + 4; const ml = u32(b, j); const mime = dec(b.subarray(j + 4, j + 4 + ml)); j += 4 + ml;
      const dl = u32(b, j); j += 4 + dl + 16; const pl = u32(b, j); j += 4;
      out.pic = new Blob([b.subarray(j, j + pl)], { type: mime || 'image/jpeg' });
    }
    i = s + len;
  }
  return out;
}

export async function readTags(file) {
  let tags = null;
  try {
    const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) {
      const size = syncsafe(head, 6) + 10;
      tags = id3(new Uint8Array(await file.slice(0, Math.min(size, 16 * 1024 * 1024)).arrayBuffer()));
    } else {
      // m4a / flac keep their tags near the start (sometimes at the end for m4a).
      const n = Math.min(file.size, 8 * 1024 * 1024);
      const b = new Uint8Array(await file.slice(0, n).arrayBuffer());
      tags = flac(b) || mp4(b);
      if (tags && !tags.title && file.size > n) tags = mp4(new Uint8Array(await file.arrayBuffer())) || tags;
    }
  } catch (e) { console.warn('tag read failed', file.name, e); }
  tags = tags || {};
  // Fall back to the file name: "Artist - Title.mp3"
  const base = file.name.replace(/\.[^.]+$/, '').replace(/^\d+[\s._-]+/, '');
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  if (!tags.title) tags.title = m ? m[2] : base;
  if (!tags.artist) tags.artist = m ? m[1] : 'Unknown artist';
  return tags;
}

function durationOf(file) {
  return new Promise(res => {
    const a = new Audio(); const u = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(u); res(isFinite(d) ? Math.round(d * 1000) : 0); };
    a.preload = 'metadata'; a.onloadedmetadata = () => done(a.duration); a.onerror = () => done(0);
    setTimeout(() => done(0), 8000);
    a.src = u;
  });
}

async function shrinkArt(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(600, bmp.width, bmp.height), c = document.createElement('canvas');
    c.width = c.height = s;
    const k = Math.min(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, (bmp.width - k) / 2, (bmp.height - k) / 2, k, k, 0, 0, s, s);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85)) || blob;
  } catch { return blob; }
}

// ---- the "On this device" playlist -----------------------------------------------
export function localPlaylist(create = false) {
  let pl = library.playlists.find(p => p.id === LOCAL_ID);
  if (!pl && create) {
    pl = { id: LOCAL_ID, name: 'On this device', source: 'local', tracks: [], created: Date.now() };
    library.playlists.unshift(pl);
  }
  return pl;
}

const AUDIO = /\.(mp3|m4a|aac|mp4|wav|flac|ogg|oga|opus|webm|aif|aiff|alac|caf)$/i;
export async function addLocalFiles(files, onProgress) {
  const list = [...files].filter(f => f.type.startsWith('audio/') || AUDIO.test(f.name));
  try { await navigator.storage?.persist?.(); } catch {}
  const pl = localPlaylist(true);
  let added = 0, skipped = 0;
  for (const [n, f] of list.entries()) {
    onProgress?.(n, list.length, f.name);
    const id = `${f.name}|${f.size}|${f.lastModified}`;
    if (here.has(id)) { skipped++; continue; }
    const tags = await readTags(f);
    const durationMs = await durationOf(f);
    await put(STORE, id, f);
    here.add(id);
    let artwork = '';
    if (tags.pic) {
      const small = await shrinkArt(tags.pic);
      await put(ART, id, small).catch(() => {});
      artwork = URL.createObjectURL(small); artUrls.set(id, artwork);
    }
    pl.tracks.push({ key: 'local:' + id, title: tags.title, artist: tags.artist, album: tags.album || '', artwork, durationMs, origin: 'local', ids: { local: id } });
    added++;
    if (added % 10 === 0) saveLibrary();
  }
  saveLibrary();
  onProgress?.(list.length, list.length, '');
  return { added, skipped, ignored: files.length - list.length };
}

export async function removeLocal(t) {
  const id = t.ids?.local; if (!id) return;
  await del(STORE, id).catch(() => {}); await del(ART, id).catch(() => {});
  here.delete(id);
  const pl = localPlaylist();
  if (pl) pl.tracks = pl.tracks.filter(x => x.ids?.local !== id);
  saveLibrary();
}

export async function localUsage() {
  try { const e = await navigator.storage.estimate(); return e; } catch { return null; }
}

// ---- player ------------------------------------------------------------------------
export function createLocal(ctx) {
  const audio = new Audio();
  let url = null;
  audio.addEventListener('ended', () => ctx.onEnded());
  return {
    name: 'local',
    label: 'On this device',
    available: () => true,
    canPlay: t => isLocalHere(t),
    async load(t) {
      const file = await localFile(t.ids.local);
      if (!file) throw new Error('file not on this device');
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(file);
      audio.src = url;
      await audio.play();
      return { score: null };
    },
    play: () => audio.play(),
    pause: () => audio.pause(),
    seek: ms => { audio.currentTime = ms / 1000; },
    setVolume: v => { audio.volume = v; },
    position: () => audio.currentTime * 1000,
    duration: () => (isFinite(audio.duration) ? audio.duration * 1000 : 0),
    isPlaying: () => !audio.paused && !audio.ended,
    stop() { audio.pause(); },
  };
}
