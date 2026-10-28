// Always-available fallback: 30-second previews from the iTunes catalog.
// This is also the only source whose raw audio the browser lets us analyse,
// so the visualizer is truly audio-reactive here (simulated for DRM/iframe players).
import { match } from '../catalog.js';
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

export function createPreview(ctx) {
  const corsAudio = new Audio();
  corsAudio.crossOrigin = 'anonymous';
  const plainAudio = new Audio();
  let audio = corsAudio;
  let analyser = null, acx = null, srcNode = null;

  for (const a of [corsAudio, plainAudio]) {
    a.preload = 'auto';
    a.addEventListener('ended', () => { if (a === audio) ctx.onEnded(); });
  }

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

  async function tryPlay(a, url) {
    a.src = url;
    await a.play();
  }

  return {
    name: 'preview',
    label: 'Preview',
    available: () => true,
    canPlay: t => !!(t.previewUrl || (t.title && t.artist)),
    async load(t) {
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
      try {
        audio = corsAudio;
        attachAnalyser();
        if (acx?.state === 'suspended') await acx.resume();
        await tryPlay(corsAudio, url);
      } catch (e) {
        // Preview host refused CORS — play without the analyser.
        corsAudio.pause();
        audio = plainAudio;
        await tryPlay(plainAudio, url);
      }
      return { score };
    },
    play: () => audio.play(),
    pause: () => audio.pause(),
    seek: ms => { audio.currentTime = ms / 1000; },
    setVolume: v => { corsAudio.volume = v; plainAudio.volume = v; },
    position: () => audio.currentTime * 1000,
    duration: () => (isFinite(audio.duration) ? audio.duration : 30) * 1000,
    isPlaying: () => !audio.paused && !audio.ended,
    stop() { for (const a of [corsAudio, plainAudio]) { a.pause(); a.removeAttribute('src'); a.load(); } },
    analyser: () => (audio === corsAudio && !corsAudio.paused ? analyser : null),
  };
}
