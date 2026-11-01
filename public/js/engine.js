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
