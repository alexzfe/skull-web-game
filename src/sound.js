// Tiny WebAudio sounds for the table: a cue per game event plus the multiplayer
// turn nudge. No files; the context is created lazily (browsers only allow
// audio after a user gesture anyway). The 🔊 toggle is remembered in
// localStorage `skull.sound` ("0" = muted).

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

// Call from a user gesture so later sounds can play.
export function unlock() {
  const c = audio();
  if (c?.state === 'suspended') c.resume().catch(() => {});
}

function ready() {
  if (!soundOn()) return null;
  const c = audio();
  return c && c.state === 'running' ? c : null;
}

// One enveloped oscillator note, `at` seconds from now.
function note(c, { freq, to = freq, type = 'sine', gain = 0.06, ms = 120, at = 0 }) {
  const t = c.currentTime + at;
  const end = t + ms / 1000;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, end);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(end + 0.02);
}

// A short filtered noise burst: a card landing on felt.
function thud(c, { gain = 0.12, ms = 60, cutoff = 1400, at = 0 } = {}) {
  const t = c.currentTime + at;
  const len = Math.ceil(c.sampleRate * ms / 1000);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = cutoff;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
}

// A soft wooden tick: a short, quickly decaying sine blip.
export function tick({ freq = 1250, gain = 0.06, ms = 70 } = {}) {
  const c = ready();
  if (c) note(c, { freq, to: freq * 0.6, gain, ms });
}

const CUES = {
  card: c => thud(c),
  bid: c => { note(c, { freq: 523, gain: 0.05, ms: 110, type: 'triangle' }); note(c, { freq: 784, gain: 0.05, ms: 160, type: 'triangle', at: 0.08 }); },
  pass: c => note(c, { freq: 330, to: 260, gain: 0.04, ms: 120, type: 'triangle' }),
  flip: c => { thud(c, { gain: 0.08, ms: 40, cutoff: 2500 }); note(c, { freq: 988, gain: 0.04, ms: 140, at: 0.02 }); },
  won: c => [523, 659, 784, 1047].forEach((freq, i) => note(c, { freq, gain: 0.05, ms: 260, type: 'triangle', at: i * 0.09 })),
  skull: c => { thud(c, { gain: 0.2, ms: 140, cutoff: 500 }); note(c, { freq: 220, to: 82, gain: 0.09, ms: 520, type: 'sawtooth', at: 0.02 }); },
  out: c => [392, 330, 262].forEach((freq, i) => note(c, { freq, gain: 0.05, ms: 220, type: 'triangle', at: i * 0.14 })),
  turn: c => note(c, { freq: 880, gain: 0.035, ms: 180 }),
  round: c => [0, 0.05, 0.1].forEach(at => thud(c, { gain: 0.07, ms: 35, cutoff: 3000, at })),
  win: c => [523, 659, 784, 1047, 1319].forEach((freq, i) => note(c, { freq, gain: 0.055, ms: 380, type: 'triangle', at: i * 0.11 })),
  lose: c => [440, 415, 392, 330].forEach((freq, i) => note(c, { freq, gain: 0.045, ms: 300, type: 'triangle', at: i * 0.16 })),
};

export function play(name) {
  const c = ready();
  if (c && CUES[name]) CUES[name](c);
}

// Which cues one applied action earns, from two consecutive views (like announce.js).
export function cuesFor(prev, next, action) {
  const me = next.me ?? 0;
  const out = [];
  switch (action.type) {
    case 'placeInitial': case 'place': case 'discard': out.push('card'); break;
    case 'bid': out.push('bid'); break;
    case 'pass': out.push('pass'); break;
    case 'nextRound': out.push('round'); break;
    case 'reveal':
      if (next.phase === 'reveal') out.push('flip');
      else out.push(next.lastResult?.type === 'lost' ? 'skull' : 'won');
      break;
  }
  if (next.phase === 'game-over' && prev.phase !== 'game-over') out.push(next.winner === me ? 'win' : 'lose');
  else if (next.players[me]?.eliminated && !prev.players[me]?.eliminated) out.push('out');
  else if (next.currentPlayer === me && prev.currentPlayer !== me && ['placement', 'bidding', 'reveal'].includes(next.phase)) out.push('turn');
  return out;
}

// Plays each cue a beat after the last so they don't smear together.
export function playCues(names) {
  names.forEach((n, i) => (i ? setTimeout(() => play(n), i * 350) : play(n)));
}
