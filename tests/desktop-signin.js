// Desktop sign-in tests: Spotify (code via local server) and Google/YouTube (token via
// callback.html) both open in the system browser and hand the result back to Strand.
// The page pretends to be the Electron app via its user agent. Run: node tests/desktop-signin.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://127.0.0.1:5176/';
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (r, d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });

(async () => {
  let focused = 0;
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5176, '127.0.0.1', { onAuth: () => focused++ });
  const b = await chromium.launch();
  const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 Strand/0.1.7 Chrome/130 Electron/33.2.0 Safari/537.36', viewport: { width: 1300, height: 850 } });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''").replace(/youtubeKey: '[^']*'/, "youtubeKey: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  await ctx.route(/itunes\.apple|lrclib|fonts\.g|rss\.apple/, r => J(r, { results: [], feed: { results: [] } }));
  let googleAuthUrl = null;
  await ctx.route('https://accounts.google.com/o/oauth2/v2/auth?**', r => {
    const u = new URL(r.request().url()); googleAuthUrl = u;
    r.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}#access_token=ya29.test&token_type=Bearer&expires_in=3599&state=${u.searchParams.get('state')}&scope=${u.searchParams.get('scope')}` } });
  });
  let ytAuth = null;
  await ctx.route('https://www.googleapis.com/**', r => {
    ytAuth = r.request().headers()['authorization'];
    const p = new URL(r.request().url()).pathname.split('/').pop();
    if (p === 'channels') return J(r, { items: [{ id: 'UC1', snippet: { title: 'Kat on YouTube', thumbnails: {} } }] });
    if (p === 'playlists') return J(r, { items: [{ id: 'PL1', snippet: { title: 'Gym', thumbnails: {} }, contentDetails: { itemCount: 4 } }] });
    return J(r, { items: [] });
  });
  await ctx.route('https://accounts.spotify.com/authorize?**', r => { const u = new URL(r.request().url()); r.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=SPCODE&state=${u.searchParams.get('state')}` } }); });
  await ctx.route('https://accounts.spotify.com/api/token', r => J(r, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'streaming' }));
  await ctx.route('https://api.spotify.com/**', r => J(r, { id: 'kat', display_name: 'Kat', items: [], next: null }));
  const tabs = []; ctx.on('page', pg => tabs.push(pg));
  const p = await ctx.newPage(); tabs.length = 0;
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', d => { errs.push('native dialog'); d.dismiss(); });

  await p.goto(BASE + '#/me'); await sleep(900);
  check('YouTube Music shows Connect (Google client built in)', await p.locator('.acct', { hasText: 'YouTube Music' }).getByRole('button', { name: 'Connect' }).count() === 1);

  await p.locator('.acct', { hasText: 'YouTube Music' }).getByRole('button', { name: 'Connect' }).click(); await sleep(3500);
  check('Google sign-in opened in the browser (not the app window)', tabs.length >= 1 && p.url().startsWith(BASE));
  check('Uses Strand callback page + read-only YouTube scope', googleAuthUrl?.searchParams.get('redirect_uri') === BASE.replace(/\/$/, '') + '/callback.html' && googleAuthUrl?.searchParams.get('scope') === 'https://www.googleapis.com/auth/youtube.readonly');
  check('Browser tab confirmed and dropped the token from its address', tabs[0] ? !(tabs[0].isClosed() ? false : tabs[0].url().includes('access_token')) : false);
  check('YouTube linked with channel name', await p.locator('.acct.linked', { hasText: 'Kat on YouTube' }).count() === 1);
  check('YouTube API called with the signed-in token', ytAuth === 'Bearer ya29.test');
  check('Strand window brought to front after sign-in', focused >= 1);
  await p.goto(BASE + '#/me/youtube'); await sleep(1500);
  check('Your YouTube playlists load', await p.locator('.card', { hasText: 'Gym' }).count() === 1);

  // Spotify still uses the code flow through the same hand-off
  await p.goto(BASE + '#/me'); await sleep(700);
  await p.locator('.acct', { hasText: 'Spotify' }).getByRole('button', { name: 'Connect' }).click(); await sleep(3500);
  check('Spotify desktop sign-in still works', await p.locator('.acct.linked', { hasText: 'Kat' }).count() >= 1 && p.url().startsWith(BASE));

  // A stray callback (nobody waiting) is rejected politely
  const stray = await b.newPage(); await stray.goto(BASE + 'callback.html#access_token=x&state=nobody'); await sleep(600);
  check('Unexpected callback shows a safe message', (await stray.textContent('#title')).includes('isn’t waiting'));

  check('No JavaScript errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1]); console.error('CRASH [' + require('path').basename(__filename) + ' after ' + results.length + ' checks: ' + (results[results.length - 1] || [])[1] + ']', e.message.split('\n')[0]); process.exit(1); });
