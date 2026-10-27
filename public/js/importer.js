// Paste a link from any of the four services → a playlist in your library.
// Imported tracks keep their native ids, so they play from their home service
// when it's connected and get matched to your preferred source otherwise.
import { spotifyConnected, spotifyCollection } from './providers/spotify.js';
import { appleConfigured, appleCollection } from './providers/apple.js';
import { settings } from './store.js';
import { ytVideosToTracks } from './providers/youtube.js';
import { ytFetch } from './providers/google.js';
import { scResolve } from './providers/soundcloud.js';
import { pool } from './util.js';

export function parseLink(input) {
  const s = (input || '').trim();
  let m;
  if ((m = s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)/))) return { service: 'spotify', kind: m[1], id: m[2] };
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'open.spotify.com') {
    const i = parts.findIndex(p => ['track', 'album', 'playlist'].includes(p));
    if (i >= 0 && parts[i + 1]) return { service: 'spotify', kind: parts[i], id: parts[i + 1] };
    if (parts.includes('collection')) return { service: 'spotify', kind: 'liked' };
  }
  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    const songId = u.searchParams.get('i');
    if (songId) return { service: 'apple', kind: 'song', id: songId };
    const kind = parts.find(p => ['album', 'playlist', 'song'].includes(p));
    if (kind) return { service: 'apple', kind, id: parts[parts.length - 1] };
  }
  if (host === 'youtu.be') return { service: 'youtube', kind: 'video', id: parts[0] };
  if (host === 'youtube.com' || host === 'music.youtube.com') {
    const list = u.searchParams.get('list'), v = u.searchParams.get('v');
    if (list && (!v || u.pathname.startsWith('/playlist'))) return { service: 'youtube', kind: 'playlist', id: list };
    if (v) return { service: 'youtube', kind: 'video', id: v };
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com' || host === 'api.soundcloud.com') {
    return { service: 'soundcloud', kind: /\/sets\//.test(u.pathname) ? 'set' : 'track', url: s.split('?')[0] };
  }
  return null;
}

export async function youtubeCollection(kind, id, onProgress) {
  let ids = [], name = 'YouTube video';
  if (kind === 'playlist') {
    const meta = await ytFetch('playlists', { part: 'snippet', id });
    name = meta.items?.[0]?.snippet?.title || 'YouTube playlist';
    let pageToken = '';
    do {
      const d = await ytFetch('playlistItems', { part: 'contentDetails', playlistId: id, maxResults: 50, ...(pageToken && { pageToken }) });
      ids.push(...d.items.map(i => i.contentDetails.videoId));
      onProgress?.(ids.length, d.pageInfo?.totalResults);
      pageToken = d.nextPageToken;
    } while (pageToken && ids.length < 2000);
  } else ids = [id];
  const tracks = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await ytFetch('videos', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(',') });
    tracks.push(...ytVideosToTracks(d.items));
  }
  if (kind !== 'playlist' && tracks[0]) name = tracks[0].title;
  return { name, tracks };
}

export async function importLink(input, onProgress) {
  const link = parseLink(input);
  if (!link) throw new Error('That doesn’t look like a Spotify, Apple Music, YouTube or SoundCloud link');
  let res;
  switch (link.service) {
    case 'spotify':
      if (!spotifyConnected()) throw new Error('Connect Spotify in Settings to import Spotify links');
      res = await spotifyCollection(link.kind, link.id, onProgress); break;
    case 'apple':
      if (!appleConfigured()) throw new Error('Add an Apple Music developer token in Settings to import Apple Music links');
      res = await appleCollection(link.kind, link.id, onProgress); break;
    case 'youtube':
      res = await youtubeCollection(link.kind, link.id, onProgress); break;
    case 'soundcloud':
      res = await scResolve(link.url, onProgress); break;
  }
  const single = ['track', 'song', 'video'].includes(link.kind) || (link.service === 'soundcloud' && link.kind === 'track');
  return { ...res, service: link.service, single, total: res.tracks.length };
}

export { pool };
