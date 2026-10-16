// Skull & Roses — one multiplayer room as a pure state machine
// (MULTIPLAYER_SPEC §4–§6). No sockets, no Cloudflare APIs: the Room Durable
// Object feeds it events and delivers what it returns.
//
// Every public method returns outputs `[{to, msg}]` (`to` is a token or 'all')
// and `[{to, close: true, code}]` for sockets the wrapper should close (`code`
// is a CLOSE value). Time comes
// from the injected `now()`; `nextAlarm()` says when `tick()` is next due.
// All room data lives in `this.s`, plain JSON, so the wrapper can persist it.

import { createGame, applyAction, legalActions } from '../src/engine.js';
import { chooseAction } from '../src/ai.js';
import { viewFor, redactAction } from '../src/view.js';

export const TIMERS = [0, 20, 30, 60];   // seconds; 0 = Off
export const REACTIONS = ['smirk', 'think', 'skull', 'rose', 'laugh', 'tomato'];
export const BOTS = [
  { name: 'Panthers', avatar: { emoji: '🐆' } },
  { name: 'Snakes', avatar: { emoji: '🐍' } },
  { name: 'Werewolves', avatar: { emoji: '🐺' } },
  { name: 'Eagles', avatar: { emoji: '🦅' } },
  { name: 'Himself', avatar: { emoji: '🤘' } },
  { name: 'Vipers', avatar: { emoji: '🦂' } },
  { name: 'Ravens', avatar: { emoji: '🐦‍⬛' } },
  { name: 'Jackals', avatar: { emoji: '🦊' } },
];

export const MIN_SEATS = 3, MAX_SEATS = 6;
export const OFF_CLOCK_MS = 30_000;     // disconnected seat's clock when the timer is Off
export const ABANDON_MS = 90_000;       // total disconnected time before forfeit
export const CLEANUP_MS = 60_000;       // room dies this long after the last human is gone
export const NEXT_ROUND_MS = 4_000;
export const GAME_OVER_MS = 4_000;      // game-over view stays up, then back to the lobby
export const REACT_MS = 2_000;
export const BOT_DELAY_MS = [700, 1200];
// Cloudflare can fire an alarm a few ms before the time it was set for; anything
// due this close counts as due, so a timer is never re-armed for the alarm that
// is already running (that alarm is then dropped and the room stalls).
export const DUE_SLACK_MS = 100;
export const DEFAULT_NAME = 'Rider';
export const DEFAULT_AVATAR = { emoji: '💀' };
const NAME_MAX = 16;

// WebSocket close codes the client understands (src/net.js).
export const CLOSE = { left: 1000, replaced: 4000, kicked: 4001, notFound: 4004, full: 4009 };

export const ERR = {
  hello: 'Say hello first',
  bad: 'Bad message',
  host: 'Only the host can do that',
  inGame: 'Game in progress',
  notInGame: 'You are not in this game',
  full: 'Table full',
  needPlayers: 'Need at least 3 players',
  noBot: 'No bot to remove',
  noSeat: 'No such seat',
  illegal: 'Illegal action',
  dead: 'Room closed',
};

const ACTION_KEYS = ['type', 'player', 'card', 'amount', 'target', 'cardIndex'];
const actionKey = a => JSON.stringify(ACTION_KEYS.map(k => a[k] ?? null));

export function cleanName(name) {
  // eslint-disable-next-line no-control-regex
  const n = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return [...n].slice(0, NAME_MAX).join('').trim() || DEFAULT_NAME;
}

// Avatars are opaque small objects ({emoji} now, skull-builder parts later).
// Other keys pass through (capped by size); `emoji` must be one short grapheme
// so a raw client can't put text on the seat cards.
const AVATAR_MAX_JSON = 300;
const EMOJI_MAX = 16;
const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
  ? s => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length
  : s => [...s].length;

