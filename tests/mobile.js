// Phone tests (iPhone-sized, touch): layout, mini player, full-screen player,
// and Spotify on phones (in-Strand by default, or the Spotify app as a remote).
// Run: node tests/mobile.js
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = 'http://127.0.0.1:5178/';
const results = [];
const check = (name, ok, extra = '') => results.push([ok ? 'PASS' : 'FAIL', name, extra]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const J = (r, d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: d === null ? '' : JSON.stringify(d) });

function wav(seconds, freq) {
  const rate = 22050, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const TONE = wav(30, 220);

(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5178);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ ...devices['iPhone 13'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''").replace(/youtubeKey: '[^']*'/, "youtubeKey: ''");
  await ctx.route(u => u.pathname === '/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
  const song = i => ({ wrapperType: 'track', trackId: 3000 + i, trackName: ['Glass Hours', 'Neon Rivers', 'Satellite Heart', 'Quiet Engines', 'After the Static'][i % 5], artistName: 'Nova Lane', artistId: 77, collectionId: 500, collectionName: 'Night Drive', artworkUrl100: '', trackTimeMillis: 200000, previewUrl: 'https://audio.test/p' + i + '.wav', trackNumber: i + 1, discNumber: 1, releaseDate: '2024-01-01' });
  await ctx.route('https://itunes.apple.com/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/search') return J(r, { results: [0, 1, 2, 3, 4].map(song) });
    const id = u.searchParams.get('id');
    if (id && id.includes(',')) return J(r, { results: id.split(',').map(x => song(+x - 3000)) });
    return J(r, { results: [{ ...song(0), wrapperType: 'collection' }, ...[0, 1, 2, 3, 4].map(song)] });
  });
  await ctx.route('https://rss.applemarketingtools.com/**', r => J(r, { feed: { results: [0, 1, 2, 3].map(i => ({ id: String(3000 + i) })) } }));
  await ctx.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: TONE }));
  await ctx.route(/lrclib|fonts\.g/, r => J(r, {}));
  let sdkLoaded = false;
  await ctx.route('https://sdk.scdn.co/**', r => { sdkLoaded = true; r.fulfill({ body: '' }); });
  // Spotify Web API with a phone running the Spotify app
  const sp = { calls: [], playing: null, pos: 0, isPlaying: false, asleep: false };
  const spt = i => ({ id: 's' + i, name: ['Glass Hours', 'Neon Rivers', 'Satellite Heart'][i % 3], uri: 'spotify:track:s' + i, duration_ms: 200000, artists: [{ name: 'Nova Lane' }], album: { name: 'Night Drive', images: [] }, external_ids: {} });
  await ctx.route('https://api.spotify.com/**', r => {
    const u = new URL(r.request().url()); const P = u.pathname.replace('/v1', ''); const m = r.request().method();
    sp.calls.push(m + ' ' + P + u.search);
    if (P === '/me') return J(r, { id: 'kat', display_name: 'Kat' });
    if (P === '/search') {
      const q = u.searchParams.get('q') || ''; const title = (q.match(/track:(.+?) artist:/) || [])[1] || 'Glass Hours';
      const id = 's' + title.toLowerCase().replace(/\W+/g, '');
      return J(r, { tracks: { items: [{ ...spt(0), id, name: title, uri: 'spotify:track:' + id }] } });
    }
    if (P === '/me/player/devices') return J(r, { devices: [{ id: 'mac1', name: 'Work Mac', type: 'Computer', is_active: true }, { id: 'phone1', name: 'iPhone', type: 'Smartphone', is_active: false }] });
    if (P === '/me/player/play' && m === 'PUT' && sp.asleep) return J(r, { error: { status: 404, message: 'Not found.' } }, 404);
    if (P === '/me/player/play' && m === 'PUT') { const body = r.request().postData(); if (body) { sp.lastUris = JSON.parse(body).uris; sp.playing = sp.lastUris[0]; sp.pos = 0; } sp.isPlaying = true; return r.fulfill({ status: 200, contentType: 'text/plain', body: 'dxSALWBYoZEZpqj' }); } // Spotify now answers play with a plain-text id
    if (P === '/me/player/pause') { sp.isPlaying = false; return J(r, null, 204); }
    if (P === '/me/player/seek') { sp.pos = +u.searchParams.get('position_ms'); return J(r, null, 204); }
    if (P === '/me/player') return J(r, { is_playing: sp.isPlaying, progress_ms: sp.pos, item: sp.playing ? { uri: sp.playing, duration_ms: 200000 } : null });
    if (P === '/me/playlists') return J(r, { items: [], next: null });
    return J(r, { items: [] });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('dialog', d => { errs.push('NATIVE DIALOG'); d.dismiss(); });
  const S = () => p.evaluate(() => ({ prov: strand.player.state.provider, title: strand.player.state.track?.title, idx: strand.player.state.index, playing: strand.player.state.playing }));
  const noOverflow = () => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.main').scrollWidth <= document.querySelector('.main').clientWidth + 1);

  await p.goto(BASE); await sleep(1500);
  // ---- layout
  check('Bottom tab bar shown, sidebar hidden', await p.isVisible('#tabbar') && !(await p.isVisible('.sidebar')));
  check('Tab bar has Home, Search, Your music, Library, Settings', (await p.locator('#tabbar a').allTextContents()).join('|') === 'Home|Search|Your music|Library|Settings');
  for (const [hash, name] of [['#/', 'Home'], ['#/search/nova', 'Search'], ['#/me', 'Your music'], ['#/library', 'Library'], ['#/settings', 'Settings'], ['#/album/500', 'Album']]) {
    await p.evaluate(h => { location.hash = h; }, hash); await sleep(900);
    check(`${name} fits the phone screen (no sideways scrolling)`, await noOverflow());
  }
  await p.locator('#tabbar a', { hasText: 'Search' }).tap(); await sleep(500);
  check('Tapping a tab navigates and highlights it', p.url().includes('#/search') && await p.locator('#tabbar a.on', { hasText: 'Search' }).count() === 1);
  await p.evaluate(() => { location.hash = '#/'; }); await sleep(900);
  check('Home shelves scroll sideways like a native app', await p.evaluate(() => { const g = document.querySelector('.v-home .grid'); return getComputedStyle(g).display === 'flex' && g.scrollWidth > g.clientWidth; }));
  await p.evaluate(() => { location.hash = '#/library'; }); await sleep(700);
  check('Top bar: no back button on a tab page', await p.locator('#mtop-back').isHidden());
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  check('Top bar: back button on an album', await p.locator('#mtop-back').isVisible());
  await p.locator('#mtop-back').tap(); await sleep(700);
  check('Back button goes back', p.url().includes('#/library'));
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.tracks .row button[title=More]').first().tap(); await sleep(400);
  check('Song menu opens as a bottom sheet with the song name', await p.evaluate(() => { const m = document.getElementById('menu'); const r = m.getBoundingClientRect(); return !m.hidden && m.classList.contains('sheet') && innerHeight - r.bottom < 60 && m.textContent.includes('Glass Hours'); }));
  await p.locator('.sheet-cancel').tap(); await sleep(300);
  check('Cancel closes the sheet', await p.evaluate(() => document.getElementById('menu').hidden && !document.body.classList.contains('menu-open')));

  // ---- mini player + full-screen player
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.row').nth(0).tap(); await sleep(1500);
  let s = await S();
  check('Tapping a song plays it (in Strand, preview)', s.prov === 'preview' && s.playing, JSON.stringify(s));
  check('Mini player shows the song above the tabs', await p.isVisible('#bar') && (await p.textContent('#bar-title')) === s.title);
  const barBox = await p.locator('#bar').boundingBox(), tabBox = await p.locator('#tabbar').boundingBox();
  check('Mini player sits just above the tab bar', barBox.y + barBox.height <= tabBox.y + 1);
  await p.locator('#bar-title').tap(); await sleep(500);
  check('Tapping the mini player opens the full-screen player', await p.evaluate(() => document.body.classList.contains('np-open')) && await p.isVisible('#np-play'));
  const npBox = await p.locator('#panel').boundingBox();
  const vh = await p.evaluate(() => innerHeight);
  check('Full-screen player covers the screen', npBox.y <= 1 && npBox.height >= vh - 1, JSON.stringify(npBox) + ' vh=' + vh);
  await p.locator('#np-play').tap(); await sleep(400);
  check('Big pause button works', !(await S()).playing);
  await p.locator('#np-play').tap(); await sleep(400);
  check('Big play button works', (await S()).playing);
  await p.locator('#np-next').tap(); await sleep(1300);
  check('Next button works', (await S()).idx === 1);
  await sleep(1200);
  check('Progress bar and times update', (await p.textContent('#np-pos')) !== '0:00' || (await p.inputValue('#np-seek')) !== '0');
  check('Lyrics / Up next tabs are in the player', await p.isVisible('.tabs button[data-tab=queue]'));
  await p.locator('#np-close').tap(); await sleep(500);
  check('Chevron closes the player', !(await p.evaluate(() => document.body.classList.contains('np-open'))));
  check('Spotify web player is never loaded on phones', !sdkLoaded);

  // ---- Spotify on phones
  await p.evaluate(() => {
    localStorage.setItem('strand:spotify', JSON.stringify({ access: 'x', refresh: 'r', exp: Date.now() + 3e6, scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-top-read user-read-recently-played user-follow-read' }));
    localStorage.setItem('strand:spotify:me', JSON.stringify({ id: 'kat', display_name: 'Kat' }));
  });
  await p.reload(); await sleep(1200);
  await p.evaluate(() => { location.hash = '#/album/500'; }); await sleep(1000);
  await p.locator('.row').nth(2).tap(); await sleep(1500);
  s = await S();
  check('Spotify-connected phone never hands songs to the Spotify app', s.prov !== 'spotifyRemote' && !sp.calls.some(c => c.startsWith('PUT /me/player/play')), JSON.stringify(s));
  await p.locator('#bar-title').tap(); await sleep(500);
  check('No "Play in Spotify app" button any more', await p.locator('#np-source button', { hasText: 'Spotify app' }).count() === 0);
  check('No "Finding source…" text while a song loads', !(await p.textContent('#np-source')).includes('Finding source'));
  await p.locator('#np-close').tap(); await sleep(300);
  await p.evaluate(() => { location.hash = '#/settings'; }); await sleep(700);
  check('Settings no longer offers playing in the Spotify app', await p.locator('select:has(option[value=app])').count() === 0);
  // a song's YouTube match is looked up ahead of time for the next songs in the queue
  const ord = await p.evaluate(() => ({
    sc: strand.player.sourceOrder({ key: 'sc:1', title: 'x', artist: 'y', origin: 'soundcloud', ids: { soundcloud: 'https://soundcloud.com/a/b' } }),
    sp: strand.player.sourceOrder({ key: 'sp:1', title: 'x', artist: 'y', origin: 'spotify', ids: { spotify: 'spotify:track:1' } }),
  }));
  check('Spotify app is never in any song’s play order', !ord.sc.includes('spotifyRemote') && !ord.sp.includes('spotifyRemote'), JSON.stringify(ord));
  await p.evaluate(() => strand.player.playQueue([{ key: 'x:77', title: 'Some upload', artist: 'DJ', previewUrl: 'https://audio.test/p77.wav', origin: 'cloud', ids: {} }], 0)); await sleep(2500);
  await p.locator('#bar-title').tap(); await sleep(500);
  check('Now Playing says whether the source keeps playing when locked', await p.evaluate(() => { const n = document.querySelector('.bg-note'); return !!n && /lock/.test(n.textContent); }));

  check('First tap unlocks Strand’s audio with a sound iPhones can decode', await p.evaluate(() => Promise.all([import('/js/engine.js'), import('/js/log.js')]).then(([E, m]) => E.isUnlocked() && !m.logLines().some(l => /audio unlock failed/.test(l)))), await p.evaluate(() => Promise.all([import('/js/engine.js'), import('/js/log.js')]).then(([E, m]) => String(E.isUnlocked()) + ' ' + m.logLines().filter(l => /unlock/.test(l)).join(' / '))));
  check('Phones use one shared audio player for everything Strand plays itself', await p.evaluate(() => Promise.all([import('/js/audio.js'), import('/js/engine.js')]).then(([a, e]) => a.audio === e.el && e.el.loop === true)));

  // ---- long list on a phone
  await p.evaluate(() => import('/js/store.js').then(m => { m.library.playlists.unshift({ id: 'big', name: 'Big', tracks: [...Array(3000)].map((_, i) => ({ key: 'm' + i, title: 'Track ' + i, artist: 'A', artwork: '', durationMs: 1, origin: 'catalog', ids: {} })), created: 1 }); m.saveLibrary(); }));
  await p.evaluate(() => { location.hash = '#/playlist/big'; }); await sleep(800);
  check('3,000-song playlist on a phone draws only visible rows', (await p.locator('.tracks.virtual .row').count()) < 80);
  check('…and still fits the screen', await noOverflow());
  check('Top bar is clear at the top of a page', await p.evaluate(() => !document.getElementById('mtop').classList.contains('solid')));
  await p.evaluate(() => document.querySelector('.main').scrollTo(0, 1500)); await sleep(300);
  check('Top bar shows the playlist name after scrolling', await p.evaluate(() => document.getElementById('mtop').classList.contains('solid') && document.getElementById('mtop-title').textContent === 'Big'));

  // ---- Google / YouTube sign-in on a phone goes to Google's page and comes back
  let gUrl = null;
  await ctx.route('https://accounts.google.com/**', r => {
    gUrl = new URL(r.request().url());
    const back = gUrl.searchParams.get('redirect_uri') + '#access_token=gtok&token_type=Bearer&expires_in=3599&scope=x&state=' + gUrl.searchParams.get('state');
    r.fulfill({ status: 302, headers: { Location: back } });
  });
  await ctx.route('https://www.googleapis.com/youtube/v3/**', r => r.request().url().includes('/channels') ? J(r, { items: [{ id: 'UC1', snippet: { title: 'Kat on YouTube', thumbnails: {} } }] }) : J(r, { items: [] }));
  await p.evaluate(() => { location.hash = '#/me'; }); await sleep(600);
  await p.evaluate(() => import('/js/accounts.js').then(m => { m.ACCOUNTS.youtube.connect(); }));
  await p.waitForFunction(() => window.strand && import('/js/providers/google.js').then(m => m.googleLinked()), null, { timeout: 15000, polling: 300 }).catch(() => {});
  await sleep(500);
  check('Phone Google sign-in uses Google’s page (no popup) and returns to Strand', !!gUrl && gUrl.searchParams.get('response_type') === 'token' && gUrl.searchParams.get('redirect_uri') === BASE, gUrl && gUrl.searchParams.get('redirect_uri'));
  check('…and YouTube is connected afterwards', await p.evaluate(() => import('/js/providers/google.js').then(m => m.googleLinked() && m.googleActive() && m.googleProfile.name === 'Kat on YouTube')), JSON.stringify({ url: p.url(), g: gUrl && gUrl.href.slice(0, 160), info: await p.evaluate(async () => ({ m: await import('/js/providers/google.js').then(m => [m.googleLinked(), m.googleActive(), m.googleProfile]), ls: localStorage.getItem('strand:google'), pend: localStorage.getItem('strand:google:redirect'), toast: document.getElementById('toast')?.textContent, keys: Object.keys(localStorage).filter(k => /google/.test(k)) })) }));
  check('…and the address no longer holds the sign-in token', !p.url().includes('access_token'), p.url());

  // ---- the phone version updates itself
  let ver = 'aaa111';
  await ctx.route('**/version.json*', r => J(r, { version: ver, androidShell: 2 }));
  const u = await ctx.newPage();
  await u.goto(BASE); await sleep(1500);
  await u.evaluate(() => { window.__marker = 1; });
  await u.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(800);
  check('No reload when the version is unchanged', await u.evaluate(() => window.__marker === 1));
  ver = 'bbb222';
  await u.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(2000);
  check('Opening the app after an update loads the new version', await u.evaluate(() => window.__marker === undefined));
  await u.evaluate(() => { location.hash = '#/settings'; }); await sleep(800);
  check('Settings shows the running version', (await u.textContent('#web-version')).includes('Version bbb222'));
  await u.locator('#web-version button', { hasText: 'Check connections' }).tap(); await sleep(11000);
  check('Connection check lists every service with a result', await u.evaluate(() => { const r = [...document.querySelectorAll('.diag-row')]; return r.length === 8 && r.every(x => !x.textContent.includes('checking…')); }), await u.textContent('#web-version'));
  await u.close();
  // Android app with an older frame: told to download the new one
  const an = await ctx.newPage();
  await an.goto(BASE + '?app=android&shell=1#/'); await sleep(1800);
  check('Android app: old app version is noticed and the address is tidied', !an.url().includes('app=android') && await an.evaluate(() => localStorage.getItem('strand:androidShell')) === '1', an.url());
  check('Android app: “A new Android app is out” with a Download button', await an.locator('.update-banner', { hasText: 'Android app' }).isVisible() && (await an.locator('.update-banner a').getAttribute('href')).endsWith('/Strand.apk'));
  await an.evaluate(() => { location.hash = '#/settings'; }); await sleep(700);
  check('Android app: Settings offers “Download Android app”', await an.locator('#web-version a', { hasText: 'Download Android app' }).isVisible());
  await an.close();
  const an2 = await ctx.newPage();
  await an2.goto(BASE + '?app=android&shell=2#/settings'); await sleep(1800);
  check('Android app: up-to-date app gets no prompt', !(await an2.locator('.update-banner', { hasText: 'Android app' }).count()) && (await an2.textContent('#web-version')).includes('up to date'));
  await an2.close();

  check('No JavaScript errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await p.evaluate(() => { location.hash = '#/'; }); await sleep(800);
  try { fs.mkdirSync(path.join(__dirname, '..', 'test-results'), { recursive: true }); await p.screenshot({ path: path.join(__dirname, '..', 'test-results', 'mobile-home.png') }); } catch {}
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH [' + require('path').basename(__filename) + ' after ' + results.length + ' checks: ' + (results[results.length - 1] || [])[1] + ']', e.message.slice(0, 1500)); process.exit(1); });
