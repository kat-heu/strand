// Your own music server: Navidrome, or anything that speaks the (Open)Subsonic API
// (Gonic, Airsonic, Ampache, LMS, Jellyfin with its Subsonic plugin…).
// Strand plays the files from your server itself, through its shared background-safe
// player, so they keep playing with the iPhone locked.
// The server address and login are kept on this device only (not synced, not uploaded).
import { load, save, ns, emit } from '../store.js';
import { md5 } from '../md5.js';
import { log } from '../log.js';
import * as E from '../engine.js';

const KEY = ns('subsonic');
let conf = load(KEY, null);                 // { url, user, salt, token }
export const subsonicLinked = () => !!conf?.url;
export const subsonicInfo = () => conf && { url: conf.url, user: conf.user };

const API = 'v=1.16.1&c=Strand&f=json';
const auth = c => `u=${encodeURIComponent(c.user)}&t=${c.token}&s=${c.salt}`;
const base = c => c.url.replace(/\/+$/, '') + '/rest/';

export function normalizeUrl(input) {
  let s = (input || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return (u.origin + u.pathname).replace(/\/+$/, '').replace(/\/(app|rest)$/i, ''); } catch { return null; }
}

async function call(c, method, params = {}) {
  const q = new URLSearchParams(params).toString();
  let r;
  try { r = await fetch(`${base(c)}${method}?${auth(c)}&${API}${q ? '&' + q : ''}`); }
  catch {
    const mixed = location.protocol === 'https:' && c.url.startsWith('http:');
    throw new Error(mixed ? 'Your server needs an https:// address to work from the Strand website' : 'Can’t reach your music server (is it running and reachable from this device?)');
  }
  if (!r.ok) throw new Error('Music server error ' + r.status);
  const d = (await r.json())['subsonic-response'];
  if (!d || d.status !== 'ok') {
    const e = d?.error || {};
    throw new Error(e.code === 40 || e.code === 41 ? 'Wrong username or password for your music server' : (e.message || 'Music server error'));
  }
  return d;
}
const api = (method, params) => { if (!conf) throw new Error('Connect your music server first'); return call(conf, method, params); };

export async function subsonicConnect(url, user, password) {
  const u = normalizeUrl(url);
  if (!u) throw new Error('That doesn’t look like a web address');
  const salt = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
  const c = { url: u, user: user.trim(), salt, token: md5(password + salt) };   // the password itself isn't stored
  const d = await call(c, 'ping');
  conf = c; save(KEY, conf);
  log('music server connected', { url: u, server: d.type || 'subsonic', version: d.serverVersion || d.version });
  emit('auth');
  return { server: d.type || 'Subsonic', version: d.serverVersion || d.version };
}
export function subsonicDisconnect() { conf = null; save(KEY, null); emit('auth'); }

export const coverUrl = (id, size = 600) => (conf && id ? `${base(conf)}getCoverArt?${auth(conf)}&${API}&id=${encodeURIComponent(id)}&size=${size}` : '');
export const streamUrl = id => `${base(conf)}stream?${auth(conf)}&${API}&id=${encodeURIComponent(id)}`;

export function songToTrack(s) {
  return {
    key: 'ss:' + s.id,
    title: s.title || 'Untitled',
    artist: s.artist || s.displayArtist || 'Unknown artist',
    album: s.album || '',
    artwork: coverUrl(s.coverArt || s.albumId),
    durationMs: (s.duration || 0) * 1000,
    origin: 'server',
    ids: { server: s.id },
  };
}
const arr = x => (Array.isArray(x) ? x : x ? [x] : []);

export async function serverPlaylists() {
  return arr((await api('getPlaylists')).playlists?.playlist).map(p => ({ id: p.id, name: p.name, count: p.songCount, art: coverUrl(p.coverArt) }));
}
export async function serverPlaylist(id) {
  const p = (await api('getPlaylist', { id })).playlist;
  return { name: p.name, artwork: coverUrl(p.coverArt), tracks: arr(p.entry).map(songToTrack) };
}
export async function serverAlbums(type = 'newest', size = 30) {
  return arr((await api('getAlbumList2', { type, size })).albumList2?.album).map(a => ({ id: a.id, name: a.name, artist: a.artist, art: coverUrl(a.coverArt || a.id) }));
}
export async function serverAlbum(id) {
  const a = (await api('getAlbum', { id })).album;
  return { name: a.name, artwork: coverUrl(a.coverArt || a.id), tracks: arr(a.song).map(songToTrack) };
}
export async function serverRandom(size = 50) { return arr((await api('getRandomSongs', { size })).randomSongs?.song).map(songToTrack); }
export async function serverStarred() { return arr((await api('getStarred2')).starred2?.song).map(songToTrack); }
export async function serverSearch(q, count = 20) {
  const r = (await api('search3', { query: q, songCount: count, albumCount: 0, artistCount: 0 })).searchResult3 || {};
  return arr(r.song).map(songToTrack);
}
// "More like this": the server's own similar-songs (Navidrome uses Last.fm; AudioMuse-AI
// can provide sonic similarity) — used by Strand's mixes.
export async function serverSimilar(id, count = 30) {
  try { return arr((await api('getSimilarSongs2', { id, count })).similarSongs2?.song).map(songToTrack); } catch { return []; }
}
// Find a song on your server by title + artist (so library/Spotify songs you also own play from your server).
const missing = new Set();               // songs already looked for and not found (this session)
export async function serverFind(t) {
  if (!conf || missing.has(t.key)) return null;
  try {
    const hits = await serverSearch(`${t.title} ${t.artist.split(/,|&/)[0]}`, 5);
    const norm = s => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const hit = hits.find(h => norm(h.title) === norm(t.title) && norm(t.artist).includes(norm(h.artist).split(' ')[0])) || null;
    if (!hit) missing.add(t.key);
    return hit;
  } catch { return null; }
}

// ---- player ------------------------------------------------------------------------------
export function createSubsonic(ctx) {
  return {
    name: 'server',
    label: 'My server',
    available: () => subsonicLinked(),
    canPlay: t => subsonicLinked() && (!!t.ids?.server || ['spotify', 'catalog', 'apple', 'itunes', 'local', 'cloud'].includes(t.origin)),
    async load(t) {
      let id = t.ids?.server;
      if (!id) { const hit = await serverFind(t); if (!hit) throw new Error('not on your music server'); id = hit.ids.server; }
      await E.playUrl('server', streamUrl(id), () => ctx.onEnded());
      return { score: t.ids?.server ? null : 0.95 };
    },
    play: () => E.isOwner('server') && E.el.play(),
    pause: () => E.isOwner('server') && E.el.pause(),
    seek: ms => E.isOwner('server') && E.seekTo(ms),
    setVolume: v => { E.el.volume = v; },
    position: () => (E.isOwner('server') ? E.position() : 0),
    duration: () => (E.isOwner('server') ? E.duration() : 0),
    isPlaying: () => E.isOwner('server') && E.playing(),
    stop() { E.release('server'); },
  };
}
