// Settings, library and a tiny event bus. Everything persists in localStorage.
import CONFIG from '../config.js';

function load(k, d) {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; }
}

// With Strand accounts, each signed-in person gets their own storage namespace on
// this device (library, settings, linked-service logins). Without accounts
// (no Supabase configured) everything lives under the plain "strand:" prefix.
export const USER_ID = (CONFIG.supabaseUrl && CONFIG.supabaseKey && load('strand:session', null)?.user?.id) || null;
export const ns = k => (USER_ID ? `strand:u:${USER_ID}:${k}` : `strand:${k}`);
const SKEY = ns('settings');
const LKEY = ns('library');
export function save(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full / blocked */ }
}
export { load };

const defaults = {
  spotifyClientId: '',
  googleClientId: '',
  youtubeKey: '',
  appleDevToken: '',
  scProfile: '',          // linked SoundCloud profile URL
  scPlaylists: [],        // SoundCloud playlists added by link: [{ url, name, art, count }]
  preferred: 'auto',      // auto | spotify | apple | youtube | preview
  phoneSpotify: 'strand', // on phones, Spotify songs play: 'strand' (via YouTube in Strand) | 'app' (Spotify app remote)
  volume: 0.8,
  lyricsOffset: 0,        // ms, applied to lyric timing
  country: 'us',          // iTunes / Apple Music storefront
  shareBase: '',          // public URL for share links (defaults to current origin)
};

export const settings = { ...defaults, ...load(SKEY, {}) };
// Keys baked into config.js apply unless this device set its own.
for (const [k, v] of Object.entries(CONFIG)) if (v && !settings[k]) settings[k] = v;
export const fromConfig = k => !!CONFIG[k] && settings[k] === CONFIG[k];
export function setSetting(k, v) {
  settings[k] = v;
  save(SKEY, settings);
  emit('settings', k);
}

export const library = { playlists: [], liked: [], recent: [], ...load(LKEY, {}) };
export function saveLibrary() {
  save(LKEY, library);
  emit('library');
}

export function isLiked(t) { return library.liked.some(x => x.key === t.key); }
export function toggleLike(t) {
  const i = library.liked.findIndex(x => x.key === t.key);
  if (i >= 0) library.liked.splice(i, 1); else library.liked.unshift(t);
  saveLibrary();
}
export function pushRecent(t) {
  library.recent = [t, ...library.recent.filter(x => x.key !== t.key)].slice(0, 24);
  save(LKEY, library);
}

// Event bus
const subs = new Map();
export function on(evt, fn) {
  if (!subs.has(evt)) subs.set(evt, new Set());
  subs.get(evt).add(fn);
  return () => subs.get(evt).delete(fn);
}
export function emit(evt, data) {
  subs.get(evt)?.forEach(fn => { try { fn(data); } catch (e) { console.error(e); } });
}

// Small persistent cache for resolved ids (track -> spotify uri / youtube id),
// so we don't burn API quota resolving the same song twice.
const CKEY = 'strand:resolve';
const resolveCache = load(CKEY, {});
export function cacheGet(ns, key) { return resolveCache[ns + '|' + key]; }
export function cacheSet(ns, key, val) {
  resolveCache[ns + '|' + key] = val;
  const keys = Object.keys(resolveCache);
  if (keys.length > 3000) keys.slice(0, 500).forEach(k => delete resolveCache[k]);
  save(CKEY, resolveCache);
}
export function clearCaches() {
  Object.keys(resolveCache).forEach(k => delete resolveCache[k]);
  save(CKEY, resolveCache);
}
