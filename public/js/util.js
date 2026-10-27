// DOM helper: h('div', {class:'x', onClick: fn}, child, 'text', [more])
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; }
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}

export function fmt(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function decodeEntities(s = '') {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

let jp = 0;
export function jsonp(url, timeout = 12000) {
  return new Promise((res, rej) => {
    const cb = '__jp' + (++jp) + Date.now();
    const s = document.createElement('script');
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, timeout);
    function done() { clearTimeout(t); delete window[cb]; s.remove(); }
    window[cb] = d => { done(); res(d); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    s.onerror = () => { done(); rej(new Error('network')); };
    document.head.append(s);
  });
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res(); s.onerror = () => rej(new Error('Failed to load ' + src));
    document.head.append(s);
  });
}

// ---- fuzzy matching -------------------------------------------------------
export function norm(s = '') {
  return String(s).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\s-\s.*\b(remaster(ed)?|version|edit|live|mix|mono|stereo)\b.*$/, ' ')
    .replace(/\b(feat|ft|featuring)\.?\s.*$/, ' ')
    .replace(/\b(official|music|video|audio|lyrics?|visualizer|hd|4k|mv)\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function tokens(s) { return new Set(norm(s).split(' ').filter(Boolean)); }
export function coverage(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size) return 0;
  let i = 0; A.forEach(x => { if (B.has(x)) i++; });
  return i / A.size;
}
// 0..1 — how likely `got` is the same recording as `want`
export function matchScore(want, got) {
  const t = (coverage(want.title, got.title) + coverage(got.title, want.title)) / 2;
  const ar = Math.max(coverage(want.artist, got.artist), coverage(want.artist, got.title) * 0.9);
  let d = 0.5;
  if (want.durationMs && got.durationMs) {
    const diff = Math.abs(want.durationMs - got.durationMs);
    d = diff < 3000 ? 1 : diff < 10000 ? 0.7 : diff < 30000 ? 0.3 : 0;
  }
  return 0.55 * t + 0.3 * ar + 0.15 * d;
}

export function b64urlEncode(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}

export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
