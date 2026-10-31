// Keeps the web / phone version current. The deploy writes version.json; Strand
// checks it when it starts, whenever you come back to the app, and every 20 minutes.
// If a newer version is out it reloads straight away when nothing is playing,
// otherwise it offers an "Update" button so your song isn't cut off.
import { h } from './util.js';

const desktop = !!window.strandDesktop;
const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
let loaded = null, banner = null;

export const currentVersion = () => loaded;

let latest = null;                                   // the whole version.json
async function remoteVersion() {
  try {
    const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return null;
    latest = await r.json();
    return latest.version || null;
  } catch { return null; }
}

// ---- Android app (the frame around the website) -----------------------------------
// The Android app opens Strand with ?app=android&shell=N. Older copies didn't, so
// they're recognised by the page they were opened from.
const AKEY = 'strand:androidShell';
export const APK_URL = 'https://github.com/kat-heu/strand/releases/latest/download/Strand.apk';
(function noteAndroidApp() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('app') === 'android') {
      localStorage.setItem(AKEY, q.get('shell') || '1');
      history.replaceState(null, '', location.pathname + location.hash);
    } else if (/^android-app:\/\/app\.strand\.player/.test(document.referrer) && !localStorage.getItem(AKEY)) {
      localStorage.setItem(AKEY, '1');
    }
  } catch {}
})();
export const androidShell = () => { try { return Number(localStorage.getItem(AKEY)) || 0; } catch { return 0; } };
export const androidUpdate = () => !!(androidShell() && latest?.androidShell && latest.androidShell > androidShell());
function androidBanner() {
  if (!androidUpdate() || document.querySelector('.update-banner')) return;
  const key = 'strand:apkNag:' + latest.androidShell;
  try { if (localStorage.getItem(key)) return; } catch {}
  const b = h('div', { class: 'update-banner', role: 'status' },
    h('span', {}, 'A new Android app is out'),
    h('a', { class: 'btn small primary', href: APK_URL, onClick: () => { try { localStorage.setItem(key, '1'); } catch {} b.remove(); } }, 'Download'),
    h('button', { class: 'btn small ghost', onClick: () => { try { localStorage.setItem(key, '1'); } catch {} b.remove(); } }, 'Later'));
  document.body.append(b);
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
  androidBanner();
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
