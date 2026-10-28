// Strand accounts tests: sign-up / sign-in gate, per-user isolation on one device,
// library sync across devices, errors. Supabase Auth + PostgREST are mocked
// (including row-level security: a token can only read/write its own row).
// Run: node tests/accounts.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://127.0.0.1:5174/';
const SB = 'https://sb.test';
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- tiny Supabase mock
const users = new Map();   // email -> { id, email, password, user_metadata, confirmed }
const tokens = new Map();  // access token -> user id
const rows = new Map();    // user id -> row
const authorizeCalls = [], pkce = new Map();
let requireConfirm = false, uid = 0, clock = Date.parse('2026-01-01T00:00:00Z');
const sessionFor = u => { const t = 'at_' + u.id + '_' + Math.random().toString(36).slice(2); tokens.set(t, u.id); return { access_token: t, refresh_token: 'rt_' + u.id, expires_in: 3600, token_type: 'bearer', user: pub(u) }; };
const pub = u => ({ id: u.id, email: u.email, user_metadata: u.user_metadata });
const json = (r, status, body) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: body === undefined ? '' : JSON.stringify(body) });

async function supabase(route) {
  const req = route.request(); const u = new URL(req.url()); const body = req.postData() ? JSON.parse(req.postData()) : null;
  const auth = (req.headers()['authorization'] || '').replace('Bearer ', '');
  const me = tokens.get(auth);
  // Social sign-in: the browser is sent to /authorize, which redirects back with a code.
  if (u.pathname === '/auth/v1/authorize') {
    authorizeCalls.push(u.searchParams.get('provider'));
    const back = u.searchParams.get('redirect_to');
    pkce.set('code_' + u.searchParams.get('provider'), u.searchParams.get('code_challenge'));
    return route.fulfill({ status: 302, headers: { location: back + (back.includes('?') ? '&' : '?') + 'code=code_' + u.searchParams.get('provider') } });
  }
  if (req.headers()['apikey'] !== 'pk_test') return json(route, 401, { message: 'No API key' });
  if (u.pathname === '/auth/v1/settings') return json(route, 200, { external: { email: true, phone: false, google: true, apple: true, github: false } });
  if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'pkce') {
    if (!pkce.has(body.auth_code) || !body.code_verifier) return json(route, 400, { error_description: 'invalid flow state' });
    const email = body.auth_code.replace('code_', '') + '.user@example.com';
    if (!users.has(email)) users.set(email, { id: 'user-' + (++uid), email, password: null, user_metadata: { name: 'Social ' + body.auth_code.replace('code_', '') }, confirmed: true });
    return json(route, 200, sessionFor(users.get(email)));
  }
  if (u.pathname === '/auth/v1/signup') {
    if (users.has(body.email)) return json(route, 422, { msg: 'User already registered' });
    const user = { id: 'user-' + (++uid), email: body.email, password: body.password, user_metadata: body.data || {}, confirmed: !requireConfirm };
    users.set(body.email, user);
    return json(route, 200, user.confirmed ? sessionFor(user) : pub(user));
  }
  if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
    const user = users.get(body.email);
    if (!user || user.password !== body.password) return json(route, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    if (!user.confirmed) return json(route, 400, { error_description: 'Email not confirmed' });
    return json(route, 200, sessionFor(user));
  }
  if (u.pathname === '/auth/v1/logout') return json(route, 204);
  if (u.pathname === '/auth/v1/recover') return json(route, 200, {});
  if (u.pathname === '/rest/v1/user_data') {
    if (!me) return json(route, 401, { message: 'JWT required' });
    if (req.method() === 'GET') {
      const want = (u.searchParams.get('user_id') || '').replace('eq.', '');
      return json(route, 200, want === me && rows.has(me) ? [rows.get(me)] : []); // RLS
    }
    if (req.method() === 'POST') {
      if (body.user_id !== me) return json(route, 403, { message: 'new row violates row-level security policy' });
      clock += 1000;
      const row = { ...rows.get(me), ...body, updated_at: new Date(clock).toISOString() };
      rows.set(me, row);
      return json(route, 201, [row]);
    }
  }
  if (u.pathname === '/rest/v1/rpc/delete_my_account') {
    for (const [e, x] of users) if (x.id === me) users.delete(e);
    rows.delete(me);
    return json(route, 204);
  }
  return json(route, 404, { message: 'not mocked: ' + u.pathname });
}

async function setup(ctx) {
  await ctx.route(SB + '/**', supabase);
  await ctx.route(BASE + 'config.js', r => r.fulfill({ contentType: 'text/javascript', body: `export default { supabaseUrl: '${SB}', supabaseKey: 'pk_test', spotifyClientId: 'cid', googleClientId: '', youtubeKey: '', appleDevToken: '' };` }));
  await ctx.route(/itunes\.apple\.com|lrclib|fonts\.g|rss\.apple/, r => r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ results: [], feed: { results: [] } }) }));
  await ctx.route('https://api.spotify.com/**', r => json(r, 200, { id: 'kat', display_name: 'Kat', items: [], next: null }));
}
const track = i => ({ key: 'it:' + i, title: 'Song ' + i, artist: 'Nova Lane', album: 'A', artwork: '', durationMs: 200000, origin: 'catalog', ids: { itunes: String(i) } });

