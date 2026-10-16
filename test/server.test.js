import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ROSE, SKULL, createGame, applyAction, legalActions } from '../src/engine.js';
import {
  RoomCore, actors, autoAction, BOTS, REACTIONS, ERR, CLOSE,
  ABANDON_MS, CLEANUP_MS, NEXT_ROUND_MS, GAME_OVER_MS, OFF_CLOCK_MS,
} from '../worker/room-core.js';

// Deterministic seeded rng (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A room with fake time and fake sockets. `inbox[token]` collects messages.
function harness(seed = 1) {
  const h = { t: 1_000_000, inbox: {}, open: new Set(), closed: {} };
  h.room = new RoomCore({ code: 'KXPQ', now: () => h.t, rng: seeded(seed) });
  h.deliver = out => {
    for (const o of out) {
      if (o.close) {
        assert.ok(Object.values(CLOSE).includes(o.code), `close code ${o.code}`);
        for (const tk of o.to === 'all' ? [...h.open] : [o.to]) h.closed[tk] = o.code;
        if (o.to === 'all') h.open.clear(); else h.open.delete(o.to);
        continue;
      }
      assert.equal(typeof o.msg.serverNow, 'number', 'every message carries serverNow');
      for (const tk of o.to === 'all' ? [...h.open] : [o.to]) (h.inbox[tk] ??= []).push(o.msg);
    }
    return out;
  };
  h.hello = (tk, name, avatar) => {
    h.open.add(tk);
    return h.deliver(h.room.handle(tk, { t: 'hello', name, avatar }));
  };
  h.send = (tk, msg) => h.deliver(h.room.handle(tk, msg));
  h.lobbyOp = (tk, op, extra = {}) => h.send(tk, { t: 'lobby', op, ...extra });
  h.act = (tk, action) => h.send(tk, { t: 'action', action });
  h.drop = tk => {
    h.open.delete(tk);
    return h.deliver(h.room.disconnect(tk));
  };
  // Move the clock forward, firing every alarm on the way.
  h.wait = ms => {
    const end = h.t + ms;
    for (let i = 0; i < 10_000; i++) {
      const at = h.room.nextAlarm();
      if (at == null || at > end) break;
      h.t = Math.max(h.t, at);
      h.deliver(h.room.tick());
    }
    h.t = end;
  };
  h.msgs = (tk, t) => (h.inbox[tk] ?? []).filter(m => m.t === t);
  h.last = (tk, t) => h.msgs(tk, t).at(-1);
  h.lobby = tk => h.last(tk, 'lobby').lobby;
  h.view = tk => h.last(tk, 'view');
  h.state = () => h.room.s.game.state;
  h.seatOf = tk => h.room.s.members[tk].seat;
  h.clear = () => { h.inbox = {}; };
  return h;
}

// Host + humans (+ bots), started.
function started({ humans = 3, bots = 0, timer = 30, seed = 1 } = {}) {
  const h = harness(seed);
  for (let i = 0; i < humans; i++) h.hello(`t${i}`, `H${i}`, { emoji: '🐺' });
  h.lobbyOp('t0', 'options', { timer });
  for (let i = 0; i < bots; i++) h.lobbyOp('t0', 'addBot');
  h.lobbyOp('t0', 'start');
  assert.equal(h.room.s.phase, 'in-game');
  return h;
}

// Play the given seat's legal action matching `pred` (or the first legal one).
function play(h, tk, pred = () => true) {
  const a = legalActions(h.state(), h.seatOf(tk)).find(pred);
  assert.ok(a, `no matching action for ${tk} in ${h.state().phase}`);
  return h.act(tk, a);
}

