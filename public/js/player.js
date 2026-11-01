// One queue, many sources. For each track we try sources in preference order and
// fall back automatically (e.g. Spotify → Apple Music → YouTube → 30s preview).
import { settings, setSetting, emit, pushRecent } from './store.js';
import { log } from './log.js';
import * as E from './engine.js';
import { createSpotify, createSpotifyRemote } from './providers/spotify.js';
import { createApple } from './providers/apple.js';
import { createYouTube } from './providers/youtube.js';
import { createSoundCloud } from './providers/soundcloud.js';
import { createPreview } from './providers/preview.js';
import { createLocal, isLocalHere } from './local.js';
import { createItunes } from './itunes.js';
import { createCloud } from './cloudmusic.js';

const ctx = {
  onEnded: () => { log('song ended'); next(true); },
  onError: e => { console.warn(e); emit('toast', e.message); },
  // Songs after the current one, in play order (empty when shuffling or repeating one
  // song, because then Strand decides what comes next).
  upcoming: () => (state.shuffle || state.repeat === 'one') ? [] : state.queue.slice(state.index + 1, state.index + 100),
  // A source moved on by itself (e.g. SoundCloud playing through a list): point
  // Strand's queue at that song without reloading it. Returns true if found.
  onAdvancedTo: pred => {
    const i = state.queue.findIndex((t, k) => k > state.index && pred(t));
    if (i < 0) return false;
    ctx.onAdvanced(i - state.index);
    return true;
  },
  // The Spotify app moved on to the next song of the list Strand handed it.
  onAdvanced: steps => {
    const i = state.index + steps;
    if (i >= state.queue.length) return;
    log('moved on to the next song by itself', state.queue[i].title);
    const t = state.queue[i];
    Object.assign(state, { index: i, track: t, position: 0, duration: t.durationMs || 0, error: null });
    pushRecent(t); updateMediaSession(t);
    emit('queue'); emit('track', t);
  },
};

export const providers = {
  spotify: createSpotify(ctx),
  spotifyRemote: createSpotifyRemote(ctx),
  apple: createApple(ctx),
  youtube: createYouTube(ctx),
  soundcloud: createSoundCloud(ctx),
  preview: createPreview(ctx),
  local: createLocal(ctx),
  itunes: createItunes(ctx),
  cloud: createCloud(ctx),
};

export const state = {
  queue: [], index: -1, track: null,
  provider: null, score: null, trying: null,
  playing: false, loading: false, error: null,
  shuffle: false, repeat: 'off', // off | all | one
  position: 0, duration: 0,
};

const FULL = ['spotify', 'apple', 'youtube'];

export function sourceOrder(t) {
  const native = { spotify: 'spotify', apple: 'apple', youtube: 'youtube', soundcloud: 'soundcloud' }[t.origin];
  let list = [];
  if (t.origin === 'soundcloud') list.push('soundcloud');      // SoundCloud-only uploads rarely exist elsewhere
  if (settings.preferred !== 'auto') list.push(settings.preferred);
  // "Automatic": play inside Strand through YouTube first (also for Spotify songs),
  // then the song's own service.
  else list.push('youtube');
  if (native) list.push(native);
  // After the in-app players, hand the song to the Spotify app (full length, needs
  // Premium) before falling back to 30-second previews.
  list.push(...FULL, 'soundcloud', 'preview');
  // Phones: Spotify's in-page player can't run there. "Play in Spotify app" puts the
  // remote first; otherwise Spotify songs play inside Strand via YouTube when possible.
  // Songs that can be on Spotify (not SoundCloud uploads, YouTube videos or your own files)
  const fromSpotify = !!t.ids?.spotify || !['soundcloud', 'youtube', 'local', 'cloud'].includes(t.origin);
  if (settings.phoneSpotify2 === 'app' && fromSpotify) list.unshift('spotifyRemote');
  if (providers.itunes.canPlay(t)) list.unshift('itunes');    // iTunes song on this computer: play the file
  if (providers.cloud.canPlay(t)) list.unshift('cloud');      // your own song from your Strand cloud
  if (isLocalHere(t)) list.unshift('local');                 // your own file on this device always wins
  // The Spotify app (full song, needs Premium) only as a backup for Spotify songs,
  // before falling back to a 30-second preview.
  if (fromSpotify) list.splice(list.indexOf('preview'), 0, 'spotifyRemote');
  list = [...new Set(list)];
  return list.filter(n => providers[n].available() && providers[n].canPlay(t));
}