export function cleanAvatar(avatar) {
  if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) return { ...DEFAULT_AVATAR };
  let out;
  try {
    const json = JSON.stringify(avatar);
    if (json.length > AVATAR_MAX_JSON) return { ...DEFAULT_AVATAR };
    out = JSON.parse(json);
  } catch {
    return { ...DEFAULT_AVATAR };
  }
  const e = out.emoji;
  const ok = typeof e === 'string' && e.length > 0 && e.length <= EMOJI_MAX && !/\s/.test(e) && graphemes(e) === 1;
  if (!ok) out.emoji = DEFAULT_AVATAR.emoji;
  return out;
}

export class RoomCore {
  constructor({ code = '', now = Date.now, rng = Math.random, snapshot = null } = {}) {
    this.now = now;
    this.rng = rng;
    this.t = now();
    this.out = [];
    this.s = snapshot ? structuredClone(snapshot) : {
      code,
      dead: false,
      seq: 0,
      actionN: 0,
      joinN: 0,
      botN: 0,
      hostToken: null,
      options: { seats: 4, timer: 30, open: true },
      members: {},          // token -> member (humans and bots)
      order: [],            // seated tokens in the lobby (index = seat)
      phase: 'waiting',
      lastWinner: null,
      kicked: [],
      cleanupAt: this.t + CLEANUP_MS,   // nobody ever showed up
      game: null,
    };
  }

  static fromJSON(snapshot, deps = {}) {
    return new RoomCore({ ...deps, snapshot });
  }

  toJSON() {
    return structuredClone(this.s);
  }

  get dead() {
    return this.s.dead;
  }

  // ---------- public events ----------

  handle(token, msg) {
    return this.run(() => {
      if (this.s.dead) return this.error(token, ERR.dead, CLOSE.notFound);
      if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return this.error(token, ERR.bad);
      if (msg.t === 'hello') return this.hello(token, msg);
      const m = this.s.members[token];
      if (!m || m.isBot) return this.error(token, ERR.hello);
      switch (msg.t) {
        case 'lobby': return this.lobbyOp(m, msg);
        case 'action': return this.onAction(m, msg);
        case 'leave': return this.leave(m);
        case 'react': return this.react(m, msg);
        default: return this.error(token, ERR.bad);
      }
    });
  }

  disconnect(token) {
    return this.run(() => {
      const m = this.s.members[token];
      if (!m || m.isBot || !m.connected) return;
      m.connected = false;
      m.discSince = this.t;
      this.broadcastLobby();
      if (this.inGame(m)) this.broadcastViews();
    });
  }

  tick() {
    return this.run(() => {
      for (let guard = 0; guard < 1000 && !this.s.dead; guard++) {
        if (!this.step()) break;
      }
    });
  }

  nextAlarm() {
    const s = this.s;
    if (s.dead) return null;
    const times = [s.cleanupAt];
    for (const m of this.humans()) if (!m.connected) times.push(m.discSince + ABANDON_MS - m.discTotal);
    const g = s.game;
    if (g) {
      times.push(g.overAt, g.nextRoundAt, ...Object.values(g.botDue));
      for (const pid of actors(g.state)) times.push(this.clockAt(pid));
    }
    const due = times.filter(x => typeof x === 'number');
    return due.length ? Math.min(...due) : null;
  }

  // What LobbyDirectory lists: Open rooms in the lobby with someone home.
  listing() {
    const s = this.s;
    if (s.dead || s.phase !== 'waiting' || !s.options.open) return null;
    if (!this.humans().some(m => m.connected)) return null;
    const seated = s.order.map(t => s.members[t]);
    return {
      code: s.code,
      host: s.members[s.hostToken]?.name ?? '',
      humans: seated.filter(m => !m.isBot).length,
      seats: s.options.seats,
      bots: seated.filter(m => m.isBot).length,
      timer: s.options.timer,
    };
  }

  // ---------- plumbing ----------