describe('lobby: hello, names, seats', () => {
  test('first hello is host; seats in join order; name rules and dedupe', () => {
    const h = harness();
    h.hello('a', '  ');
    h.hello('b', 'rider');
    h.hello('c', 'Rider');
    h.hello('d', 'A very long name indeed!!');
    const l = h.lobby('a');
    assert.equal(l.code, 'KXPQ');
    assert.equal(l.hostSeat, 0);
    assert.equal(l.phase, 'waiting');
    assert.deepEqual(l.options, { seats: 4, timer: 30, open: true });
    assert.deepEqual(l.members.map(m => [m.seat, m.name]),
      [[0, 'Rider'], [1, 'rider 2'], [2, 'Rider 3'], [3, 'A very long name']]);
    assert.ok(l.members.every(m => !m.isBot && m.connected && !m.waiting));
    assert.deepEqual(h.room.s.members.a.avatar, { emoji: '💀' }, 'default avatar');
  });

  test('avatar is passed through as an opaque object', () => {
    const h = harness();
    h.hello('a', 'Mo', { shape: 2, hat: 'cap', emoji: '🐍' });
    assert.deepEqual(h.lobby('a').members[0].avatar, { shape: 2, hat: 'cap', emoji: '🐍' });
  });

  test('same token rejoins the same seat; name can change in the lobby', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.drop('a');
    assert.equal(h.lobby('b').members[0].connected, false);
    h.hello('a', 'Moe');
    const l = h.lobby('b');
    assert.equal(l.members.length, 2);
    assert.deepEqual([l.members[0].name, l.members[0].connected], ['Moe', true]);
    assert.equal(l.hostSeat, 0);
  });

  test('messages before hello are rejected', () => {
    const h = harness();
    h.open.add('x');
    h.send('x', { t: 'lobby', op: 'start' });
    assert.equal(h.last('x', 'error').msg, ERR.hello);
    h.send('x', 'nonsense');
    assert.equal(h.last('x', 'error').msg, ERR.bad);
  });

  test('host options: host only, validated, private hides the listing', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.lobbyOp('b', 'options', { timer: 60 });
    assert.equal(h.last('b', 'error').msg, ERR.host);
    h.lobbyOp('a', 'options', { timer: 45 });
    assert.equal(h.last('a', 'error').msg, ERR.bad);
    h.lobbyOp('a', 'options', { seats: 7 });
    assert.equal(h.last('a', 'error').msg, ERR.bad);
    h.lobbyOp('a', 'options', { seats: 5, timer: 0 });
    assert.deepEqual(h.lobby('b').options, { seats: 5, timer: 0, open: true });
    assert.deepEqual(h.room.listing(), { code: 'KXPQ', host: 'Mo', humans: 2, seats: 5, bots: 0, timer: 0 });
    h.lobbyOp('a', 'options', { open: false });
    assert.equal(h.lobby('b').options.open, false);
    assert.equal(h.room.listing(), null);
  });

  test('bots: fixed names/avatars, add/remove, shrinking seats drops bots', () => {
    const h = harness();
    h.hello('a', 'Panthers');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');
    let l = h.lobby('a');
    assert.deepEqual(l.members.slice(1).map(m => [m.name, m.avatar.emoji, m.isBot]),
      [['Snakes', '🐍', true], ['Werewolves', '🐺', true]], 'skips a name a human already has');
    assert.deepEqual(h.room.listing(), { code: 'KXPQ', host: 'Panthers', humans: 1, seats: 4, bots: 2, timer: 30 });
    h.lobbyOp('a', 'removeBot', { seat: 1 });
    assert.deepEqual(h.lobby('a').members.map(m => m.name), ['Panthers', 'Werewolves']);
    h.lobbyOp('a', 'removeBot', { seat: 0 });
    assert.equal(h.last('a', 'error').msg, ERR.noBot);
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');   // table of 4 is full: grows to 5
    l = h.lobby('a');
    assert.equal(l.members.length, 5);
    assert.equal(l.options.seats, 5);
    h.lobbyOp('a', 'options', { seats: 3 });
    l = h.lobby('a');
    assert.equal(l.members.length, 3);
    assert.equal(l.options.seats, 3);
    assert.ok(BOTS.length >= 5);
  });

  test('kick: host only, lobby only; kicked token cannot come back', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.hello('c', 'Al');
    h.lobbyOp('b', 'kick', { seat: 2 });
    assert.equal(h.last('b', 'error').msg, ERR.host);
    h.lobbyOp('a', 'kick', { seat: 0 });
    assert.equal(h.last('a', 'error').msg, ERR.noSeat, 'cannot kick yourself');
    h.lobbyOp('a', 'kick', { seat: 1 });
    assert.ok(h.msgs('b', 'kicked').length === 1);
    assert.ok(!h.open.has('b'), 'socket closed');
    assert.deepEqual(h.lobby('a').members.map(m => [m.seat, m.name]), [[0, 'Mo'], [1, 'Al']]);
    h.hello('b', 'Jo');
    assert.equal(h.msgs('b', 'kicked').length, 2);
    assert.equal(h.lobby('a').members.length, 2);
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'kick', { seat: 2 });
    assert.equal(h.lobby('a').members.length, 2, 'kicking a bot removes it');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'start');
    h.lobbyOp('a', 'kick', { seat: 1 });
    assert.equal(h.last('a', 'error').msg, ERR.inGame, 'no kick mid-game');
  });

  test('host leaving passes host to the longest-seated human', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.hello('c', 'Al');
    h.send('a', { t: 'leave' });
    assert.ok(!h.open.has('a'));
    const l = h.lobby('c');
    assert.deepEqual(l.members.map(m => m.name), ['Jo', 'Al']);
    assert.equal(l.hostSeat, 0);
    assert.equal(h.room.s.hostToken, 'b');
  });

  test('host transfer mid-game when the host leaves', () => {
    const h = started({ humans: 3 });
    h.send('t0', { t: 'leave' });
    assert.equal(h.room.s.hostToken, 't1');
    assert.equal(h.lobby('t2').hostSeat, h.seatOf('t1'));
  });

  test('start: host only, needs 3 seats, 1 human + bots is fine, random first player', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.lobbyOp('b', 'start');
    assert.equal(h.last('b', 'error').msg, ERR.host);
    h.lobbyOp('a', 'start');
    assert.equal(h.last('a', 'error').msg, ERR.needPlayers);
    h.send('b', { t: 'leave' });
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'start');
    assert.equal(h.lobby('a').phase, 'in-game');
    assert.equal(h.room.listing(), null, 'in-game rooms are not listed');
    const firsts = new Set();
    for (let seed = 1; seed <= 30; seed++) firsts.add(started({ seed }).state().firstPlayer);
    assert.equal(firsts.size, 3);
  });
});