let loadToken = 0;

async function playTrack(t, force = null) {
  const my = ++loadToken;
  try { providers.spotifyRemote.cancel(); } catch {}         // an older attempt still waking the Spotify app must give up
  if (state.provider) { try { providers[state.provider].stop(); } catch {} }
  Object.assign(state, { track: t, loading: true, error: null, playing: false, position: 0, duration: t.durationMs || 0, provider: null, score: null });
  emit('track', t);
  const errors = [];
  const order = force ? [force, ...sourceOrder(t).filter(n => n !== force)] : sourceOrder(t);
  log('play', { song: t.title + ' — ' + t.artist, origin: t.origin, order });
  for (const name of order) {
    const p = providers[name];
    state.trying = name; emit('trying', name);
    try {
      const { score } = await p.load(t) || {};
      if (my !== loadToken) { try { p.stop(); } catch {} return; }
      p.setVolume(settings.volume);
      Object.assign(state, { provider: name, score: score ?? null, loading: false, playing: true, trying: null });
      log('playing via ' + name);
      pushRecent(t);
      updateMediaSession(t);
      emit('track', t);
      // Get the next song ready (so it can start instantly with the phone locked).
      const nx = state.queue[state.index + 1];
      if (nx && !state.shuffle) { try { for (const n of sourceOrder(nx).slice(0, 1)) providers[n].prepare?.(nx); } catch {} }
      return;
    } catch (e) {
      if (my !== loadToken) return;
      console.warn(`[${name}]`, e);
      errors.push(`${p.label}: ${e.message}`);
      log('failed ' + name, e.message);
      try { p.stop(); } catch {}
      if (e.final) break;
    }
  }
  if (my !== loadToken) return;
  Object.assign(state, { loading: false, trying: null, error: errors.join(' · ') || 'No source can play this track' });
  emit('track', t);
  const hint = !providers.spotifyRemote.available() && !providers.youtube.canPlay(t) ? '. Connect Spotify in Your music to play full songs.' : '';
  emit('toast', 'Couldn’t play “' + t.title + '” — ' + (errors[0] || 'no source available') + hint);
}

// Replay the current song from a specific source (e.g. "Play in Spotify app").
export function playCurrentOn(name) {
  if (!state.track) return;
  const pos = state.position;
  return playTrack(state.track, name).then(() => { if (state.provider === name && pos > 3000) seek(pos); });
}

export function playQueue(tracks, i = 0) {
  if (!tracks?.length) return;
  state.queue = tracks.slice();
  state.index = Math.max(0, Math.min(i, tracks.length - 1));
  emit('queue');
  playTrack(state.queue[state.index]);
}
export function playAt(i) {
  if (i < 0 || i >= state.queue.length) return;
  state.index = i; emit('queue');
  playTrack(state.queue[i]);
}
export function addToQueue(t) {
  state.queue.push(t); emit('queue');
  if (state.index < 0) playAt(state.queue.length - 1);
}
export function playNext(t) {
  state.queue.splice(state.index + 1, 0, t); emit('queue');
  if (state.index < 0) playAt(0);
}
export function removeFromQueue(i) {
  if (i === state.index) return;
  state.queue.splice(i, 1);
  if (i < state.index) state.index--;
  emit('queue');
}

