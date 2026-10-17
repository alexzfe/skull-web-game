// Pure helpers for the shell's screens (home, lobby, multiplayer table). No DOM,
// so `node --test` covers them (test/shell-core.test.js).

export const AVATARS = ['💀', '🌹', '🐍', '🐺', '🦅', '🐆', '🤘', '🔥', '🍺', '🃏', '🏍️', '👻'];
export const NAME_MAX = 16;
export const DEFAULT_NAME = 'Rider';
export const TIMERS = [0, 20, 30, 60];   // seconds, 0 = Off (MULTIPLAYER_SPEC §5)
export const MIN_SEATS = 3, MAX_SEATS = 6;
export const OFF_CLOCK_MS = 30_000;      // a disconnected seat's clock when the timer is Off
export const NUDGE_MS = 5_000;           // turn nudge: this long before your own deadline
export const DEFAULT_HOST_OPTIONS = { seats: 4, timer: 30, open: true };

const DEFAULT_SETTINGS = { name: DEFAULT_NAME, opponents: 3, avatar: { emoji: AVATARS[0] } };

// ---------- settings (`skull.settings` = {name, opponents, avatar}) ----------

export function parseSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const opponents = Number(s.opponents);
  const emoji = s.avatar?.emoji;
  return {
    name: typeof s.name === 'string' ? cleanName(s.name) : DEFAULT_SETTINGS.name,
    opponents: opponents >= 2 && opponents <= 5 ? opponents : DEFAULT_SETTINGS.opponents,
    avatar: { emoji: AVATARS.includes(emoji) ? emoji : DEFAULT_SETTINGS.avatar.emoji },
  };
}

export const cleanName = name => [...String(name ?? '').trim()].slice(0, NAME_MAX).join('').trim();

export function parseHostOptions(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    seats: Number.isInteger(o.seats) && o.seats >= MIN_SEATS && o.seats <= MAX_SEATS ? o.seats : DEFAULT_HOST_OPTIONS.seats,
    timer: TIMERS.includes(o.timer) ? o.timer : DEFAULT_HOST_OPTIONS.timer,
    open: typeof o.open === 'boolean' ? o.open : DEFAULT_HOST_OPTIONS.open,
  };
}

// ◀ ▶ through the avatar list (wraps).
export function stepAvatar(emoji, d) {
  const i = AVATARS.indexOf(emoji);
  const n = AVATARS.length;
  return AVATARS[((i < 0 ? 0 : i) + d + n) % n];
}

// ---------- who am I in the lobby? ----------

// The lobby message doesn't say which member is you. Your avatar carries a short
// public tag derived from your token (the token itself stays secret), and you find
// yourself by it. A server-provided `lobby.me` wins when present.
export function avatarTag(token) {
  let h = 0x811c9dc5;   // FNV-1a, 32 bits
  for (const c of String(token)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export function findMe(lobby, tag) {
  if (!lobby?.members) return null;
  if (Number.isInteger(lobby.me)) return lobby.members.find(m => m.seat === lobby.me && !m.waiting) ?? null;
  return lobby.members.find(m => !m.isBot && m.avatar?.k === tag) ?? null;
}

export function lobbySummary(lobby, me) {
  const seated = (lobby?.members ?? []).filter(m => !m.waiting);
  const waiting = (lobby?.members ?? []).filter(m => m.waiting);
  const isHost = !!me && !me.waiting && lobby.hostSeat === me.seat;
  return {
    seated: seated.sort((a, b) => a.seat - b.seat),
    waiting,
    isHost,
    host: seated.find(m => m.seat === lobby?.hostSeat) ?? null,
    canStart: isHost && lobby.phase === 'waiting' && seated.length >= MIN_SEATS,
    empty: Math.max(0, (lobby?.options?.seats ?? 0) - seated.length),
  };
}

export const timerLabel = t => (t ? `${t}s` : 'Off');

// ---------- the table ----------

// Opponents clockwise from the seat after yours, so you sit at the bottom.
export function seatOrder(n, me) {
  const out = [];
  for (let k = 1; k < n; k++) out.push((me + k) % n);
  return out;
}

// Per-seat clocks from a server deadline: {id: {at, total}} with `total` the full
// clock length the ring drains over.
export function seatClocks(deadline, { timer = 0 } = {}) {
  const out = {};
  if (!deadline) return out;
  const ats = deadline.ats ?? Object.fromEntries((deadline.players ?? []).map(id => [id, deadline.at]));
  for (const [k, at] of Object.entries(ats)) {
    const id = Number(k);
    if (!Number.isFinite(at)) continue;
    // with the timer Off only a disconnected seat has a clock: the 30s fallback
    out[id] = { at, total: timer ? timer * 1000 : OFF_CLOCK_MS };
  }
  return out;
}

// The ring's state at time `now`: fraction left (0..1) and ms left.
export function ringAt(clock, now) {
  const left = Math.max(0, clock.at - now);
  return { left, frac: clock.total > 0 ? Math.min(1, left / clock.total) : 0 };
}

// What the open-lobbies list shows for one row.
export function lobbyRow(l) {
  const humans = Number(l.humans) || 0, bots = Number(l.bots) || 0, seats = Number(l.seats) || 0;
  return {
    code: l.code,
    host: String(l.host || DEFAULT_NAME),
    fill: `${humans + bots}/${seats}`,
    bots,
    timer: timerLabel(Number(l.timer) || 0),
    full: humans + bots >= 6,
  };
}

// ---------- version-skew reload ----------

export const RELOAD_GAP_MS = 30_000;     // at most one automatic reload per 30s (no loops)

// The server said this page runs an old build. Reload unless we already did so
// recently (`lastAt`: epoch ms of the last auto-reload, from sessionStorage).
export function shouldAutoReload(lastAt, now, gap = RELOAD_GAP_MS) {
  const last = Number(lastAt);
  return !(Number.isFinite(last) && last > 0 && now - last >= 0 && now - last < gap);
}