describe('table full and late joiners', () => {
  test('a human takes a bot seat when the table is full, else the table grows to 6', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');
    h.lobbyOp('a', 'addBot');
    h.hello('b', 'Jo');
    let l = h.lobby('a');
    assert.equal(l.members.filter(m => m.isBot).length, 2);
    assert.equal(l.members.length, 4);
    for (const tk of ['c', 'd', 'e', 'f']) h.hello(tk, tk);
    l = h.lobby('a');
    assert.equal(l.members.length, 6);
    assert.equal(l.members.filter(m => m.isBot).length, 0);
    assert.equal(l.options.seats, 6);
    h.hello('g', 'g');
    assert.equal(h.last('g', 'error').msg, ERR.full);
    assert.ok(!h.open.has('g'));
    assert.equal(h.lobby('a').members.length, 6);
  });

  test('in-game: late joiners wait; humans + bots + waiting <= 6; seated after the game', () => {
    const h = started({ humans: 2, bots: 2 });
    h.hello('w1', 'Late');
    h.hello('w2', 'Later');
    h.hello('w3', 'Latest');
    assert.equal(h.last('w3', 'error').msg, ERR.full);
    const l = h.lobby('t0');
    assert.deepEqual(l.members.filter(m => m.waiting).map(m => [m.name, m.seat]), [['Late', null], ['Later', null]]);
    assert.equal(h.msgs('w1', 'view').length, 0, 'waiting players get no views');
    // Play the game out on timeouts.
    h.wait(30 * 60_000);
    const back = h.lobby('w1');
    assert.equal(back.phase, 'waiting');
    assert.ok(back.lastWinner && typeof back.lastWinner.name === 'string');
    // The table of 4 was full, so the late joiners take the bots' seats.
    assert.deepEqual(back.members.map(m => [m.seat, m.name, m.waiting]),
      [[0, 'H0', false], [1, 'H1', false], [2, 'Late', false], [3, 'Later', false]]);
  });
});

