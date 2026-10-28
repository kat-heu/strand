// Strand accounts + library sync, backed by Supabase (Auth + one Postgres table).
// A tiny dependency-free client: Supabase Auth (GoTrue) and PostgREST over fetch.
//
// - Sign up / sign in with email + password.
// - Each signed-in person gets their own storage namespace on this device
//   (see store.js `ns`), so two people on one computer never see each other's
//   linked Spotify/YouTube logins, library or settings.
// - Library (playlists, liked, recent) and a few preferences sync to the
//   `user_data` table, protected by row-level security (each user: own row only).
// - Service logins (Spotify / Google tokens) stay on the device; they are not uploaded.
import CONFIG from '../config.js';
import { load, save, emit, on, library, settings, ns, USER_ID } from './store.js';

const BASE = (CONFIG.supabaseUrl || '').replace(/\/+$/, '');
const KEY = CONFIG.supabaseKey || '';
const SESSION_KEY = 'strand:session';
const PREF_KEYS = ['preferred', 'country', 'lyricsOffset', 'volume', 'scProfile'];

export const cloudEnabled = () => !!(BASE && KEY);
let session = load(SESSION_KEY, null);
export const currentUser = () => session?.user || null;
export const displayName = u => (u?.user_metadata?.name || u?.email || 'You');

// ---------------------------------------------------------------- http
function friendly(d, status) {
  const m = d?.msg || d?.error_description || d?.message || d?.error || `HTTP ${status}`;
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
  if (/already (been )?registered|already exists/i.test(m)) return 'An account with this email already exists. Sign in instead.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox (and spam).';
  if (/rate limit|too many/i.test(m) || status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (/unable to validate email|invalid format/i.test(m)) return 'That email address doesn’t look right.';
  return m;
}
async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: { apikey: KEY, 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || KEY), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Can’t reach Strand’s servers. Check your internet connection.');
  }
  const text = await r.text();
  let d = null;
  try { d = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) { const e = new Error(friendly(d, r.status)); e.status = r.status; throw e; }
  return d;
}

// Changing only the #hash doesn't reload the page, so reset the hash and reload.
function reloadHome() { history.replaceState(null, '', location.pathname + '#/'); location.reload(); }

// ---------------------------------------------------------------- session
function setSession(d) {
  session = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at ? d.expires_at * 1000 : Date.now() + (d.expires_in || 3600) * 1000,
    user: d.user || session?.user,
  };
  save(SESSION_KEY, session);
}
let refreshing = null;
async function token() {
  if (!session) throw new Error('Not signed in');
  if (Date.now() > session.expires_at - 60000) {
    refreshing ??= api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token } })
      .then(setSession)
      .catch(e => { if (e.status === 400 || e.status === 401) { session = null; save(SESSION_KEY, null); emit('signed-out'); } throw e; })
      .finally(() => { refreshing = null; });
    await refreshing;
  }
  return session.access_token;
}

// The first account created on a device inherits what was there before accounts
// existed (library, linked Spotify, settings), so nothing is lost by signing up.
function claimDeviceData(uid) {
  if (localStorage.getItem('strand:legacyClaimed')) return;
  for (const k of ['settings', 'library', 'spotify', 'spotify:me', 'google', 'google:me']) {
    const v = localStorage.getItem('strand:' + k);
    if (v != null && localStorage.getItem(`strand:u:${uid}:${k}`) == null) localStorage.setItem(`strand:u:${uid}:${k}`, v);
  }
  localStorage.setItem('strand:legacyClaimed', uid);
}
function enter(d) {
  setSession(d);
  claimDeviceData(d.user.id);
  // Reload so every module re-opens storage in this user's namespace.
  reloadHome();
}

export async function signUp(email, password, name) {
  const d = await api('/auth/v1/signup', { method: 'POST', body: { email, password, data: { name } } });
  if (d?.access_token) { enter(d); return { signedIn: true }; }
  return { signedIn: false }; // email confirmation required
}
export async function signIn(email, password) {
  enter(await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }));
}
export async function sendPasswordReset(email) {
  await api('/auth/v1/recover', { method: 'POST', body: { email } });
}
export async function signOut() {
  try { await api('/auth/v1/logout', { method: 'POST', token: session?.access_token }); } catch {}
  session = null;
  save(SESSION_KEY, null);
  reloadHome();
}
export async function updateName(name) {
  const u = await api('/auth/v1/user', { method: 'PUT', token: await token(), body: { data: { name } } });
  session.user = u; save(SESSION_KEY, session); emit('account');
}
export async function deleteAccount() {
  await api('/rest/v1/rpc/delete_my_account', { method: 'POST', token: await token(), body: {} });
  for (const k of Object.keys(localStorage)) if (k.startsWith(`strand:u:${session.user.id}:`)) localStorage.removeItem(k);
  session = null; save(SESSION_KEY, null);
  reloadHome();
}

