// iTunes / Apple Music app library sync. Reads the library file iTunes keeps
// ("iTunes Library.xml") or one exported from the Music app (File → Library →
// Export Library…): every song and playlist comes into Strand.
// In the desktop app the songs play straight from the files on your computer;
// elsewhere they play from a streaming service.
// Kept on this device only (libraries can hold tens of thousands of songs).

const DB = 'strand-itunes', STORE = 'lib';
let data = null;                     // { syncedAt, from, playlists: [{ id, name, keys }], tracks: { key: track } }

function idb(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onerror = () => rej(r.error);
    r.onsuccess = () => {
      const t = r.result.transaction(STORE, mode), s = t.objectStore(STORE);
      const q = fn(s);
      t.oncomplete = () => res(q?.result);
      t.onerror = () => rej(t.error);
    };
  });
}

export const itunesData = () => data;
export const desktopItunes = () => window.strandDesktop?.itunes || null;

export async function initItunes() {
  try { data = await idb('readonly', s => s.get('lib')) || null; } catch { data = null; }
  if (data && desktopItunes()) await allowFiles();
  return data;
}

// ---- plist parsing -------------------------------------------------------------
function val(el) {
  switch (el.tagName) {
    case 'dict': {
      const o = {}; const kids = el.children;
      for (let i = 0; i + 1 < kids.length; i += 2) o[kids[i].textContent] = val(kids[i + 1]);
      return o;
    }
    case 'array': return [...el.children].map(val);
    case 'integer': return Number(el.textContent);
    case 'real': return Number(el.textContent);
    case 'true': return true;
    case 'false': return false;
    default: return el.textContent;           // string, date, data
  }
}
export function parsePlist(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That isn’t an iTunes library file');
  const root = doc.querySelector('plist > dict');
  if (!root) throw new Error('That isn’t an iTunes library file');
  return val(root);
}

export function fileFromLocation(loc) {
  if (!loc || !/^file:/i.test(loc)) return '';
  // file://localhost/C:/Users/.../a.mp3 (Windows) · file:///Users/.../a.mp3 (Mac)
  let p = loc.replace(/^file:\/\/localhost\//i, 'file:///');
  try { p = decodeURIComponent(new URL(p).pathname); } catch { return ''; }
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1).replace(/\//g, '\\');   // Windows drive path
  return p;
}

const SKIP_KIND = /video|movie|tv show|podcast|audiobook|book|app|pdf/i;
const SKIP_PL = new Set(['Library', 'Music', 'Movies', 'TV Shows', 'Podcasts', 'Audiobooks', 'Books', 'Purchased', 'Genius', 'Downloaded', 'Home Videos', 'Music Videos', 'Voice Memos', 'Tones', 'iTunes U', 'Rentals']);

export function libraryFromPlist(pl) {
  const tracks = {};
  for (const [, t] of Object.entries(pl.Tracks || {})) {
    if (t['Has Video'] || t.Podcast || t.Movie || t['TV Show'] || SKIP_KIND.test(t.Kind || '')) continue;
    if (!t.Name) continue;
    const key = 'itl:' + (t['Persistent ID'] || t['Track ID']);
    const file = t['Track Type'] === 'File' || t.Location ? fileFromLocation(t.Location) : '';
    const drm = !!t.Protected || /protected/i.test(t.Kind || '');          // Apple Music downloads can't be played outside Apple's app
    tracks[key] = {
      key, title: t.Name, artist: t.Artist || t['Album Artist'] || 'Unknown artist', album: t.Album || '',
      artwork: '', durationMs: t['Total Time'] || 0, origin: 'itunes',
      ids: { ...(file && !drm ? { itunesFile: file } : {}), ...(t['Track ID'] ? { itunesTrack: t['Track ID'] } : {}) },
      _tid: t['Track ID'],
    };
  }
  const byTid = new Map(Object.values(tracks).map(t => [t._tid, t.key]));
  Object.values(tracks).forEach(t => delete t._tid);
  const playlists = [];
  for (const p of pl.Playlists || []) {
    if (p.Master || p['Distinguished Kind'] || p.Folder || p.Visible === false || SKIP_PL.has(p.Name)) continue;
    const keys = (p['Playlist Items'] || []).map(i => byTid.get(i['Track ID'])).filter(Boolean);
    if (!keys.length) continue;
    playlists.push({ id: 'itl-' + (p['Playlist Persistent ID'] || p['Playlist ID']), name: p.Name, keys, smart: !!p['Smart Info'] });
  }
  return { tracks, playlists };
}

export async function syncItunesXml(xml, from = 'file') {
  const lib = libraryFromPlist(parsePlist(xml));
  const songs = Object.keys(lib.tracks).length;
  if (!songs) throw new Error('No songs found in that library file');
  data = { syncedAt: Date.now(), from, ...lib };
  await idb('readwrite', s => s.put(data, 'lib'));
  if (desktopItunes()) await allowFiles();
  return { songs, playlists: lib.playlists.length, files: Object.values(lib.tracks).filter(t => t.ids.itunesFile).length };
}

async function allowFiles() {
  const files = Object.values(data?.tracks || {}).map(t => t.ids.itunesFile).filter(Boolean);
  try { await desktopItunes().allow(files); } catch (e) { console.warn('iTunes file access', e); }
}

// Desktop: find the library file iTunes keeps and sync from it.
export async function syncFromComputer({ pick = false } = {}) {
  const d = desktopItunes(); if (!d) throw new Error('Only in the desktop app');
  const r = pick ? await d.pickLibrary() : await d.findLibrary();
  if (!r) return null;
  const out = await syncItunesXml(r.xml, r.path);
  return { ...out, path: r.path };
}

export async function forgetItunes() {
  data = null;
  await idb('readwrite', s => s.delete('lib')).catch(() => {});
  try { await desktopItunes()?.allow([]); } catch {}
}

export const ALL_ID = 'itl-all';
export function itunesPlaylist(id) {
  if (!data) return null;
  if (id === ALL_ID) {
    const tracks = Object.values(data.tracks).sort((a, b) => (a.artist || '').localeCompare(b.artist || '') || (a.album || '').localeCompare(b.album || ''));
    return { id, name: 'All songs', source: 'itunes', tracks };
  }
  const p = data.playlists.find(x => x.id === id);
  return p ? { id, name: p.name, source: 'itunes', tracks: p.keys.map(k => data.tracks[k]).filter(Boolean) } : null;
}

// ---- player (desktop app: straight from the file on this computer) --------------
export function createItunes(ctx) {
  const audio = new Audio();
  audio.addEventListener('ended', () => ctx.onEnded());
  return {
    name: 'itunes',
    label: 'iTunes',
    available: () => !!desktopItunes(),
    canPlay: t => !!(desktopItunes() && t.ids?.itunesFile),
    async load(t) {
      audio.src = 'strandfile://song/' + encodeURIComponent(t.ids.itunesFile);
      try { await audio.play(); }
      catch (e) { throw new Error(audio.error?.code === 4 ? 'file missing or not playable' : e.message); }
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
