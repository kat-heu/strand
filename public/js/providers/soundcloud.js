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
    return { name: isSet ? (current?.title && sounds.length === 1 ? current.title : 'SoundCloud set') : current?.title, tracks: sounds.map(scToTrack) };
  } finally {
    iframe.remove();
  }
}

export function createSoundCloud(ctx) {
  let widget = null, iframe = null, ready = null, pos = 0, dur = 0, playing = false;
  const host = () => document.getElementById('media-sc');

  async function ensure(url) {
    await loadScript(WIDGET_API);
    if (ready) return ready;
    iframe = document.createElement('iframe');
    iframe.allow = 'autoplay';
    iframe.src = scWidgetSrc(url);
    host().replaceChildren(iframe);
    widget = window.SC.Widget(iframe);
    const E = window.SC.Widget.Events;
    ready = new Promise((res, rej) => {
      widget.bind(E.READY, () => res(widget));
      setTimeout(() => rej(new Error('SoundCloud timed out')), 20000);
    });
    widget.bind(E.PLAY_PROGRESS, e => { pos = e.currentPosition; });
    widget.bind(E.PLAY, () => { playing = true; widget.getDuration(d => { dur = d; }); });
    widget.bind(E.PAUSE, () => { playing = false; });
    widget.bind(E.FINISH, () => { playing = false; ctx.onEnded(); });
    widget.bind(E.ERROR, () => ctx.onError(new Error('SoundCloud playback error')));
    ready.catch(() => { ready = null; });
    return ready;
  }

  return {
    name: 'soundcloud',
    label: 'SoundCloud',
    host,
    available: () => true,
    canPlay: t => !!t.ids?.soundcloud,
    async load(t) {
      const url = t.ids.soundcloud;
      pos = 0; dur = t.durationMs || 0;
      const fresh = !ready;
      await ensure(url);
      if (!fresh) {
        await new Promise(res => widget.load(url, { auto_play: true, visual: false, show_artwork: true, hide_related: true, callback: res }));
      }
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
    stop: () => { try { widget?.pause(); } catch {} playing = false; },
  };
}