  run(fn) {
    this.t = this.now();
    this.out = [];
    fn();
    if (!this.s.dead) {
      const home = this.humans().some(m => m.connected);
      if (home) this.s.cleanupAt = null;
      else this.s.cleanupAt ??= this.t + CLEANUP_MS;
    }
    const serverNow = this.t;
    const out = this.out.map(o => (o.msg ? { to: o.to, msg: { ...o.msg, serverNow } } : o));
    this.out = [];
    return out;
  }

  send(to, msg) {
    this.out.push({ to, msg });
  }

  close(to, code) {
    this.out.push({ to, close: true, code });
  }

  error(token, msg, closeCode = null) {
    this.send(token, { t: 'error', msg });
    if (closeCode) this.close(token, closeCode);
  }

  humans() {
    return Object.values(this.s.members).filter(m => !m.isBot);
  }

  // Seated in the running game (not waiting for the rematch).
  inGame(m) {
    return this.s.phase === 'in-game' && !m.waiting && m.seat != null;
  }

  takenNames(except) {
    const names = Object.values(this.s.members).filter(m => m.token !== except).map(m => m.name);
    // A forfeited seat's name is free again (its owner may come back for the rematch).
    if (this.s.game) names.push(...this.s.game.seats.filter(x => !x.forfeited).map(x => x.name));
    return new Set(names.map(n => n.toLowerCase()));
  }

