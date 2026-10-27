import { h, fmt, debounce, b64urlEncode, b64urlDecode } from './util.js';
import { I, SERVICES } from './icons.js';
import { settings, setSetting, fromConfig, library, saveLibrary, isLiked, toggleLike, on, emit, clearCaches } from './store.js';
import * as catalog from './catalog.js';
import * as P from './player.js';
import { fetchLyrics, activeIndex } from './lyrics.js';
import { startVisualizer } from './visualizer.js';
import { parseLink, importLink } from './importer.js';
import {
  spotifyLogin, spotifyLogout, spotifyConnected, handleSpotifyCallback, redirectUri,
  spotifyPlaylists, spApi, playlistTotal,
} from './providers/spotify.js';
import { appleConfigured, appleAuthorized, appleAuthorize, appleUnauthorize, appleInit } from './providers/apple.js';
import { ytSearch, ytToTrack } from './providers/youtube.js';
import { googleActive } from './providers/google.js';
import { ACCOUNTS, ORDER, anyLinked, remoteCollection, clearRemoteCache } from './accounts.js';

// Spotify only allows http://127.0.0.1 loopback redirects — normalise "localhost".
if (location.hostname === 'localhost') {
  location.replace(location.href.replace('//localhost', '//127.0.0.1'));
}

const $ = id => document.getElementById(id);
const main = $('main');

// ---------------------------------------------------------------- toast/menu
let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3800);
}
on('toast', toast);

