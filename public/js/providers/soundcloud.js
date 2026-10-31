// SoundCloud via the official Widget API — no key needed for public tracks.
// SoundCloud's search API now requires an approved OAuth app, so tracks come from
// pasted links / imported sets rather than search.
import { loadScript } from '../util.js';

const WIDGET_API = 'https://w.soundcloud.com/player/api.js';

export function scWidgetSrc(url) {
  const p = new URLSearchParams({ url, auto_play: 'true', visual: 'false', show_artwork: 'true', show_comments: 'false', hide_related: 'true', show_teaser: 'false' });
  return 'https://w.soundcloud.com/player/?' + p;
}

function scToTrack(s) {
  return {
    key: 'sc:' + s.id,
    title: s.title || 'SoundCloud track',
    artist: s.user?.username || s.publisher_metadata?.artist || 'SoundCloud',
    album: s.publisher_metadata?.album_title || '',
    artwork: (s.artwork_url || s.user?.avatar_url || '').replace('-large', '-t500x500'),
    durationMs: s.duration || 0,
    origin: 'soundcloud',
    ids: { soundcloud: s.permalink_url || `https://api.soundcloud.com/tracks/${s.id}` },
  };
}

// Load a URL into a throwaway hidden widget and read its sounds (for imports/pasted links).
export async function scResolve(url, onProgress) {
  await loadScript(WIDGET_API);
  const iframe = document.createElement('iframe');
  iframe.allow = 'autoplay';
  iframe.style.cssText = 'position:fixed;width:300px;height:160px;left:-9999px;top:0;';
  iframe.src = scWidgetSrc(url).replace('auto_play=true', 'auto_play=false');
  document.body.append(iframe);
  try {
    const w = window.SC.Widget(iframe);
    await new Promise((res, rej) => {
      w.bind(window.SC.Widget.Events.READY, res);
      w.bind(window.SC.Widget.Events.ERROR, () => rej(new Error('SoundCloud could not load that link')));
      setTimeout(() => rej(new Error('SoundCloud timed out')), 20000);
    });
    const getSounds = () => new Promise(r => w.getSounds(r));
    // The widget lazy-loads set metadata; poll until it settles.
    let sounds = await getSounds(), stable = 0, last = -1;
    for (let i = 0; i < 20 && stable < 3; i++) {
      const loaded = sounds.filter(s => s.title).length;
      onProgress?.(loaded, sounds.length);
      if (loaded === sounds.length) break;
      stable = loaded === last ? stable + 1 : 0; last = loaded;
      await new Promise(r => setTimeout(r, 600));
      sounds = await getSounds();
    }
    const current = await new Promise(r => w.getCurrentSound(r));
    const isSet = /\/sets\//.test(url) || sounds.length > 1;
    // Remember which list each song came from: playing the list in one widget lets
    // SoundCloud go from song to song itself (phones block starting a new widget
    // without a tap, which made playback stop after one song).
    const tracks = sounds.map((x, i) => { const t = scToTrack(x); if (sounds.length > 1) Object.assign(t.ids, { scList: url, scIndex: i }); return t; });
    return { name: isSet ? (current?.title && sounds.length === 1 ? current.title : 'SoundCloud set') : current?.title, tracks };
  } finally {
    iframe.remove();
  }
}

export function createSoundCloud(ctx) {
  let widget = null, iframe = null, ready = null, pos = 0, dur = 0, playing = false;
  let loadedUrl = null;          // what the widget currently holds (a song, or a whole list)
  let listIndex = -1;            // in list mode: which song of the list should be playing
  let finishT = null;
  const host = () => document.getElementById('media-sc');
  const E = () => window.SC.Widget.Events;

  function bindAll() {
    const ev = E();
    for (const k of ['PLAY_PROGRESS', 'PLAY', 'PAUSE', 'FINISH', 'ERROR']) { try { widget.unbind(ev[k]); } catch {} }
    widget.bind(ev.PLAY_PROGRESS, e => { pos = e.currentPosition; });
    widget.bind(ev.PLAY, () => {
      playing = true; clearTimeout(finishT);
      widget.getDuration(d => { dur = d; });
      if (listIndex >= 0 && widget.getCurrentSoundIndex) widget.getCurrentSoundIndex(i => {
        // SoundCloud moved to the next song of the list by itself: follow it.
        if (typeof i === 'number' && i !== listIndex && ctx.onAdvancedTo?.(t => t.ids?.scList === loadedUrl && t.ids?.scIndex === i)) { listIndex = i; pos = 0; }
      });
    });
    widget.bind(ev.PAUSE, () => { playing = false; });
    widget.bind(ev.FINISH, () => {
      playing = false;
      // In a list the widget carries on by itself; only step Strand's queue if it doesn't.
      clearTimeout(finishT);
      finishT = setTimeout(() => { if (!playing) ctx.onEnded(); }, listIndex >= 0 ? 2500 : 0);
    });
    widget.bind(ev.ERROR, () => ctx.onError(new Error('SoundCloud playback error')));
  }

  async function ensure(url) {
    await loadScript(WIDGET_API);
    if (ready) return ready;
    iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.src = scWidgetSrc(url);
    host().replaceChildren(iframe);
    widget = window.SC.Widget(iframe);
    loadedUrl = url;
    ready = new Promise((res, rej) => {
      widget.bind(E().READY, () => { bindAll(); res(widget); });
      setTimeout(() => rej(new Error('SoundCloud timed out')), 20000);
    });
    ready.catch(() => { ready = null; });
    return ready;
  }
  const skipTo = i => new Promise(res => { widget.skip(i); setTimeout(res, 300); });

  return {
    name: 'soundcloud',
    label: 'SoundCloud',
    host,
    available: () => true,
    canPlay: t => !!t.ids?.soundcloud,
    async load(t) {
      clearTimeout(finishT);
      const list = t.ids.scList, idx = t.ids.scIndex;
      const url = list && Number.isInteger(idx) ? list : t.ids.soundcloud;
      pos = 0; dur = t.durationMs || 0;
      const fresh = !ready;
      await ensure(url);
      if (!fresh && loadedUrl !== url) {
        await new Promise(res => widget.load(url, { auto_play: !list, visual: false, show_artwork: true, hide_related: true, callback: res }));
        loadedUrl = url;
        bindAll();
      }
      if (url === list) { listIndex = idx; await skipTo(idx); }
      else { if (!fresh && loadedUrl === url && listIndex < 0) widget.seekTo(0); listIndex = -1; }
      widget.play();
      return { score: null };
    },
    play: () => widget?.play(),
    pause: () => widget?.pause(),
    seek: ms => { widget?.seekTo(ms); pos = ms; },
    setVolume: v => widget?.setVolume(Math.round(v * 100)),
    position: () => pos,
    duration: () => dur,
    isPlaying: () => playing,
    stop: () => { clearTimeout(finishT); try { widget?.pause(); } catch {} playing = false; },
  };
}