export function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && state.repeat === 'one') return playTrack(state.track);
  let i;
  if (state.shuffle && state.queue.length > 1) {
    do { i = Math.floor(Math.random() * state.queue.length); } while (i === state.index);
  } else i = state.index + 1;
  if (i >= state.queue.length) {
    if (state.repeat === 'all') i = 0;
    else { try { current()?.stop(); } catch {} state.playing = false; emit('state'); return; }
  }
  playAt(i);
}
export function prev() {
  if (current() && state.position > 3000) return seek(0);
  if (state.index > 0) playAt(state.index - 1);
  else seek(0);
}

const current = () => state.provider ? providers[state.provider] : null;

export function toggle() {
  const p = current();
  if (!p) {
    if (state.track) return playTrack(state.track);
    if (state.queue.length) return playAt(Math.max(0, state.index));
    return;
  }
  if (p.isPlaying()) p.pause(); else p.play();
  setTimeout(tick, 120);
}
export function seek(ms) { current()?.seek(ms); state.position = ms; emit('time'); }
export function setVolume(v) { setSetting('volume', v); current()?.setVolume(v); }
export function toggleShuffle() { state.shuffle = !state.shuffle; emit('state'); }
export function cycleRepeat() { state.repeat = { off: 'all', all: 'one', one: 'off' }[state.repeat]; emit('state'); }
export function analyser() { return state.provider === 'preview' ? providers.preview.analyser() : null; }

function tick() {
  const p = current();
  if (!p) return;
  const playing = !!p.isPlaying();
  state.position = p.position() || 0;
  state.duration = p.duration() || state.track?.durationMs || 0;
  if (playing !== state.playing) { state.playing = playing; emit('state'); lastPos = -1; }
  updateMediaPosition();
  emit('time');
}
setInterval(tick, 200);

// Lock screen, Control Center, headphones and car controls (Media Session).
function updateMediaSession(t) {
  if (!('mediaSession' in navigator) || !t) return;
  try {
    const art = t.artwork && !t.artwork.startsWith('blob:') ? t.artwork : new URL('icons/icon-512.png', location.href).href;
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || 'Strand',
      artwork: [96, 192, 256, 512].map(n => ({ src: art, sizes: `${n}x${n}`, type: /\.png($|\?)/.test(art) ? 'image/png' : 'image/jpeg' })) });
  } catch {}
}
let lastPos = 0;
function updateMediaPosition() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  try { ms.playbackState = state.track ? (state.playing ? 'playing' : 'paused') : 'none'; } catch {}
  const d = state.duration / 1000, p = Math.min(state.position / 1000, d);
  if (!ms.setPositionState || !(d > 0) || !isFinite(d)) return;
  if (Math.abs(p - lastPos) < 0.9 && state.playing) { lastPos += 0.2; return; }   // the lock screen counts by itself
  lastPos = p;
  try { ms.setPositionState({ duration: d, position: Math.max(0, p), playbackRate: 1 }); } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => { const p = current(); if (p) p.play(); else toggle(); setTimeout(tick, 150); });
  set('pause', () => { current()?.pause(); setTimeout(tick, 150); });
  set('stop', () => { current()?.pause(); setTimeout(tick, 150); });
  set('nexttrack', () => next()); set('previoustrack', prev);
  set('seekto', d => { seek(d.seekTime * 1000); lastPos = -1; updateMediaPosition(); });
  // iPhone shows ±10s buttons instead of previous/next if these exist, so phones skip them.
  if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
    set('seekbackward', d => { seek(Math.max(0, state.position - (d.seekOffset || 10) * 1000)); lastPos = -1; });
    set('seekforward', d => { seek(state.position + (d.seekOffset || 10) * 1000); lastPos = -1; });
  }
  // iOS ignores handlers set before audio became "Now Playing", so set previous/next
  // again whenever Strand's own player starts.
  E.el.addEventListener('playing', () => { set('nexttrack', () => next()); set('previoustrack', prev); updateMediaSession(state.track); });
}
