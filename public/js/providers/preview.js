// Always-available fallback: 30-second previews from the iTunes catalog.
// This is also the only source whose raw audio the browser lets us analyse,
// so the visualizer is truly audio-reactive here (simulated for DRM/iframe players).
import { match } from '../catalog.js';

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
        const m = await match(t);
        if (!m.track?.previewUrl) throw new Error('no preview found');
        url = m.track.previewUrl; score = m.score;
        if (!t.artwork) t.artwork = m.track.artwork;
        if (!t.durationMs) t.durationMs = m.track.durationMs;
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