describe('game: actions and views', () => {
  test('views are per player, filtered, with seats, seq and deadline', () => {
    const h = started({ humans: 3 });
    const v0 = h.view('t0');
    const me = h.seatOf('t0');
    assert.equal(v0.view.me, me);
    assert.equal(v0.view.players[me].hand.length, 4);
    assert.ok(v0.view.players[me].hand.every(c => c === ROSE || c === SKULL));
    for (const p of v0.view.players) if (p.id !== me) assert.ok(p.hand.every(c => c === null));
    assert.equal(v0.seats.length, 3);
    assert.deepEqual(Object.keys(v0.seats[0]).sort(), ['avatar', 'connected', 'forfeited', 'isBot', 'name']);
    assert.deepEqual(v0.deadline.players.sort(), [0, 1, 2], 'place-initial: every unplaced player has a clock');
    assert.equal(v0.deadline.at, h.t + 30_000);
    const seq0 = v0.seq;
    play(h, 't0', a => a.card === SKULL);
    const v1 = h.view('t1');
    assert.ok(v1.seq > seq0);
    assert.deepEqual(v1.view.lastAction, { type: 'placeInitial', player: me, n: 1 }, 'no card face');
    assert.deepEqual(v1.view.players[me].mat, [null]);
    assert.deepEqual(h.view('t0').view.players[me].mat, [SKULL]);
    assert.equal(h.view('t1').deadline.players.includes(me), false);
  });

  test('illegal actions are rejected; action.player is overwritten', () => {
    const h = started({ humans: 3 });
    play(h, 't0');
    const before = h.state();
    h.act('t0', { type: 'placeInitial', card: ROSE });
    assert.equal(h.last('t0', 'error').msg, ERR.illegal, 'already placed');
    h.act('t1', { type: 'bid', amount: 1 });
    assert.equal(h.last('t1', 'error').msg, ERR.illegal);
    h.act('t1', { type: 'nextRound' });
    assert.equal(h.last('t1', 'error').msg, ERR.illegal);
    h.act('t1', null);
    assert.equal(h.last('t1', 'error').msg, ERR.illegal);
    assert.equal(h.state(), before);
    // Claims to be t0, but plays as t1's seat.
    h.act('t1', { type: 'placeInitial', player: h.seatOf('t0'), card: ROSE });
    assert.equal(h.state().players[h.seatOf('t1')].mat.length, 1);
    h.lobbyOp('t0', 'options', { timer: 60 });
    assert.equal(h.last('t0', 'error').msg, ERR.inGame);
  });

  test('bots play with a 700–1200ms delay', () => {
    const h = started({ humans: 1, bots: 2 });
    const due = Object.values(h.room.s.game.botDue);
    assert.equal(due.length, 2);
    for (const at of due) assert.ok(at - h.t >= 700 && at - h.t <= 1200);
    h.wait(699);
    assert.ok(h.state().players.every(p => p.mat.length === 0));
    h.wait(501);
    assert.equal(h.state().players.filter(p => p.mat.length === 1).length, 2);
  });

  test('next round starts ~4s after round-over, server-timed', () => {
    const h = started({ humans: 3, timer: 20 });
    for (let i = 0; i < 200 && h.state().phase !== 'round-over'; i++) h.wait(20_000);
    assert.equal(h.state().phase, 'round-over');
    const round = h.state().round;
    h.wait(NEXT_ROUND_MS - 1);
    assert.equal(h.state().phase, 'round-over');
    h.wait(1);
    assert.equal(h.state().round, round + 1);
    assert.equal(h.view('t0').view.lastAction.type, 'nextRound');
  });

  test('a full game on timeouts ends back in the lobby; rematch keeps seats and options', () => {
    const h = started({ humans: 3, bots: 1, timer: 20, seed: 7 });
    for (let i = 0; i < 1000 && h.state()?.phase !== 'game-over' && h.room.s.game; i++) h.wait(1000);
    assert.equal(h.state().phase, 'game-over');
    const winner = h.state().winner;
    const left = h.room.s.game.overAt - h.t;
    assert.ok(left > 0 && left <= GAME_OVER_MS);
    h.wait(left - 1);
    assert.equal(h.room.s.phase, 'in-game', 'game-over view stays up first');
    h.wait(1);
    const l = h.lobby('t1');
    assert.equal(l.phase, 'waiting');
    assert.equal(l.lastWinner.seat, winner);
    assert.equal(l.members.length, 4);
    assert.equal(h.room.listing()?.code, 'KXPQ', 'listed again');
    h.lobbyOp('t1', 'rematch');
    assert.equal(h.last('t1', 'error').msg, ERR.host);
    h.lobbyOp('t0', 'rematch');
    assert.equal(h.lobby('t1').phase, 'in-game');
    assert.equal(h.state().round, 1);
    assert.equal(h.room.s.options.timer, 20);
  });
});

