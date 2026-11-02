// Strand Mixes: playlists made for you, rebuilt every day.
// How they're made (no paid AI service, nothing leaves your device except optional
// lookups of related artists on Deezer's free public catalogue):
//  - Who you listen to: artists in your recently played (most), liked songs and playlists.
//  - What goes together: songs that sit close to each other in your playlists are
//    treated as "similar" — so each mix follows the way you already group music.
//  - Discovery: related artists you don't have yet (Deezer), sprinkled in.
//  - Your music server: its own "similar songs" when connected.
//  - Smart shuffle: never the same artist twice in a row, with familiar and new mixed.
import { library, load, save, ns } from './store.js';
import { jsonp, norm } from './util.js';
import { log } from './log.js';
import { subsonicLinked, serverSimilar, serverRandom } from './providers/subsonic.js';

const KEY = ns('mixes');
const today = () => new Date().toISOString().slice(0, 10);
const artistOf = t => (t?.artist || '').split(/\s*(?:,|&| feat\.? | ft\.? | x )\s*/i)[0].trim();
const akey = t => norm(artistOf(t));

// ---- smart shuffle --------------------------------------------------------------------
export function smartShuffle(tracks) {
  // Group by artist, shuffle each group, then deal songs out: always from an artist
  // other than the last one, favouring artists with more songs left (so nobody piles
  // up at the end). Back-to-back repeats only happen when one artist is over half.
  const groups = new Map();
  for (const t of tracks) { const k = akey(t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  for (const g of groups.values()) for (let i = g.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [g[i], g[j]] = [g[j], g[i]]; }
  const out = []; let last = null;
  while (groups.size) {
    const options = [...groups.entries()].filter(([k]) => k !== last);
    const pool = options.length ? options : [...groups.entries()];
    const total = pool.reduce((n, [, g]) => n + g.length, 0);
    let r = Math.random() * total, pickK = pool[0][0];
    for (const [k, g] of pool) { r -= g.length; if (r <= 0) { pickK = k; break; } }
    // never let the biggest group outgrow the rest (keeps a gap available to the end)
    const biggest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const rest = [...groups.values()].reduce((n, g) => n + g.length, 0) - biggest[1].length;
    if (biggest[0] !== last && biggest[1].length > rest) pickK = biggest[0];
    const g = groups.get(pickK);
    out.push(g.shift()); if (!g.length) groups.delete(pickK);
    last = pickK;
  }
  return out;
}

// ---- what you listen to ------------------------------------------------------------------
function allLists() {
  const lists = library.playlists.filter(p => p.tracks?.length).map(p => p.tracks);
  if (library.liked.length) lists.push(library.liked);
  if (library.recent.length) lists.push(library.recent);
  return lists;
}
function profile() {
  const score = new Map(), names = new Map(), songs = new Map();
  const add = (t, w) => {
    const k = akey(t); if (!k) return;
    score.set(k, (score.get(k) || 0) + w); if (!names.has(k)) names.set(k, artistOf(t));
    if (!songs.has(k)) songs.set(k, new Map());
    songs.get(k).set(t.key, t);
  };
  library.recent.forEach((t, i) => add(t, 6 - Math.min(5, i / 5)));
  library.liked.forEach(t => add(t, 3));
  library.playlists.forEach(p => (p.tracks || []).forEach(t => add(t, 1)));
  // "goes together": artists of songs within 4 places of each other in the same list
  const near = new Map();
  for (const list of allLists()) {
    const ks = list.map(akey);
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j <= i + 4 && j < ks.length; j++) {
      const a = ks[i], b = ks[j]; if (!a || !b || a === b) continue;
      for (const [x, y] of [[a, b], [b, a]]) { if (!near.has(x)) near.set(x, new Map()); near.get(x).set(y, (near.get(x).get(y) || 0) + 1); }
    }
  }
  return { score, names, songs, near };
}

// ---- Deezer (free public catalogue) for related artists ----------------------------------
const dz = path => jsonp(`https://api.deezer.com${path}${path.includes('?') ? '&' : '?'}output=jsonp`, 8000);
async function dzArtistId(name) {
  const d = await dz(`/search/artist?q=${encodeURIComponent(name)}&limit=1`);
  const a = d?.data?.[0];
  return a && norm(a.name) === norm(name) ? a.id : a?.id || null;
}
const dzTrack = t => ({
  key: 'dz:' + t.id, title: t.title_short || t.title, artist: t.artist?.name || '', album: t.album?.title || '',
  artwork: t.album?.cover_xl || t.album?.cover_big || '', durationMs: (t.duration || 0) * 1000,
  previewUrl: t.preview || undefined, origin: 'catalog', ids: { deezer: t.id }, discovered: true,
});
async function related(name, n = 4) {
  try {
    const id = await dzArtistId(name); if (!id) return [];
    return ((await dz(`/artist/${id}/related?limit=${n}`))?.data || []).map(a => ({ id: a.id, name: a.name }));
  } catch { return []; }
}
async function topTracks(artistId, n = 3) {
  try { return ((await dz(`/artist/${artistId}/top?limit=${n}`))?.data || []).map(dzTrack); } catch { return []; }
}

// ---- building ----------------------------------------------------------------------------
const pick = (map, n) => [...map.values()].sort(() => Math.random() - 0.5).slice(0, n);
const cover = tracks => tracks.find(t => t.artwork && !t.artwork.startsWith('blob:'))?.artwork || '';

export async function buildMixes({ force = false, online = true } = {}) {
  const saved = load(KEY, null);
  if (!force && saved?.day === today() && saved.mixes?.length) return saved.mixes;
  const P = profile();
  const ranked = [...P.score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const mixes = [], used = new Set();
  // Daily mixes: a favourite artist + the artists you put next to them
  for (const seed of ranked) {
    if (mixes.length >= 4) break;
    if (used.has(seed)) continue;
    const friends = [...(P.near.get(seed) || new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k).filter(k => P.songs.has(k));
    const group = [seed, ...friends];
    let tracks = [];
    for (const k of group) tracks.push(...pick(P.songs.get(k) || new Map(), k === seed ? 10 : 5));
    if (tracks.length < 8) continue;
    group.forEach(k => used.add(k));
    // a few new songs from related artists you don't have yet
    if (online) {
      const rel = (await related(P.names.get(seed), 3)).filter(a => !P.songs.has(norm(a.name)));
      for (const a of rel) tracks.push(...await topTracks(a.id, 2));
    }
    tracks = smartShuffle(tracks).slice(0, 50);
    const who = group.slice(0, 3).map(k => P.names.get(k)).filter(Boolean);
    mixes.push({ id: 'daily-' + (mixes.length + 1), name: `Daily Mix ${mixes.length + 1}`, sub: who.join(', ') + (group.length > 3 ? ' and more' : ''), artwork: cover(tracks), tracks });
  }
  // Discover: artists related to your favourites that you don't listen to yet
  if (online && ranked.length) {
    const seen = new Set(), tracks = [];
    for (const seed of ranked.slice(0, 6)) {
      for (const a of await related(P.names.get(seed), 5)) {
        const k = norm(a.name); if (P.songs.has(k) || seen.has(k)) continue;
        seen.add(k); tracks.push(...await topTracks(a.id, 2));
        if (tracks.length >= 40) break;
      }
      if (tracks.length >= 40) break;
    }
    if (tracks.length) mixes.push({ id: 'discover', name: 'Discover', sub: 'New artists like the ones you play', artwork: cover(tracks), tracks: smartShuffle(tracks) });
  }
  // Favourites, mixed up
  if (library.liked.length >= 8) {
    const tracks = smartShuffle(library.liked).slice(0, 60);
    mixes.push({ id: 'favourites', name: 'Favourites Mix', sub: 'Your liked songs, mixed up', artwork: cover(tracks), tracks });
  }
  // Your music server
  if (subsonicLinked()) {
    try {
      let tracks = await serverRandom(30);
      const seed = tracks[0];
      if (seed) tracks = tracks.concat(await serverSimilar(seed.ids.server, 20));
      const seen = new Set(); tracks = tracks.filter(t => !seen.has(t.key) && seen.add(t.key));
      if (tracks.length) mixes.push({ id: 'server', name: 'Server Mix', sub: 'From your own music server', artwork: cover(tracks), tracks: smartShuffle(tracks) });
    } catch (e) { log('server mix failed', e.message); }
  }
  log('mixes built', mixes.map(m => `${m.name} (${m.tracks.length})`));
  save(KEY, { day: today(), mixes });
  return mixes;
}
export const savedMix = id => load(KEY, null)?.mixes?.find(m => m.id === id) || null;