// Password-reset links land on the web app with "#access_token=…&type=recovery".
export function recoveryFromHash() {
  const p = new URLSearchParams(location.hash.replace(/^#\/?/, ''));
  return p.get('type') === 'recovery' && p.get('access_token') ? p.get('access_token') : null;
}
export async function setNewPassword(accessToken, password) {
  await api('/auth/v1/user', { method: 'PUT', token: accessToken, body: { password } });
}

// ---------------------------------------------------------------- sync
const META_KEY = ns('sync');
const meta = { syncedAt: 0, dirty: false, ...load(META_KEY, {}) };
let syncState = { state: 'idle' };
export const getSyncState = () => syncState;
function setSync(s) { syncState = { ...s, at: Date.now() }; emit('sync', syncState); }

let applying = false, version = 0, pushTimer = null;
function markDirty() {
  if (applying) return;
  meta.dirty = true; version++;
  save(META_KEY, meta);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => push().catch(() => {}), 1500);
}
const slimTrack = t => {
  const { key, title, artist, album, artistId, albumId, artwork, durationMs, previewUrl, explicit, trackNumber, origin, ids, appleUrl } = t;
  return { key, title, artist, album, artistId, albumId, artwork, durationMs, previewUrl, explicit, trackNumber, origin, ids, appleUrl };
};
const snapshot = () => ({
  library: {
    playlists: library.playlists.map(p => ({ ...p, tracks: p.tracks.map(slimTrack) })),
    liked: library.liked.map(slimTrack),
    recent: library.recent.map(slimTrack),
  },
  prefs: Object.fromEntries(PREF_KEYS.map(k => [k, settings[k]])),
});

async function push() {
  if (!session) return;
  const v = version;
  setSync({ state: 'saving' });
  try {
    const rows = await api('/rest/v1/user_data?on_conflict=user_id', {
      method: 'POST', token: await token(),
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: { user_id: session.user.id, ...snapshot() },
    });
    meta.syncedAt = Date.parse(rows?.[0]?.updated_at) || Date.now();
    if (v === version) meta.dirty = false;
    save(META_KEY, meta);
    setSync({ state: 'synced' });
  } catch (e) {
    setSync({ state: 'error', message: e.message });
    throw e;
  }
}

function applyRemote(row, mergeLocal) {
  const r = row.library || {};
  applying = true;
  try {
    if (mergeLocal) {
      const byId = new Map((r.playlists || []).map(p => [p.id, p]));
      for (const p of library.playlists) byId.set(p.id, p); // local wins on the same playlist
      const liked = new Map((r.liked || []).map(t => [t.key, t]));
      for (const t of library.liked) liked.set(t.key, t);
      library.playlists = [...byId.values()];
      library.liked = [...liked.values()];
    } else {
      library.playlists = r.playlists || [];
      library.liked = r.liked || [];
      library.recent = r.recent || [];
    }
    save(ns('library'), library);
    for (const k of PREF_KEYS) if (row.prefs && k in row.prefs && row.prefs[k] !== undefined) settings[k] = row.prefs[k];
    save(ns('settings'), settings);
    emit('library');
    emit('remote-update');
  } finally { applying = false; }
}

async function pull() {
  if (!session) return;
  setSync({ state: 'syncing' });
  try {
    const rows = await api(`/rest/v1/user_data?select=*&user_id=eq.${session.user.id}`, { token: await token() });
    const row = rows?.[0];
    if (!row) { await push(); return; }                 // first sign-in: upload this device's library
    const remoteAt = Date.parse(row.updated_at) || 0;
    if (remoteAt > meta.syncedAt) {
      if (meta.dirty) { applyRemote(row, true); await push(); }   // both changed: merge, then save
      else { applyRemote(row, false); meta.syncedAt = remoteAt; save(META_KEY, meta); setSync({ state: 'synced' }); }
    } else if (meta.dirty) await push();
    else setSync({ state: 'synced' });
  } catch (e) {
    setSync({ state: 'error', message: e.message });
  }
}

export function startSync() {
  if (!cloudEnabled() || !session) return;
  on('library', markDirty);
  on('settings', k => { if (PREF_KEYS.includes(k)) markDirty(); });
  on('signed-out', () => reloadHome());
  pull();
  setInterval(pull, 5 * 60000);
  addEventListener('focus', () => { if (Date.now() - (syncState.at || 0) > 60000) pull(); });
}
export const syncNow = () => (meta.dirty ? push() : pull());
export { USER_ID };
