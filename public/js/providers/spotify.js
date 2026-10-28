// Spotify via the official Web Playback SDK + Web API, using PKCE login (no client secret).
// Requirements: each listener has Spotify Premium, and while your Spotify app is in
// "Development mode" only users you add in the Spotify dashboard can log in.
import { settings, load, save, emit, cacheGet, cacheSet, ns } from '../store.js';
import { matchScore, loadScript } from '../util.js';

const AUTH = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
const TKEY = ns('spotify');
const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',
  'user-read-playback-state', 'user-modify-playback-state',
  'playlist-read-private', 'playlist-read-collaborative', 'user-library-read',
  'user-top-read', 'user-read-recently-played', 'user-follow-read',
].join(' ');

let tok = load(TKEY, null); // { access, refresh, exp }
export let spotifyProfile = load(TKEY + ':me', null);

// The app's own base address (works at the site root or under a sub-path such as GitHub Pages).
export const redirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, '');
export const spotifyConnected = () => !!tok?.refresh;
// True when the saved login predates permissions this version asks for.
export const spotifyNeedsReconnect = () => !!tok && SCOPES.split(' ').some(sc => !(tok.scope || '').split(' ').includes(sc));

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function spotifyLogin() {
  const id = settings.spotifyClientId.trim();
  if (!id) throw new Error('Add your Spotify Client ID first');
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const authUrl = `${AUTH}/authorize?` + new URLSearchParams({
    client_id: id, response_type: 'code', redirect_uri: redirectUri(),
    code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
  });
  if (isDesktop()) return desktopLogin(authUrl, state, verifier);
  sessionStorage.setItem('sp_verifier', verifier);
  sessionStorage.setItem('sp_state', state);
  sessionStorage.setItem('sp_return', location.hash || '#/settings');
  location.href = authUrl;
}

// Desktop app: log in through the system browser, then collect the code from the
// local server (see server.js). The app window never leaves Strand.
export const isDesktop = () => !!window.strandDesktop || /Electron\//.test(navigator.userAgent);
let cancelDesktop = null;
export const cancelSpotifyLogin = () => cancelDesktop?.();
async function desktopLogin(authUrl, state, verifier) {
  await fetch(`/__auth/start?state=${encodeURIComponent(state)}`, { method: 'POST' });
  window.open(authUrl, '_blank'); // the desktop shell opens this in the default browser
  emit('toast', 'Finish signing in to Spotify in your browser…');
  let cancelled = false;
  cancelDesktop = () => { cancelled = true; };
  const until = Date.now() + 10 * 60000;
  while (!cancelled && Date.now() < until) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await fetch(`/__auth/result?state=${encodeURIComponent(state)}`).then(x => x.json()).catch(() => ({ pending: true }));
    if (r.pending) continue;
    if (r.error) throw new Error(r.error === 'expired' ? 'Spotify sign-in expired — try again' : 'Spotify sign-in was cancelled');
    await finishLogin(r.code, verifier);
    return spotifyProfile;
  }
  throw new Error(cancelled ? 'Spotify sign-in cancelled' : 'Spotify sign-in timed out — try again');
}

async function finishLogin(code, verifier) {
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
  spotifyProfile = await spApi('/me');
  save(TKEY + ':me', spotifyProfile);
  emit('auth');
}

export function spotifyLogout() {
  tok = null; spotifyProfile = null;
  localStorage.removeItem(TKEY); localStorage.removeItem(TKEY + ':me');
  emit('auth');
}

