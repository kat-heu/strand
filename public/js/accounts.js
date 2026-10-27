// Linked accounts: how to connect each service and what to show from it.
// Each service exposes `sections` — rows/grids loaded lazily for the "Your music" pages —
// and `remoteCollection` loads any playlist/album/liked list for the detail page.
import { settings, setSetting, emit } from './store.js';
import {
  spotifyConnected, spotifyLogin, spotifyLogout, spotifyNeedsReconnect, spotifyProfile,
  spApi, spToTrack, spotifyPlaylists, spotifyCollection, playlistTotal,
} from './providers/spotify.js';
import * as sp from './providers/spotify.js';
import {
  appleConfigured, appleAuthorized, appleAuthorize, appleUnauthorize,
  appleApi, appleAll, appleArt, amAnyToTrack, appleCollection,
} from './providers/apple.js';
import { googleConfigured, googleLinked, googleActive, googleLogin, googleLogout, googleReconnect, ytFetch } from './providers/google.js';
import * as gg from './providers/google.js';
import { ytVideosToTracks } from './providers/youtube.js';
import { youtubeCollection } from './importer.js';
import { scResolve } from './providers/soundcloud.js';

const dedupe = list => { const s = new Set(); return list.filter(t => t && !s.has(t.key) && s.add(t.key)); };
// Liked videos include everything; keep music (category 10) when there is any.
const musicOnly = items => { const m = items.filter(v => v.snippet?.categoryId === '10'); return m.length ? m : items; };
const remoteHref = (svc, kind, id = 'me') => `#/remote/${svc}/${kind}/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------- SoundCloud "link"
// SoundCloud's login API is closed to new apps, so listeners link their public
// profile URL instead; we read their public tracks and likes through the widget.
function scNormalize(input) {
  let u;
  try { u = new URL(/^https?:/.test(input) ? input : 'https://soundcloud.com/' + input.replace(/^@/, '')); } catch { return null; }
  if (!/(^|\.)soundcloud\.com$/.test(u.hostname)) return null;
  const user = u.pathname.split('/').filter(Boolean)[0];
  return user ? `https://soundcloud.com/${user}` : null;
}