const menu = $('menu');
function showMenu(anchor, items) {
  menu.replaceChildren(...items.map(it => {
    if (it === '-') return h('hr');
    if (it.group) return h('div', { class: 'sub' }, it.group.map(g => h('button', { onClick: () => { hideMenu(); g.onClick(); } }, g.label)));
    return h('button', { onClick: () => { hideMenu(); it.onClick(); } }, h('span', { html: it.icon || '' }), it.label);
  }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y, right: anchor.x };
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(r.right - mw, innerWidth - mw - 8); x = Math.max(8, x);
  let y = r.bottom + 6; if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
}
function hideMenu() { menu.hidden = true; }
document.addEventListener('pointerdown', e => { if (!menu.hidden && !menu.contains(e.target)) hideMenu(); });

// ---------------------------------------------------------------- helpers
const img = (src, cls = '', alt = '') => src ? h('img', { src, class: cls, alt, loading: 'lazy' }) : h('div', { class: 'ph ' + cls, html: I.disc });
const svcDot = name => h('span', { class: 'svc', style: { background: SERVICES[name]?.color || 'var(--dim)' }, title: SERVICES[name]?.label });

function shareUrl(t) {
  const payload = { t: t.title, a: t.artist, al: t.album, ar: t.artwork, d: t.durationMs, o: t.origin, i: t.ids };
  const base = (settings.shareBase || (location.origin + location.pathname.replace(/[^/]*$/, ''))).replace(/#.*$/, '');
  return base + '#/t/' + b64urlEncode(JSON.stringify(payload));
}
async function copy(text, msg = 'Link copied') {
  try { await navigator.clipboard.writeText(text); toast(msg); }
  catch { prompt('Copy this link', text); }
}

function trackMenu(anchor, t) {
  const items = [
    { label: 'Play next', icon: I.queue, onClick: () => { P.playNext(t); toast('Playing next'); } },
    { label: 'Add to queue', icon: I.plus, onClick: () => { P.addToQueue(t); toast('Added to queue'); } },
    { label: isLiked(t) ? 'Remove from Liked' : 'Add to Liked', icon: I.heart, onClick: () => toggleLike(t) },
    '-',
    { label: 'Add to playlist…', icon: I.library, onClick: () => playlistPicker(anchor, t) },
    { label: 'Share smart link', icon: I.share, onClick: () => copy(shareUrl(t)) },
  ];
  if (t.artistId) items.push({ label: 'Go to artist', icon: I.search, onClick: () => go(`#/artist/${t.artistId}`) });
  else items.push({ label: 'Find artist', icon: I.search, onClick: () => go(`#/search/${encodeURIComponent(t.artist)}`) });
  if (t.albumId) items.push({ label: 'Go to album', icon: I.disc.replace(/40/g, '18'), onClick: () => go(`#/album/${t.albumId}`) });
  showMenu(anchor, items);
}
function playlistPicker(anchor, t) {
  const add = pl => {
    if (pl.tracks.some(x => x.key === t.key)) return toast('Already in ' + pl.name);
    pl.tracks.push(t); saveLibrary(); toast('Added to ' + pl.name);
  };
  showMenu(anchor, [
    { label: 'New playlist', icon: I.plus, onClick: () => {
      const name = prompt('Playlist name', 'My playlist'); if (!name) return;
      const pl = newPlaylist(name, []); add(pl);
    } },
    ...(library.playlists.length ? ['-', { group: library.playlists.map(pl => ({ label: pl.name, onClick: () => add(pl) })) }] : []),
  ]);
}
function newPlaylist(name, tracks, extra = {}) {
  const pl = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, tracks, created: Date.now(), ...extra };
  library.playlists.unshift(pl); saveLibrary();
  return pl;
}

const touch = matchMedia('(hover: none)');
function trackRows(list, { compact = false, showArt = true, numbers = false } = {}) {
  const wrap = h('div', { class: 'tracks' + (compact ? ' compact' : '') });
  list.forEach((t, i) => {
    const like = h('button', { class: 'icon-btn' + (isLiked(t) ? ' on' : ''), title: 'Like', html: isLiked(t) ? I.heartFill : I.heart, onClick: e => { e.stopPropagation(); toggleLike(t); like.className = 'icon-btn' + (isLiked(t) ? ' on' : ''); like.innerHTML = isLiked(t) ? I.heartFill : I.heart; } });
    const more = h('button', { class: 'icon-btn', title: 'More', html: I.more, onClick: e => { e.stopPropagation(); trackMenu(more, t); } });
    const titleEl = h('div', { class: 'title' }, t.explicit ? h('span', { class: 'badge-e' }, 'E') : null, t.title);
    const artistEl = h('div', { class: 'artist' }, t.origin && t.origin !== 'catalog' ? svcDot(t.origin) : null,
      // On touch screens a tap snaps to nearby links, so rows keep artist names as text
      // there (the ⋯ menu still has "Go to artist").
      t.artistId && !touch.matches ? h('a', { href: `#/artist/${t.artistId}`, onClick: e => e.stopPropagation() }, t.artist) : t.artist);
    const row = compact
      ? h('div', { class: 'row', 'data-key': t.key }, img(t.artwork), h('div', { style: { minWidth: 0 } }, titleEl, artistEl), h('div', { class: 'dur' }, fmt(t.durationMs)), more)
      : h('div', { class: 'row', 'data-key': t.key },
          h('div', { class: 'num' }, h('span', {}, numbers ? (t.trackNumber || i + 1) : i + 1), h('button', { html: I.play, title: 'Play', onClick: e => { e.stopPropagation(); P.playQueue(list, i); } })),
          showArt ? img(t.artwork) : h('span'),
          h('div', { style: { minWidth: 0 } }, titleEl, artistEl),
          h('div', { class: 'album' }, t.albumId && !touch.matches ? h('a', { href: `#/album/${t.albumId}`, onClick: e => e.stopPropagation() }, t.album) : t.album),
          h('div', { class: 'dur' }, t.durationMs ? fmt(t.durationMs) : ''),
          h('div', { class: 'acts' }, like, more));
    row.addEventListener('dblclick', () => P.playQueue(list, i));
    // Touch screens have no hover/double-click: a single tap plays.
    if (compact || touch.matches) row.addEventListener('click', () => P.playQueue(list, i));
    row.addEventListener('contextmenu', e => { e.preventDefault(); trackMenu({ x: e.clientX, y: e.clientY }, t); });
    wrap.append(row);
  });
  markPlaying(wrap);
  return wrap;
}
function markPlaying(root = document) {
  const k = P.state.track?.key;
  root.querySelectorAll('.row[data-key]').forEach(r => r.classList.toggle('playing', r.dataset.key === k));
}

function card({ href, art, title, sub, round, onPlay }) {
  const c = h('a', { class: 'card' + (round ? ' artist' : ''), href: href || 'javascript:void 0' },
    img(art), h('div', { class: 't' }, title), h('div', { class: 's' }, sub || ''));
  if (onPlay) c.append(h('button', { class: 'fab', html: I.play, title: 'Play', onClick: e => { e.preventDefault(); e.stopPropagation(); onPlay(); } }));
  return c;
}
const trackCard = (t, list, i) => {
  const c = card({ art: t.artwork, title: t.title, sub: t.artist, onPlay: () => P.playQueue(list, i) });
  c.addEventListener('click', e => { e.preventDefault(); P.playQueue(list, i); });
  c.addEventListener('contextmenu', e => { e.preventDefault(); trackMenu({ x: e.clientX, y: e.clientY }, t); });
  return c;
};

const loading = () => h('div', { class: 'empty' }, h('div', { class: 'spinner' }));
const errorBox = (e, retry) => h('div', { class: 'empty' }, h('h3', {}, 'Something went wrong'), h('div', {}, e?.message || String(e)), retry ? h('button', { class: 'btn', onClick: retry }, 'Try again') : null);

// ---------------------------------------------------------------- views
const views = {};

views.home = async v => {
  const hr = new Date().getHours();
  v.append(h('div', { class: 'eyebrow' }, 'Strand'), h('h1', {}, hr < 5 ? 'Late night listening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening'));
  if (!anyLinked()) {
    v.append(h('div', { class: 'svc-card', style: { marginTop: '22px' } },
      h('header', {}, h('h3', {}, 'Link your music accounts')),
      h('p', {}, 'Connect Spotify, Apple Music, YouTube Music or SoundCloud to see your playlists and likes here and play full-length songs. Until then, songs play as 30-second previews.'),
      h('div', { class: 'inline' }, h('a', { class: 'btn primary small', href: '#/me' }, 'Link accounts'), h('a', { class: 'btn small ghost', href: '#/import' }, 'Import a playlist link'))));
  } else {
    ORDER.filter(k => ACCOUNTS[k].linked()).slice(0, 2).forEach(k =>
      v.append(renderSection(k, ACCOUNTS[k].sections[0], { limit: 6, title: [svcDot(k), `From ${ACCOUNTS[k].label}`], more: `#/me/${k}` })));
  }
  if (library.recent.length) {
    v.append(h('h2', {}, 'Recently played'));
    const g = h('div', { class: 'grid' }); library.recent.slice(0, 12).forEach((t, i, a) => g.append(trackCard(t, a, i))); v.append(g);
  }
  if (library.playlists.length || library.liked.length) {
    v.append(h('h2', {}, 'Your library', h('small', {}, h('a', { href: '#/library' }, 'See all'))));
    v.append(playlistGrid(6));
  }
  v.append(h('h2', {}, 'Most played right now', h('small', {}, settings.country.toUpperCase())));
  const box = h('div', {}, loading()); v.append(box);
  try {
    const t = await catalog.top();
    box.replaceChildren(t.length ? (() => { const g = h('div', { class: 'grid' }); t.slice(0, 18).forEach((x, i) => g.append(trackCard(x, t, i))); return g; })() : h('div', { class: 'empty' }, 'Charts unavailable — try Search.'));
  } catch (e) { box.replaceChildren(errorBox(e)); }
};

function playlistGrid(limit = Infinity) {
  const g = h('div', { class: 'grid' });
  if (library.liked.length) g.append(card({ href: '#/liked', art: null, title: 'Liked songs', sub: `${library.liked.length} songs`, onPlay: () => P.playQueue(library.liked, 0) }));
  library.playlists.slice(0, limit).forEach(pl => g.append(card({
    href: `#/playlist/${pl.id}`, art: pl.artwork || pl.tracks[0]?.artwork, title: pl.name,
    sub: `${pl.source ? SERVICES[pl.source]?.label + ' · ' : ''}${pl.tracks.length} songs`, onPlay: () => P.playQueue(pl.tracks, 0),
  })));
  return g;
}

let searchTab = 'all';
views.search = async (v, q = '') => {
  const input = h('input', { class: 'input', type: 'search', placeholder: 'Artists, songs, albums — or paste a Spotify / Apple Music / YouTube / SoundCloud link', value: q, autofocus: true });
  const chips = h('div', { class: 'chips' });
  const results = h('div', {});
  v.append(h('div', { class: 'searchbar' }, h('div', { class: 'wrap' }, h('span', { html: I.search }), input), chips), results);
  const tabs = [['all', 'All'], ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['youtube', 'YouTube']];
  function drawChips() {
    chips.replaceChildren(...tabs.map(([k, l]) => h('button', { class: 'chip' + (searchTab === k ? ' on' : ''), onClick: () => { searchTab = k; drawChips(); run(input.value); } }, l)));
  }
  drawChips();
  let token = 0;
  async function run(term) {
    term = term.trim();
    const my = ++token;
    history.replaceState(null, '', '#/search' + (term ? '/' + encodeURIComponent(term) : ''));
    if (!term) {
      results.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Search everything'), h('div', {}, 'Paste a link from any service to play or import it.')));
      return;
    }
    const link = parseLink(term);
    if (link) return results.replaceChildren(linkCard(term, link));
    results.replaceChildren(loading());
    try {
      if (searchTab === 'youtube') {
        if (!settings.youtubeKey && !googleActive()) return results.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Sign in with Google to search YouTube'), h('a', { class: 'btn', href: '#/me' }, 'Link YouTube Music')));
        const vids = (await ytSearch(term, 20)).map(x => ytToTrack(x));
        if (my !== token) return;
        return results.replaceChildren(h('h2', {}, 'YouTube'), trackRows(vids));
      }
      const r = await catalog.search(term);
      if (my !== token) return;
      const out = [];
      if (!r.tracks.length) out.push(h('div', { class: 'empty' }, h('h3', {}, 'No results'), h('div', {}, 'Try a different spelling, or the YouTube tab.')));
      if (searchTab === 'all' && r.tracks.length) {
        const topCard = h('div', { class: 'top-card' }, img(r.tracks[0].artwork), h('div', { class: 't' }, r.tracks[0].title), h('div', { class: 'muted' }, 'Song · ' + r.tracks[0].artist),
          h('div', { class: 'inline' }, h('button', { class: 'btn primary', onClick: () => P.playQueue(r.tracks, 0) }, h('span', { html: I.play }), 'Play'),
            r.tracks[0].artistId ? h('a', { class: 'btn ghost', href: `#/artist/${r.tracks[0].artistId}` }, 'Artist') : null));
        out.push(h('div', { class: 'top-result' }, h('div', {}, h('h2', { style: { marginTop: 0 } }, 'Top result'), topCard), h('div', {}, h('h2', { style: { marginTop: 0 } }, 'Songs'), trackRows(r.tracks.slice(0, 5), { compact: true }))));
      }
      if (searchTab === 'songs') out.push(h('h2', {}, 'Songs'), trackRows(r.tracks));
      if ((searchTab === 'all' || searchTab === 'artists') && r.artists.length) {
        const g = h('div', { class: 'grid' }); r.artists.forEach(a => g.append(card({ href: `#/artist/${a.id}`, art: a.artwork, title: a.name, sub: a.genre || 'Artist', round: true })));
        out.push(h('h2', {}, 'Artists'), g);
      }
      if ((searchTab === 'all' || searchTab === 'albums') && r.albums.length) {
        const g = h('div', { class: 'grid' }); r.albums.forEach(a => g.append(card({ href: `#/album/${a.id}`, art: a.artwork, title: a.title, sub: `${a.year} · ${a.artist}` })));
        out.push(h('h2', {}, 'Albums'), g);
      }
      results.replaceChildren(...out);
    } catch (e) { if (my === token) results.replaceChildren(errorBox(e, () => run(input.value))); }
  }
  input.addEventListener('input', debounce(() => run(input.value), 550));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') run(input.value); });
  setTimeout(() => input.focus(), 30);
  run(q);
};

function linkCard(url, link) {
  const box = h('div', { class: 'import-box' },
    h('div', { class: 'svc-row' }, h('span', { class: 'svc-tag' }, svcDot(link.service), SERVICES[link.service].label + ' ' + (link.kind || 'link'))),
    h('div', { class: 'mono', style: { wordBreak: 'break-all' } }, url));
  const status = h('div', {});
  const btn = h('button', { class: 'btn primary', onClick: () => runImport(url, status, btn) }, h('span', { html: I.import }), 'Open / import');
  box.append(h('div', { class: 'inline' }, btn), status);
  return box;
}

async function runImport(url, status, btn) {
  if (btn) btn.disabled = true;
  const bar = h('i'); const label = h('div', { class: 'muted' }, 'Reading link…');
  status.replaceChildren(h('div', { class: 'progress-card' }, label, h('div', { class: 'meter' }, bar)));
  try {
    const res = await importLink(url, (n, total) => {
      label.textContent = total ? `Fetched ${n} of ${total} tracks…` : `Fetched ${n} tracks…`;
      if (total) bar.style.setProperty('--w', Math.round(n / total * 100) + '%');
    });
    bar.style.setProperty('--w', '100%');
    if (!res.tracks.length) throw new Error('No playable tracks found in that link');
    if (res.single) {
      P.playQueue(res.tracks, 0);
      status.replaceChildren(h('div', { class: 'progress-card' }, h('div', {}, 'Playing ', h('b', {}, res.tracks[0].title), ' — ', res.tracks[0].artist),
        h('div', { class: 'inline' }, h('button', { class: 'btn small', onClick: e => playlistPicker(e.currentTarget, res.tracks[0]) }, 'Add to playlist'))));
    } else {
      const pl = newPlaylist(res.name || 'Imported playlist', res.tracks, { source: res.service, artwork: res.artwork, url });
      status.replaceChildren(h('div', { class: 'progress-card' },
        h('div', { class: 'inline' }, h('div', { class: 'big-num' }, `${res.tracks.length}/${res.total}`), h('div', { class: 'muted' }, 'tracks imported into ', h('b', {}, pl.name))),
        h('div', { class: 'inline' }, h('a', { class: 'btn primary small', href: `#/playlist/${pl.id}` }, 'Open playlist'), h('button', { class: 'btn small', onClick: () => P.playQueue(pl.tracks, 0) }, 'Play'))));
    }
  } catch (e) {
    status.replaceChildren(h('div', { class: 'progress-card' }, h('div', {}, '⚠️ ', e.message)));
  } finally { if (btn) btn.disabled = false; }
}

views.artist = async (v, id) => {
  v.append(loading());
  const a = await catalog.artist(id);
  v.replaceChildren();
  const hero = h('div', { class: 'hero', style: { '--hero-img': `url("${a.artwork}")` } },
    a.artwork ? h('img', { class: 'hero-art round', src: a.artwork, alt: '' }) : h('div', { class: 'hero-art round ph', html: I.disc }),
    h('div', { class: 'hero-meta' }, h('div', { class: 'eyebrow' }, 'Artist' + (a.genre ? ' · ' + a.genre : '')), h('h1', {}, a.name),
      h('div', { class: 'row-actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary', onClick: () => P.playQueue(a.songs, 0) }, h('span', { html: I.play }), 'Play'),
        h('button', { class: 'btn', onClick: () => { P.state.shuffle = true; emit('state'); P.playQueue(a.songs, Math.floor(Math.random() * a.songs.length)); } }, h('span', { html: I.shuffle }), 'Shuffle'))));
  hero.style.setProperty('--hero-img', `url("${a.artwork}")`);
  v.append(hero, h('h2', {}, 'Popular'), trackRows(a.songs.slice(0, 10)));
  const groups = [['Albums', 'Album'], ['Singles & EPs', null]];
  for (const [label, type] of groups) {
    const list = a.albums.filter(x => type ? x.type === type : x.type !== 'Album');
    if (!list.length) continue;
    const g = h('div', { class: 'grid' });
    list.forEach(al => g.append(card({ href: `#/album/${al.id}`, art: al.artwork, title: al.title, sub: `${al.year} · ${al.type}`, onPlay: async () => { const d = await catalog.album(al.id); P.playQueue(d.tracks, 0); } })));
    v.append(h('h2', {}, label), g);
  }
};

