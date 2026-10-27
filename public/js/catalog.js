// Free, key-less metadata catalog: the iTunes Search API.
// Gives us search, artists, albums, artwork, durations and 30-second previews.
// iTunes trackIds are the same ids Apple Music uses, so they play directly via MusicKit.
// Note: Apple rate-limits this API (~20 calls/minute), so results are memoised.
import { jsonp, matchScore, norm } from './util.js';
import { settings } from './store.js';

const BASE = 'https://itunes.apple.com';
const mem = new Map();

async function get(path, params) {
  const q = new URLSearchParams({ ...params, country: settings.country || 'us' });
  const url = `${BASE}/${path}?${q}`;
  if (mem.has(url)) return mem.get(url);
  const p = (async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch {
      return await jsonp(url); // iTunes supports JSONP when CORS is unavailable
    }
  })();
  mem.set(url, p);
  p.catch(() => mem.delete(url));
  return p;
}

export const art = (u, size = 600) =>
  u ? u.replace(/\d+x\d+(bb)?\.(jpg|png|webp)/, `${size}x${size}bb.jpg`) : '';

export function toTrack(r) {
  return {
    key: 'it:' + r.trackId,
    title: r.trackName,
    artist: r.artistName,
    album: (r.collectionName || '').replace(/ - (Single|EP)$/, ''),
    artistId: r.artistId,
    albumId: r.collectionId,
    artwork: art(r.artworkUrl100),
    durationMs: r.trackTimeMillis || 0,
    previewUrl: r.previewUrl || '',
    explicit: r.trackExplicitness === 'explicit',
    trackNumber: r.trackNumber,
    disc: r.discNumber,
    origin: 'catalog',
    ids: { itunes: String(r.trackId), apple: String(r.trackId) },
    appleUrl: r.trackViewUrl,
  };
}

export function toAlbum(r) {
  return {
    id: r.collectionId,
    title: (r.collectionName || '').replace(/ - (Single|EP)$/, ''),
    rawTitle: r.collectionName,
    artist: r.artistName,
    artistId: r.artistId,
    artwork: art(r.artworkUrl100),
    year: (r.releaseDate || '').slice(0, 4),
    count: r.trackCount,
    type: /- Single$/.test(r.collectionName || '') ? 'Single' : /- EP$/.test(r.collectionName || '') ? 'EP' : 'Album',
  };
}

export async function search(term) {
  const d = await get('search', { term, media: 'music', entity: 'song', limit: 40 });
  const tracks = (d.results || []).filter(r => r.wrapperType === 'track').map(toTrack);
  const raw = d.results || [];
  const albums = [], artists = [];
  const seenA = new Set(), seenR = new Set();
  for (const r of raw) {
    if (r.collectionId && !seenA.has(r.collectionId)) {
      seenA.add(r.collectionId);
      albums.push(toAlbum({ ...r, releaseDate: r.releaseDate }));
    }
    if (r.artistId && !seenR.has(r.artistId)) {
      seenR.add(r.artistId);
      artists.push({ id: r.artistId, name: r.artistName, artwork: art(r.artworkUrl100, 300), genre: r.primaryGenreName });
    }
  }
  // Rank artists by how well they match the query
  const q = norm(term);
  artists.sort((a, b) => (norm(b.name) === q) - (norm(a.name) === q));
  return { tracks, albums: albums.slice(0, 12), artists: artists.slice(0, 8) };
}

export async function artist(id) {
  const [a, s] = await Promise.all([
    get('lookup', { id, entity: 'album', limit: 80 }),
    get('lookup', { id, entity: 'song', limit: 30 }),
  ]);
  const info = (a.results || []).find(x => x.wrapperType === 'artist') ||
               (s.results || []).find(x => x.wrapperType === 'artist') || {};
  const seen = new Set();
  const albums = (a.results || [])
    .filter(x => x.wrapperType === 'collection')
    .map(toAlbum)
    .filter(al => { const k = norm(al.title) + al.type; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => (y.year || '').localeCompare(x.year || ''));
  const songs = (s.results || []).filter(x => x.wrapperType === 'track').map(toTrack);
  return {
    id,
    name: info.artistName || songs[0]?.artist || 'Artist',
    genre: info.primaryGenreName || '',
    artwork: songs[0]?.artwork || albums[0]?.artwork || '',
    albums,
    songs,
  };
}

export async function album(id) {
  const d = await get('lookup', { id, entity: 'song', limit: 200 });
  const res = d.results || [];
  const col = res.find(x => x.wrapperType === 'collection');
  const tracks = res.filter(x => x.wrapperType === 'track').map(toTrack)
    .sort((a, b) => (a.disc - b.disc) || (a.trackNumber - b.trackNumber));
  return { ...(col ? toAlbum(col) : { id, title: 'Album' }), copyright: col?.copyright, genre: col?.primaryGenreName, tracks };
}

export async function lookupTracks(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const d = await get('lookup', { id: ids.slice(i, i + 150).join(','), entity: 'song' });
    out.push(...(d.results || []).filter(r => r.wrapperType === 'track').map(toTrack));
  }
  const order = new Map(ids.map((id, i) => [String(id), i]));
  return out.sort((a, b) => (order.get(a.ids.itunes) ?? 0) - (order.get(b.ids.itunes) ?? 0));
}

export async function top() {
  try {
    const r = await fetch(`https://rss.applemarketingtools.com/api/v2/${settings.country || 'us'}/music/most-played/30/songs.json`);
    const d = await r.json();
    const ids = d.feed.results.map(x => x.id);
    return await lookupTracks(ids);
  } catch {
    // Feed unavailable (CORS/offline) — fall back to a search
    try { return (await search('top hits ' + new Date().getFullYear())).tracks.slice(0, 20); } catch { return []; }
  }
}

// Find the catalog version of a track from another service (for previews/artwork/artist pages).
export async function match(t) {
  if (t.ids?.itunes) return { track: t, score: 1 };
  const d = await get('search', { term: norm(`${t.artist} ${t.title}`).slice(0, 120), media: 'music', entity: 'song', limit: 10 });
  let best = null, score = 0;
  for (const r of d.results || []) {
    const c = toTrack(r);
    const sc = matchScore(t, c);
    if (sc > score) { score = sc; best = c; }
  }
  return score >= 0.6 ? { track: best, score } : { track: null, score };
}
