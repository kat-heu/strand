// One shared <audio> element for everything Strand plays itself (your files, your
// cloud music, previews, iTunes files on the desktop).
// Why one: iPhones only let a page start sound after a tap, and only keep it going in
// the background / with the screen locked while the same element keeps playing. Moving
// from song to song on one element lets the next song start by itself while the phone
// is locked. (A second element would be blocked until you open Strand again.)
import { log } from './log.js';

export const audio = document.createElement('audio');
audio.id = 'strand-audio';
audio.preload = 'auto';
audio.setAttribute('playsinline', '');
audio.setAttribute('webkit-playsinline', '');
audio.setAttribute('x-webkit-airplay', 'allow');        // AirPlay picker on iPhone
(document.body || document.documentElement).append(audio);

let owner = null, wantPlaying = false;
export const claim = o => { owner = o; };
export const owns = o => owner === o;
export const release = o => { if (owner === o) { wantPlaying = false; audio.pause(); } };

audio.addEventListener('ended', () => { wantPlaying = false; owner?.onEnded?.(); });
audio.addEventListener('playing', () => { wantPlaying = true; });
// Note pauses Strand didn't ask for (a phone call, another app taking the audio,
// iOS stopping background audio) so playback problems can be traced in the log.
audio.addEventListener('pause', () => {
  if (wantPlaying && !audio.ended) log('audio paused by the system', { hidden: document.hidden, at: Math.round(audio.currentTime) });
});

// Shared player for sources that are just an audio file/URL.
export function audioProvider(spec, ctx) {
  const self = {
    name: spec.name,
    label: spec.label,
    available: spec.available,
    canPlay: spec.canPlay,
    onEnded: () => ctx.onEnded(),
    async load(t) {
      claim(self);
      const src = await spec.src(t);
      if (!owns(self)) throw Object.assign(new Error('cancelled'), { final: true });
      audio.src = src;
      try { await audio.play(); }
      catch (e) { throw new Error(audio.error?.code === 4 ? 'file missing or not playable' : e.message); }
      return { score: null };
    },
    play: () => { if (owns(self)) { wantPlaying = true; return audio.play(); } },
    pause: () => { if (owns(self)) { wantPlaying = false; audio.pause(); } },
    seek: ms => { if (owns(self)) audio.currentTime = ms / 1000; },
    setVolume: v => { audio.volume = v; },
    position: () => (owns(self) ? audio.currentTime * 1000 : 0),
    duration: () => (owns(self) && isFinite(audio.duration) ? audio.duration * 1000 : 0),
    isPlaying: () => owns(self) && !audio.paused && !audio.ended,
    stop() { release(self); },
  };
  return self;
}

// App lifecycle in the log (for checking background playback on a real phone).
document.addEventListener('visibilitychange', () => log('app ' + (document.hidden ? 'in background / screen locked' : 'back in front'), { audio: audio.paused ? 'paused' : 'playing' }));
window.addEventListener('pagehide', e => log('page hidden', { persisted: e.persisted }));