describe('timers and ⏱ auto moves', () => {
  test('timeout in place-initial: every unplaced player gets an auto placeInitial', () => {
    const h = started({ humans: 3, timer: 20 });
    play(h, 't0');
    h.wait(19_999);
    assert.equal(h.state().phase, 'place-initial');
    h.wait(1);
    assert.equal(h.state().phase, 'placement');
    assert.equal(h.view('t0').view.lastAction.auto, true);
    assert.equal(h.view('t0').view.lastAction.type, 'placeInitial');
  });

  test('clock resets per move outside place-initial', () => {
    const h = started({ humans: 3, timer: 20 });
    h.wait(20_000);
    const cur = h.state().currentPlayer;
    const tk = h.room.s.game.seats[cur].token;
    assert.equal(h.view(tk).deadline.at, h.t + 20_000);
    assert.deepEqual(h.view(tk).deadline.players, [cur]);
    h.wait(10_000);
    play(h, tk, a => a.type === 'place');
    const next = h.state().currentPlayer;
    assert.deepEqual(h.view(tk).deadline, { players: [next], at: h.t + 20_000, ats: { [next]: h.t + 20_000 } });
  });

  test('timer Off: connected players have no clock', () => {
    const h = started({ humans: 3, timer: 0 });
    assert.equal(h.view('t0').deadline, null);
    h.wait(10 * 60_000);
    assert.equal(h.state().phase, 'place-initial');
  });

  test('timer Off + disconnected: 30s clock, cleared on reconnect', () => {
    const h = started({ humans: 3, timer: 0 });
    h.wait(5_000);
    h.drop('t1');
    const s1 = h.seatOf('t1');
    const d = h.view('t0').deadline;
    assert.deepEqual(d.players, [s1]);
    assert.equal(d.at, h.t + OFF_CLOCK_MS);
    assert.equal(h.view('t0').seats[s1].connected, false);
    h.wait(10_000);
    h.hello('t1', 'H1');
    assert.equal(h.view('t1').deadline, null, 'back in time: plays own turn');
    h.drop('t1');
    h.wait(OFF_CLOCK_MS);
    assert.equal(h.state().players[s1].mat.length, 1, '⏱ auto move for the disconnected seat');
    assert.deepEqual(h.view('t0').view.lastAction, { type: 'placeInitial', player: s1, auto: true, n: 1 });
  });

  test('disconnect keeps the normal clock; reconnecting in time plays your own turn', () => {
    const h = started({ humans: 3, timer: 30 });
    h.drop('t2');
    h.wait(10_000);
    h.hello('t2', 'H2');
    assert.equal(h.view('t2').view.me, h.seatOf('t2'), 'same seat after rejoin');
    play(h, 't2', a => a.card === ROSE);
    assert.equal(h.view('t0').view.lastAction.auto, undefined);
  });

  test('autoAction follows §6 in every phase', () => {
    const rng = seeded(3);
    const P = n => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isHuman: true }));
    let s = createGame({ players: P(3), firstPlayer: 0 });
    // place-initial: a card from hand
    let a = autoAction(s, 1, rng);
    assert.equal(a.type, 'placeInitial');
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'placeInitial', player: i, card: i === 2 ? SKULL : ROSE });
    // placement with cards: place
    a = autoAction(s, 0, rng);
    assert.equal(a.type, 'place');
    // placement with an empty hand: minimum bid
    const empty = structuredClone(s);
    empty.players[0].mat.push(...empty.players[0].hand);
    empty.players[0].hand = [];
    assert.deepEqual(autoAction(empty, 0, rng), { type: 'bid', player: 0, amount: 1 });
    // bidding: pass
    s = applyAction(s, { type: 'bid', player: 0, amount: 2 });
    assert.deepEqual(autoAction(s, 1, rng), { type: 'pass', player: 1 });
    s = applyAction(s, { type: 'pass', player: 1 });
    s = applyAction(s, { type: 'pass', player: 2 });
    // reveal: own stack first, then a random opponent stack
    assert.deepEqual(autoAction(s, 0, rng), { type: 'reveal', player: 0, target: 0 });
    s = applyAction(s, { type: 'reveal', player: 0, target: 0 });
    const targets = new Set();
    for (let i = 0; i < 40; i++) targets.add(autoAction(s, 0, rng).target);
    assert.deepEqual([...targets].sort(), [1, 2]);
    // discard: random card
    let d = createGame({ players: P(3), firstPlayer: 0 });
    for (let i = 0; i < 3; i++) d = applyAction(d, { type: 'placeInitial', player: i, card: i === 0 ? SKULL : ROSE });
    d = applyAction(d, { type: 'bid', player: 0, amount: 1 });
    d = applyAction(d, { type: 'pass', player: 1 });
    d = applyAction(d, { type: 'pass', player: 2 });
    d = applyAction(d, { type: 'reveal', player: 0, target: 0 });
    assert.equal(d.phase, 'discard');
    const idx = new Set();
    for (let i = 0; i < 40; i++) idx.add(autoAction(d, 0, rng).cardIndex);
    assert.equal(idx.size, 4);
    // choose-first: random active player
    const c = structuredClone(d);
    c.phase = 'choose-first';
    const picks = new Set();
    for (let i = 0; i < 40; i++) picks.add(autoAction(c, 0, rng).target);
    assert.deepEqual([...picks].sort(), [0, 1, 2]);
    assert.deepEqual(actors(c), [0]);
    assert.deepEqual(actors(s), [0]);
  });
});