async function tokenRequest(body) {
  const r = await fetch(`${AUTH}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.spotifyClientId.trim(), ...body }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || d.error || 'Spotify token error');
  tok = { access: d.access_token, refresh: d.refresh_token || tok?.refresh, exp: Date.now() + d.expires_in * 1000, scope: d.scope || tok?.scope || '' };
  save(TKEY, tok);
  return tok;
}

// Call at startup: finishes the redirect from Spotify's login page.
export async function handleSpotifyCallback() {
  const u = new URL(location.href);
  const code = u.searchParams.get('code'), state = u.searchParams.get('state'), err = u.searchParams.get('error');
  if (!code && !err) return null;
  const ret = sessionStorage.getItem('sp_return') || '#/settings';
  history.replaceState(null, '', location.pathname + ret);
  if (err) throw new Error('Spotify login cancelled: ' + err);
  if (state !== sessionStorage.getItem('sp_state')) throw new Error('Spotify login state mismatch — try again');
  const verifier = sessionStorage.getItem('sp_verifier');
  sessionStorage.removeItem('sp_verifier'); sessionStorage.removeItem('sp_state');
  await finishLogin(code, verifier);
  return spotifyProfile;
}

let refreshing = null;
async function accessToken() {
  if (!tok) throw new Error('Spotify not connected');
  if (Date.now() > tok.exp - 60000) {
    refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: tok.refresh }).finally(() => { refreshing = null; });
    try { await refreshing; } catch (e) { spotifyLogout(); throw e; }
  }
  return tok.access;
}

export async function spApi(path, opts = {}, retry = true) {
  const url = path.startsWith('http') ? path : API + path;
  const r = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + await accessToken(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401 && retry) { tok.exp = 0; return spApi(path, opts, false); }
  if (r.status === 429 && retry) {
    await new Promise(res => setTimeout(res, (Number(r.headers.get('Retry-After')) || 2) * 1000));
    return spApi(path, opts, false);
  }
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  // Some player endpoints (e.g. "play") answer 200 with a plain-text id, not JSON.
  let d = null;
  if (text) { try { d = JSON.parse(text); } catch { d = r.ok ? null : { error: { message: text.slice(0, 120) } }; } }
  if (!r.ok) {
    const e = new Error(r.status === 429 ? 'Spotify rate limit reached — try again in a minute' : (d?.error?.message || 'Spotify HTTP ' + r.status));
    e.status = r.status; throw e;
  }
  return d;
}

export function spToTrack(t) {
  return {
    key: 'sp:' + t.id,
    title: t.name,
    artist: (t.artists || []).map(a => a.name).join(', '),
    album: t.album?.name || '',
    artwork: t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms,
    explicit: t.explicit,
    origin: 'spotify',
    ids: { spotify: t.uri, isrc: t.external_ids?.isrc },
  };
}

let sdkReady;
function loadSdk() {
  return sdkReady ??= new Promise((res, rej) => {
    if (window.Spotify?.Player) return res();
    window.onSpotifyWebPlaybackSDKReady = res;
    loadScript('https://sdk.scdn.co/spotify-player.js').catch(e => { sdkReady = null; rej(e); });
  });
}

export async function resolveSpotifyUri(t) {
  if (t.ids?.spotify) return { uri: t.ids.spotify, score: null };
  const cached = cacheGet('sp', t.key);
  if (cached) return cached;
  let items = [];
  if (t.ids?.isrc) items = (await spApi(`/search?type=track&limit=3&q=${encodeURIComponent('isrc:' + t.ids.isrc)}`)).tracks.items;
  if (!items.length) {
    const q = `track:${t.title.replace(/["']/g, '')} artist:${t.artist.split(/,|&/)[0].trim()}`;
    items = (await spApi(`/search?type=track&limit=8&q=${encodeURIComponent(q)}`)).tracks.items;
  }
  if (!items.length) items = (await spApi(`/search?type=track&limit=8&q=${encodeURIComponent(t.artist + ' ' + t.title)}`)).tracks.items;
  let best = null, score = 0;
  for (const it of items) {
    const sc = matchScore(t, { title: it.name, artist: it.artists.map(a => a.name).join(' '), durationMs: it.duration_ms });
    if (sc > score) { score = sc; best = it; }
  }
  if (!best || score < 0.55) throw new Error('not found on Spotify');
  const out = { uri: best.uri, score };
  cacheSet('sp', t.key, out);
  return out;
}


// Phones (and tablets) can't run Spotify's in-page player; there Strand uses the
// remote instead (createSpotifyRemote below).
export const isPhone = () => /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export function createSpotify(ctx) {
  let player = null, deviceId = null, ready = null;
  let st = { pos: 0, dur: 0, paused: true, at: 0 }, currentUri = null, nearEnd = false, endedFor = null;

  function onState(s) {
    if (!s) return;
    st = { pos: s.position, dur: s.duration, paused: s.paused, at: performance.now() };
    const cur = s.track_window?.current_track;
    if (!s.paused && s.duration && s.position > s.duration - 2500) nearEnd = true;
    const finished = s.paused && currentUri && endedFor !== currentUri &&
      ((s.position === 0 && (nearEnd || s.track_window?.previous_tracks?.some(t => t.uri === currentUri))) ||
       (cur && cur.uri !== currentUri && nearEnd));
    if (finished) { endedFor = currentUri; ctx.onEnded(); }
  }

  async function ensure() {
    if (ready) return ready;
    ready = (async () => {
      await loadSdk();
      player = new window.Spotify.Player({
        name: 'Strand',
        getOAuthToken: cb => accessToken().then(cb, e => ctx.onError(e)),
        volume: settings.volume,
      });
      const dev = new Promise((res, rej) => {
        player.addListener('ready', ({ device_id }) => { deviceId = device_id; res(); });
        player.addListener('not_ready', () => { deviceId = null; });
        player.addListener('initialization_error', ({ message }) => rej(new Error(message + ' (this window may lack Widevine DRM)')));
        player.addListener('authentication_error', ({ message }) => rej(new Error(message)));
        player.addListener('account_error', () => rej(new Error('Spotify Premium is required for playback')));
        setTimeout(() => rej(new Error('Spotify player timed out')), 15000);
      });
      player.addListener('player_state_changed', onState);
      player.addListener('playback_error', ({ message }) => ctx.onError(new Error(message)));
      if (!(await player.connect())) throw new Error('Spotify player failed to connect');
      await dev;
      return player;
    })();
    ready.catch(() => { ready = null; try { player?.disconnect(); } catch {} });
    return ready;
  }

  return {
    name: 'spotify',
    label: 'Spotify',
    available: () => spotifyConnected() && !isPhone() && hasWidevine(),
    canPlay: () => spotifyConnected(),
    async load(t) {
      const { uri, score } = await resolveSpotifyUri(t);
      await ensure();
      try { player.activateElement?.(); } catch {}
      nearEnd = false; endedFor = null; currentUri = uri;
      st = { pos: 0, dur: t.durationMs || 0, paused: false, at: performance.now() };
      await spApi(`/me/player/play?device_id=${deviceId}`, { method: 'PUT', body: JSON.stringify({ uris: [uri] }) });
      return { score };
    },
    play: () => player?.resume(),
    pause: () => player?.pause(),
    seek: ms => { player?.seek(Math.round(ms)); st.pos = ms; st.at = performance.now(); },
    setVolume: v => player?.setVolume(v),
    position: () => {
      const p = st.paused ? st.pos : Math.min(st.dur || Infinity, st.pos + (performance.now() - st.at));
      if (!st.paused && st.dur && p > st.dur - 2500) nearEnd = true;
      return p;
    },
    duration: () => st.dur,
    isPlaying: () => !st.paused,
    stop: () => { currentUri = null; try { player?.pause(); } catch {} },
  };
}

// ---- phone remote ---------------------------------------------------------
// On phones, Strand plays Spotify songs in the Spotify app and acts as its remote:
// Strand's own player shows the song, progress, pause/skip/seek, using Spotify's
// Web API player endpoints (needs Premium). If the Spotify app isn't running yet,
// Strand opens it and waits for it to appear as a device.
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Spotify's in-app player needs Widevine (built into Chrome, Edge and Safari, but
// not into the desktop app's Electron). Without it, Strand drives the Spotify app instead.
let widevine = null;
try {
  navigator.requestMediaKeySystemAccess?.('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }])
    .then(() => { widevine = true; }, () => { widevine = false; });
} catch { widevine = false; }
export const hasWidevine = () => widevine !== false;

export function createSpotifyRemote(ctx) {
  let st = { pos: 0, dur: 0, paused: true, at: 0 }, uri = null, poll = null, nearEnd = false, ended = false;

  async function devices() { return (await spApi('/me/player/devices'))?.devices || []; }
  async function pickDevice() {
    let ds = await devices();
    const here = isPhone() ? /smartphone|tablet/i : /computer/i;
    let d = ds.find(x => x.is_active) || ds.find(x => here.test(x.type)) || ds[0];
    if (!d) {
      try { window.location.href = 'spotify:'; } catch {}           // open the Spotify app
      for (let i = 0; i < 10 && !d; i++) {
        await sleep(1500);
        ds = await devices();
        d = ds.find(x => here.test(x.type)) || ds[0];
      }
    }
    if (!d) throw new Error(`Open the Spotify app on this ${isPhone() ? 'phone' : 'computer'}, then press play again`);
    return d.id;
  }
  async function refresh() {
    let s;
    try { s = await spApi('/me/player'); } catch { return; }
    if (!s) return;
    const item = s.item;
    st = { pos: s.progress_ms || 0, dur: item?.duration_ms || st.dur, paused: !s.is_playing, at: performance.now() };
    if (!st.paused && st.dur && st.pos > st.dur - 4000) nearEnd = true;
    const movedOn = uri && item && item.uri !== uri;
    if (!ended && uri && nearEnd && (movedOn || (st.paused && st.pos < 3000))) { ended = true; ctx.onEnded(); }
  }
  const startPolling = () => { clearInterval(poll); poll = setInterval(refresh, 2000); };

  return {
    name: 'spotifyRemote',
    label: 'Spotify app',
    available: () => spotifyConnected(),
    canPlay: () => spotifyConnected(),
    async load(t) {
      const { uri: u, score } = await resolveSpotifyUri(t);
      const device = await pickDevice();
      await spApi(`/me/player/play?device_id=${device}`, { method: 'PUT', body: JSON.stringify({ uris: [u] }) });
      uri = u; nearEnd = false; ended = false;
      st = { pos: 0, dur: t.durationMs || 0, paused: false, at: performance.now() };
      startPolling();
      return { score };
    },
    play: () => { st.paused = false; st.at = performance.now(); return spApi('/me/player/play', { method: 'PUT' }).catch(e => ctx.onError(e)); },
    pause: () => { st.pos = st.paused ? st.pos : st.pos + (performance.now() - st.at); st.paused = true; return spApi('/me/player/pause', { method: 'PUT' }).catch(e => ctx.onError(e)); },
    seek: ms => { st.pos = ms; st.at = performance.now(); return spApi(`/me/player/seek?position_ms=${Math.round(ms)}`, { method: 'PUT' }).catch(() => {}); },
    setVolume: () => {},                                          // the Spotify app has its own volume
    position: () => (st.paused ? st.pos : Math.min(st.dur || Infinity, st.pos + (performance.now() - st.at))),
    duration: () => st.dur,
    isPlaying: () => !st.paused,
    stop: () => {
      clearInterval(poll); poll = null;
      if (uri && !st.paused) spApi('/me/player/pause', { method: 'PUT' }).catch(() => {});
      uri = null; st.paused = true;
    },
  };
}

// ---- import helpers --------------------------------------------------------
export const playlistTotal = p => p.items?.total ?? p.tracks?.total ?? 0;
export async function spotifyPlaylists() {
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 500) {
    const d = await spApi(next);
    out.push(...d.items.filter(Boolean));
    next = d.next;
  }
  return out;
}

// Fetch every page of a big list: the first page tells us the total, then the rest
// are fetched 4 at a time (a 3,000-song playlist takes ~15 rounds instead of 60).
async function pagesInParallel(path, onProgress, knownTotal) {
  const sep = path.includes('?') ? '&' : '?';
  const first = await spApi(`${path}${sep}limit=50&offset=0`);
  const total = first.total ?? knownTotal ?? first.items?.length ?? 0;
  const pages = [first];
  let loaded = first.items?.length || 0;
  onProgress?.(loaded, total);
  if (!first.next || total <= 50) return pages;
  const offsets = [];
  for (let o = 50; o < total && o < 10000; o += 50) offsets.push(o);
  let k = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < offsets.length) {
      const idx = k++;
      const d = await spApi(`${path}${sep}limit=50&offset=${offsets[idx]}`);
      pages[idx + 1] = d;
      loaded += d.items?.length || 0;
      onProgress?.(loaded, total);
    }
  }));
  return pages.filter(Boolean);
}

