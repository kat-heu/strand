// One shared <audio> element for every source Strand plays itself (your files,
// your cloud music, previews). Built to keep playing on iPhone when you go to the
// Home Screen, switch apps or lock the screen:
//
// - audioSession.type = 'playback' (Safari 16.4+): music, not a sound effect, so it
//   keeps going with the silent switch on and in the background.
// - The element loops and never fires "ended". On iPhone, when a track ends
//   naturally and nothing is playing, iOS closes the audio session and the next
//   track can't start until the app is opened again. Instead we notice the jump back
//   to 0:00, mute, and swap in the next song on the same, still-active element.
// - No Web Audio routing here: iOS silences Web Audio in the background.
import { log } from './log.js';

export const el = new Audio();
el.preload = 'auto';
el.loop = true;
el.setAttribute('playsinline', '');
el.setAttribute('webkit-playsinline', '');
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
export const sessionInfo = () => navigator.audioSession ? `${navigator.audioSession.type}/${navigator.audioSession.state || '?'}` : 'not supported';

// iPhones only let audio start from a tap. Our songs start after a short wait (reading
// the file, fetching a link), which can be too late, so on the first tap we "unlock"
// this element with a moment of silence; after that Strand can start songs itself.
// A real (decodable) 0.1 s silent WAV: 8 kHz, 8-bit, mono.
const SILENCE = (() => {
  const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
  const str = (o, s) => [...s].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  return 'data:audio/wav;base64,' + btoa(String.fromCharCode(...b));
})();
// Only unlock while nothing else is playing: starting Strand's audio, even silence,
// makes iOS pause another app's music (e.g. the Spotify app Strand is controlling).
let unlockAllowed = () => true;
export const setUnlockAllowed = f => { unlockAllowed = f; };
export const isUnlocked = () => unlocked;
let unlocked = false, unlockTries = 0;
function unlock() {
  if (unlocked || owner || unlockTries >= 3 || !unlockAllowed()) return;
  unlockTries++;
  unlocked = true;
  const was = el.src;
  el.muted = true; el.src = SILENCE;
  el.play().then(() => { if (!owner) el.pause(); el.muted = false; log('audio unlocked by tap'); },
    e => {
      // A song started from this same tap and replaced the silence: that unlocks it too.
      if (owner || e?.name === 'AbortError') { log('audio unlocked (a song started from the tap)'); return; }
      unlocked = false; el.muted = false; log('audio unlock failed', e?.message || String(e));
    })
    .finally(() => { if (!owner) { if (was && was !== SILENCE) el.src = was; else { el.removeAttribute('src'); el.load(); } } });
}
for (const ev of ['touchend', 'pointerup', 'keydown']) document.addEventListener(ev, unlock, { capture: true, passive: true });

let owner = null, onEnd = null, ownSeek = false, lastT = 0, ended = false;
el.addEventListener('timeupdate', () => { if (!el.seeking) lastT = el.currentTime; });
el.addEventListener('seeking', () => {
  if (ownSeek) { ownSeek = false; return; }
  const d = el.duration;
  // Looped back to the start on its own = the song finished.
  if (!ended && isFinite(d) && d > 2 && lastT > d - 1.5 && el.currentTime < 1) {
    ended = true; el.muted = true; lastT = 0;
    log('song ended (background-safe)');
    const f = onEnd; if (f) f();
  }
});

// A provider takes the element for a song.
export async function playUrl(name, url, endedCb) {
  clearTimeout(releaseT);
  owner = name; onEnd = endedCb; ended = false; lastT = 0;
  if (el.src !== url) { el.src = url; }
  else { ownSeek = true; el.currentTime = 0; }
  el.muted = false;
  await el.play();
}
export const isOwner = name => owner === name;
// Take the element before the song's address is known (so a newer song can tell an
// older one to give up), without stopping what's playing.
export function claim(name, endedCb) { clearTimeout(releaseT); owner = name; onEnd = endedCb; }
export function seekTo(ms) { ownSeek = true; el.currentTime = ms / 1000; lastT = el.currentTime; }
// Let go of the element. It isn't paused straight away: if the next song also plays
// here it takes over a still-running element (pausing first can stop iOS from
// starting it again while the phone is locked). If nobody does, it's paused shortly.
let releaseT = null;
export function release(name) {
  if (owner !== name) return;
  owner = null; onEnd = null;
  el.muted = true;
  clearTimeout(releaseT);
  releaseT = setTimeout(() => { if (!owner) el.pause(); }, 2500);
}
export const position = () => el.currentTime * 1000;
export const duration = () => (isFinite(el.duration) ? el.duration * 1000 : 0);
export const playing = () => !el.paused && !ended && !el.muted;
export const ownerName = () => (owner == null ? 'none' : typeof owner === 'string' ? owner : owner.name || 'source');
export const describe = () => `${ownerName()}: ${el.paused ? 'paused' : el.muted ? 'silent' : el.readyState < 3 ? 'buffering' : 'playing'}${el.error ? ' error ' + el.error.code : ''}`;
el.addEventListener('waiting', () => { if (owner) log('strand audio buffering', ownerName()); });
el.addEventListener('error', () => { if (owner) log('strand audio error', { owner: ownerName(), code: el.error?.code }); });
el.addEventListener('stalled', () => { if (owner) log('strand audio stalled (network)', ownerName()); });