views.album = async (v, id) => {
  v.append(loading());
  const a = await catalog.album(id);
  v.replaceChildren();
  const total = a.tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const hero = h('div', { class: 'hero' },
    img(a.artwork, 'hero-art'),
    h('div', { class: 'hero-meta' }, h('div', { class: 'eyebrow' }, a.type || 'Album'), h('h1', {}, a.title),
      h('div', { class: 'sub' }, a.artistId ? h('a', { href: `#/artist/${a.artistId}` }, h('b', {}, a.artist)) : a.artist, ` · ${a.year} · ${a.tracks.length} songs · ${Math.round(total / 60000)} min`),
      h('div', { class: 'row-actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary', onClick: () => P.playQueue(a.tracks, 0) }, h('span', { html: I.play }), 'Play'),
        h('button', { class: 'btn', onClick: () => { newPlaylist(a.title, a.tracks.slice(), { artwork: a.artwork }); toast('Saved to your library'); } }, h('span', { html: I.plus }), 'Save'))));
  hero.style.setProperty('--hero-img', `url("${a.artwork}")`);
  v.append(hero, h('div', { style: { marginTop: '20px' } }, trackRows(a.tracks, { showArt: false, numbers: true })));
  if (a.copyright) v.append(h('p', { class: 'dim', style: { fontSize: '12px', marginTop: '24px' } }, a.copyright));
};

function playlistView(v, pl, { liked = false } = {}) {
  const total = pl.tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const art = pl.artwork || pl.tracks[0]?.artwork;
  const hero = h('div', { class: 'hero' },
    liked ? h('div', { class: 'hero-art ph', style: { background: 'linear-gradient(135deg,var(--accent),var(--accent-2))', color: '#140a07' }, html: I.heartFill.replace(/18/g, '72') }) : img(art, 'hero-art'),
    h('div', { class: 'hero-meta' }, h('div', { class: 'eyebrow' }, liked ? 'Collection' : (pl.source ? 'Imported from ' + SERVICES[pl.source].label : 'Playlist')), h('h1', {}, pl.name),
      h('div', { class: 'sub' }, `${pl.tracks.length} songs · ${Math.round(total / 60000)} min`),
      h('div', { class: 'row-actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary', disabled: !pl.tracks.length, onClick: () => P.playQueue(pl.tracks, 0) }, h('span', { html: I.play }), 'Play'),
        h('button', { class: 'btn', disabled: !pl.tracks.length, onClick: () => { P.state.shuffle = true; emit('state'); P.playQueue(pl.tracks, Math.floor(Math.random() * pl.tracks.length)); } }, h('span', { html: I.shuffle }), 'Shuffle'),
        !liked ? h('button', { class: 'btn ghost', onClick: () => { const n = prompt('Rename playlist', pl.name); if (n) { pl.name = n; saveLibrary(); route(); } } }, 'Rename') : null,
        !liked ? h('button', { class: 'btn ghost', onClick: () => { if (confirm(`Delete “${pl.name}”?`)) { library.playlists = library.playlists.filter(x => x !== pl); saveLibrary(); go('#/library'); } } }, h('span', { html: I.trash }), 'Delete') : null)));
  if (art) hero.style.setProperty('--hero-img', `url("${art}")`);
  v.append(hero, h('div', { style: { marginTop: '20px' } }, pl.tracks.length ? trackRows(pl.tracks) : h('div', { class: 'empty' }, 'No songs yet — use “Add to playlist” from any track menu.')));
}
views.playlist = (v, id) => {
  const pl = library.playlists.find(p => p.id === id);
  if (!pl) return v.append(h('div', { class: 'empty' }, h('h3', {}, 'Playlist not found')));
  playlistView(v, pl);
};
views.liked = v => playlistView(v, { name: 'Liked songs', tracks: library.liked }, { liked: true });

