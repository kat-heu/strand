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
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
let unlocked = false;
function unlock() {
  if (unlocked || owner) return;
  unlocked = true;
  const was = el.src;
  el.muted = true; el.src = SILENCE;
  el.play().then(() => { if (!owner) el.pause(); el.muted = false; log('audio unlocked by tap'); }, () => { unlocked = false; el.muted = false; })
    .finally(() => { if (!owner && was && was !== SILENCE) el.src = was; });
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
