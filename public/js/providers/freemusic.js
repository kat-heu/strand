// Free full-length music that apps are allowed to stream:
//  - Audius: independent artists; free public API, no key or sign-up (apps identify
//    themselves with app_name). https://docs.audius.co
//  - Jamendo: free-licensed (Creative Commons) music; free for non-commercial apps
//    with a free developer ID (client_id) from devportal.jamendo.com — off until one
//    is added in config.js.
// Both play inside Strand's own background-safe player (keeps going on a locked iPhone).
import CONFIG from '../../config.js';
import { settings } from '../store.js';
import { log } from '../log.js';
import * as E from '../engine.js';

const APP = 'Strand';

// ---- Audius --------------------------------------------------------------------------------
// api.audius.co answers directly; if it doesn't, ask it for its list of servers and use one.
let auHost = 'https://api.audius.co';
let auChecked = false;
async function auGet(path, params = {}) {
  const q = new URLSearchParams({ ...params, app_name: APP });
  const tryHost = async h => { const r = await fetch(`${h}/v1${path}?${q}`); if (!r.ok) throw new Error('Audius ' + r.status); return r.json(); };
  try { return await tryHost(auHost); }
  catch (e) {
    if (auChecked) throw e;
    auChecked = true;
    const hosts = (await (await fetch('https://api.audius.co')).json())?.data || [];
    if (!hosts.length) throw e;
    auHost = hosts[Math.floor(Math.random() * Math.min(3, hosts.length))];
    log('audius server', auHost);
    return tryHost(auHost);
  }
}
const auArt = a => a?.['1000x1000'] || a?.['480x480'] || a?.['150x150'] || '';
export const auToTrack = t => ({
  key: 'au:' + t.id, title: t.title, artist: t.user?.name || t.user?.handle || 'Audius artist', album: t.genre || '',
  artwork: auArt(t.artwork), durationMs: (t.duration || 0) * 1000, origin: 'audius', ids: { audius: t.id },
});
const auOk = t => t && t.is_streamable !== false && !t.is_delete && !t.stream_conditions;   // skip deleted / paid / gated tracks
export async function audiusSearch(query, limit = 20) {
  return ((await auGet('/tracks/search', { query, limit }))?.data || []).filter(auOk).slice(0, limit).map(auToTrack);
}
export async function audiusTrending(limit = 30, genre = '') {
  return ((await auGet('/tracks/trending', { limit, ...(genre ? { genre } : {}) }))?.data || []).filter(auOk).slice(0, limit).map(auToTrack);
}
const auStream = id => `${auHost}/v1/tracks/${encodeURIComponent(id)}/stream?app_name=${APP}`;

// ---- Jamendo -------------------------------------------------------------------------------
const jamId = () => (settings.jamendoClientId || CONFIG.jamendoClientId || '').trim();
export const jamendoOn = () => !!jamId();
async function jamGet(path, params = {}) {
  const q = new URLSearchParams({ client_id: jamId(), format: 'json', ...params });
  const r = await fetch(`https://api.jamendo.com/v3.0${path}/?${q}`);
  const d = await r.json();
  if (d?.headers?.status !== 'success') throw new Error('Jamendo: ' + (d?.headers?.error_message || r.status));
  return d.results || [];
}
const jamToTrack = t => ({
  key: 'ja:' + t.id, title: t.name, artist: t.artist_name, album: t.album_name || '',
  artwork: t.album_image || t.image || '', durationMs: (t.duration || 0) * 1000, origin: 'jamendo',
  ids: { jamendo: t.id }, jamendoAudio: t.audio || '',
});
export async function jamendoSearch(search, limit = 20) {
  if (!jamendoOn()) return [];
  return (await jamGet('/tracks', { search, limit, audioformat: 'mp32', include: 'musicinfo' })).map(jamToTrack);
}
export async function jamendoPopular(limit = 30) {
  if (!jamendoOn()) return [];
  return (await jamGet('/tracks', { order: 'popularity_week', limit, audioformat: 'mp32' })).map(jamToTrack);
}
const jamStream = t => t.jamendoAudio || `https://api.jamendo.com/v3.0/tracks/file/?client_id=${jamId()}&id=${t.ids.jamendo}&action=stream&audioformat=mp32`;

// Search both (whichever are available), Audius first.
export async function freeSearch(q, limit = 12) {
  const [a, j] = await Promise.all([audiusSearch(q, limit).catch(e => { log('audius search failed', e.message); return []; }), jamendoSearch(q, Math.ceil(limit / 2)).catch(() => [])]);
  return [...a, ...j];
}

// ---- players ------------------------------------------------------------------------------
function streamProvider(name, label, canPlay, urlOf, ctx) {
  return {
    name, label,
    available: () => true,
    canPlay,
    async load(t) { await E.playUrl(name, urlOf(t), () => ctx.onEnded()); return { score: null }; },
    play: () => E.isOwner(name) && E.el.play(),
    pause: () => E.isOwner(name) && E.el.pause(),
    seek: ms => E.isOwner(name) && E.seekTo(ms),
    setVolume: v => { E.el.volume = v; },
    position: () => (E.isOwner(name) ? E.position() : 0),
    duration: () => (E.isOwner(name) ? E.duration() : 0),
    isPlaying: () => E.isOwner(name) && E.playing(),
    stop() { E.release(name); },
  };
}
export const createAudius = ctx => streamProvider('audius', 'Audius', t => !!t.ids?.audius, t => auStream(t.ids.audius), ctx);
export const createJamendo = ctx => streamProvider('jamendo', 'Jamendo', t => !!t.ids?.jamendo && jamendoOn(), jamStream, ctx);