export const ACCOUNTS = {
  spotify: {
    label: 'Spotify',
    blurb: 'Playlists, Liked Songs, saved albums, top tracks, recently played and artists you follow.',
    needs: 'Playback needs Spotify Premium. Only playlists you created or collaborate on show their songs.',
    configured: () => !!settings.spotifyClientId,
    linked: spotifyConnected,
    connect: spotifyLogin,
    disconnect: spotifyLogout,
    profile: () => sp.spotifyProfile && {
      name: sp.spotifyProfile.display_name || sp.spotifyProfile.id,
      image: sp.spotifyProfile.images?.[0]?.url,
      note: 'Connected',
    },
    warning: () => spotifyNeedsReconnect() ? { text: 'Reconnect to let Strand see your top tracks, history and followed artists.', action: 'Reconnect', run: spotifyLogin } : null,
    sections: [
      { id: 'playlists', title: 'Playlists', type: 'grid', load: async () => [
        { title: 'Liked Songs', sub: 'Spotify', liked: true, href: remoteHref('spotify', 'liked') },
        ...(await spotifyPlaylists()).map(p => {
          // Spotify only exposes the songs of playlists the listener owns or collaborates on.
          const mine = !sp.spotifyProfile?.id || p.owner?.id === sp.spotifyProfile.id || p.collaborative;
          return { title: p.name, sub: mine ? `${playlistTotal(p)} songs` : `Followed · by ${p.owner?.display_name || 'Spotify'}`, art: p.images?.[0]?.url, href: remoteHref('spotify', 'playlist', p.id) };
        }),
      ] },
      { id: 'recent', title: 'Recently played', type: 'tracks', href: remoteHref('spotify', 'recent'),
        load: async () => dedupe((await spApi('/me/player/recently-played?limit=50')).items.map(i => spToTrack(i.track))) },
      { id: 'top', title: 'Your top tracks this month', type: 'tracks', href: remoteHref('spotify', 'top'),
        load: async () => (await spApi('/me/top/tracks?limit=50&time_range=short_term')).items.map(spToTrack) },
      { id: 'albums', title: 'Saved albums', type: 'grid', load: async () =>
        (await spApi('/me/albums?limit=50')).items.map(({ album: a }) => ({ title: a.name, sub: a.artists.map(x => x.name).join(', '), art: a.images?.[0]?.url, href: remoteHref('spotify', 'album', a.id) })) },
      { id: 'artists', title: 'Artists you follow', type: 'grid', load: async () =>
        (await spApi('/me/following?type=artist&limit=50')).artists.items.map(a => ({ title: a.name, sub: 'Artist', art: a.images?.[0]?.url, round: true, href: `#/search/${encodeURIComponent(a.name)}` })) },
    ],
  },

  apple: {
    label: 'Apple Music',
    blurb: 'Library playlists, songs and albums, recently played and heavy rotation.',
    needs: 'Needs an Apple Music subscription.',
    configured: appleConfigured,
    linked: appleAuthorized,
    connect: appleAuthorize,
    disconnect: appleUnauthorize,
    profile: () => appleAuthorized() && { name: 'Apple Music', note: 'Signed in' },
    warning: () => null,
    sections: [
      { id: 'playlists', title: 'Library playlists', type: 'grid', load: async () =>
        (await appleAll('/v1/me/library/playlists?limit=100', 300)).map(p => ({ title: p.attributes.name, sub: 'Playlist', art: appleArt(p.attributes.artwork), href: remoteHref('apple', 'libplaylist', p.id) })) },
      { id: 'recent', title: 'Recently played', type: 'tracks', href: remoteHref('apple', 'recent'),
        load: async () => dedupe((await appleApi('/v1/me/recent/played/tracks', { limit: 30, types: 'songs,library-songs' })).data.map(amAnyToTrack)) },
      { id: 'songs', title: 'Songs in your library', type: 'tracks', href: remoteHref('apple', 'libsongs'),
        load: async () => (await appleApi('/v1/me/library/songs', { limit: 100 })).data.map(amAnyToTrack) },
      { id: 'albums', title: 'Albums', type: 'grid', load: async () =>
        (await appleAll('/v1/me/library/albums?limit=100', 300)).map(a => ({ title: a.attributes.name, sub: a.attributes.artistName, art: appleArt(a.attributes.artwork), href: remoteHref('apple', 'libalbum', a.id) })) },
      { id: 'heavy', title: 'Heavy rotation', type: 'grid', load: async () =>
        (await appleApi('/v1/me/history/heavy-rotation', { limit: 10 })).data.map(x => ({
          title: x.attributes.name, sub: x.attributes.artistName || x.attributes.curatorName || '', art: appleArt(x.attributes.artwork),
          href: x.type === 'albums' ? `#/album/${x.id}` : x.type === 'playlists' ? remoteHref('apple', 'playlist', x.id)
              : x.type === 'library-albums' ? remoteHref('apple', 'libalbum', x.id) : remoteHref('apple', 'libplaylist', x.id),
        })) },
    ],
  },

  youtube: {
    label: 'YouTube Music',
    blurb: 'Your YouTube / YouTube Music playlists and liked songs.',
    needs: 'Sign in with your Google account.',
    configured: googleConfigured,
    linked: googleLinked,
    connect: googleLogin,
    disconnect: googleLogout,
    profile: () => gg.googleProfile && { name: gg.googleProfile.name, image: gg.googleProfile.image, note: googleActive() ? 'Signed in with Google' : 'Session expired' },
    warning: () => googleLinked() && !googleActive() ? { text: 'Google sessions last an hour. Reconnect to load your playlists again.', action: 'Reconnect', run: googleReconnect } : null,
    sections: [
      { id: 'playlists', title: 'Playlists', type: 'grid', load: async () => {
        const out = [{ title: 'Liked music', sub: 'YouTube', liked: true, href: remoteHref('youtube', 'liked') }];
        let pageToken = '';
        do {
          const d = await ytFetch('playlists', { part: 'snippet,contentDetails', mine: 'true', maxResults: 50, ...(pageToken && { pageToken }) }, { requireUser: true });
          out.push(...d.items.map(p => ({ title: p.snippet.title, sub: `${p.contentDetails.itemCount} videos`, art: p.snippet.thumbnails?.high?.url || p.snippet.thumbnails?.medium?.url, href: remoteHref('youtube', 'playlist', p.id) })));
          pageToken = d.nextPageToken;
        } while (pageToken && out.length < 300);
        return out;
      } },
      { id: 'liked', title: 'Liked music', type: 'tracks', href: remoteHref('youtube', 'liked'),
        load: async () => ytVideosToTracks(musicOnly((await ytFetch('videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50 }, { requireUser: true })).items)) },
    ],
  },

  soundcloud: {
    label: 'SoundCloud',
    blurb: 'Tracks and likes from your public SoundCloud profile.',
    needs: 'Your profile and likes must be public.',
    configured: () => true,
    linked: () => !!settings.scProfile,
    connect: async () => {
      const input = prompt('Your SoundCloud profile link or username', 'https://soundcloud.com/');
      if (!input) return;
      const url = scNormalize(input.trim());
      if (!url) throw new Error('That isn’t a SoundCloud profile link');
      setSetting('scProfile', url); emit('auth');
    },
    disconnect: async () => { setSetting('scProfile', ''); emit('auth'); },
    profile: () => settings.scProfile && { name: settings.scProfile.split('/').pop(), note: 'Public profile' },
    warning: () => null,
    sections: [
      { id: 'likes', title: 'Likes', type: 'tracks', href: () => remoteHref('soundcloud', 'url', settings.scProfile + '/likes'),
        load: async () => (await scResolve(settings.scProfile + '/likes')).tracks },
      { id: 'tracks', title: 'Your uploads', type: 'tracks', href: () => remoteHref('soundcloud', 'url', settings.scProfile),
        load: async () => (await scResolve(settings.scProfile)).tracks },
    ],
  },
};
export const ORDER = ['spotify', 'apple', 'youtube', 'soundcloud'];
export const anyLinked = () => ORDER.some(k => ACCOUNTS[k].linked());

// ---------------------------------------------------------------- detail lists
const cache = new Map();
export async function remoteCollection(svc, kind, id, onProgress) {
  const key = [svc, kind, id].join('|');
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    if (svc === 'spotify') {
      if (kind === 'top') return { name: 'Your top tracks', tracks: (await spApi('/me/top/tracks?limit=50&time_range=short_term')).items.map(spToTrack) };
      if (kind === 'recent') return { name: 'Recently played on Spotify', tracks: dedupe((await spApi('/me/player/recently-played?limit=50')).items.map(i => spToTrack(i.track))) };
      return spotifyCollection(kind, id, onProgress);
    }
    if (svc === 'apple') {
      if (kind === 'playlist') return appleCollection('playlist', id, onProgress);
      if (kind === 'recent') return { name: 'Recently played on Apple Music', tracks: dedupe((await appleApi('/v1/me/recent/played/tracks', { limit: 30, types: 'songs,library-songs' })).data.map(amAnyToTrack)) };
      if (kind === 'libsongs') return { name: 'Apple Music library', tracks: (await appleAll('/v1/me/library/songs?limit=100', 3000, onProgress)).map(amAnyToTrack) };
      const base = kind === 'libalbum' ? 'albums' : 'playlists';
      const meta = (await appleApi(`/v1/me/library/${base}/${id}`)).data[0];
      const tracks = (await appleAll(`/v1/me/library/${base}/${id}/tracks?limit=100`, 3000, onProgress)).map(amAnyToTrack);
      return { name: meta.attributes.name, artwork: appleArt(meta.attributes.artwork), tracks };
    }
    if (svc === 'youtube') {
      if (kind === 'liked') {
        const tracks = [];
        let pageToken = '';
        do {
          const d = await ytFetch('videos', { part: 'snippet,contentDetails', myRating: 'like', maxResults: 50, ...(pageToken && { pageToken }) }, { requireUser: true });
          tracks.push(...ytVideosToTracks(musicOnly(d.items)));
          onProgress?.(tracks.length, d.pageInfo?.totalResults);
          pageToken = d.nextPageToken;
        } while (pageToken && tracks.length < 1000);
        return { name: 'Liked music', tracks };
      }
      return youtubeCollection('playlist', id, onProgress);
    }
    if (svc === 'soundcloud') {
      const r = await scResolve(id, onProgress);
      return { ...r, name: id.endsWith('/likes') ? 'SoundCloud likes' : id.split('/').pop() };
    }
    throw new Error('Unknown source');
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
export function clearRemoteCache() { cache.clear(); }