describe('disconnects, abandon, forfeit', () => {
  test('90s disconnected in total -> forfeit; plays out the round on instant ⏱ moves; eliminated at round end', () => {
    const h = started({ humans: 4, timer: 60 });
    const s3 = h.seatOf('t3');
    h.drop('t3');
    h.wait(50_000);
    h.hello('t3', 'H3');
    h.drop('t3');
    h.wait(39_999);
    assert.equal(h.room.s.game.seats[s3].forfeited, false);
    h.wait(1);
    assert.equal(h.room.s.game.seats[s3].forfeited, true, '50s + 40s = abandon');
    assert.equal(h.view('t0').seats[s3].forfeited, true);
    assert.equal(h.view('t0').seats[s3].connected, false);
    assert.equal(h.lobby('t0').members.some(m => m.name === 'H3'), false);
    // Its seat now moves instantly, without a clock.
    assert.equal(h.state().players[s3].mat.length, 1);
    assert.equal(h.view('t0').deadline?.players.includes(s3) ?? false, false);
    // Drive to round end: forfeit applied there.
    for (let i = 0; i < 5000 && h.state().phase !== 'round-over' && h.state().phase !== 'game-over'; i++) h.wait(1000);
    assert.equal(h.state().players[s3].eliminated, true);
    assert.ok(h.msgs('t0', 'view').some(v => v.view.lastAction?.type === 'forfeit' && v.view.lastAction.player === s3));
    // They can come back to the lobby for the rematch.
    h.hello('t3', 'H3');
    assert.equal(h.lobby('t3').members.find(m => m.name === 'H3').waiting, true);
    assert.equal(h.msgs('t3', 'view').length > 0, true, 'old views from before');
  });

  test('Leave mid-round = forfeit; when already between rounds it applies at once', () => {
    const h = started({ humans: 3, bots: 1, timer: 20 });
    for (let i = 0; i < 5000 && h.state().phase !== 'round-over'; i++) h.wait(500);
    assert.equal(h.state().phase, 'round-over');
    const s2 = h.seatOf('t2');
    h.send('t2', { t: 'leave' });
    assert.ok(!h.open.has('t2'));
    assert.equal(h.state().players[s2].eliminated, true);
    assert.deepEqual(h.view('t0').view.lastAction, { type: 'forfeit', player: s2, n: h.room.s.actionN });
  });

  test('Leave during a turn: the seat auto-moves instantly', () => {
    const h = started({ humans: 3, timer: 60 });
    h.wait(60_000);   // everyone auto-placed; placement begins
    const cur = h.state().currentPlayer;
    const tk = h.room.s.game.seats[cur].token;
    h.send(tk, { t: 'leave' });
    assert.notEqual(h.state().currentPlayer, cur, 'moved on without waiting');
    assert.equal(h.view('t0').view.lastAction.auto ?? h.room.s.game.lastAction.auto, true);
  });

  test('the last human leaving ends the game', () => {
    const h = started({ humans: 1, bots: 2 });
    h.hello('w', 'Late');
    h.send('t0', { t: 'leave' });
    assert.equal(h.room.s.phase, 'waiting');
    assert.equal(h.room.s.game, null);
    const l = h.lobby('w');
    assert.equal(l.phase, 'waiting');
    assert.equal(l.lastWinner, undefined);
    assert.deepEqual(l.members.map(m => m.name).sort(), ['Late', 'Snakes', 'Panthers'].sort());
    assert.equal(h.room.s.hostToken, 'w');
  });

  test('forfeited seats are freed at game over', () => {
    const h = started({ humans: 4, timer: 20, seed: 5 });
    h.send('t3', { t: 'leave' });
    for (let i = 0; i < 2000 && h.room.s.phase === 'in-game'; i++) h.wait(1000);
    const l = h.lobby('t0');
    assert.equal(l.phase, 'waiting');
    assert.deepEqual(l.members.map(m => m.name), ['H0', 'H1', 'H2']);
  });

  test('lobby: 90s disconnected frees the seat', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.drop('a');
    h.wait(ABANDON_MS);
    const l = h.lobby('b');
    assert.deepEqual(l.members.map(m => m.name), ['Jo']);
    assert.equal(l.hostSeat, 0);
  });
});