views.library = v => {
  v.append(h('div', { class: 'eyebrow' }, 'Library'), h('h1', {}, 'Your Strand library'),
    h('div', { class: 'row-actions' },
      h('button', { class: 'btn', onClick: () => { const n = prompt('Playlist name', 'My playlist'); if (n) { const pl = newPlaylist(n, []); go(`#/playlist/${pl.id}`); } } }, h('span', { html: I.plus }), 'New playlist'),
      h('a', { class: 'btn ghost', href: '#/import' }, h('span', { html: I.import }), 'Import')));
  if (!library.playlists.length && !library.liked.length) {
    v.append(h('div', { class: 'empty' }, h('h3', {}, 'Nothing here yet'), h('div', {}, 'Like songs with the heart, or import a playlist from Spotify, Apple Music, YouTube or SoundCloud.')));
  } else v.append(h('h2', {}, 'Playlists'), playlistGrid());
};

views.import = async v => {
  const input = h('input', { class: 'input', placeholder: 'https://open.spotify.com/playlist/…  ·  music.apple.com/…  ·  youtube.com/playlist?list=…  ·  soundcloud.com/…/sets/…' });
  const status = h('div', {});
  const btn = h('button', { class: 'btn primary', onClick: () => input.value.trim() && runImport(input.value, status, btn) }, 'Import');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') btn.click(); });
  v.append(h('div', { class: 'eyebrow' }, 'Import'), h('h1', {}, 'Bring your playlists'),
    h('p', { class: 'muted', style: { maxWidth: '640px', marginTop: '12px' } }, 'Paste a playlist, album or track link. Tracks keep their original IDs, so they play from their home service when it’s connected, or get matched to your preferred source otherwise.'),
    h('div', { class: 'import-box', style: { marginTop: '22px' } },
      h('div', { class: 'svc-row' }, ['spotify', 'apple', 'youtube', 'soundcloud'].map(s => h('span', { class: 'svc-tag' }, svcDot(s), SERVICES[s].label,
        h('span', { class: 'dim' }, { spotify: spotifyConnected() ? ' ✓' : ' · connect', apple: appleConfigured() ? ' ✓' : ' · token', youtube: googleActive() || settings.youtubeKey ? ' ✓' : ' · sign in', soundcloud: ' ✓' }[s])))),
      h('div', { class: 'inline' }, input, btn), status));
  if (spotifyConnected()) {
    const box = h('div', {}, loading());
    v.append(h('h2', {}, 'Your Spotify playlists'), box);
    try {
      const pls = await spotifyPlaylists();
      const g = h('div', { class: 'grid' });
      const liked = card({ art: null, title: 'Liked Songs', sub: 'Spotify' });
      liked.addEventListener('click', e => { e.preventDefault(); scrollTo(0, 0); main.scrollTo({ top: 0, behavior: 'smooth' }); runImport('https://open.spotify.com/collection/tracks', status, btn); });
      g.append(liked);
      pls.forEach(p => {
        const c = card({ art: p.images?.[0]?.url, title: p.name, sub: `${playlistTotal(p)} songs · ${p.owner?.display_name || ''}` });
        c.addEventListener('click', e => { e.preventDefault(); main.scrollTo({ top: 0, behavior: 'smooth' }); runImport(`https://open.spotify.com/playlist/${p.id}`, status, btn); });
        g.append(c);
      });
      box.replaceChildren(g);
    } catch (e) { box.replaceChildren(errorBox(e)); }
  }
};

// ---------------------------------------------------------------- your music (linked accounts)
function accountTile(k) {
  const A = ACCOUNTS[k], linked = A.linked(), prof = linked ? A.profile() : null;
  let action;
  if (linked) {
    action = h('button', { class: 'btn small ghost', onClick: async () => {
      if (!confirm(`Disconnect ${A.label}? Your Strand library stays as it is.`)) return;
      try { await A.disconnect(); } catch (e) { toast(e.message); }
      clearRemoteCache(); route();
    } }, 'Disconnect');
  } else if (!A.configured()) {
    action = h('a', { class: 'btn small ghost', href: '#/settings', title: 'The app owner needs to add a developer key first (Settings → Developer keys)' }, 'Needs setup');
  } else {
    action = h('button', { class: 'btn small primary', onClick: async e => {
      const b = e.currentTarget; b.disabled = true;
      try { await A.connect(); clearRemoteCache(); route(); }
      catch (err) { toast(err.message || 'Could not connect'); b.disabled = false; }
    } }, 'Connect');
  }
  return h('div', { class: 'acct' + (linked ? ' linked' : ''), style: { '--svc': SERVICES[k].color } },
    h('div', { class: 'acct-top' },
      prof?.image ? h('img', { class: 'acct-av', src: prof.image, alt: '' }) : h('div', { class: 'acct-av', html: I.headphones }),
      h('div', { class: 'acct-id' },
        h('div', { class: 'acct-name' }, svcDot(k), A.label),
        h('div', { class: 'acct-sub' }, linked ? [prof?.name || 'Connected', prof?.note ? h('span', { class: 'dim' }, ' · ' + prof.note) : null] : A.blurb))),
    !linked ? h('div', { class: 'acct-needs' }, A.needs) : null,
    h('div', { class: 'acct-actions' }, linked ? h('a', { class: 'btn small', href: `#/me/${k}` }, 'Open') : null, action));
}

function warningBanner(k) {
  const w = ACCOUNTS[k].warning();
  if (!w) return null;
  return h('div', { class: 'warn-banner' }, h('span', {}, w.text),
    h('button', { class: 'btn small', onClick: async () => { try { await w.run(); clearRemoteCache(); route(); } catch (e) { toast(e.message); } } }, w.action));
}