export async function spotifyCollection(kind, id, onProgress) {
  if (kind === 'track') {
    const t = await spApi(`/tracks/${id}`);
    return { name: t.name, tracks: [spToTrack(t)] };
  }
  if (kind === 'album') {
    const a = await spApi(`/albums/${id}`);
    const tracks = [];
    let page = a.tracks;
    while (page) {
      tracks.push(...page.items.map(t => spToTrack({ ...t, album: a })));
      onProgress?.(tracks.length, a.tracks.total);
      page = page.next ? await spApi(page.next) : null;
    }
    return { name: a.name, artwork: a.images?.[0]?.url, tracks };
  }
  if (kind === 'liked') {
    const pages = await pagesInParallel('/me/tracks', onProgress);
    return { name: 'Spotify Liked Songs', tracks: pages.flatMap(d => d.items.map(i => i.track).filter(Boolean).map(spToTrack)) };
  }
  // Spotify Web API (Feb 2026): playlist songs come from /playlists/{id}/items, each row's
  // song is in `item` (older responses used `track`), and only playlists the listener
  // owns or collaborates on return their songs.
  const p = await spApi(`/playlists/${id}`);
  const total = p.items?.total ?? p.tracks?.total;
  const tracks = [];
  try {
    const pages = await pagesInParallel(`/playlists/${id}/items`, onProgress, total);
    for (const d of pages) for (const row of d.items || []) {
      const t = (row.item && typeof row.item === 'object') ? row.item : (row.track && typeof row.track === 'object') ? row.track : null;
      if (t?.id && (!t.type || t.type === 'track')) tracks.push(spToTrack(t));
    }
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      const err = new Error(`Spotify only lets apps read songs from playlists you created or collaborate on. “${p.name}” can still be played in the Spotify app.`);
      err.openUrl = `https://open.spotify.com/playlist/${id}`; throw err;
    }
    throw e;
  }
  return { name: p.name, artwork: p.images?.[0]?.url, tracks };
}