describe('reactions', () => {
  test('allowlisted kinds, 1 per player per 2s, tomato needs a target', () => {
    const h = started({ humans: 3 });
    const me = h.seatOf('t0');
    const other = h.seatOf('t1');
    h.send('t0', { t: 'react', kind: 'smirk' });
    assert.deepEqual(
      (({ t, e, from, kind }) => ({ t, e, from, kind }))(h.last('t1', 'event')),
      { t: 'event', e: 'react', from: me, kind: 'smirk' });
    h.send('t0', { t: 'react', kind: 'laugh' });
    assert.equal(h.msgs('t1', 'event').length, 1, 'rate limited');
    h.wait(2000);
    h.send('t0', { t: 'react', kind: 'banana' });
    assert.equal(h.msgs('t1', 'event').length, 1, 'unknown kind dropped');
    h.send('t0', { t: 'react', kind: 'tomato' });
    h.send('t0', { t: 'react', kind: 'tomato', target: me });
    h.send('t0', { t: 'react', kind: 'tomato', target: 9 });
    assert.equal(h.msgs('t1', 'event').length, 1, 'bad tomato target dropped');
    h.send('t0', { t: 'react', kind: 'tomato', target: other });
    assert.equal(h.last('t2', 'event').target, other);
    for (const k of REACTIONS) assert.equal(typeof k, 'string');
  });
});

