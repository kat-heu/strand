// "Sign in with Google" for YouTube / YouTube Music, using Google Identity Services'
// browser token flow (no client secret, no server). Scope is read-only.
// Google gives browser-only apps 1-hour tokens with no refresh token, so after an
// hour we ask again (a quick popup, usually with no password since the user is
// already signed in to Google).
import { settings, load, save, emit, ns } from '../store.js';
import { loadScript } from '../util.js';

const KEY = ns('google');
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
let tok = load(KEY, null);                 // { access, exp }
export let googleProfile = load(KEY + ':me', null);

export const googleConfigured = () => !!settings.googleClientId?.trim();
export const googleLinked = () => !!googleProfile;
export const googleActive = () => !!tok && Date.now() < tok.exp - 60000;

async function gis() {
  await loadScript('https://accounts.google.com/gsi/client');
  for (let i = 0; i < 50 && !window.google?.accounts?.oauth2; i++) await new Promise(r => setTimeout(r, 100));
  if (!window.google?.accounts?.oauth2) throw new Error('Google sign-in failed to load');
  return window.google.accounts.oauth2;
}

const isDesktop = () => !!window.strandDesktop || /Electron\//.test(navigator.userAgent);
const rand = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/[+/=]/g, '');

// Desktop app: Google blocks sign-in inside apps, so sign in through the default
// browser. Google sends the token to callback.html, which hands it to the local server.
async function desktopToken(prompt) {
  const state = rand();
  await fetch(`/__auth/start?state=${encodeURIComponent(state)}`, { method: 'POST' });
  const params = {
    client_id: settings.googleClientId.trim(),
    redirect_uri: location.origin + '/callback.html',
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  };
  if (prompt) params.prompt = prompt;
  window.open('https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(params), '_blank');
  emit('toast', 'Finish signing in with Google in your browser…');
  const until = Date.now() + 10 * 60000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 1000));
    const r = await fetch(`/__auth/result?state=${encodeURIComponent(state)}`).then(x => x.json()).catch(() => ({ pending: true }));
    if (r.pending) continue;
    if (r.error || !r.code) throw new Error(r.error === 'expired' ? 'Google sign-in expired. Try again.' : 'Google sign-in was cancelled');
    const t = JSON.parse(r.code);
    tok = { access: t.access_token, exp: Date.now() + Number(t.expires_in || 3600) * 1000 };
    save(KEY, tok);
    emit('auth');
    return tok.access;
  }
  throw new Error('Google sign-in timed out. Try again.');
}

// Phones (and Home Screen apps): Google's sign-in popup often can't hand the login
// back to an installed web app, so go to Google's page and come back instead —
// the same way Spotify sign-in works.
const usesRedirect = () => /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) || navigator.standalone;
const RKEY = 'strand:google:redirect';
export const googleRedirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, '');
function redirectToken(prompt) {
  const state = rand();
  localStorage.setItem(RKEY, JSON.stringify({ state, back: location.hash || '#/me/youtube', at: Date.now() }));
  const params = { client_id: settings.googleClientId.trim(), redirect_uri: googleRedirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state };
  if (prompt) params.prompt = prompt;
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams(params);
  return new Promise(() => {});                                     // the page is leaving
}
// Call at startup: finishes the return from Google's sign-in page.
// Returns null (nothing to do), { ok: true, back } or { error }.
export async function finishGoogleRedirect() {
  const h = location.hash.replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(h) || !/(^|&)state=/.test(h)) return null;
  const p = new URLSearchParams(h);
  let pend = null; try { pend = JSON.parse(localStorage.getItem(RKEY) || 'null'); } catch {}
  if (!pend || pend.state !== p.get('state')) return null;         // not ours (e.g. another sign-in)
  localStorage.removeItem(RKEY);
  history.replaceState(null, '', location.pathname + location.search + pend.back);
  if (p.get('error')) return { error: p.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed: ' + p.get('error') };
  tok = { access: p.get('access_token'), exp: Date.now() + Number(p.get('expires_in') || 3600) * 1000 };
  save(KEY, tok);
  try { await loadProfile(); } catch (e) { return { error: e.message }; }
  return { ok: true, back: pend.back };
}

function requestToken(prompt) {
  if (isDesktop()) return desktopToken(prompt);
  if (usesRedirect()) return redirectToken(prompt);
  return new Promise(async (res, rej) => {
    try {
      const oauth2 = await gis();
      const client = oauth2.initTokenClient({
        client_id: settings.googleClientId.trim(),
        scope: SCOPE,
        prompt,
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          tok = { access: r.access_token, exp: Date.now() + Number(r.expires_in) * 1000 };
          save(KEY, tok);
          emit('auth');
          res(tok.access);
        },
        error_callback: e => rej(new Error(e?.type === 'popup_closed' ? 'Google sign-in was closed' : (e?.message || 'Google sign-in failed'))),
      });
      client.requestAccessToken();
    } catch (e) { rej(e); }
  });
}

export async function googleLogin() {
  if (!googleConfigured()) throw new Error('The app owner needs to add a Google Client ID (Settings → Developer keys)');
  await requestToken(googleProfile ? '' : 'consent');
  return loadProfile();
}
async function loadProfile() {
  const d = await ytFetch('channels', { part: 'snippet', mine: 'true' });
  const ch = d.items?.[0];
  googleProfile = ch
    ? { name: ch.snippet.title, image: ch.snippet.thumbnails?.default?.url, channelId: ch.id }
    : { name: 'Google account', image: null };
  save(KEY + ':me', googleProfile);
  emit('auth');
  return googleProfile;
}

export function googleLogout() {
  if (tok && window.google?.accounts?.oauth2) { try { window.google.accounts.oauth2.revoke(tok.access); } catch {} }
  tok = null; googleProfile = null;
  localStorage.removeItem(KEY); localStorage.removeItem(KEY + ':me');
  emit('auth');
}

// Call from a click handler to refresh an expired session.
export const googleReconnect = () => requestToken('');

// YouTube Data API call: uses the signed-in user's token when available,
// otherwise the app's API key (public data only).
export async function ytFetch(path, params = {}, { requireUser = false } = {}) {
  const q = new URLSearchParams(params);
  const headers = {};
  if (googleActive()) headers.Authorization = 'Bearer ' + tok.access;
  else if (requireUser) {
    const e = new Error(googleLinked() ? 'Your Google session expired — reconnect to refresh' : 'Sign in with Google to see this');
    e.code = 'reauth'; throw e;
  } else if (settings.youtubeKey) q.set('key', settings.youtubeKey);
  else throw new Error('Sign in with Google (Your music) or add a YouTube API key');
  const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}`, { headers });
  const d = await r.json();
  if (r.status === 401) { tok = null; save(KEY, null); const e = new Error('Your Google session expired — reconnect to refresh'); e.code = 'reauth'; throw e; }
  if (d.error) throw new Error(d.error.message);
  return d;
}
