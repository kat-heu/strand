// Always-available fallback: 30-second previews from the iTunes catalog.
// This is also the only source whose raw audio the browser lets us analyse,
// so the visualizer is truly audio-reactive here (simulated for DRM/iframe players).
import { match } from '../catalog.js';
import { audio, claim, owns, release, playUrl } from '../audio.js';
import * as E from '../engine.js';
import { jsonp, matchScore } from '../util.js';

// Second source of 30-second previews (Deezer's public API), used when Apple's
// catalogue can't be reached — e.g. Apple rate-limits busy mobile networks.
async function deezerPreview(t) {
  const q = `artist:"${t.artist}" track:"${t.title}"`;
  const d = await jsonp('https://api.deezer.com/search?' + new URLSearchParams({ q, limit: 8, output: 'jsonp' }));
  let best = null, score = 0;
  for (const r of d?.data || []) {
    if (!r.preview) continue;
    const sc = matchScore(t, { title: r.title, artist: r.artist?.name || '', durationMs: (r.duration || 0) * 1000 });
    if (sc > score) { score = sc; best = r; }
  }
  return score >= 0.6 ? { url: best.preview, score, artwork: best.album?.cover_xl, durationMs: best.duration * 1000 } : null;
}

const phone = () => /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

export function createPreview(ctx) {
  // Computers: a separate element wired to the visualizer (needs the preview host to
  // allow it). Phones: Strand's shared element, never routed through Web Audio —
  // on iPhones that would stop the sound when the screen locks.
  const corsAudio = new Audio();
  corsAudio.crossOrigin = 'anonymous';
  corsAudio.preload = 'auto';
  let usingShared = true;
  let analyser = null, acx = null, srcNode = null;
  corsAudio.addEventListener('ended', () => { if (!usingShared) ctx.onEnded(); });

  function attachAnalyser() {
    if (srcNode) return;
    try {
      acx = new (window.AudioContext || window.webkitAudioContext)();
      srcNode = acx.createMediaElementSource(corsAudio);
      analyser = acx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      srcNode.connect(analyser);
      analyser.connect(acx.destination);
    } catch (e) { console.warn('Analyser unavailable', e); }
  }

  const self = {
    name: 'preview',
    label: 'Preview',
    available: () => true,
    canPlay: t => !!(t.previewUrl || (t.title && t.artist)),
    onEnded: () => ctx.onEnded(),
    async load(t) {
      claim(self);
      let url = t.previewUrl, score = null;
      if (!url) {
        let m = null, why = null;
        try { m = await match(t); } catch (e) { why = e; }
        if (m?.track?.previewUrl) {
          url = m.track.previewUrl; score = m.score;
          if (!t.artwork) t.artwork = m.track.artwork;
          if (!t.durationMs) t.durationMs = m.track.durationMs;
        } else {
          const dz = await deezerPreview(t).catch(() => null);
          if (!dz) throw new Error(why ? 'couldn’t reach the preview catalogue' : 'no preview found');
          url = dz.url; score = dz.score;
          if (!t.artwork) t.artwork = dz.artwork;
          if (!t.durationMs) t.durationMs = dz.durationMs;
        }
      }
      if (!owns(self)) throw Object.assign(new Error('cancelled'), { final: true });
      if (!phone()) {
        try {
          usingShared = false;
          attachAnalyser();
          if (acx?.state === 'suspended') await acx.resume();
          corsAudio.src = url;
          await corsAudio.play();
          return { score };
        } catch { corsAudio.pause(); }           // host refused CORS: play without the visualizer
      }
      usingShared = true;
      await playUrl(self, url);
      return { score };
    },
    play: () => (usingShared ? owns(self) && audio.play() : corsAudio.play()),
    pause: () => (usingShared ? owns(self) && audio.pause() : corsAudio.pause()),
    seek: ms => { if (usingShared) { if (owns(self)) E.seekTo(ms); } else corsAudio.currentTime = ms / 1000; },
    setVolume: v => { corsAudio.volume = v; audio.volume = v; },
    position: () => (usingShared ? (owns(self) ? audio.currentTime * 1000 : 0) : corsAudio.currentTime * 1000),
    duration: () => { const a = usingShared ? audio : corsAudio; return (isFinite(a.duration) ? a.duration : 30) * 1000; },
    isPlaying: () => (usingShared ? owns(self) && E.playing() : !corsAudio.paused && !corsAudio.ended),
    stop() { corsAudio.pause(); corsAudio.removeAttribute('src'); release(self); },
    analyser: () => (!usingShared && !corsAudio.paused ? analyser : null),
  };
  return self;
}
