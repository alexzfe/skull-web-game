// Tiny WebAudio blips for the multiplayer turn nudge. No files; the context is
// created lazily (browsers only allow audio after a user gesture anyway).
// The 🔊 toggle is remembered in localStorage `skull.sound` ("0" = muted).

const KEY = 'skull.sound';
let ctx = null;

export function soundOn() {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

export function setSound(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  if (on) unlock();
}

function audio() {
  if (ctx) return ctx;
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) return null;
  try { ctx = new AC(); } catch { ctx = null; }
  return ctx;
}

// Call from a user gesture so later ticks can play.
export function unlock() {
  const c = audio();
  if (c?.state === 'suspended') c.resume().catch(() => {});
}

// A soft wooden tick: a short, quickly decaying sine blip.
export function tick({ freq = 1250, gain = 0.06, ms = 70 } = {}) {
  if (!soundOn()) return;
  const c = audio();
  if (!c || c.state !== 'running') return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + ms / 1000);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}