describe('room lifecycle', () => {
  test('room dies 60s after the last human is gone; reconnecting cancels it', () => {
    const h = harness();
    h.wait(CLEANUP_MS - 1);
    assert.equal(h.room.dead, false);
    h.hello('a', 'Mo');
    h.lobbyOp('a', 'addBot');
    assert.ok(h.room.listing());
    h.drop('a');
    assert.equal(h.room.listing(), null, 'unlisted at once');
    h.wait(30_000);
    h.hello('a', 'Mo');
    h.drop('a');
    h.wait(CLEANUP_MS - 1);
    assert.equal(h.room.dead, false);
    h.wait(1);
    assert.equal(h.room.dead, true);
    assert.equal(h.room.nextAlarm(), null);
    h.hello('a', 'Mo');
    assert.equal(h.last('a', 'error').msg, ERR.dead);
  });

  test('a fresh room nobody joins dies after 60s', () => {
    const h = harness();
    h.wait(CLEANUP_MS);
    assert.equal(h.room.dead, true);
  });

  test('snapshot round trip resumes the same game', () => {
    const h = started({ humans: 2, bots: 1, timer: 20 });
    h.wait(5_000);
    const copy = RoomCore.fromJSON(JSON.parse(JSON.stringify(h.room.toJSON())), { now: () => h.t, rng: seeded(9) });
    assert.deepEqual(copy.toJSON(), h.room.toJSON());
    assert.equal(copy.nextAlarm(), h.room.nextAlarm());
    h.room = copy;
    for (let i = 0; i < 2000 && h.room.s.phase === 'in-game'; i++) h.wait(1000);
    assert.equal(h.lobby('t0').phase, 'waiting');
  });
});

describe('client requests (NOTES.md, net agent)', () => {
  test('serverNow is on every message type, including error and kicked', () => {
    const h = started({ humans: 3 });
    h.hello('k', 'Late');
    h.send('t0', { t: 'react', kind: 'skull' });
    h.act('t1', { type: 'bid', amount: 99 });
    const all = Object.values(h.inbox).flat();
    for (const t of ['lobby', 'view', 'event', 'error']) {
      const ms = all.filter(m => m.t === t);
      assert.ok(ms.length > 0, `saw ${t}`);
      for (const m of ms) assert.equal(m.serverNow, h.t, `${t} has serverNow`);
    }
    const k = harness();
    k.hello('a', 'Mo');
    k.hello('b', 'Jo');
    k.lobbyOp('a', 'kick', { seat: 1 });
    assert.equal(typeof k.last('b', 'kicked').serverNow, 'number');
  });

  test('close codes: kicked 4001, full 4009, left 1000, room closed 4004', () => {
    const h = harness();
    h.hello('a', 'Mo');
    h.hello('b', 'Jo');
    h.lobbyOp('a', 'kick', { seat: 1 });
    assert.equal(h.closed.b, CLOSE.kicked);
    for (const tk of ['c', 'd', 'e', 'f', 'g']) h.hello(tk, tk);
    h.hello('x', 'x');
    assert.match(h.last('x', 'error').msg, /full/i);
    assert.equal(h.closed.x, CLOSE.full);
    h.send('c', { t: 'leave' });
    assert.equal(h.closed.c, CLOSE.left);
    for (const tk of ['a', 'd', 'e', 'f', 'g']) h.drop(tk);
    h.wait(CLEANUP_MS);
    assert.equal(h.room.dead, true);
    h.hello('a', 'Mo');
    assert.equal(h.closed.a, CLOSE.notFound);
  });

  test('seq is monotonic for the room lifetime: across rematches and a persist/restore', () => {
    const h = started({ humans: 2, bots: 1, timer: 20, seed: 4 });
    const seen = [];
    const record = () => { for (const v of h.msgs('t0', 'view')) seen.push(v.seq); h.inbox.t0 = []; };
    for (let game = 0; game < 2; game++) {
      for (let i = 0; i < 3000 && h.room.s.phase === 'in-game'; i++) {
        h.wait(1000);
        if (i === 50) {
          // Hibernation/eviction: the DO rebuilds the core from its stored JSON.
          record();
          h.room = RoomCore.fromJSON(JSON.parse(JSON.stringify(h.room.toJSON())), { now: () => h.t, rng: seeded(game) });
          h.drop('t0');
          h.hello('t0', 'H0');
        }
      }
      record();
      assert.equal(h.room.s.phase, 'waiting');
      h.lobbyOp('t0', 'rematch');
    }
    record();
    assert.ok(seen.length > 20);
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `seq ${seen[i]} after ${seen[i - 1]}`);
  });
});
