// Apple Music via MusicKit JS v3.
// Needs a MusicKit developer token (JWT signed with a MusicKit key from an Apple
// Developer account) and each listener needs an Apple Music subscription.
// iTunes catalog ids == Apple Music catalog ids, so catalog tracks play directly.
import { settings, emit } from '../store.js';
import { matchScore, loadScript } from '../util.js';

let mk = null, ready = null;

export const appleConfigured = () => !!settings.appleDevToken.trim();
export const appleAuthorized = () => !!mk?.isAuthorized;

async function ensure() {
  if (!appleConfigured()) throw new Error('add an Apple Music developer token in Settings');
  if (ready) return ready;
  ready = (async () => {
    if (!window.MusicKit) {
      const loaded = new Promise(res => document.addEventListener('musickitloaded', res, { once: true }));
      await loadScript('https://js-cdn.music.apple.com/musickit/v3/musickit.js');
      if (!window.MusicKit) await loaded;
    }
    mk = await window.MusicKit.configure({
      developerToken: settings.appleDevToken.trim(),
      app: { name: 'Strand', build: '0.1.0' },
    });
    return mk;
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

// Restore an existing authorisation silently at startup.
export async function appleInit() {
  if (!appleConfigured()) return;
  try { await ensure(); emit('auth'); } catch (e) { console.warn('MusicKit init failed', e); }
}

export async function appleAuthorize() { await ensure(); await mk.authorize(); emit('auth'); }
export async function appleUnauthorize() { await ensure(); await mk.unauthorize(); emit('auth'); }

export function amToTrack(s) {
  const a = s.attributes || {};
  return {
    key: 'it:' + s.id,
    title: a.name, artist: a.artistName, album: a.albumName || '',
    artwork: a.artwork?.url?.replace('{w}', '600').replace('{h}', '600') || '',
    durationMs: a.durationInMillis || 0,
    previewUrl: a.previews?.[0]?.url || '',
    origin: 'apple',
    ids: { apple: s.id, itunes: s.id, isrc: a.isrc },
  };
}

// Raw Apple Music API call (adds the listener's Music User Token automatically).
// Accepts paths with a query string, e.g. the `next` links Apple returns.
export async function appleApi(path, params = {}) {
  await ensure();
  if (!mk.isAuthorized) throw new Error('Sign in to Apple Music to see this');
  const u = new URL(path, 'https://api.music.apple.com');
  u.searchParams.forEach((v, k) => { if (!(k in params)) params[k] = v; });
  const r = await mk.api.music(u.pathname, params);
  return r.data;
}
export async function appleAll(path, cap = 2000, onProgress) {
  const out = [];
  let next = path;
  while (next && out.length < cap) {
    const d = await appleApi(next);
    out.push(...(d.data || []));
    onProgress?.(out.length, d.meta?.total);
    next = d.next;
  }
  return out;
}
export const appleArt = (a, size = 600) => a?.url ? a.url.replace('{w}', size).replace('{h}', size) : '';

// Catalog songs *and* library songs → tracks. Library songs carry the catalog id
// in playParams when they exist in the catalog; uploads only have a library id.
export function amAnyToTrack(s) {
  if (s.type === 'songs') return amToTrack(s);
  const a = s.attributes || {};
  const catalogId = a.playParams?.catalogId || a.playParams?.purchasedId;
  return {
    key: catalogId ? 'it:' + catalogId : 'am:' + s.id,
    title: a.name, artist: a.artistName, album: a.albumName || '',
    artwork: appleArt(a.artwork), durationMs: a.durationInMillis || 0,
    origin: 'apple',
    ids: { apple: catalogId || s.id, ...(catalogId && { itunes: catalogId }), isrc: a.isrc },
  };
}

export async function appleCollection(kind, id, onProgress) {
  await ensure();
  const sf = mk.storefrontId || settings.country || 'us';
  const path = kind === 'album' ? 'albums' : kind === 'song' ? 'songs' : 'playlists';
  const r = await mk.api.music(`/v1/catalog/${sf}/${path}/${id}`, kind === 'song' ? {} : { include: 'tracks' });
  const item = r.data.data[0];
  if (kind === 'song') return { name: item.attributes.name, tracks: [amToTrack(item)] };
  let rel = item.relationships.tracks;
  const tracks = rel.data.filter(x => x.type === 'songs').map(amToTrack);
  while (rel.next) {
    rel = await appleApi(rel.next);
    tracks.push(...rel.data.filter(x => x.type === 'songs').map(amToTrack));
    onProgress?.(tracks.length);
  }
  return { name: item.attributes.name, artwork: item.attributes.artwork?.url?.replace('{w}', '600').replace('{h}', '600'), tracks };
}

export function createApple(ctx) {
  let endedFor = null, current = null;

  async function resolve(t) {
    if (t.ids?.apple) return { id: t.ids.apple, score: null };
    const sf = mk.storefrontId || 'us';
    const r = await mk.api.music(`/v1/catalog/${sf}/search`, { term: `${t.artist} ${t.title}`, types: 'songs', limit: 8 });
    let best = null, score = 0;
    for (const s of r.data.results?.songs?.data || []) {
      const a = s.attributes;
      const sc = matchScore(t, { title: a.name, artist: a.artistName, durationMs: a.durationInMillis });
      if (sc > score) { score = sc; best = s; }
    }
    if (!best || score < 0.55) throw new Error('not found on Apple Music');
    return { id: best.id, score };
  }

  function bind() {
    if (bind.done) return; bind.done = true;
    mk.addEventListener('playbackStateDidChange', ({ state }) => {
      const S = window.MusicKit.PlaybackStates;
      if ((state === S.completed || state === S.ended) && current && endedFor !== current) {
        endedFor = current; ctx.onEnded();
      }
    });
  }

  return {
    name: 'apple',
    label: 'Apple Music',
    available: () => appleAuthorized(),
    canPlay: () => appleAuthorized(),
    async load(t) {
      await ensure();
      if (!mk.isAuthorized) await mk.authorize();
      bind();
      let { id, score } = await resolve(t);
      current = id; endedFor = null;
      try {
        await mk.setQueue({ song: id, startPlaying: true });
      } catch (e) {
        // iTunes ids come from the app's store region; the listener's region may differ.
        if (!t.ids?.apple) throw e;
        ({ id, score } = await resolve({ ...t, ids: {} }));
        current = id;
        await mk.setQueue({ song: id, startPlaying: true });
      }
      return { score };
    },
    play: () => mk?.play(),
    pause: () => mk?.pause(),
    seek: ms => mk?.seekToTime(ms / 1000),
    setVolume: v => { if (mk) mk.volume = v; },
    position: () => (mk?.currentPlaybackTime || 0) * 1000,
    duration: () => (mk?.currentPlaybackDuration || 0) * 1000,
    isPlaying: () => !!mk?.isPlaying,
    stop: () => { current = null; try { mk?.stop(); } catch {} },
  };
}