  uniqueName(base, except) {
    const taken = this.takenNames(except);
    if (!taken.has(base.toLowerCase())) return base;
    for (let k = 2; ; k++) {
      const n = `${base} ${k}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  // Lobby seat numbers are positions in `order`; in a game they're player ids.
  reseat() {
    this.s.order.forEach((t, i) => { this.s.members[t].seat = i; });
  }

  // Longest-seated human; late joiners only if nobody else is left.
  pickHost() {
    const sorted = this.humans().sort((a, b) => (a.waiting - b.waiting) || (a.joinedAt - b.joinedAt));
    return sorted[0]?.token ?? null;
  }

  removeMember(token) {
    const s = this.s;
    delete s.members[token];
    const i = s.order.indexOf(token);
    if (i >= 0) {
      s.order.splice(i, 1);
      this.reseat();
    }
    if (s.hostToken === token) s.hostToken = this.pickHost();
  }

  // Lobby only: humans take an empty seat, else a bot's seat, else a new seat.
  seatHuman(m) {
    const s = this.s;
    if (s.order.length >= s.options.seats) {
      const bot = [...s.order].reverse().find(t => s.members[t].isBot);
      if (bot) this.removeMember(bot);
      else if (s.order.length < MAX_SEATS) s.options.seats = s.order.length + 1;
      else return false;
    }
    s.order.push(m.token);
    m.waiting = false;
    this.reseat();
    return true;
  }

  // ---------- hello / leave ----------

  hello(token, msg) {
    const s = this.s;
    if (s.kicked.includes(token)) {
      this.send(token, { t: 'kicked' });
      return this.close(token, CLOSE.kicked);
    }
    let m = s.members[token];
    if (m) {
      if (!m.connected) {
        m.discTotal += this.t - m.discSince;
        m.discSince = null;
        m.connected = true;
      }
      // Name/avatar changes only outside a running game.
      if (!this.inGame(m)) {
        m.name = this.uniqueName(cleanName(msg.name), token);
        m.avatar = cleanAvatar(msg.avatar);
      }
    } else {
      m = {
        token,
        name: this.uniqueName(cleanName(msg.name), token),
        avatar: cleanAvatar(msg.avatar),
        isBot: false,
        connected: true,
        waiting: false,
        seat: null,
        joinedAt: ++s.joinN,
        discSince: null,
        discTotal: 0,
        lastReact: null,
      };
      if (s.phase === 'waiting') {
        s.members[token] = m;
        if (!this.seatHuman(m)) {
          delete s.members[token];
          return this.error(token, ERR.full, CLOSE.full);
        }
      } else {
        if (this.tableCount() >= MAX_SEATS) return this.error(token, ERR.full, CLOSE.full);
        m.waiting = true;
        s.members[token] = m;
      }
      if (!s.members[s.hostToken]) s.hostToken = token;
    }
    this.broadcastLobby();
    if (this.inGame(m)) this.broadcastViews();
  }

  // Humans + bots still in the game + waiting late joiners.
  tableCount() {
    const g = this.s.game;
    const playing = g ? g.seats.filter(x => !x.forfeited).length : this.s.order.length;
    return playing + Object.values(this.s.members).filter(m => m.waiting).length;
  }

  leave(m) {
    const seat = this.inGame(m) ? m.seat : null;
    this.removeMember(m.token);
    if (seat != null) this.forfeitSeat(seat);
    this.close(m.token, CLOSE.left);
    this.broadcastLobby();
    if (this.s.game) this.broadcastViews();
  }

  // Disconnected too long: same as Leave, but they may come back for the rematch.
  abandon(m) {
    const seat = this.inGame(m) ? m.seat : null;
    this.removeMember(m.token);
    if (seat != null) this.forfeitSeat(seat);
    this.broadcastLobby();
    if (this.s.game) this.broadcastViews();
  }

  // ---------- lobby ops (host only) ----------

  lobbyOp(m, msg) {
    const s = this.s;
    if (s.hostToken !== m.token) return this.error(m.token, ERR.host);
    if (s.phase !== 'waiting') return this.error(m.token, ERR.inGame);
    switch (msg.op) {
      case 'options': {
        const o = s.options;
        if (msg.timer !== undefined) {
          if (!TIMERS.includes(msg.timer)) return this.error(m.token, ERR.bad);
          o.timer = msg.timer;
        }
        if (msg.open !== undefined) o.open = !!msg.open;
        if (msg.seats !== undefined) {
          if (!Number.isInteger(msg.seats) || msg.seats < MIN_SEATS || msg.seats > MAX_SEATS) {
            return this.error(m.token, ERR.bad);
          }
          // Shrinking drops bots from the end; humans are never unseated.
          while (s.order.length > msg.seats) {
            const bot = [...s.order].reverse().find(t => s.members[t].isBot);
            if (!bot) break;
            this.removeMember(bot);
          }
          o.seats = Math.max(msg.seats, s.order.length);
        }
        break;
      }
      case 'addBot': {
        if (s.order.length >= MAX_SEATS) return this.error(m.token, ERR.full);
        if (s.order.length >= s.options.seats) s.options.seats = s.order.length + 1;
        const taken = this.takenNames(null);
        const pick = BOTS.find(b => !taken.has(b.name.toLowerCase())) ?? BOTS[s.botN % BOTS.length];
        const bot = {
          token: `bot:${++s.botN}`,
          name: this.uniqueName(pick.name, null),
          avatar: { ...pick.avatar },
          isBot: true,
          connected: true,
          waiting: false,
          seat: null,
          joinedAt: ++s.joinN,
          discSince: null,
          discTotal: 0,
          lastReact: null,
        };
        s.members[bot.token] = bot;
        s.order.push(bot.token);
        this.reseat();
        break;
      }
      case 'removeBot': {
        const t = msg.seat === undefined
          ? [...s.order].reverse().find(x => s.members[x].isBot)
          : s.order[msg.seat];
        if (!t || !s.members[t].isBot) return this.error(m.token, ERR.noBot);
        this.removeMember(t);
        break;
      }
      case 'kick': {
        const t = s.order[msg.seat];
        if (!t || t === m.token) return this.error(m.token, ERR.noSeat);
        if (!s.members[t].isBot) {
          s.kicked.push(t);
          this.send(t, { t: 'kicked' });
          this.close(t, CLOSE.kicked);
        }
        this.removeMember(t);
        break;
      }
      case 'start':
      case 'rematch':
        if (s.order.length < MIN_SEATS) return this.error(m.token, ERR.needPlayers);
        return this.startGame();
      default:
        return this.error(m.token, ERR.bad);
    }
    this.broadcastLobby();
  }

  startGame() {
    const s = this.s;
    const players = s.order.map(t => s.members[t]);
    const state = createGame({
      players: players.map(m => ({ name: m.name, isHuman: !m.isBot })),
      firstPlayer: 'random',
      rng: this.rng,
    });
    s.game = {
      state,
      seats: players.map(m => ({ token: m.token, name: m.name, avatar: m.avatar, isBot: m.isBot, forfeited: false })),
      lastAction: null,
      turnStart: this.t,
      botDue: {},
      nextRoundAt: null,
      overAt: null,
    };
    for (const m of Object.values(s.members)) {
      m.discTotal = 0;
      if (!m.connected) m.discSince = this.t;
    }
    // In a game, seats are player ids (fixed); `order` is rebuilt at game end.
    s.order = [];
    s.phase = 'in-game';
    s.lastWinner = null;
    this.broadcastLobby();
    this.broadcastViews();
    this.advance();
  }

  // Game over (or no humans left): everyone back to the same lobby.
  finishGame() {
    const s = this.s;
    const g = s.game;
    const w = g.state.phase === 'game-over' ? g.seats[g.state.winner] : null;
    s.lastWinner = w ? { seat: g.state.winner, name: w.name, avatar: w.avatar, isBot: w.isBot } : null;
    s.order = g.seats.filter(x => !x.forfeited && s.members[x.token]).map(x => x.token);
    s.game = null;
    s.phase = 'waiting';
    this.reseat();
    const waiting = Object.values(s.members).filter(m => m.waiting).sort((a, b) => a.joinedAt - b.joinedAt);
    for (const m of waiting) if (!this.seatHuman(m)) this.removeMember(m.token);
    for (const m of Object.values(s.members)) {
      m.discTotal = 0;
      if (!m.connected) m.discSince = this.t;
    }
    if (!s.members[s.hostToken]) s.hostToken = this.pickHost();
    this.broadcastLobby();
  }

  // ---------- game ----------

  onAction(m, msg) {
    const g = this.s.game;
    if (!this.inGame(m)) return this.error(m.token, ERR.notInGame);
    const a = msg.action;
    if (!a || typeof a !== 'object' || typeof a.type !== 'string') return this.error(m.token, ERR.illegal);
    const action = { type: a.type, player: m.seat };
    for (const k of ['card', 'amount', 'target', 'cardIndex']) if (a[k] !== undefined) action[k] = a[k];
    const key = actionKey(action);
    const ok = action.type !== 'nextRound' && g.state.phase !== 'game-over' &&
      legalActions(g.state, m.seat).some(l => actionKey(l) === key);
    if (!ok) return this.error(m.token, ERR.illegal);
    this.applyMove(action, false);
    this.advance();
  }

  applyMove(action, auto) {
    const g = this.s.game;
    const prev = g.state.phase;
    g.state = applyAction(g.state, action, this.rng);
    g.lastAction = { ...redactAction(action, { auto }), n: ++this.s.actionN };
    // In place-initial every clock started together, so placing doesn't reset it.
    if (!(prev === 'place-initial' && g.state.phase === 'place-initial')) g.turnStart = this.t;
    this.broadcastViews();
  }

  forfeitSeat(pid) {
    const g = this.s.game;
    g.seats[pid].forfeited = true;
    delete g.botDue[pid];
    if (g.seats.every(x => x.isBot || x.forfeited)) return this.finishGame();
    this.advance();
  }

  // Run whatever needs no waiting: forfeits at round end, instant ⏱ moves of
  // forfeited seats, and bot scheduling. Timed things are left to tick().
  advance() {
    const g = this.s.game;
    for (let guard = 0; guard < 1000 && this.s.game === g; guard++) {
      const st = g.state;
      if (st.phase === 'game-over') {
        g.botDue = {};
        g.overAt ??= this.t + GAME_OVER_MS;
        return;
      }
      if (st.phase === 'round-over') {
        g.botDue = {};
        const pid = g.seats.findIndex((x, i) => x.forfeited && !st.players[i].eliminated);
        if (pid >= 0) {
          g.state = applyAction(st, { type: 'forfeit', player: pid });
          g.lastAction = { type: 'forfeit', player: pid, n: ++this.s.actionN };
          this.broadcastViews();
          continue;
        }
        g.nextRoundAt ??= this.t + NEXT_ROUND_MS;
        return;
      }
      g.nextRoundAt = null;
      const acts = actors(st);
      const f = acts.find(pid => g.seats[pid].forfeited);
      if (f !== undefined) {
        this.applyMove(autoAction(st, f, this.rng), true);
        continue;
      }
      for (const k of Object.keys(g.botDue)) if (!acts.includes(Number(k))) delete g.botDue[k];
      const [lo, hi] = BOT_DELAY_MS;
      for (const pid of acts) {
        if (g.seats[pid].isBot && g.botDue[pid] == null) g.botDue[pid] = this.t + lo + this.rng() * (hi - lo);
      }
      return;
    }
  }

  // When `pid`'s clock runs out, or null if it has none.
  clockAt(pid) {
    const g = this.s.game;
    const seat = g.seats[pid];
    if (seat.isBot || seat.forfeited || !actors(g.state).includes(pid)) return null;
    const m = this.s.members[seat.token];
    if (!m) return null;
    const timer = this.s.options.timer;
    if (timer > 0) return g.turnStart + timer * 1000;
    if (!m.connected) return Math.max(g.turnStart, m.discSince) + OFF_CLOCK_MS;
    return null;
  }

  deadline() {
    const g = this.s.game;
    const ats = {};
    for (const pid of actors(g.state)) {
      const at = this.clockAt(pid);
      if (at != null) ats[pid] = at;
    }
    const players = Object.keys(ats).map(Number);
    if (!players.length) return null;
    return { players, at: Math.min(...Object.values(ats)), ats };
  }

  // One due timer per call; returns false when nothing is due.
  step() {
    const s = this.s;
    const now = this.t + DUE_SLACK_MS;
    if (s.cleanupAt != null && s.cleanupAt <= now) {
      s.dead = true;
      s.game = null;
      this.close('all', CLOSE.notFound);
      return false;
    }
    const gone = this.humans().find(m => !m.connected && now - m.discSince + m.discTotal >= ABANDON_MS);
    if (gone) {
      this.abandon(gone);
      return true;
    }
    const g = s.game;
    if (!g) return false;
    if (g.overAt != null && g.overAt <= now) {
      this.finishGame();
      return true;
    }
    if (g.nextRoundAt != null && g.nextRoundAt <= now) {
      g.nextRoundAt = null;
      this.applyMove({ type: 'nextRound' }, false);
      this.advance();
      return true;
    }
    const due = Object.entries(g.botDue).filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1])[0];
    if (due) {
      const pid = Number(due[0]);
      delete g.botDue[pid];
      const action = chooseAction(g.state, pid, this.rng);
      if (action) this.applyMove(action, false);
      this.advance();
      return true;
    }
    for (const pid of actors(g.state)) {
      const at = this.clockAt(pid);
      if (at != null && at <= now) {
        this.applyMove(autoAction(g.state, pid, this.rng), true);
        this.advance();
        return true;
      }
    }
    return false;
  }

  // ---------- reactions ----------

  react(m, msg) {
    const g = this.s.game;
    if (!this.inGame(m) || !REACTIONS.includes(msg.kind)) return;
    if (m.lastReact != null && this.t - m.lastReact < REACT_MS) return;
    const ev = { t: 'event', e: 'react', from: m.seat, kind: msg.kind };
    if (msg.kind === 'tomato') {
      const target = msg.target;
      if (!Number.isInteger(target) || target === m.seat || !g.seats[target]) return;
      ev.target = target;
    }
    m.lastReact = this.t;
    // Only seated players at the table: lobby members and late joiners have no use for it.
    for (const x of this.humans()) if (x.connected && this.inGame(x)) this.send(x.token, ev);
  }

  // ---------- outgoing ----------

  lobby() {
    const s = this.s;
    const member = (m, seat) => ({
      seat, name: m.name, avatar: m.avatar, isBot: m.isBot, connected: m.connected, waiting: !!m.waiting,
    });
    let members;
    if (s.game) {
      members = s.game.seats
        .map((x, pid) => (!x.forfeited && s.members[x.token] ? member(s.members[x.token], pid) : null))
        .filter(Boolean);
    } else {
      members = s.order.map((t, i) => member(s.members[t], i));
    }
    const waiting = Object.values(s.members).filter(m => m.waiting).sort((a, b) => a.joinedAt - b.joinedAt);
    members.push(...waiting.map(m => member(m, null)));
    const host = s.members[s.hostToken];
    const lobby = {
      code: s.code,
      hostSeat: host && !host.waiting ? host.seat : null,
      options: { ...s.options },
      members,
      phase: s.phase,
    };
    if (s.lastWinner) lobby.lastWinner = s.lastWinner;
    return lobby;
  }

  // Per recipient: `me` is your seat (null while waiting), `meWaiting` whether
  // you're a late joiner waiting for the rematch.
  broadcastLobby() {
    const lobby = this.lobby();
    for (const m of this.humans()) {
      if (!m.connected) continue;
      this.send(m.token, { t: 'lobby', lobby: { ...lobby, me: m.waiting ? null : m.seat, meWaiting: !!m.waiting } });
    }
  }

  broadcastViews() {
    const s = this.s;
    const g = s.game;
    if (!g) return;
    const seq = ++s.seq;
    const deadline = this.deadline();
    const seats = g.seats.map(x => {
      const m = s.members[x.token];
      return {
        name: x.name, avatar: x.avatar, isBot: x.isBot,
        connected: x.isBot || (!x.forfeited && !!m?.connected),
        forfeited: x.forfeited,
      };
    });
    for (const m of this.humans()) {
      if (!m.connected || !this.inGame(m)) continue;
      const view = viewFor(g.state, m.seat);
      view.lastAction = g.lastAction;
      this.send(m.token, { t: 'view', seq, view, seats, deadline });
    }
  }
}

// ---------- game helpers ----------

// Players whose move the game is waiting for.
export function actors(st) {
  switch (st.phase) {
    case 'place-initial':
      return st.players.filter(p => !p.eliminated && p.mat.length === 0).map(p => p.id);
    case 'placement':
    case 'bidding':
    case 'discard':
    case 'choose-first':
      return [st.currentPlayer];
    case 'reveal':
      return [st.challenger];
    default:
      return [];
  }
}

// ⏱ The least interactive legal move (MULTIPLAYER_SPEC §6).
export function autoAction(st, pid, rng = Math.random) {
  const legal = legalActions(st, pid);
  const pick = list => list[Math.min(Math.floor(rng() * list.length), list.length - 1)];
  switch (st.phase) {
    case 'bidding':
      return legal.find(a => a.type === 'pass');
    case 'place-initial':
    case 'placement': {
      const hand = st.players[pid].hand;
      if (hand.length) {
        const card = pick(hand);
        return legal.find(a => (a.type === 'place' || a.type === 'placeInitial') && a.card === card);
      }
      return legal.filter(a => a.type === 'bid').reduce((lo, a) => (a.amount < lo.amount ? a : lo));
    }
    default:
      // reveal (own stack is the only legal target until it's done), discard, choose-first
      return pick(legal);
  }
}
