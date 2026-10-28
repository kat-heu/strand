// Keeps the web / phone version current. The deploy writes version.json; Strand
// checks it when it starts, whenever you come back to the app, and every 20 minutes.
// If a newer version is out it reloads straight away when nothing is playing,
// otherwise it offers an "Update" button so your song isn't cut off.
import { h } from './util.js';

const desktop = !!window.strandDesktop;
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
let loaded = null, banner = null;

export const currentVersion = () => loaded;

async function remoteVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch { return null; }
}

function reload() {
  // Clear the saved copies so the reload can't pick up an old file.
  const done = () => location.reload();
  if (window.caches) caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k)))).then(done, done);
  else done();
}

export async function checkForUpdate({ isPlaying = () => false, manual = false } = {}) {
  const v = await remoteVersion();
  if (!v) return manual ? 'offline' : null;
  if (!loaded) { loaded = v; return 'latest'; }
  if (v === loaded) return 'latest';
  if (!isPlaying() || manual) { reload(); return 'updating'; }
  if (!banner) {
    banner = h('div', { class: 'update-banner', role: 'status' },
      h('span', {}, 'A new version of Strand is ready'),
      h('button', { class: 'btn small primary', onClick: reload }, 'Update'));
    document.body.append(banner);
  }
  return 'ready';
}

export function startUpdates(isPlaying) {
  if (desktop) return;                                   // the desktop app has its own updater
  if (!local && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  checkForUpdate({ isPlaying });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate({ isPlaying }); });
  window.addEventListener('pageshow', e => { if (e.persisted) checkForUpdate({ isPlaying }); });
  setInterval(() => checkForUpdate({ isPlaying }), 20 * 60 * 1000);
}
