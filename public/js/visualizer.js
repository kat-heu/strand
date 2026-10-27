// Visualizer. Real FFT for preview audio; for Spotify / Apple / YouTube / SoundCloud
// the audio is DRM-protected or inside a cross-origin iframe, so the browser does not
// expose samples — we draw a tempo-ish simulated spectrum that follows play/pause.
import { state, analyser } from './player.js';

export function startVisualizer(canvas, { mode = 'radial', anchor = null } = {}) {
  const g = canvas.getContext('2d');
  let raf = 0, energy = 0, alive = true;
  const N = 64;
  const sim = new Float32Array(N);
  const buf = new Uint8Array(128);

  function resize() {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.max(1, r.width * dpr); canvas.height = Math.max(1, r.height * dpr);
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();

  function spectrum(t) {
    const an = analyser();
    if (an) {
      an.getByteFrequencyData(buf);
      for (let i = 0; i < N; i++) sim[i] = buf[Math.floor(i * 1.6)] / 255;
      return;
    }
    const target = state.playing ? 1 : 0;
    energy += (target - energy) * 0.05;
    const beat = Math.pow(Math.max(0, Math.sin(t / 1000 * Math.PI * 2 * (118 / 60))), 6);
    for (let i = 0; i < N; i++) {
      const f = i / N;
      const v = (0.55 * (1 - f) + 0.12) * (0.55 + 0.45 * Math.sin(t / (380 + i * 23) + i * 1.7) * Math.sin(t / 900 + i))
              + beat * 0.35 * (1 - f) ;
      sim[i] += (Math.max(0, v) * energy - sim[i]) * 0.2;
    }
  }

  function frame(t) {
    if (!alive) return;
    spectrum(t);
    const W = canvas.width, H = canvas.height;
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const a1 = css.getPropertyValue('--accent').trim() || '#ff6b4a';
    const a2 = css.getPropertyValue('--accent-2').trim() || '#7c5cff';
    if (mode === 'radial') {
      let cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.24;
      if (anchor && anchor.offsetParent !== null) {
        // Ring around an element (the spinning artwork)
        const a = anchor.getBoundingClientRect(), c = canvas.getBoundingClientRect(), k = W / Math.max(1, c.width);
        cx = (a.left + a.width / 2 - c.left) * k; cy = (a.top + a.height / 2 - c.top) * k; R = (anchor.offsetWidth / 2 + 14) * k;
      }
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, a1); grad.addColorStop(1, a2);
      g.strokeStyle = grad; g.lineCap = 'round';
      g.lineWidth = Math.max(2, Math.min(W, H) / 140);
      for (let i = 0; i < N * 2; i++) {
        const v = sim[i < N ? i : 2 * N - 1 - i];
        const ang = (i / (N * 2)) * Math.PI * 2 - Math.PI / 2;
        const r1 = R, r2 = R + v * R * 0.62 + 2;
        g.globalAlpha = 0.35 + v * 0.65;
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
        g.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
        g.stroke();
      }
      g.globalAlpha = 1;
    } else {
      const bw = W / N;
      for (let i = 0; i < N; i++) {
        const v = sim[i], bh = Math.max(2, v * H * 0.9);
        const grad = g.createLinearGradient(0, H - bh, 0, H);
        grad.addColorStop(0, a1); grad.addColorStop(1, a2);
        g.fillStyle = grad; g.globalAlpha = 0.85;
        g.fillRect(i * bw + bw * 0.18, H - bh, bw * 0.64, bh);
      }
      g.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); };
}