(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5174);
  const b = await chromium.launch();
  const errs = [];
  const ctxA = await b.newContext({ viewport: { width: 1300, height: 850 } }); await setup(ctxA);
  const p = await ctxA.newPage();
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('dialog', d => { errs.push('NATIVE DIALOG'); d.dismiss(); });

  // Pre-existing (pre-accounts) data on this device: a library + a linked Spotify.
  await p.goto(BASE); await sleep(300);
  await p.evaluate(t => {
    localStorage.setItem('strand:library', JSON.stringify({ playlists: [{ id: 'pl1', name: 'Kat mix', tracks: t, created: 1 }], liked: [t[0]], recent: [] }));
    localStorage.setItem('strand:spotify', JSON.stringify({ access: 'x', refresh: 'r', exp: Date.now() + 3e6, scope: '' }));
    localStorage.setItem('strand:spotify:me', JSON.stringify({ id: 'kat', display_name: 'Kat' }));
  }, [track(1), track(2)]);
  await p.reload(); await sleep(600);

  check('Opens on the create-account screen', await p.locator('.auth-screen h1', { hasText: 'Create your account' }).isVisible());
  check('App is hidden until signed in', await p.evaluate(() => getComputedStyle(document.querySelector('.app')).visibility === 'hidden'));

  // Validation
  await p.fill('.auth-form input[type=email]', 'kat@example.com');
  await p.fill('.auth-form input[type=password]', '123');
  await p.click('.auth-submit'); await sleep(200);
  check('Short password rejected', (await p.textContent('.auth-err')).includes('6 characters'));

  // Sign up
  await p.fill('.auth-form input[placeholder="Your name"]', 'Kat');
  await p.fill('.auth-form input[type=password]', 'secret123');
  await p.click('.auth-submit'); await sleep(1800);
  check('Sign-up enters the app', !(await p.locator('.auth-screen').count()) && await p.locator('#nav').isVisible());
  check('Sidebar shows account name', (await p.textContent('.me-chip')).includes('Kat'));
  check('Existing library kept after sign-up', await p.evaluate(() => strand.library.playlists[0]?.name === 'Kat mix' && strand.library.liked.length === 1));
  check('Existing Spotify link kept after sign-up', await p.locator('#conn a[title="Spotify linked"]').count() === 1);
  await sleep(1500);
  const katId = users.get('kat@example.com').id;
  check('Library uploaded to the cloud', rows.get(katId)?.library?.playlists?.[0]?.name === 'Kat mix', JSON.stringify(rows.get(katId)?.library || {}).slice(0, 120));

  // Change → synced
  await p.evaluate(t => { strand.library.liked.unshift(t); }, track(3));
  await p.evaluate(() => { import('/js/store.js').then(m => m.saveLibrary()); });
  await sleep(2500);
  check('New like syncs to the cloud', rows.get(katId)?.library?.liked?.length === 2);
  await p.goto(BASE + '#/settings'); await sleep(500);
  check('Settings shows account + "Library synced"', (await p.locator('.svc-card').first().innerText()).includes('kat@example.com') && (await p.locator('.svc-card').first().innerText()).includes('Library synced'));

  // Sign out
  await p.getByRole('button', { name: 'Sign out' }).click();
  await p.locator('.dialog .btn.primary').click(); await sleep(1200);
  check('Sign out returns to sign-in screen', await p.locator('.auth-screen h1', { hasText: 'Welcome back' }).isVisible());

  // Wrong password
  await p.fill('.auth-form input[type=email]', 'kat@example.com');
  await p.fill('.auth-form input[type=password]', 'nope');
  await p.click('.auth-submit'); await sleep(500);
  check('Wrong password shows a clear error', (await p.textContent('.auth-err')).includes('Wrong email or password'));

  // Second person on the same computer
  await p.getByRole('button', { name: 'Create an account' }).click();
  await p.fill('.auth-form input[placeholder="Your name"]', 'Bob');
  await p.fill('.auth-form input[type=email]', 'bob@example.com');
  await p.fill('.auth-form input[type=password]', 'bobpass1');
  await p.click('.auth-submit'); await sleep(1800);
  check('Second user signs up on same device', (await p.textContent('.me-chip')).includes('Bob'));
  check('Second user does NOT see first user\'s library', await p.evaluate(() => strand.library.playlists.length === 0 && strand.library.liked.length === 0));
  check('Second user does NOT inherit first user\'s Spotify', await p.locator('#conn a[title="Spotify linked"]').count() === 0);
  check('Duplicate email rejected', await (async () => {
    const r = await p.evaluate(async () => { try { await strand.cloud.signUp('kat@example.com', 'whatever1', 'x'); return 'ok'; } catch (e) { return e.message; } });
    return r.includes('already exists');
  })());

  // Delete Bob's account
  await p.goto(BASE + '#/settings'); await sleep(500);
  await p.getByRole('button', { name: 'Delete account' }).click();
  await p.locator('.dialog .btn.primary').click(); await sleep(1200);
  check('Delete account removes it and signs out', !users.has('bob@example.com') && await p.locator('.auth-screen').isVisible());

  // Kat signs back in on the same device
  await p.fill('.auth-form input[type=email]', 'kat@example.com');
  await p.fill('.auth-form input[type=password]', 'secret123');
  await p.click('.auth-submit'); await sleep(1800);
  check('First user signs back in with her library + Spotify', await p.evaluate(() => strand.library.liked.length === 2) && await p.locator('#conn a[title="Spotify linked"]').count() === 1);

  // Another device: fresh browser profile
  const ctxB = await b.newContext({ viewport: { width: 1300, height: 850 } }); await setup(ctxB);
  const q = await ctxB.newPage(); q.on('pageerror', e => errs.push('PAGEERR(B) ' + e.message));
  await q.goto(BASE); await sleep(600);
  await q.getByRole('button', { name: 'Sign in' }).last().click(); await sleep(200);
  await q.fill('.auth-form input[type=email]', 'kat@example.com');
  await q.fill('.auth-form input[type=password]', 'secret123');
  await q.click('.auth-submit'); await sleep(2500);
  check('Other device gets the synced library', await q.evaluate(() => strand.library.playlists[0]?.name === 'Kat mix' && strand.library.liked.length === 2));
  check('Other device: Spotify not linked (per-device logins)', await q.locator('#conn a[title="Spotify linked"]').count() === 0);
  // edit on device B, see it on device A after a sync
  await q.evaluate(() => import('/js/store.js').then(m => { m.library.playlists.push({ id: 'plB', name: 'From laptop', tracks: [], created: 2 }); m.saveLibrary(); }));
  await sleep(2500);
  await p.evaluate(() => strand.cloud.syncNow()); await sleep(1200);
  check('Change on one device appears on the other', await p.evaluate(() => strand.library.playlists.some(x => x.name === 'From laptop')) && await p.locator('#side-playlists a', { hasText: 'From laptop' }).count() === 1);

  // Email confirmation flow
  requireConfirm = true;
  const ctxC = await b.newContext(); await setup(ctxC);
  const c = await ctxC.newPage(); await c.goto(BASE); await sleep(500);
  await c.fill('.auth-form input[placeholder="Your name"]', 'Cara');
  await c.fill('.auth-form input[type=email]', 'cara@example.com');
  await c.fill('.auth-form input[type=password]', 'carapass');
  await c.click('.auth-submit'); await sleep(800);
  check('Email-confirmation sign-up explains next step', (await c.textContent('.auth-info')).includes('confirmation link') && await c.locator('.auth-screen h1', { hasText: 'Welcome back' }).isVisible());
  await c.fill('.auth-form input[type=email]', 'cara@example.com');
  await c.fill('.auth-form input[type=password]', 'carapass');
  await c.click('.auth-submit'); await sleep(500);
  check('Unconfirmed sign-in explains to check email', (await c.textContent('.auth-err')).includes('confirm your email'));

  // Social sign-in buttons only for providers switched on in Supabase
  requireConfirm = false;
  const ctxD = await b.newContext(); await setup(ctxD);
  const d = await ctxD.newPage(); d.on('pageerror', e => errs.push('PAGEERR(D) ' + e.message));
  await d.goto(BASE); await sleep(800);
  const provs = await d.locator('.auth-provider').allTextContents();
  check('Shows buttons for enabled providers only', provs.join(',') === 'Google,Apple', provs.join(','));
  // Web flow: full-page redirect and back
  await d.locator('.auth-provider', { hasText: 'Google' }).click(); await sleep(2500);
  check('Google sign-in (web) completes and enters the app', authorizeCalls.includes('google') && (await d.locator('.me-chip').textContent().catch(() => '')).includes('Social google'));
  check('Address bar cleaned after sign-in', !d.url().includes('code='), d.url());

  // Desktop flow: login opens in the browser, Strand picks up the result
  const ctxE = await b.newContext({ userAgent: 'Mozilla/5.0 Strand/0.1.5 Chrome/130 Electron/33.2.0 Safari/537.36' }); await setup(ctxE);
  const e = await ctxE.newPage(); e.on('pageerror', x => errs.push('PAGEERR(E) ' + x.message));
  let browserTab = null; ctxE.on('page', pg => { browserTab = pg; });
  await e.goto(BASE); await sleep(800);
  await e.locator('.auth-provider', { hasText: 'Apple' }).click(); await sleep(4000);
  check('Apple sign-in (desktop) opens the browser and signs in', !!browserTab && (await e.locator('.me-chip').textContent().catch(() => '')).includes('Social apple'));
  check('Desktop app window never left Strand', e.url().startsWith(BASE));

  check('No JavaScript errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