async function playHref(href) {
  const m = href.match(/^#\/remote\/([^/]+)\/([^/]+)\/(.+)$/);
  try {
    if (m) {
      toast('Loading…');
      const r = await remoteCollection(m[1], m[2], decodeURIComponent(m[3]));
      if (!r.tracks.length) return toast('That list is empty');
      return P.playQueue(r.tracks, 0);
    }
    const a = href.match(/^#\/album\/(\d+)/);
    if (a) { const d = await catalog.album(a[1]); P.playQueue(d.tracks, 0); }
  } catch (e) { toast(e.message); }
}

const likedTile = () => h('div', { class: 'ph', style: { background: 'linear-gradient(135deg,var(--accent),var(--accent-2))', color: '#140a07' }, html: I.heartFill.replace(/18/g, '56') });

function remoteCard(it) {
  const playable = /^#\/(remote|album)\//.test(it.href);
  const c = card({ href: it.href, art: it.art, title: it.title, sub: it.sub, round: it.round, onPlay: playable ? () => playHref(it.href) : null });
  if (it.liked) c.firstChild.replaceWith(likedTile());
  return c;
}

function renderSection(k, sec, { limit = Infinity, title, more } = {}) {
  const box = h('section', { class: 'me-sec' });
  const href = more || (typeof sec.href === 'function' ? sec.href() : sec.href);
  box.append(h('h2', {}, h('span', {}, title || sec.title), href ? h('small', {}, h('a', { href }, 'See all')) : null));
  const body = h('div', {}, loading());
  box.append(body);
  sec.load().then(items => {
    if (!items?.length) return body.replaceChildren(h('div', { class: 'dim sec-note' }, 'Nothing here yet.'));
    if (sec.type === 'grid') {
      const g = h('div', { class: 'grid' });
      items.slice(0, limit).forEach(it => g.append(remoteCard(it)));
      body.replaceChildren(g);
    } else body.replaceChildren(trackRows(items.slice(0, limit === Infinity ? 50 : limit)));
  }).catch(e => {
    const w = ACCOUNTS[k].warning();
    body.replaceChildren(h('div', { class: 'sec-note' }, h('span', { class: 'muted' }, e.message || 'Couldn’t load this'),
      (e.code === 'reauth' || w) && w ? h('button', { class: 'btn small', onClick: async () => { try { await w.run(); clearRemoteCache(); route(); } catch (er) { toast(er.message); } } }, w.action) : null));
  });
  return box;
}

views.me = (v, k) => {
  if (k && ACCOUNTS[k]) {
    const A = ACCOUNTS[k];
    if (!A.linked()) { go('#/me'); return; }
    const prof = A.profile() || {};
    const hero = h('div', { class: 'hero' },
      prof.image ? h('img', { class: 'hero-art round', src: prof.image, alt: '' }) : h('div', { class: 'hero-art round ph', style: { color: SERVICES[k].color }, html: I.headphones.replace(/20/g, '72') }),
      h('div', { class: 'hero-meta' }, h('div', { class: 'eyebrow' }, A.label), h('h1', {}, prof.name || A.label),
        h('div', { class: 'sub' }, prof.note || ''),
        h('div', { class: 'row-actions', style: { marginTop: '6px' } },
          h('a', { class: 'btn ghost', href: '#/me' }, 'All accounts'),
          h('button', { class: 'btn ghost', onClick: () => { clearRemoteCache(); route(); } }, 'Refresh'))));
    if (prof.image) hero.style.setProperty('--hero-img', `url("${prof.image}")`);
    v.append(hero);
    const w = warningBanner(k); if (w) v.append(w);
    A.sections.forEach(sec => v.append(renderSection(k, sec, { limit: sec.type === 'tracks' ? 10 : Infinity })));
    return;
  }
  v.append(h('div', { class: 'eyebrow' }, 'Your music'), h('h1', {}, 'All your music, one place'),
    h('p', { class: 'muted', style: { maxWidth: '640px', marginTop: '12px' } }, 'Link the services you use. Your playlists, likes and listening history show up here, and everything plays from the best source you have.'),
    h('div', { class: 'acct-grid' }, ORDER.map(accountTile)));
  const linked = ORDER.filter(x => ACCOUNTS[x].linked());
  if (!linked.length) {
    v.append(h('div', { class: 'empty' }, h('h3', {}, 'No accounts linked yet'), h('div', {}, 'Connect one above. You can link as many as you like.')));
    return;
  }
  for (const x of linked) {
    const A = ACCOUNTS[x];
    const w = warningBanner(x); if (w) v.append(w);
    v.append(renderSection(x, A.sections[0], { limit: 6, title: [svcDot(x), `${A.label} · ${A.sections[0].title}`], more: `#/me/${x}` }));
  }
};

views.remote = async (v, arg) => {
  const [svc, kind, ...rest] = (arg || '').split('/');
  const id = rest.join('/');
  const label = h('div', { class: 'muted' }, 'Loading from ' + (SERVICES[svc]?.label || svc) + '…');
  v.append(h('div', { class: 'empty' }, h('div', { class: 'spinner' }), label));
  let res;
  try {
    res = await remoteCollection(svc, kind, id, (n, total) => { label.textContent = total ? `Loaded ${n} of ${total} songs…` : `Loaded ${n} songs…`; });
  } catch (e) {
    const w = ACCOUNTS[svc]?.warning();
    v.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'Couldn’t load this'), h('div', { style: { maxWidth: '520px' } }, e.message),
      e.openUrl ? h('a', { class: 'btn', href: e.openUrl, target: '_blank', rel: 'noopener' }, 'Open in ' + (SERVICES[svc]?.label || 'app')) : null,
      w ? h('button', { class: 'btn', onClick: async () => { try { await w.run(); clearRemoteCache(); route(); } catch (er) { toast(er.message); } } }, w.action) : null));
    return;
  }
  v.replaceChildren();
  const tracks = res.tracks;
  const total = tracks.reduce((s, t) => s + (t.durationMs || 0), 0);
  const art = res.artwork || tracks[0]?.artwork;
  const liked = kind === 'liked';
  const kinds = { playlist: 'Playlist', libplaylist: 'Library playlist', album: 'Album', libalbum: 'Album', liked: 'Liked', top: 'Top tracks', recent: 'History', libsongs: 'Library', url: 'Profile' };
  const hero = h('div', { class: 'hero' },
    liked ? h('div', { class: 'hero-art ph', style: { background: 'linear-gradient(135deg,var(--accent),var(--accent-2))', color: '#140a07' }, html: I.heartFill.replace(/18/g, '72') }) : img(art, 'hero-art'),
    h('div', { class: 'hero-meta' },
      h('div', { class: 'eyebrow' }, svcDot(svc), `${SERVICES[svc].label} · ${kinds[kind] || ''}`),
      h('h1', {}, res.name || 'Untitled'),
      h('div', { class: 'sub' }, `${tracks.length} songs${total ? ` · ${Math.round(total / 60000)} min` : ''}`),
      h('div', { class: 'row-actions', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary', disabled: !tracks.length, onClick: () => P.playQueue(tracks, 0) }, h('span', { html: I.play }), 'Play'),
        h('button', { class: 'btn', disabled: !tracks.length, onClick: () => { P.state.shuffle = true; emit('state'); P.playQueue(tracks, Math.floor(Math.random() * tracks.length)); } }, h('span', { html: I.shuffle }), 'Shuffle'),
        h('button', { class: 'btn ghost', disabled: !tracks.length, onClick: () => { const pl = newPlaylist(res.name || 'Saved playlist', tracks.slice(), { source: svc, artwork: art }); toast('Saved to your Strand library'); go(`#/playlist/${pl.id}`); } }, h('span', { html: I.plus }), 'Save to library'),
        h('button', { class: 'btn ghost', onClick: () => { clearRemoteCache(); route(); } }, 'Refresh'))));
  if (art) hero.style.setProperty('--hero-img', `url("${art}")`);
  v.append(hero, h('div', { style: { marginTop: '20px' } }, tracks.length ? trackRows(tracks) : h('div', { class: 'empty' }, 'This list is empty.')));
};

