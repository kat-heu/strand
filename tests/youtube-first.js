// With a YouTube key: Spotify songs play inside Strand through YouTube first, and the
// song → video match is shared, so the next device doesn't search YouTube again.
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs');
const results = []; const check = (n, ok, info = '') => results.push([ok ? 'PASS' : 'FAIL', n, info]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK_YT = `window.YT = { PlayerState:{ENDED:0,PLAYING:1,PAUSED:2}, Player: class {
  constructor(el,o){ this.o=o; this.vid=o.videoId; this.t0=performance.now(); this.st=1; const d=document.createElement('div'); el.replaceWith(d); window.__yt=this; setTimeout(()=>o.events.onReady({target:this}),20); }
  loadVideoById(id){ this.vid=id; } playVideo(){ this.st=1; } pauseVideo(){ this.st=2; } stopVideo(){ this.st=5; } seekTo(){} getCurrentTime(){ return (performance.now()-this.t0)/1000; } getDuration(){ return 200; } getPlayerState(){ return this.st; } setVolume(){} }};
setTimeout(()=>window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(),10);`;
const SB = 'https://sb.test';
(async () => {
  const { start } = require(path.join(__dirname, '..', 'server.js')); await start(5172);
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const cfg = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8').replace(/supabaseUrl: '[^']*'/, `supabaseUrl: '${SB}'`).replace(/supabaseKey: '[^']*'/, "supabaseKey: 'pk'").replace(/youtubeKey: '[^']*'/, "youtubeKey: 'test-key'");
  const J = (r, d, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(d) });
  const matches = new Map(); let searches = 0;
  const session = { access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600e3, user: { id: 'u1', email: 'k@example.com', user_metadata: { name: 'Kat' } } };
  const setup = async ctx => {
    await ctx.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: cfg }));
    await ctx.route('https://www.youtube.com/iframe_api', r => r.fulfill({ contentType: 'text/javascript', body: MOCK_YT }));
    await ctx.route('https://www.googleapis.com/youtube/v3/search**', r => { searches++; J(r, { items: [{ id: { videoId: 'vid12345678' }, snippet: { title: 'Nova Lane - Glass Hours (Official Audio)', channelTitle: 'Nova Lane - Topic', thumbnails: {} } }] }); });
    await ctx.route(/itunes\.apple|rss\.apple|lrclib/, r => J(r, { results: [], feed: { results: [] } }));
    await ctx.route(/fonts\.g|deezer|sdk\.scdn/, r => r.abort());
    await ctx.route(SB + '/**', r => {
      const req = r.request(), u = new URL(req.url()), m = req.method();
      if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
      if (u.pathname === '/rest/v1/song_matches') {
        if (m === 'GET') { const k = (u.searchParams.get('key') || '').replace(/^eq\./, ''); return J(r, matches.has(k) ? [matches.get(k)] : []); }
        const row = JSON.parse(req.postData()); if (!matches.has(row.key)) matches.set(row.key, row); return J(r, [], 201);
      }
      if (u.pathname === '/rest/v1/user_data') return J(r, []);
      return J(r, {});
    });
    await ctx.addInitScript(s => { if (!localStorage.getItem('strand:session')) localStorage.setItem('strand:session', JSON.stringify(s)); }, session);
  };
  const song = { key: 'sp:abc', title: 'Glass Hours', artist: 'Nova Lane', durationMs: 200000, origin: 'spotify', ids: { spotify: 'spotify:track:abc' } };
  const A = await b.newContext(); await setup(A);
  const p = await A.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:5172/'); await sleep(1500);
  await p.evaluate(t => strand.player.playQueue([t], 0), song); await sleep(2500);
  let s = await p.evaluate(() => ({ prov: strand.player.state.provider, order: strand.player.sourceOrder(strand.player.state.track) }));
  check('Spotify song plays inside Strand through YouTube first', s.prov === 'youtube' && s.order[0] === 'youtube', JSON.stringify(s));
  check('The match is shared for everyone', matches.size === 1 && [...matches.values()][0].video_id === 'vid12345678', JSON.stringify([...matches.values()]));
  const B = await b.newContext(); await setup(B);
  const q = await B.newPage(); q.on('pageerror', e => errs.push(e.message));
  await q.goto('http://127.0.0.1:5172/'); await sleep(1500);
  await q.evaluate(t => strand.player.playQueue([t], 0), song); await sleep(2500);
  s = await q.evaluate(() => ({ prov: strand.player.state.provider }));
  check('Another device plays it without searching YouTube again', s.prov === 'youtube' && searches === 1, JSON.stringify({ ...s, searches }));
  check('No JavaScript errors', !errs.length, errs.join(' | '));
  const failed = results.filter(r => r[0] === 'FAIL').length;
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : '');
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await b.close(); process.exit(failed ? 1 : 0);
})().catch(e => { for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '→ ' + r[2] : ''); console.error('CRASH [youtube-first]', e.message.slice(0, 800)); process.exit(1); });
