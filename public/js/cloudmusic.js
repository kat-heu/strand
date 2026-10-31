// Your music in your Strand cloud (Supabase Storage, bucket "music").
// Songs you add are uploaded to a private folder only you can read; every device
// you sign in on can then play them. Strand plays them itself — no other service.
// One-time setup for the app owner: run supabase/cloud-music.sql in Supabase.
import { cloudEnabled, currentUser, supabaseBase, supabaseKey, accessToken } from './cloud.js';
import { log } from './log.js';

const BUCKET = 'music';
export const cloudMusicOn = () => cloudEnabled() && !!currentUser();

async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const r = await fetch(supabaseBase() + '/storage/v1' + path, {
    method, body,
    headers: { apikey: supabaseKey(), Authorization: 'Bearer ' + await accessToken(), ...headers },
  });
  if (!r.ok) {
    let m = ''; try { const d = await r.json(); m = d.message || d.error || ''; } catch {}
    if (/bucket not found/i.test(m)) m = 'cloud music isn’t set up yet (run supabase/cloud-music.sql)';
    else if (r.status === 413 || /maximum allowed size|too large/i.test(m)) m = 'file is too large for your storage plan';
    else if (/quota|exceed/i.test(m)) m = 'your storage is full';
    const e = new Error(m || 'HTTP ' + r.status); e.status = r.status; throw e;
  }
  return raw ? r : r.json().catch(() => null);
}

async function hash(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join('');
}
const extOf = name => (name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'audio').toLowerCase();

// Upload a song (and its cover). Returns { cloud, cloudArt } paths.
export async function uploadSong(file, id, cover) {
  const uid = currentUser().id, h = await hash(id);
  const cloud = `${uid}/songs/${h}.${extOf(file.name)}`;
  await call(`/object/${BUCKET}/${cloud}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' } });
  let cloudArt;
  if (cover) {
    cloudArt = `${uid}/art/${h}.jpg`;
    await call(`/object/${BUCKET}/${cloudArt}`, { method: 'POST', body: cover, headers: { 'Content-Type': cover.type || 'image/jpeg', 'x-upsert': 'true' } }).catch(() => { cloudArt = undefined; });
  }
  log('uploaded to cloud', file.name);
  return { cloud, cloudArt };
}

export async function deleteSong(t) {
  const prefixes = [t.ids?.cloud, t.ids?.cloudArt].filter(Boolean);
  if (prefixes.length) await call(`/object/${BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes }), headers: { 'Content-Type': 'application/json' } }).catch(() => {});
}

// Signed (temporary) links to play/show files. Cached until shortly before they expire.
const signed = new Map();      // path -> { url, exp }
export async function signPaths(paths, seconds = 6 * 3600) {
  const need = [...new Set(paths)].filter(p => p && !(signed.get(p)?.exp > Date.now() + 60000));
  for (let i = 0; i < need.length; i += 100) {
    const d = await call(`/object/sign/${BUCKET}`, { method: 'POST', body: JSON.stringify({ expiresIn: seconds, paths: need.slice(i, i + 100) }), headers: { 'Content-Type': 'application/json' } });
    for (const x of d || []) if (x.signedURL && x.path) signed.set(x.path, { url: supabaseBase() + '/storage/v1' + x.signedURL, exp: Date.now() + seconds * 1000 });
  }
  return paths.map(p => signed.get(p)?.url || '');
}

// Covers for songs that live in the cloud (shown on devices that don't have the file).
const liveArt = new Set();
export const isCloudArt = u => liveArt.has(u);
export async function showCloudCovers(tracks, hasOwnCover = () => false) {
  if (!cloudMusicOn()) return 0;
  const list = tracks.filter(t => t?.ids?.cloudArt && !hasOwnCover(t) && !liveArt.has(t.artwork));
  if (!list.length) return 0;
  try {
    const urls = await signPaths(list.map(t => t.ids.cloudArt), 7 * 24 * 3600);
    list.forEach((t, i) => { if (urls[i]) { t.artwork = urls[i]; liveArt.add(urls[i]); } });
  } catch (e) { log('cloud covers failed', e.message); }
  return list.length;
}

export function createCloud(ctx) {
  const audio = new Audio();
  audio.addEventListener('ended', () => ctx.onEnded());
  return {
    name: 'cloud',
    label: 'My music (cloud)',
    available: () => cloudMusicOn(),
    canPlay: t => !!t.ids?.cloud && cloudMusicOn(),
    async load(t) {
      const [url] = await signPaths([t.ids.cloud]);
      if (!url) throw new Error('couldn’t open it from your cloud');
      audio.src = url;
      await audio.play();
      return { score: null };
    },
    play: () => audio.play(),
    pause: () => audio.pause(),
    seek: ms => { audio.currentTime = ms / 1000; },
    setVolume: v => { audio.volume = v; },
    position: () => audio.currentTime * 1000,
    duration: () => (isFinite(audio.duration) ? audio.duration * 1000 : 0),
    isPlaying: () => !audio.paused && !audio.ended,
    stop() { audio.pause(); },
  };
}