views.settings = v => {
  v.append(h('div', { class: 'eyebrow' }, 'Settings'), h('h1', {}, 'Settings'));
  const s = h('div', { class: 'settings', style: { marginTop: '24px' } });
  v.append(s);
  const field = (label, key, opts = {}) => {
    const inp = h(opts.multiline ? 'textarea' : 'input', { class: 'input', placeholder: opts.placeholder || '', type: opts.secret ? 'password' : 'text', rows: 3, spellcheck: false });
    inp.value = settings[key] || '';
    inp.addEventListener('change', () => { setSetting(key, inp.value.trim()); toast('Saved'); opts.onChange?.(); });
    return h('div', { class: 'field' }, h('label', {}, label, fromConfig(key) ? h('span', { class: 'dim' }, ' — set in config.js') : null), inp);
  };
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener', style: { textDecoration: 'underline' } }, text);
  const copyBtn = (text, msg) => h('button', { class: 'btn small ghost', onClick: () => copy(text, msg) }, 'Copy');

  // Accounts
  s.append(h('section', { class: 'svc-card' },
    h('header', {}, h('h3', {}, 'Linked accounts'), h('a', { class: 'btn small', href: '#/me' }, 'Open Your music')),
    h('div', { class: 'acct-grid compact' }, ORDER.map(accountTile))));

  // Playback
  const pref = h('select', { class: 'input', onChange: e => { setSetting('preferred', e.target.value); toast('Saved'); } },
    [['auto', 'Automatic (best available)'], ['spotify', 'Spotify first'], ['apple', 'Apple Music first'], ['youtube', 'YouTube first'], ['preview', 'Previews only']].map(([k, l]) => h('option', { value: k, selected: settings.preferred === k }, l)));
  const country = h('input', { class: 'input', value: settings.country, maxlength: 2, style: { maxWidth: '90px', textTransform: 'uppercase' } });
  country.addEventListener('change', () => { setSetting('country', country.value.trim().toLowerCase() || 'us'); toast('Saved'); });
  s.append(h('section', { class: 'svc-card' },
    h('header', {}, h('h3', {}, 'Playback')),
    h('div', { class: 'field' }, h('label', {}, 'Preferred source. If a song isn’t available there, Strand tries the next one.'), pref),
    h('div', { class: 'field' }, h('label', {}, 'Store region (two-letter country code, e.g. us, gb, ae)'), country),
    field('Public web address for share links (leave blank to use this one)', 'shareBase', { placeholder: 'https://strand.example.com/' }),
    h('div', { class: 'inline' },
      h('button', { class: 'btn ghost small', onClick: () => { clearCaches(); clearRemoteCache(); toast('Caches cleared'); } }, 'Clear caches'),
      h('button', { class: 'btn ghost small', onClick: () => { const blob = new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' }); h('a', { href: URL.createObjectURL(blob), download: 'strand-library.json' }).click(); } }, 'Export library'))));

  // Developer keys
  const dev = h('section', { class: 'svc-card', id: 'dev' },
    h('header', {}, h('h3', {}, 'Developer keys'), h('span', { class: 'status' }, 'For the app owner')),
    h('p', {}, 'Put these in ', h('code', {}, 'public/config.js'), ' once and every listener just sees Connect buttons. Anything entered here only applies to this device.'));
  const block = (title, ok, steps, ...fields) => h('details', { class: 'dev-block', open: !ok },
    h('summary', {}, h('span', { class: 'dot' + (ok ? ' on' : ''), style: { background: ok ? 'var(--good)' : 'var(--dim)', color: 'var(--good)' } }), title, h('span', { class: 'dim' }, ok ? ' · set' : ' · not set')),
    h('ol', {}, steps.map(x => h('li', {}, x))), ...fields);
  dev.append(
    block('Spotify Client ID', !!settings.spotifyClientId, [
      ['Create an app at ', link('https://developer.spotify.com/dashboard', 'developer.spotify.com/dashboard'), ' and tick “Web API” and “Web Playback SDK”.'],
      ['Add this Redirect URI: ', h('code', {}, redirectUri()), ' ', copyBtn(redirectUri(), 'Redirect URI copied'), ' (and your web address if you put Strand online).'],
      ['Your Spotify account (the app owner) needs Premium. In development mode, add each listener’s Spotify email under “User Management” (up to 5 people); apply for extended quota to open it to everyone.'],
    ], field('Client ID', 'spotifyClientId', { placeholder: 'e.g. 1a2b3c4d5e6f…', onChange: () => route() })),
    block('Google Client ID (YouTube sign-in)', !!settings.googleClientId, [
      ['In ', link('https://console.cloud.google.com/apis/library/youtube.googleapis.com', 'Google Cloud'), ', enable “YouTube Data API v3”.'],
      ['Set up the OAuth consent screen (External) and add the scope ', h('code', {}, 'youtube.readonly'), '. While it’s in Testing, add listeners as test users.'],
      ['Credentials → Create OAuth client ID → “Web application”. Under Authorized JavaScript origins add ', h('code', {}, location.origin), ' ', copyBtn(location.origin, 'Origin copied'), '.'],
    ], field('OAuth Client ID', 'googleClientId', { placeholder: '1234-abc.apps.googleusercontent.com', onChange: () => route() })),
    block('YouTube API key (optional)', !!settings.youtubeKey, [
      ['Lets people who haven’t signed in with Google still play songs through YouTube. Create it in the same Google Cloud project and restrict it to your web address.'],
    ], field('API key', 'youtubeKey', { secret: true, placeholder: 'AIza…', onChange: () => route() })),
    block('Apple Music developer token', !!settings.appleDevToken, [
      ['In Apple Developer → Certificates, IDs & Profiles → Keys, create a key with MusicKit enabled and download the .p8 file.'],
      ['Run ', h('code', {}, 'node tools/apple-token.js AuthKey_XXXX.p8 KEY_ID TEAM_ID'), ' in the project folder (tokens last up to 6 months).'],
    ], field('Developer token (JWT)', 'appleDevToken', { multiline: true, placeholder: 'eyJhbGciOiJFUzI1NiIs…', onChange: () => location.reload() })),
  );
  s.append(dev);
};

views.t = (v, payload) => {
  let d;
  try { d = JSON.parse(b64urlDecode(payload)); } catch { return v.append(h('div', { class: 'empty' }, h('h3', {}, 'Invalid link'))); }
  const t = { key: d.i?.itunes ? 'it:' + d.i.itunes : 'sh:' + payload.slice(0, 24), title: d.t, artist: d.a, album: d.al, artwork: d.ar, durationMs: d.d, origin: d.o || 'catalog', ids: d.i || {} };
  const q = encodeURIComponent(`${t.artist} ${t.title}`);
  const cc = settings.country || 'us';
  const spId = (t.ids.spotify || '').split(':').pop();
  const links = [
    ['spotify', spId ? `https://open.spotify.com/track/${spId}` : `https://open.spotify.com/search/${q}`],
    ['apple', t.ids.apple ? `https://music.apple.com/${cc}/song/${t.ids.apple}` : `https://music.apple.com/${cc}/search?term=${q}`],
    ['youtube', t.ids.youtube ? `https://music.youtube.com/watch?v=${t.ids.youtube}` : `https://music.youtube.com/search?q=${q}`],
    ['soundcloud', t.ids.soundcloud && t.ids.soundcloud.includes('soundcloud.com/') && !t.ids.soundcloud.includes('api.') ? t.ids.soundcloud : `https://soundcloud.com/search?q=${q}`],
  ];
  v.append(h('div', { class: 'share-page' },
    img(t.artwork), h('div', { class: 'eyebrow' }, 'Shared with Strand'), h('h1', {}, t.title), h('div', { class: 'muted', style: { fontSize: '16px' } }, t.artist + (t.album ? ' · ' + t.album : '')),
    h('div', { class: 'inline', style: { justifyContent: 'center' } },
      h('button', { class: 'btn primary', onClick: () => P.playQueue([t], 0) }, h('span', { html: I.play }), 'Play here'),
      h('button', { class: 'btn', onClick: () => { toggleLike(t); toast(isLiked(t) ? 'Added to Liked' : 'Removed'); } }, h('span', { html: I.heart }), 'Like')),
    h('div', { class: 'open-in' }, links.map(([k, href]) => h('a', { href, target: '_blank', rel: 'noopener' }, h('span', {}, svcDot(k), 'Open in ' + SERVICES[k].label), h('span', {}, '↗'))))));
};

// ---------------------------------------------------------------- router
let routeToken = 0;
function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
async function route() {
  const my = ++routeToken;
  const [name = 'home', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : undefined;
  const fn = views[name] || views.home;
  hideMenu();
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === name || (name === '' && a.dataset.nav === 'home')));
  document.querySelectorAll('#side-playlists a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === location.hash));
  const v = h('div', { class: 'view' });
  main.replaceChildren(v);
  main.scrollTop = 0;
  try { await fn(v, arg); }
  catch (e) { if (my === routeToken) v.replaceChildren(errorBox(e, route)); console.error(e); }
  if (my === routeToken) markPlaying(main);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- sidebar
function renderNav() {
  const items = [['home', 'Home', I.home], ['me', 'Your music', I.headphones], ['search', 'Search', I.search], ['library', 'Library', I.library], ['import', 'Import', I.import], ['settings', 'Settings', I.settings]];
  $('nav').replaceChildren(...items.map(([k, l, ic]) => h('a', { href: '#/' + (k === 'home' ? '' : k), 'data-nav': k, title: l }, h('span', { html: ic, style: { display: 'contents' } }), h('span', {}, l))));
}
function renderSide() {
  const box = $('side-playlists');
  const items = [];
  if (library.liked.length) items.push(h('a', { href: '#/liked', title: 'Liked songs' }, h('div', { class: 'ph', style: { background: 'linear-gradient(135deg,var(--accent),var(--accent-2))', color: '#140a07' }, html: I.heartFill.replace(/18/g, '14') }), h('span', { class: 'name' }, 'Liked songs')));
  library.playlists.forEach(pl => items.push(h('a', { href: `#/playlist/${pl.id}`, title: pl.name }, img(pl.artwork || pl.tracks[0]?.artwork), h('span', { class: 'name' }, pl.name))));
  box.replaceChildren(...(items.length ? items : [h('div', { class: 'side-empty' }, 'Import or create a playlist')]));
  const st = ORDER.map(k => [k, ACCOUNTS[k].linked()]);
  $('conn').replaceChildren(...st.map(([k, ok]) => h('a', { href: ok ? `#/me/${k}` : '#/me', title: SERVICES[k].label + (ok ? ' linked' : ' not linked') },
    h('span', { class: 'dot' + (ok ? ' on' : ''), style: { background: ok ? SERVICES[k].color : 'var(--dim)', color: SERVICES[k].color } }), h('span', {}, SERVICES[k].label))));
}
on('library', () => { renderSide(); });
on('auth', () => { renderSide(); if (/^#\/(me|settings|import)?(\/|$)/.test(location.hash || '#/')) route(); });
on('settings', () => renderSide());

// ---------------------------------------------------------------- player bar
const btnPlay = $('btn-play'), seekEl = $('seek'), vol = $('volume');
$('btn-prev').innerHTML = I.prev; $('btn-next').innerHTML = I.next;
$('btn-shuffle').innerHTML = I.shuffle; $('btn-repeat').innerHTML = I.repeat;
$('btn-stage').innerHTML = I.expand; $('btn-panel').innerHTML = I.queue; $('stage-close').innerHTML = I.close;
btnPlay.onclick = P.toggle;
$('btn-prev').onclick = P.prev; $('btn-next').onclick = () => P.next();
$('btn-shuffle').onclick = P.toggleShuffle; $('btn-repeat').onclick = P.cycleRepeat;
$('bar-like').onclick = () => { if (P.state.track) { toggleLike(P.state.track); drawBar(); } };
$('btn-panel').onclick = () => {
  if (matchMedia('(max-width: 1180px)').matches) document.body.classList.toggle('panel-open');
  else document.body.classList.toggle('panel-off');
};
let seeking = false;
seekEl.addEventListener('input', () => { seeking = true; setRange(seekEl, seekEl.value / 10); $('t-pos').textContent = fmt(seekEl.value / 1000 * P.state.duration); });
seekEl.addEventListener('change', () => { P.seek(seekEl.value / 1000 * P.state.duration); seeking = false; });
vol.value = Math.round(settings.volume * 100); setRange(vol, vol.value);
let lastVol = settings.volume || 0.8;
vol.addEventListener('input', () => { P.setVolume(vol.value / 100); setRange(vol, vol.value); drawMute(); });
$('btn-mute').onclick = () => {
  if (settings.volume > 0) { lastVol = settings.volume; P.setVolume(0); } else P.setVolume(lastVol || 0.8);
  vol.value = Math.round(settings.volume * 100); setRange(vol, vol.value); drawMute();
};
function drawMute() { $('btn-mute').innerHTML = settings.volume > 0 ? I.volume : I.mute; }
drawMute();
function setRange(el, pct) { el.style.setProperty('--v', pct + '%'); }

function sourcePill(el) {
  const { provider, score, loading } = P.state;
  el.replaceChildren();
  if (loading) { el.append(h('span', { class: 'dot', style: { background: 'var(--muted)' } }), 'Finding source…'); return; }
  if (!provider) return;
  el.append(h('span', { class: 'dot', style: { background: SERVICES[provider].color } }), SERVICES[provider].label + (score != null ? ` · ${Math.round(score * 100)}% match` : ''));
}

function drawBar() {
  const t = P.state.track;
  $('bar-art').src = t?.artwork || '';
  $('bar-title').textContent = t ? t.title : 'Pick something to play';
  $('bar-artist').replaceChildren(t ? (t.artistId ? h('a', { href: `#/artist/${t.artistId}` }, t.artist) : t.artist) : '');
  $('bar-like').innerHTML = t && isLiked(t) ? I.heartFill : I.heart;
  $('bar-like').classList.toggle('on', !!(t && isLiked(t)));
  $('bar-like').style.visibility = t ? 'visible' : 'hidden';
  btnPlay.innerHTML = P.state.playing ? I.pause : I.play;
  btnPlay.classList.toggle('loading', P.state.loading);
  $('btn-shuffle').classList.toggle('on', P.state.shuffle);
  const rp = $('btn-repeat'); rp.classList.toggle('on', P.state.repeat !== 'off'); rp.classList.toggle('one', P.state.repeat === 'one');
  rp.style.position = 'relative'; rp.title = 'Repeat: ' + P.state.repeat;
  sourcePill($('bar-source'));
  document.title = t ? `${t.title} · ${t.artist} — Strand` : 'Strand';
  $('stage').classList.toggle('playing', P.state.playing);
}
function drawTime() {
  const { position, duration } = P.state;
  if (!seeking) {
    const pct = duration ? Math.min(100, position / duration * 100) : 0;
    seekEl.value = pct * 10; setRange(seekEl, pct);
    $('t-pos').textContent = fmt(position);
  }
  $('t-dur').textContent = fmt(duration);
  panelLyrics.update(position);
  if (!$('stage').hidden) stageLyrics.update(position);
}

// ---------------------------------------------------------------- now playing panel
function drawPanel() {
  const t = P.state.track, prov = P.state.provider || P.state.trying;
  const media = $('np-media');
  media.classList.toggle('video', prov === 'youtube');
  media.classList.toggle('sc', prov === 'soundcloud');
  $('np-art').src = t?.artwork || '';
  $('np-art').style.visibility = t?.artwork ? 'visible' : 'hidden';
  $('np-empty').hidden = !!t;
  $('np-title').textContent = t?.title || '';
  $('np-artist').replaceChildren(t ? (t.artistId ? h('a', { href: `#/artist/${t.artistId}` }, t.artist) : t.artist) : '');
  const src = $('np-source'); src.replaceChildren();
  if (t) {
    const pill = h('span', { class: 'src-pill' }); sourcePill(pill); src.append(pill);
    if (P.state.error) src.append(h('div', { class: 'dim', style: { fontSize: '12px', width: '100%' } }, P.state.error));
    src.append(h('button', { class: 'src-pill', onClick: () => copy(shareUrl(t)) }, h('span', { html: I.link }), 'Share'));
  }
}
let panelTab = 'lyrics';
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  panelTab = b.dataset.tab;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  drawPanelBody();
});
const panelBody = $('panel-body');
const lyricsHost = h('div', {});
const queueHost = h('div', {});
function drawPanelBody() {
  panelBody.replaceChildren(panelTab === 'lyrics' ? lyricsHost : queueHost);
  if (panelTab === 'queue') drawQueue();
}
function drawQueue() {
  const { queue, index } = P.state;
  const item = (t, i) => h('div', { class: 'q-item' + (i === index ? ' cur' : ''), onClick: () => P.playAt(i) },
    img(t.artwork), h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, t.title), h('div', { class: 's' }, t.origin && t.origin !== 'catalog' ? svcDot(t.origin) : null, t.artist)),
    i !== index ? h('button', { class: 'icon-btn', title: 'Remove', html: I.close, onClick: e => { e.stopPropagation(); P.removeFromQueue(i); } }) : h('span'));
  if (!queue.length) return queueHost.replaceChildren(h('div', { class: 'empty' }, 'Your queue is empty'));
  queueHost.replaceChildren(
    h('div', { class: 'q-label' }, 'Now playing'), index >= 0 ? item(queue[index], index) : null,
    h('div', { class: 'q-label' }, `Next up · ${Math.max(0, queue.length - index - 1)}`),
    ...queue.slice(index + 1, index + 101).map((t, k) => item(t, index + 1 + k)));
}

// ---------------------------------------------------------------- lyrics component
function lyricsView(root, scroller, { big = false } = {}) {
  let track = null, data = null, els = [], last = -2, userScroll = 0;
  scroller.addEventListener('wheel', () => { userScroll = Date.now(); }, { passive: true });
  scroller.addEventListener('touchmove', () => { userScroll = Date.now(); }, { passive: true });
  const offsetCtl = () => {
    const lab = h('span', {}, (settings.lyricsOffset >= 0 ? '+' : '') + (settings.lyricsOffset / 1000).toFixed(2) + 's');
    const adj = d => { setSetting('lyricsOffset', settings.lyricsOffset + d); lab.textContent = (settings.lyricsOffset >= 0 ? '+' : '') + (settings.lyricsOffset / 1000).toFixed(2) + 's'; };
    return h('div', { class: 'offset', title: 'Lyrics timing offset' }, h('button', { onClick: () => adj(-250) }, '−'), lab, h('button', { onClick: () => adj(250) }, '+'));
  };
  async function set(t) {
    track = t; data = null; els = []; last = -2;
    if (!t) return root.replaceChildren(h('div', { class: 'empty' }, 'Play something to see lyrics'));
    root.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
    let d;
    try { d = await fetchLyrics(t); } catch { d = null; }
    if (track !== t) return;
    data = d; render();
  }
  function render() {
    const wrap = h('div', { class: 'lyrics' });
    if (!data || (!data.lines && !data.plain)) {
      wrap.append(h('div', { class: 'empty' }, data?.instrumental ? '♪ Instrumental' : 'No lyrics found for this song'));
      return root.replaceChildren(wrap);
    }
    wrap.append(h('div', { class: 'lyrics-head' }, h('span', {}, (data.lines ? 'Synced · ' : 'Unsynced · ') + data.source), data.lines ? offsetCtl() : null));
    if (data.lines) {
      els = data.lines.map(l => {
        const e = h('div', { class: 'line' + (l.text ? '' : ' gap') }, l.text || '• • •');
        e.onclick = () => P.seek(Math.max(0, l.t - settings.lyricsOffset));
        wrap.append(e); return e;
      });
    } else wrap.append(h('div', { class: 'plain' }, data.plain));
    root.replaceChildren(wrap);
    last = -2;
  }
  function update(pos) {
    if (!data?.lines || !els.length) return;
    const ms = pos + settings.lyricsOffset;
    const lines = data.lines;
    const i = activeIndex(lines, ms);
    if (i !== last) {
      els.forEach((e, k) => { e.classList.toggle('active', k === i); e.classList.toggle('past', k < i); if (k !== i) e.style.removeProperty('--p'); });
      last = i;
      if (i >= 0 && Date.now() - userScroll > 3000 && scroller.offsetParent !== null) {
        const e = els[i];
        const top = e.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - scroller.clientHeight * (big ? 0.4 : 0.32);
        scroller.scrollTo({ top, behavior: 'smooth' });
      }
    }
    if (i >= 0) {
      const L = lines[i];
      let p;
      if (L.words?.length) {
        const total = L.words.reduce((s, w) => s + w.text.length, 0) || 1;
        let done = 0;
        for (let k = 0; k < L.words.length; k++) {
          const w = L.words[k], nt = L.words[k + 1]?.t ?? L.end;
          if (ms >= nt) done += w.text.length;
          else if (ms >= w.t) { done += w.text.length * (ms - w.t) / Math.max(1, nt - w.t); break; }
          else break;
        }
        p = done / total;
      } else {
        const dur = Math.min(L.end - L.t, Math.max(1200, L.text.length * 75));
        p = (ms - L.t) / Math.max(1, dur);
      }
      els[i].style.setProperty('--p', Math.max(0, Math.min(1, p)) * 100 + '%');
    }
  }
  return { set, update };
}
const panelLyrics = lyricsView(lyricsHost, panelBody);
const stageLyricsHost = $('stage-lyrics');
const stageLyrics = lyricsView(stageLyricsHost, stageLyricsHost, { big: true });

// ---------------------------------------------------------------- stage
let stopViz = null;
function openStage() {
  $('stage').hidden = false;
  drawStage();
  stopViz = startVisualizer($('stage-viz'), { mode: 'radial', anchor: $('stage-art') });
  stageLyrics.set(P.state.track);
}
function closeStage() { $('stage').hidden = true; stopViz?.(); stopViz = null; }
function drawStage() {
  const t = P.state.track;
  $('stage-art').src = t?.artwork || '';
  $('stage-bg').style.setProperty('--stage-img', t?.artwork ? `url("${t.artwork}")` : 'none');
  $('stage-title').textContent = t?.title || 'Nothing playing';
  $('stage-artist').textContent = t?.artist || '';
  const tools = $('stage-tools'); tools.replaceChildren();
  const pill = h('span', { class: 'src-pill' }); sourcePill(pill); tools.append(pill);
  if (P.state.provider && P.state.provider !== 'preview') tools.append(h('span', { class: 'src-pill', title: 'Protected streams don’t expose audio data to apps' }, 'Visualizer: simulated'));
}
$('btn-stage').onclick = () => ($('stage').hidden ? openStage() : closeStage());
$('stage-close').onclick = closeStage;

// ---------------------------------------------------------------- events
let lastKey = null;
on('track', () => {
  drawBar(); drawPanel(); markPlaying(main);
  const t = P.state.track;
  if (t?.key !== lastKey) {
    lastKey = t?.key;
    panelLyrics.set(t);
    if (!$('stage').hidden) stageLyrics.set(t);
  }
  if (!$('stage').hidden) drawStage();
  if (panelTab === 'queue') drawQueue();
});
on('state', drawBar);
on('trying', drawPanel);
on('time', drawTime);
on('queue', () => { if (panelTab === 'queue') drawQueue(); });
on('library', () => { drawBar(); });

document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ') { e.preventDefault(); P.toggle(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) P.next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) P.prev();
  else if (e.key === 'ArrowRight') P.seek(P.state.position + 5000);
  else if (e.key === 'ArrowLeft') P.seek(Math.max(0, P.state.position - 5000));
  else if (e.key.toLowerCase() === 'l') ($('stage').hidden ? openStage() : closeStage());
  else if (e.key === '/') { e.preventDefault(); go('#/search'); }
  else if (e.key === 'Escape') { hideMenu(); if (!$('stage').hidden) closeStage(); document.body.classList.remove('panel-open'); }
});

// ---------------------------------------------------------------- boot
(async function boot() {
  renderNav(); renderSide(); drawBar(); drawPanel(); drawPanelBody(); panelLyrics.set(null);
  try {
    const me = await handleSpotifyCallback();
    if (me) toast(`Spotify connected as ${me.display_name || me.id}`);
  } catch (e) { toast(e.message); }
  appleInit();
  route();
})();

// expose for debugging in devtools
window.strand = { player: P, catalog, library, settings, spApi };
