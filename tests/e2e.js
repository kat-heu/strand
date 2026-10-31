// End-to-end tests: runs the real app in Chromium with every outside service
// (iTunes, LRCLIB, Spotify, YouTube, SoundCloud, Google sign-in) replaced by mocks.
// Run: npm test   (needs `npx playwright install chromium` once)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const BASE = 'http://127.0.0.1:5173/';

// Simple sine-wave WAV files generated in memory (stand-ins for 30s previews / 3s clips).
function wav(seconds, freq) {
  const rate = 22050, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * freq * i / rate)), 44 + i * 2);
  return buf;
}
const TONE = wav(30, 220), SHORT = wav(3, 330);
const results = [];
const check = (name, ok, extra = '') => { results.push([ok ? 'PASS' : 'FAIL', name, extra]); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MOCK_SP_SDK = `
window.Spotify = { Player: class {
  constructor(o){ this.o=o; this.l={}; this.state={paused:true,position:0,duration:0}; window.__sp=this; }
  addListener(e,f){ (this.l[e] ||= []).push(f); return true; }
  emit(e,d){ (this.l[e]||[]).forEach(f=>f(d)); }
  async connect(){ setTimeout(()=>this.emit('ready',{device_id:'dev1'}),30); return true; }
  activateElement(){} disconnect(){}
  async resume(){ this.state.paused=false; this.push(); } async pause(){ this.state.paused=true; this.push(); }
  async seek(ms){ this.state.position=ms; this.push(); } async setVolume(){}
  push(){ this.emit('player_state_changed',{position:this.state.position,duration:this.state.duration,paused:this.state.paused,track_window:{current_track:{uri:this.uri},previous_tracks:[]}}); }
  _play(uri,dur){ this.uri=uri; this.state={paused:false,position:0,duration:dur}; this.push(); }
}};
setTimeout(()=>window.onSpotifyWebPlaybackSDKReady(),10);`;

const MOCK_YT = `
window.YT = { PlayerState:{ENDED:0,PLAYING:1,PAUSED:2}, Player: class {
  constructor(el,o){ this.o=o; this.vid=o.videoId; this.t0=performance.now(); this.st=1;
    const d=document.createElement('div'); d.className='yt-mock'; d.textContent='YT '+this.vid; el.replaceWith(d);
    window.__yt=this; setTimeout(()=>o.events.onReady({target:this}),20); }
  loadVideoById(id){ this.vid=id; this.t0=performance.now(); this.st=1; } playVideo(){ this.st=1; } pauseVideo(){ this.st=2; } stopVideo(){ this.st=5; }
  seekTo(s){ this.t0=performance.now()-s*1000; } getCurrentTime(){ return (performance.now()-this.t0)/1000; } getDuration(){ return 200; }
  getPlayerState(){ return this.st; } setVolume(){} _end(){ this.st=0; this.o.events.onStateChange({data:0}); }
}};
setTimeout(()=>window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(),10);`;

const MOCK_SC = `
window.__scSounds = u => [0,1,2].map(i=>({id:900+i,title:(u.includes('likes')?'Liked ':'Upload ')+i,user:{username:'djkati'},duration:180000,permalink_url:'https://soundcloud.com/djkati/t'+i,artwork_url:null}));
window.SC = { Widget: Object.assign(function(iframe){
  if (iframe.__w) return iframe.__w;
  const url = new URL(iframe.src).searchParams.get('url');
  const w = { url, b:{}, idx:0, loads:0, bind(e,f){ this.b[e]=f; if(e==='ready') setTimeout(()=>f(),30); }, unbind(e){ delete this.b[e]; },
    skip(i){ this.idx=i; }, getCurrentSoundIndex(cb){ cb(this.idx); }, _finishAndAdvance(){ this.b.finish&&this.b.finish(); this.idx++; setTimeout(()=>this.b.play&&this.b.play(),300); }, _finish(){ this.b.finish&&this.b.finish(); },
    getSounds(cb){ cb(window.__scSounds(this.url)); }, getCurrentSound(cb){ cb(window.__scSounds(this.url)[0]); },
    load(u,o){ this.url=u; this.loads++; setTimeout(()=>o.callback&&o.callback(),20); }, play(){ window.__scPlayed=this.url; this.b.play&&this.b.play(); },
    pause(){ this.b.pause&&this.b.pause(); }, seekTo(){}, setVolume(){}, getDuration(cb){ cb(180000); } };
  iframe.__w = w; window.__scw = w; return w;
}, { Events:{READY:'ready',PLAY:'play',PAUSE:'pause',FINISH:'finish',PLAY_PROGRESS:'playProgress',ERROR:'error'} }) };`;

const MOCK_GIS = `window.google={accounts:{oauth2:{initTokenClient(c){ window.__gisCfg=c; return {requestAccessToken(){ setTimeout(()=>c.callback({access_token:'gtok',expires_in:3599}),20); }}; }, revoke(){}}}};`;

(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5173);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => { navigator.requestMediaKeySystemAccess = () => Promise.resolve({}); }); // pretend this browser has Widevine, like Chrome
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/ERR_FAILED|status of 4/.test(m.text())) errs.push('CONSOLE ' + m.text()); });
  // Browser-native dialogs must never appear (Electron can't show prompt()).
  p.on('dialog', d => { errs.push('NATIVE DIALOG ' + d.type() + ': ' + d.message()); d.dismiss(); });
  // Answer the app's own in-app dialog.
  const answer = async (text) => {
    await p.locator('.dialog').waitFor();
    if (text !== undefined) await p.fill('.dialog input', text);
    await p.locator('.dialog .btn.primary').click(); await sleep(300);
  };

  const J = (r, d, status = 200) => r.fulfill({ status, json: d, headers: { 'Access-Control-Allow-Origin': '*' } });
  const art = i => `https://img.test/a${i % 4}/100x100bb.jpg`;
  await p.route('https://img.test/**', r => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#555"/></svg>' }));
  await p.route('https://audio.test/**', r => r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: TONE }));
  const it = i => ({ wrapperType: 'track', trackId: 1000 + i, trackName: ['Glass Hours', 'Neon Rivers', 'Satellite Heart', 'Quiet Engines', 'After the Static'][i % 5], artistName: 'Nova Lane', artistId: 77, collectionId: 500, collectionName: 'Night Drive', artworkUrl100: art(i), trackTimeMillis: 200000 + i * 1000, previewUrl: 'https://audio.test/p' + i + '.wav', trackNumber: i + 1, discNumber: 1, releaseDate: '2024-01-01' });
  await p.route('https://itunes.apple.com/**', r => {
    const u = new URL(r.request().url()); const term = (u.searchParams.get('term') || '').toLowerCase();
    if (u.pathname === '/search') return J(r, { results: term.includes('zzz') ? [] : [0, 1, 2, 3, 4].map(it) });
    const id = u.searchParams.get('id');
    if (id.includes(',')) return J(r, { results: id.split(',').map(x => it(+x - 1000)) });
    if (u.searchParams.get('entity') === 'album') return J(r, { results: [{ wrapperType: 'artist', artistName: 'Nova Lane' }, { ...it(0), wrapperType: 'collection', trackCount: 5 }] });
    if (+id < 1000) return J(r, { results: [{ ...it(0), wrapperType: 'collection' }, ...[0, 1, 2, 3, 4].map(it)] });
    J(r, { results: [{ wrapperType: 'artist', artistName: 'Nova Lane' }, ...[0, 1, 2, 3, 4].map(it)] });
  });
  await p.route('https://rss.applemarketingtools.com/**', r => J(r, { feed: { results: [0, 1, 2].map(i => ({ id: String(1000 + i) })) } }));
  const lrc = [...Array(20)].map((_, i) => `[00:${String(i * 2).padStart(2, '0')}.00] Lyric line ${i}`).join('\n');
  await p.route('https://lrclib.net/**', r => J(r, { syncedLyrics: lrc, plainLyrics: 'x' }));
  await p.route('https://fonts.googleapis.com/**', r => r.abort());
  // These tests cover the app itself, so run with Strand accounts switched off.
  const cfgNoAccounts = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabase(Url|Key): '[^']*'/g, "supabase$1: ''");
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfgNoAccounts }));
  await p.route('https://sdk.scdn.co/**', r => r.fulfill({ contentType: 'text/javascript', body: MOCK_SP_SDK }));
  await p.route('https://www.youtube.com/iframe_api', r => r.fulfill({ contentType: 'text/javascript', body: MOCK_YT }));
  await p.route('https://w.soundcloud.com/player/api.js', r => r.fulfill({ contentType: 'text/javascript', body: MOCK_SC }));
  await p.route('https://w.soundcloud.com/player/?**', r => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await p.route('https://accounts.google.com/gsi/client', r => r.fulfill({ contentType: 'text/javascript', body: MOCK_GIS }));

  // Spotify Web API mock (Feb-2026 shapes: playlist.items.total, /items rows with `item`)
  const spCalls = [];
  let spSearchEmpty = false;
  const spt = i => ({ id: 't' + i, type: 'track', name: ['Glass Hours', 'Neon Rivers', 'Satellite Heart'][i % 3], uri: 'spotify:track:t' + i, duration_ms: 200000 + i * 1000, artists: [{ name: 'Nova Lane' }], album: { name: 'Night Drive', images: [{ url: art(i) }] }, external_ids: {} });
  await p.route('https://accounts.spotify.com/api/token', r => J(r, { access_token: 'sp_at', refresh_token: 'sp_rt', expires_in: 3600, scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read user-top-read user-read-recently-played user-follow-read' }));
  await p.route('https://api.spotify.com/**', r => {
    const u = new URL(r.request().url()); const P = u.pathname.replace('/v1', ''); spCalls.push(r.request().method() + ' ' + P + u.search);
    if (P === '/me') return J(r, { id: 'kati', display_name: 'Kati', images: [] });
    if (P === '/me/player/play') {
      // Like the real Spotify: the in-page player starts the song it was asked to play.
      const body = r.request().postData(); const uri = body && JSON.parse(body).uris?.[0];
      if (uri && !global.__spRefuse) setTimeout(() => p.evaluate(u => window.__sp && __sp._play(u, 200000), uri).catch(() => {}), 50);
      return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    }
    if (P === '/search') return J(r, { tracks: { items: spSearchEmpty ? [] : [spt(0), spt(1)] } });
    if (P === '/me/playlists') return J(r, { items: [{ id: 'own1', name: 'My Mix', images: [], items: { total: 3 }, owner: { id: 'kati', display_name: 'Kati' } }, { id: 'ed1', name: 'Today’s Top Hits', images: [], items: { total: 50 }, owner: { id: 'spotify', display_name: 'Spotify' } }], next: null });
    if (P === '/playlists/own1') return J(r, { name: 'My Mix', images: [], items: { total: 3 } });
    if (P === '/playlists/big1') return J(r, { name: 'Everything', images: [], items: { total: 3000 } });
    if (P === '/playlists/big1/items') {
      const off = +(u.searchParams.get('offset') || 0);
      const items = [...Array(Math.min(50, 3000 - off))].map((_, k) => ({ item: { ...spt(off + k), id: 'b' + (off + k), name: 'Big ' + (off + k), uri: 'spotify:track:b' + (off + k) } }));
      return J(r, { items, total: 3000, next: off + 50 < 3000 ? 'more' : null });
    }
    if (P === '/playlists/own1/items') return J(r, { items: [{ item: spt(0), track: true }, { item: spt(1), track: true }, { item: { id: 'ep', type: 'episode', name: 'Podcast' }, track: false }], next: null });
    if (P === '/playlists/ed1') return J(r, { name: 'Today’s Top Hits', images: [] });
    if (P === '/playlists/ed1/items') return J(r, { error: { status: 403, message: 'Forbidden' } }, 403);
    if (P === '/me/player/recently-played') return J(r, { items: [{ track: spt(2) }] });
    if (P === '/me/top/tracks') return J(r, { items: [spt(0)] });
    if (P === '/me/albums') return J(r, { items: [] });
    if (P === '/me/following') return J(r, { artists: { items: [] } });
    J(r, {}, 404);
  });
  // YouTube Data API mock
  let ytLikedQuery = null;
  await p.route('https://www.googleapis.com/**', r => {
    const u = new URL(r.request().url()); const P = u.pathname.split('/').pop();
    const v = i => ({ id: 'v' + i, snippet: { title: `Nova Lane - Song ${i} (Official Audio)`, channelTitle: 'Nova Lane - Topic', categoryId: i === 2 ? '22' : '10', thumbnails: { high: { url: art(i) } } }, contentDetails: { duration: 'PT3M2' + i + 'S' } });
    if (P === 'channels') return J(r, { items: [{ id: 'UC1', snippet: { title: 'Kati Music', thumbnails: { default: { url: art(1) } } } }] });
    if (P === 'playlists') return J(r, { items: [{ id: 'PLx', snippet: { title: 'Road trip', thumbnails: {} }, contentDetails: { itemCount: 3 } }] });
    if (P === 'playlistItems') return J(r, { items: [0, 1, 3].map(i => ({ contentDetails: { videoId: 'v' + i } })), pageInfo: { totalResults: 3 } });
    if (P === 'videos') { if (u.searchParams.get('myRating')) ytLikedQuery = u.search; return J(r, { items: (u.searchParams.get('id') || 'v0,v1,v2').split(',').map(x => v(+x.slice(1))) }); }
    if (P === 'search') return J(r, { items: [{ id: { videoId: 'v7' }, snippet: { title: 'Nova Lane - Glass Hours', channelTitle: 'Nova Lane - Topic', thumbnails: {} } }] });
    J(r, {});
  });

  const S = () => p.evaluate(() => ({ prov: strand.player.state.provider, title: strand.player.state.track?.title, idx: strand.player.state.index, playing: strand.player.state.playing, err: strand.player.state.error, score: strand.player.state.score, q: strand.player.state.queue.length }));
  const go = async (h, wait = 700) => { await p.evaluate(h => { location.hash = h; }, h); await sleep(wait); };

  // ---------- 1. No accounts: preview playback, lyrics, queue controls
  await p.goto(BASE); await sleep(1200);
  check('Home renders with charts', await p.locator('.grid .card').count() >= 3);
  await p.locator('.grid .card').first().click(); await sleep(1500);
  let s = await S();
  check('Catalog song plays as preview with no accounts', s.prov === 'preview' && s.playing, JSON.stringify(s));
  check('Bar shows title', (await p.textContent('#bar-title')) === s.title);
  await sleep(2600);
  check('Synced lyric line becomes active', await p.locator('#panel-body .line.active').count() === 1);
  await p.click('#btn-next'); await sleep(1200); s = await S();
  check('Next button advances', s.idx === 1 && s.prov === 'preview', JSON.stringify(s));
  await p.click('#btn-prev'); await sleep(1200); s = await S();
  check('Previous goes back', s.idx === 0);
  await p.click('#btn-play'); await sleep(400); s = await S();
  check('Play/pause toggles to paused', s.playing === false);
  await p.keyboard.press('Space'); await sleep(400); s = await S();
  check('Space key resumes', s.playing === true);
  await p.click('#btn-repeat'); await p.click('#btn-repeat');
  check('Repeat cycles to one', await p.evaluate(() => strand.player.state.repeat) === 'one');
  await p.click('#btn-repeat');
  await p.route('https://short.test/**', r => r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: SHORT }));
  await p.evaluate(() => strand.player.playQueue([0, 1, 2].map(i => ({ key: 'short' + i, title: 'Clip ' + i, artist: 'Nova Lane', previewUrl: 'https://short.test/' + i + '.wav', origin: 'catalog', ids: {} })), 0));
  await sleep(4800); s = await S();
  check('Song end auto-advances', s.idx === 1 && s.title === 'Clip 1', JSON.stringify(s));
  await go('#/album/500', 1000);
  await p.getByRole('button', { name: 'Play', exact: true }).click(); await sleep(1200);
  await p.click('#btn-shuffle');
  check('Shuffle toggles', await p.evaluate(() => strand.player.state.shuffle) === true);
  await p.click('#btn-shuffle');

  // queue panel
  await p.click('.tabs button[data-tab=queue]'); await sleep(200);
  check('Queue panel lists songs', await p.locator('.q-item').count() >= 3);
  await p.locator('.q-item').nth(2).click(); await sleep(1000);
  check('Clicking queue item plays it', (await S()).idx === 2);
  await p.click('.tabs button[data-tab=lyrics]');

  // like + library
  await p.click('#bar-like'); await sleep(200);
  check('Like from bar saves to library', await p.evaluate(() => strand.library.liked.length) === 1);
  await go('#/liked');
  check('Liked songs page lists it', await p.locator('.row').count() === 1);

  // playlist create / add / rename / delete
  await go('#/search/nova', 1500);
  check('Search shows top result + songs', await p.locator('.top-card').count() === 1 && await p.locator('.row').count() >= 5);
  await p.locator('.row').first().click({ button: 'right' }); await sleep(200);
  await p.getByRole('button', { name: 'Add to playlist…' }).click(); await sleep(200);
  await p.getByRole('button', { name: 'New playlist' }).click();
  await answer('Test list');
  const pls = await p.evaluate(() => strand.library.playlists.map(x => [x.name, x.tracks.length]));
  check('Create playlist from track menu', pls.length === 1 && pls[0][0] === 'Test list' && pls[0][1] === 1, JSON.stringify(pls));
  check('Sidebar shows new playlist', await p.locator('#side-playlists a', { hasText: 'Test list' }).count() === 1);
  await p.locator('#side-playlists a', { hasText: 'Test list' }).click(); await sleep(500);
  await p.getByRole('button', { name: 'Rename' }).click();
  await answer('Renamed');
  check('Rename playlist', await p.evaluate(() => strand.library.playlists[0].name) === 'Renamed');
  await p.getByRole('button', { name: 'Delete' }).click();
  await answer();
  check('Delete playlist', await p.evaluate(() => strand.library.playlists.length) === 0 && p.url().endsWith('#/library'));

  // Very long playlist: virtualized, smooth, still fully playable
  await p.evaluate(() => import('/js/store.js').then(m => {
    const tracks = [...Array(5000)].map((_, i) => ({ key: 'big:' + i, title: 'Song ' + i, artist: 'Artist ' + (i % 50), album: 'Album', artwork: '', durationMs: 180000, previewUrl: 'https://audio.test/p' + (i % 5) + '.wav', origin: 'catalog', ids: {} }));
    m.library.playlists.unshift({ id: 'huge', name: 'Huge list', tracks, created: 1 }); m.saveLibrary();
  }));
  const t0 = Date.now();
  await go('#/playlist/huge', 0);
  await p.locator('.tracks.virtual .row').first().waitFor();
  const openMs = Date.now() - t0;
  const domRows = await p.locator('.tracks.virtual .row').count();
  check('5,000-song playlist opens fast', openMs < 2500, openMs + 'ms');
  check('Only on-screen rows are drawn (not 5,000)', domRows > 5 && domRows < 120, domRows + ' rows');
  const scrollMs = await p.evaluate(async () => {
    const m = document.querySelector('.main'); const t = performance.now();
    for (let y = 0; y < m.scrollHeight; y += 2500) { m.scrollTop = y; await new Promise(r => requestAnimationFrame(r)); }
    m.scrollTop = m.scrollHeight; await new Promise(r => requestAnimationFrame(r)); await new Promise(r => requestAnimationFrame(r));
    return performance.now() - t;
  });
  check('Scrolling through all of it stays smooth', scrollMs < 3000, Math.round(scrollMs) + 'ms');
  check('Last song is reachable at the bottom', await p.locator('.row', { hasText: 'Song 4999' }).isVisible());
  await p.locator('.row', { hasText: 'Song 4999' }).hover();
  await p.locator('.row', { hasText: 'Song 4999' }).locator('.num button').click(); await sleep(1200);
  s = await S();
  check('Playing from the bottom of a huge list works', s.idx === 4999 && s.title === 'Song 4999' && s.q === 5000, JSON.stringify(s));
  check('Row count stays small after scrolling', await p.locator('.tracks.virtual .row').count() < 120);
  await p.evaluate(() => import('/js/store.js').then(m => { m.library.playlists = m.library.playlists.filter(x => x.id !== 'huge'); m.saveLibrary(); }));

  // artist + album pages
  await go('#/artist/77', 1000);
  check('Artist page', await p.locator('h1', { hasText: 'Nova Lane' }).count() === 1 && await p.locator('.row').count() >= 1);
  await go('#/album/500', 1000);
  check('Album page', await p.locator('.row').count() === 5);

  // no results
  await go('#/search/zzz', 1500);
  check('Empty search message', await p.locator('text=No results').count() === 1);

  // share link
  const share = await p.evaluate(() => { const t = strand.player.state.track; return location.origin + '/#/t/' + btoa(unescape(encodeURIComponent(JSON.stringify({ t: t.title, a: t.artist, i: t.ids, ar: t.artwork })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); });
  await p.goto(share); await sleep(800);
  check('Share page shows song + 4 open-in links', await p.locator('.open-in a').count() === 4 && await p.locator('.share-page h1').count() === 1);

  // stage
  await p.keyboard.press('l'); await sleep(500);
  check('L opens full-screen lyrics', await p.isVisible('#stage'));
  await p.keyboard.press('Escape'); await sleep(200);
  check('Esc closes it', !(await p.isVisible('#stage')));

  // ---------- 2. SoundCloud link (no key) via search paste
  await go('#/search/' + encodeURIComponent('https://soundcloud.com/djkati/sets/mix'), 600);
  check('Pasted link detected', await p.locator('.import-box .svc-tag', { hasText: 'SoundCloud' }).count() === 1);
  await p.getByRole('button', { name: 'Open / import' }).click(); await sleep(2500);
  const scPl = await p.evaluate(() => strand.library.playlists[0]);
  check('SoundCloud set imports', scPl && scPl.tracks.length === 3 && scPl.source === 'soundcloud', JSON.stringify(scPl && scPl.tracks.length));
  await p.getByRole('button', { name: 'Play', exact: true }).click(); await sleep(1500); s = await S();
  check('SoundCloud track plays through widget', s.prov === 'soundcloud' && await p.evaluate(() => document.getElementById('np-media').classList.contains('sc')), JSON.stringify(s));
  check('SoundCloud set songs remember their list', await p.evaluate(() => strand.library.playlists[0].tracks[1].ids.scIndex === 1 && !!strand.library.playlists[0].tracks[1].ids.scList));
  await p.evaluate(() => window.__scw._finishAndAdvance()); await sleep(1200); s = await S();
  check('SoundCloud: next song of the set plays on its own and Strand follows', s.prov === 'soundcloud' && s.idx === 1 && s.title === 'Upload 1' && await p.evaluate(() => window.__scw.loads === 0), JSON.stringify(s));
  await p.evaluate(() => window.__scw._finish()); await sleep(3200); s = await S();
  check('SoundCloud: if the widget doesn’t carry on, Strand moves to the next song', s.idx === 2 && s.prov === 'soundcloud', JSON.stringify(s));

  // ---------- 3. Accounts: connect Spotify via real redirect flow (token endpoint mocked)
  await p.evaluate(() => { const st = JSON.parse(localStorage.getItem('strand:settings')) || {}; st.spotifyClientId = 'cid'; st.googleClientId = 'gid'; localStorage.setItem('strand:settings', JSON.stringify(st)); });
  await p.goto(BASE + '#/me'); await p.reload(); await sleep(1000);
  check('Your music shows 4 account tiles', await p.locator('.acct').count() === 4);
  // Spotify connect: intercept the authorize redirect and bounce back with a code
  await p.route('https://accounts.spotify.com/authorize?**', r => {
    const u = new URL(r.request().url());
    r.fulfill({ status: 302, headers: { location: `${u.searchParams.get('redirect_uri')}?code=abc&state=${u.searchParams.get('state')}` } });
  });
  await p.locator('.acct', { hasText: 'Spotify' }).getByRole('button', { name: 'Connect' }).click();
  await sleep(2000);
  check('Spotify login completes and returns to Your music', p.url().endsWith('#/me') && await p.locator('.acct.linked', { hasText: 'Spotify' }).count() === 1, p.url());
  check('Spotify tile shows profile name', await p.locator('.acct.linked', { hasText: 'Kati' }).count() >= 1);
  await go('#/me/spotify', 1500);
  check('Spotify page: own playlist shows count', await p.locator('.card', { hasText: 'My Mix' }).locator('text=3 songs').count() === 1);
  check('Spotify page: followed playlist labelled', await p.locator('.card', { hasText: 'Today’s Top Hits' }).locator('text=Followed').count() === 1);
  check('Spotify page: recently played + top tracks', await p.locator('.me-sec', { hasText: 'Recently played' }).locator('.row').count() === 1);
  await go('#/library', 1500);
  check('Library shows the Spotify playlists', await p.locator('.me-sec', { hasText: 'From Spotify' }).locator('.card', { hasText: 'My Mix' }).count() === 1);
  check('Sidebar lists Spotify playlists under a Spotify heading', await p.locator('#side-playlists .side-sub', { hasText: 'Spotify' }).count() === 1 && await p.locator('#side-playlists a', { hasText: 'My Mix' }).count() === 1);
  await go('#/me/spotify', 1500);
  await p.locator('.card', { hasText: 'My Mix' }).click(); await sleep(1200);
  check('Own playlist opens via /items (episodes skipped)', await p.locator('.row').count() === 2 && spCalls.some(c => c.includes('/playlists/own1/items')), spCalls.filter(c => c.includes('playlists')).join(' | '));
  const before = spCalls.length;
  await go('#/remote/spotify/playlist/big1', 0);
  await p.locator('h1', { hasText: 'Everything' }).waitFor({ timeout: 20000 });
  const bigCalls = spCalls.slice(before).filter(c => c.includes('/playlists/big1/items'));
  check('3,000-song Spotify playlist loads every song', await p.locator('.sub', { hasText: '3000 songs' }).count() === 1, await p.locator('.hero .sub').first().textContent().catch(() => '?'));
  check('…using 60 page requests', bigCalls.length === 60, bigCalls.length + ' calls');
  check('…kept in the right order', await p.evaluate(() => [...document.querySelectorAll('.row .title')].slice(0, 3).map(e => e.textContent).join(',')) === 'Big 0,Big 1,Big 2');
  check('No calls to removed /tracks endpoint', !spCalls.some(c => /\/playlists\/[^/]+\/tracks/.test(c)));
  await go('#/remote/spotify/playlist/own1', 1200);
  await p.getByRole('button', { name: 'Play', exact: true }).click(); await sleep(1500);
  await p.evaluate(() => window.__sp && __sp._play('spotify:track:t0', 200000)); await sleep(400); s = await S();
  check('Spotify-origin song plays on Spotify', s.prov === 'spotify' && s.playing, JSON.stringify(s));
  check('Play request sent to Strand device', spCalls.some(c => c.startsWith('PUT /me/player/play?device_id=dev1')));
  // ended detection
  await p.evaluate(() => { __sp.state = { paused: false, position: 198500, duration: 200000 }; __sp.push(); }); await sleep(500);
  await p.evaluate(() => { __sp.state = { paused: true, position: 0, duration: 200000 }; __sp.push(); }); await sleep(1500); s = await S();
  check('Spotify song end advances queue', s.idx === 1, JSON.stringify(s));
  await go('#/remote/spotify/playlist/ed1', 1200);
  check('Followed playlist explains Spotify rule + Open in Spotify', await p.locator('text=Spotify only lets apps read songs').count() === 1 && await p.locator('a', { hasText: 'Open in Spotify' }).count() === 1);
  // catalog song with Spotify connected → resolved via search, with match score
  await go('#/search/glass', 1500);
  await p.locator('.top-card').getByRole('button', { name: 'Play' }).click(); await sleep(1500);
  await p.evaluate(() => __sp._play('spotify:track:t0', 200000)); await sleep(300); s = await S();
  check('Catalog song matched on Spotify with score', s.prov === 'spotify' && s.score > 0.6, JSON.stringify(s));
  check('Search requests stay within new 10-result limit', !spCalls.filter(c => c.includes('/search')).some(c => +(new URLSearchParams(c.split('?')[1]).get('limit')) > 10));
  // fallback when Spotify has no match
  spSearchEmpty = true;
  await p.evaluate(() => strand.player.playQueue([{ key: 'it:1003', title: 'Quiet Engines', artist: 'Nova Lane', durationMs: 203000, previewUrl: 'https://audio.test/p3.wav', origin: 'catalog', ids: { itunes: '1003' } }], 0)); await sleep(2000); s = await S();
  check('Falls back to preview when not on Spotify', s.prov === 'preview' && s.playing, JSON.stringify(s));
  spSearchEmpty = false;
  // Spotify refuses to play inside Strand on this computer (e.g. copy protection not accepted)
  global.__spRefuse = true;
  const putsBefore = spCalls.filter(c => c.startsWith('PUT /me/player/play?device_id=dev1')).length;
  await p.evaluate(() => strand.player.playQueue([{ key: 'it:1004', title: 'Glass Hours', artist: 'Nova Lane', durationMs: 200000, previewUrl: 'https://audio.test/p.wav', origin: 'catalog', ids: {} }, { key: 'it:1005', title: 'Glass Hours', artist: 'Nova Lane', durationMs: 200000, previewUrl: 'https://audio.test/p.wav', origin: 'catalog', ids: {} }], 0));
  await sleep(400); await p.evaluate(() => window.__sp.emit('playback_error', { message: 'Failed to initialize player (license)' })); await sleep(1500); s = await S();
  check('If Spotify refuses to play inside Strand, the next source takes over right away', s.prov && s.prov !== 'spotify' && s.playing, JSON.stringify(s));
  await p.evaluate(() => strand.player.next()); await sleep(1500); s = await S();
  check('…and Strand doesn’t keep retrying Spotify for every song', s.prov && s.prov !== 'spotify' && spCalls.filter(c => c.startsWith('PUT /me/player/play?device_id=dev1')).length === putsBefore + 1, JSON.stringify(s));
  global.__spRefuse = false;

  // ---------- 4. Google / YouTube sign-in
  await go('#/me', 800);
  await p.locator('.acct', { hasText: 'YouTube Music' }).getByRole('button', { name: 'Connect' }).click(); await sleep(1500);
  check('Google sign-in links YouTube', await p.locator('.acct.linked', { hasText: 'Kati Music' }).count() === 1);
  check('GIS config uses valid options only', await p.evaluate(() => !('hint' in window.__gisCfg) && window.__gisCfg.scope.includes('youtube.readonly')));
  await go('#/me/youtube', 1500);
  check('YouTube playlists + liked load', await p.locator('.card', { hasText: 'Road trip' }).count() === 1 && await p.locator('.me-sec', { hasText: 'Liked music' }).locator('.row').count() === 2);
  check('Liked request has no invalid videoCategoryId filter', ytLikedQuery && !ytLikedQuery.includes('videoCategoryId'), ytLikedQuery);
  await p.locator('.card', { hasText: 'Road trip' }).click(); await sleep(1500);
  check('YouTube playlist opens', await p.locator('.row').count() === 3);
  await go('#/library', 1500);
  check('Library shows Spotify and YouTube playlists together', await p.locator('.me-sec', { hasText: 'From YouTube Music' }).locator('.card', { hasText: 'Road trip' }).count() === 1 && await p.locator('.me-sec', { hasText: 'From Spotify' }).count() === 1);
  await p.locator('#side-playlists a', { hasText: 'Road trip' }).click(); await sleep(1500);
  check('Clicking a service playlist in the sidebar opens it', await p.locator('h1', { hasText: 'Road trip' }).count() === 1);
  await p.getByRole('button', { name: 'Play', exact: true }).click(); await sleep(1500); s = await S();
  check('YouTube song plays in visible player', s.prov === 'youtube' && await p.evaluate(() => getComputedStyle(document.getElementById('media-yt')).display) === 'block', JSON.stringify(s));
  await p.evaluate(() => __yt._end()); await sleep(800); s = await S();
  check('YouTube song end advances', s.idx === 1);
  await p.getByRole('button', { name: 'Save to library' }).click(); await sleep(500);
  check('Save remote playlist to library', await p.evaluate(() => strand.library.playlists.some(x => x.name === 'Road trip' && x.source === 'youtube')));

  // ---------- 5. SoundCloud profile link
  await go('#/me', 800);
  await p.locator('.acct', { hasText: 'SoundCloud' }).getByRole('button', { name: 'Connect' }).click();
  await answer('https://soundcloud.com/djkati/sets/whatever'); await sleep(500);
  check('SoundCloud profile linked (normalized)', await p.evaluate(() => strand.settings.scProfile) === 'https://soundcloud.com/djkati');
  await go('#/me/soundcloud', 3500);
  await p.locator('.me-sec', { hasText: 'Your uploads' }).locator('.row').first().waitFor({ timeout: 10000 }).catch(() => {});
  await p.locator('.me-sec', { hasText: 'Likes' }).locator('.row').first().waitFor({ timeout: 10000 }).catch(() => {});
  check('SoundCloud likes + uploads load', await p.locator('.me-sec', { hasText: 'Likes' }).locator('.row').count() === 3 && await p.locator('.me-sec', { hasText: 'Your uploads' }).locator('.row').count() === 3);

  // Add a public SoundCloud playlist by link
  check('SoundCloud page has an Add playlist card', await p.locator('.add-card', { hasText: 'Add playlist' }).count() === 1);
  await p.locator('.add-card').click();
  await answer('https://soundcloud.com/djkati/tracks'); await sleep(400);
  check('Non-playlist link is rejected with a clear message', (await p.textContent('#toast')).includes('isn’t a SoundCloud playlist link'));
  await p.locator('.add-card').click();
  await answer('https://soundcloud.com/djkati/sets/late-night-drive?si=abc&utm_source=clipboard'); await sleep(2500);
  check('Playlist added with a name from its link', await p.locator('.card', { hasText: 'Late Night Drive' }).count() === 1, await p.evaluate(() => JSON.stringify(strand.settings.scPlaylists)));
  check('Saved link is cleaned (no tracking parameters)', await p.evaluate(() => strand.settings.scPlaylists[0].url) === 'https://soundcloud.com/djkati/sets/late-night-drive');
  await p.locator('.add-card').click();
  await answer('https://soundcloud.com/djkati/sets/late-night-drive'); await sleep(600);
  check('Adding the same playlist twice is refused', (await p.textContent('#toast')).includes('already on your SoundCloud page') && await p.evaluate(() => strand.settings.scPlaylists.length) === 1);
  await p.locator('.card', { hasText: 'Late Night Drive' }).click(); await sleep(1500);
  check('Added playlist opens with its tracks', await p.locator('h1', { hasText: 'Late Night Drive' }).count() === 1 && await p.locator('.row').count() === 3);
  await p.getByRole('button', { name: 'Remove' }).click();
  await answer(); await sleep(800);
  check('Remove takes it off the SoundCloud page', p.url().endsWith('#/me/soundcloud') && await p.evaluate(() => strand.settings.scPlaylists.length) === 0);

  // ---------- 6. Disconnect + settings
  await go('#/settings', 800);
  check('Settings shows linked accounts + developer keys', await p.locator('.acct.linked').count() === 3 && await p.locator('details.dev-block').count() === 4);
  await p.locator('.acct', { hasText: 'Spotify' }).getByRole('button', { name: 'Disconnect' }).click();
  await answer(); await sleep(400);
  check('Disconnect Spotify', await p.evaluate(() => !localStorage.getItem('strand:spotify')) && await p.locator('.acct.linked').count() === 2);

  // ---------- 7. Mobile: tap a row to play
  const m = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mp = await m.newPage();
  await mp.route('**/*', r => {
    const url = r.request().url();
    if (url.startsWith(BASE)) return r.continue();
    if (url.includes('itunes.apple.com')) return r.fulfill({ json: { results: [0, 1, 2].map(it) }, headers: { 'Access-Control-Allow-Origin': '*' } });
    if (url.includes('audio.test')) return r.fulfill({ contentType: 'audio/wav', headers: { 'Access-Control-Allow-Origin': '*' }, body: TONE });
    if (url.includes('lrclib')) return r.fulfill({ json: {}, headers: { 'Access-Control-Allow-Origin': '*' } });
    return r.fulfill({ status: 404, body: '' });
  });
  await mp.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfgNoAccounts }));
  await mp.goto(BASE + '#/album/500'); await sleep(1200);
  await mp.locator('.row').nth(1).tap(); await sleep(1500);
  const ms = await mp.evaluate(() => ({ idx: strand.player.state.index, prov: strand.player.state.provider }));
  check('Mobile: single tap on a song plays it', ms.idx === 1 && ms.prov === 'preview', JSON.stringify(ms));
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  check('Mobile: no horizontal overflow', !overflow);
  await mp.close();

  check('No JavaScript errors during the whole run', errs.length === 0, errs.join(' || '));
  for (const r of results) console.log(r[0], '-', r[1], r[2] && r[0] === 'FAIL' ? '→ ' + r[2] : '');
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0]==='FAIL' ? '→ ' + r[2] : ''); console.error('CRASH', e.message.split('\n')[0]); process.exit(1); });
