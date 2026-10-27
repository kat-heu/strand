// YouTube / YouTube Music via the official IFrame Player API.
// The player must stay visible (YouTube API terms); it lives in the Now Playing panel.
// Ads are shown by YouTube as usual — we don't (and can't legitimately) strip them.
import { settings, cacheGet, cacheSet } from '../store.js';
import { decodeEntities, coverage } from '../util.js';
import { ytFetch, googleActive } from './google.js';

let apiReady;
function loadApi() {
  return apiReady ??= new Promise((res, rej) => {
    if (window.YT?.Player) return res(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiReady = null; rej(new Error('YouTube API failed to load')); };
    document.head.append(s);
  });
}

// Search costs 100 quota units per call (default quota: 10,000/day) — results are cached.
export async function ytSearch(q, max = 5) {
  const d = await ytFetch('search', { part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: max, q });
  return d.items.filter(i => i.id?.videoId).map(i => ({
    videoId: i.id.videoId,
    title: decodeEntities(i.snippet.title),
    channel: decodeEntities(i.snippet.channelTitle),
    thumb: i.snippet.thumbnails?.high?.url || i.snippet.thumbnails?.default?.url,
  }));
}

function isoDur(s = '') {
  const m = s.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 : 0;
}
// videos.list items → tracks
export function ytVideosToTracks(items) {
  return items.filter(v => v.snippet).map(v => ytToTrack({
    videoId: v.id, title: decodeEntities(v.snippet.title), channel: decodeEntities(v.snippet.videoOwnerChannelTitle || v.snippet.channelTitle || ''),
    thumb: v.snippet.thumbnails?.high?.url || v.snippet.thumbnails?.medium?.url, durationMs: isoDur(v.contentDetails?.duration),
  }));
}

export function ytToTrack(v) {
  // "Artist - Title (Official Video)" is the common pattern; "Artist - Topic" channels are auto-generated.
  let artist = v.channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
  let title = v.title;
  const m = v.title.match(/^(.+?)\s[-–—]\s(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  title = title.replace(/\s*[([](official|lyric|music|audio|video|visuali[sz]er|hd|4k)[^)\]]*[)\]]/gi, '').trim();
  return {
    key: 'yt:' + v.videoId,
    title, artist, album: '',
    artwork: v.thumb || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
    durationMs: v.durationMs || 0,
    origin: 'youtube',
    ids: { youtube: v.videoId },
  };
}

export function createYouTube(ctx) {
  let player = null, playerReady = null, loadToken = 0;
  const host = () => document.getElementById('media-yt');

  async function ensure(videoId) {
    if (playerReady) return playerReady;
    const YT = await loadApi();
    const mount = document.createElement('div');
    host().replaceChildren(mount);
    playerReady = new Promise((res, rej) => {
      player = new YT.Player(mount, {
        width: '100%', height: '100%', videoId,
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => res(player),
          onStateChange: e => { if (e.data === YT.PlayerState.ENDED) ctx.onEnded(); },
          onError: e => ctx.onError(new Error('YouTube error ' + e.data + (e.data === 150 || e.data === 101 ? ' (embedding disabled for this video)' : ''))),
        },
      });
      setTimeout(() => rej(new Error('YouTube player timed out')), 15000);
    });
    playerReady.catch(() => { playerReady = null; });
    return playerReady;
  }

  async function resolve(t) {
    if (t.ids?.youtube) return { id: t.ids.youtube, score: null };
    const cached = cacheGet('yt', t.key);
    if (cached) return cached;
    const want = { title: t.title, artist: t.artist };
    const res = await ytSearch(`${t.artist} ${t.title} audio`, 5);
    let best = null, score = 0;
    for (const v of res) {
      const sc = 0.6 * coverage(want.title, v.title) +
                 0.4 * Math.max(coverage(want.artist, v.channel), coverage(want.artist, v.title)) +
                 (/topic$/i.test(v.channel) ? 0.05 : 0);
      if (sc > score) { score = sc; best = v; }
    }
    if (!best || score < 0.5) throw new Error('no good YouTube match');
    const out = { id: best.videoId, score: Math.min(1, score) };
    cacheSet('yt', t.key, out);
    return out;
  }

  return {
    name: 'youtube',
    label: 'YouTube Music',
    host,
    available: () => true,
    canPlay: t => !!(t.ids?.youtube || settings.youtubeKey || googleActive()),
    async load(t) {
      const my = ++loadToken;
      const { id, score } = await resolve(t);
      const fresh = !playerReady;
      await ensure(id);
      if (my !== loadToken) return { score };
      if (!fresh) player.loadVideoById(id);
      else player.playVideo();
      return { score };
    },
    play: () => player?.playVideo(),
    pause: () => player?.pauseVideo(),
    seek: ms => player?.seekTo(ms / 1000, true),
    setVolume: v => player?.setVolume?.(Math.round(v * 100)),
    position: () => (player?.getCurrentTime?.() || 0) * 1000,
    duration: () => (player?.getDuration?.() || 0) * 1000,
    isPlaying: () => player?.getPlayerState?.() === 1,
    stop: () => { loadToken++; try { player?.stopVideo(); } catch {} },
  };
}
