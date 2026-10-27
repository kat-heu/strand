// Time-synced lyrics from LRCLIB (free, open, no key). Supports standard LRC
// line timing and "enhanced" LRC word timing (<mm:ss.xx> tags) when present;
// otherwise word progress within a line is interpolated.
const cache = new Map();
const API = 'https://lrclib.net/api';

function clean(s = '') {
  return s.replace(/\s*[([](feat|ft|with)[^)\]]*[)\]]/gi, '').replace(/\s-\s.*(remaster|version|edit|mix).*$/i, '').trim();
}
const ts = (m, s) => (Number(m) * 60 + Number(s)) * 1000;

export function parseLrc(text) {
  if (!text) return null;
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    let body = raw.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, '');
    let words = null;
    if (/<\d+:\d+(?:\.\d+)?>/.test(body)) {
      words = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)].map(m => ({ t: ts(m[1], m[2]), text: m[3] })).filter(w => w.text);
      body = body.replace(/<\d+:\d+(?:\.\d+)?>/g, '');
    }
    for (const st of stamps) out.push({ t: ts(st[1], st[2]), text: body.trim(), words });
  }
  out.sort((a, b) => a.t - b.t);
  for (let i = 0; i < out.length; i++) out[i].end = out[i + 1]?.t ?? out[i].t + 5000;
  return out.length ? out : null;
}

export async function fetchLyrics(t) {
  const key = t.key;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const title = clean(t.title), artist = (t.artist || '').split(/,|&| x /i)[0].trim();
    let d = null;
    try {
      const q = new URLSearchParams({ artist_name: artist, track_name: title });
      if (t.durationMs) q.set('duration', Math.round(t.durationMs / 1000));
      const r = await fetch(`${API}/get?${q}`);
      if (r.ok) d = await r.json();
    } catch {}
    if (!d || (!d.syncedLyrics && !d.plainLyrics && !d.instrumental)) {
      try {
        const r = await fetch(`${API}/search?` + new URLSearchParams({ track_name: title, artist_name: artist }));
        const arr = r.ok ? await r.json() : [];
        const near = x => !t.durationMs || Math.abs(x.duration * 1000 - t.durationMs) < 8000;
        d = arr.find(x => x.syncedLyrics && near(x)) || arr.find(x => x.syncedLyrics) || arr[0] || d;
      } catch {}
    }
    if (!d) return { lines: null, plain: null, instrumental: false, source: null };
    return { lines: parseLrc(d.syncedLyrics), plain: d.plainLyrics || null, instrumental: !!d.instrumental, source: 'LRCLIB' };
  })();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

export function activeIndex(lines, ms) {
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
