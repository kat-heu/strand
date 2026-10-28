// Small playback log (last 120 events), kept on this device so playback problems
// can be diagnosed from Settings → Playback log. Contains song titles and device
// names only — never tokens or passwords.
const KEY = 'strand:playlog';
let buf = [];
try { buf = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}
let saveT;
export function log(msg, data) {
  const d = new Date();
  const line = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')} ${msg}` + (data === undefined ? '' : ' ' + (typeof data === 'string' ? data : JSON.stringify(data)));
  buf.push(line);
  if (buf.length > 120) buf = buf.slice(-120);
  clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(buf)); } catch {} }, 300);
}
export const logLines = () => buf.slice();
export function clearLog() { buf = []; try { localStorage.removeItem(KEY); } catch {} }
log('app start', { ua: navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 90), standalone: !!navigator.standalone });
