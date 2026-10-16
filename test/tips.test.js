import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction } from '../src/engine.js';
import {
  tipsEnabled, createTipsDirector, triggeredTips, TIP_TRIGGERS,
  TIPS_OFF_KEY, TIPS_SEEN_KEY, TIPS_GAMES_KEY,
} from '../src/tips.js';

const PLAYERS = n => Array.from({ length: n }, (_, i) => ({ name: i ? `P${i}` : 'You', isHuman: i === 0 }));
const ids = (prev, next) => triggeredTips(prev, next, 0).map(t => t.id);
const run = (s, ...actions) => actions.reduce((st, a) => applyAction(st, a, () => 0), s);
const pi = (player, card = 'rose') => ({ type: 'placeInitial', player, card });

let store;
beforeEach(() => {
  store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
});

describe('tipsEnabled', () => {
  test('on by default, off after tipsOff or one completed tips game', () => {
    assert.equal(tipsEnabled(), true);
    store.set(TIPS_GAMES_KEY, '1');
    assert.equal(tipsEnabled(), false);
    store.delete(TIPS_GAMES_KEY);
    store.set(TIPS_OFF_KEY, '1');
    assert.equal(tipsEnabled(), false);
  });
});

describe('triggers', () => {
  test('first-player: human starts a round', () => {
    const s = createGame({ players: PLAYERS(3), firstPlayer: 0 });
    assert.ok(ids(null, s).includes('first-player'));
    const t = createGame({ players: PLAYERS(3), firstPlayer: 1 });
    assert.ok(!ids(null, t).includes('first-player'));
    // not re-fired by other place-initial moves in the same round
    assert.ok(!ids(s, run(s, pi(1))).includes('first-player'));
  });

  test('max-bid: human can bid the whole table', () => {
    const s0 = createGame({ players: PLAYERS(3), firstPlayer: 1 });
    const placed = run(s0, pi(0), pi(1), pi(2));     // P1 to play
    assert.ok(!ids(s0, placed).includes('max-bid'), 'not the human turn');
    const mine = run(placed, { type: 'bid', player: 1, amount: 1 }, { type: 'pass', player: 2 });
    assert.ok(ids(placed, mine).includes('max-bid'));
    const t = TIP_TRIGGERS['max-bid'](placed, mine, 0);
    assert.match(t.text, /3/);
  });

  test('lost-bet: opponent skull vs own skull', () => {
    const s = run(createGame({ players: PLAYERS(3), firstPlayer: 0 }), pi(0), pi(1, 'skull'), pi(2));
    const rev = run(s, { type: 'bid', player: 0, amount: 3 });
    const own = run(rev, { type: 'reveal', player: 0, target: 0 });
    const lost = run(own, { type: 'reveal', player: 0, target: 1 });
    assert.ok(ids(own, lost).includes('lost-bet'));
    assert.match(TIP_TRIGGERS['lost-bet'](own, lost, 0).text, /P1/);

    const s2 = run(createGame({ players: PLAYERS(3), firstPlayer: 0 }), pi(0, 'skull'), pi(1), pi(2));
    const rev2 = run(s2, { type: 'bid', player: 0, amount: 3 });
    const lost2 = run(rev2, { type: 'reveal', player: 0, target: 0 });
    assert.equal(lost2.phase, 'discard');
    assert.match(TIP_TRIGGERS['lost-bet'](rev2, lost2, 0).text, /You pick/);

    // a bot losing doesn't trigger it
    const s3 = run(createGame({ players: PLAYERS(3), firstPlayer: 1 }), pi(0, 'skull'), pi(1), pi(2));
    const rev3 = run(s3, { type: 'bid', player: 1, amount: 3 }, { type: 'reveal', player: 1, target: 1 });
    const lost3 = run(rev3, { type: 'reveal', player: 1, target: 0 });
    assert.equal(lost3.lastResult.type, 'lost');
    assert.ok(!ids(rev3, lost3).includes('lost-bet'));
  });

  test('elimination and last-card', () => {
    // Human down to one card: losing it eliminates them.
    let s = createGame({ players: PLAYERS(3), firstPlayer: 0 });
    s = structuredClone(s);
    s.players[0].hand = ['rose', 'rose'];
    s = run(s, pi(0), pi(1, 'skull'), pi(2));
    const rev = run(s, { type: 'bid', player: 0, amount: 3 }, { type: 'reveal', player: 0, target: 0 });
    const lost = run(rev, { type: 'reveal', player: 0, target: 1 });
    assert.ok(ids(rev, lost).includes('last-card'));
    assert.ok(!ids(rev, lost).includes('elimination'));

    let t = structuredClone(s);
    t.players[0].hand = [];  // only the card on the mat left
    const rev2 = run(t, { type: 'bid', player: 0, amount: 3 }, { type: 'reveal', player: 0, target: 0 });
    const out = run(rev2, { type: 'reveal', player: 0, target: 1 });
    assert.equal(out.players[0].eliminated, true);
    const tips = triggeredTips(rev2, out, 0);
    const e = tips.find(x => x.id === 'elimination');
    assert.ok(e);
    assert.match(e.text, /Whoever owned that Skull starts/);
    assert.ok(!tips.some(x => x.id === 'last-card'));
  });
});

describe('director', () => {
  function harness() {
    const says = [];
    let resolveLast;
    const coach = {
      say(o) { says.push(o); return new Promise(r => { resolveLast = r; }); },
      hide() {}, onSkip() {}, destroy() {},
    };
    return { says, coach, resolve: v => resolveLast(v) };
  }
  const tick = () => new Promise(r => setImmediate(r));

  test('shows tips once ever, one at a time, as non-blocking tip bubbles', async () => {
    const h = harness();
    const s = createGame({ players: PLAYERS(3), firstPlayer: 0 });
    const d = createTipsDirector();
    d.onStart({ coach: h.coach, getState: () => s, humanId: 0 });
    assert.equal(h.says.length, 1);
    assert.equal(h.says[0].mode, 'tip');
    assert.deepEqual(JSON.parse(store.get(TIPS_SEEN_KEY)), ['first-player']);
    h.resolve(undefined);
    await tick();

    const d2 = createTipsDirector();
    d2.onStart({ coach: h.coach, getState: () => s, humanId: 0 });
    assert.equal(h.says.length, 1, 'seen tips never repeat');
  });

  test("Don't show tips turns them off", async () => {
    const h = harness();
    const s = createGame({ players: PLAYERS(3), firstPlayer: 0 });
    const d = createTipsDirector();
    d.onStart({ coach: h.coach, getState: () => s, humanId: 0 });
    // the coach's link sets the flag, then dismisses the bubble
    store.set(TIPS_OFF_KEY, '1');
    h.resolve(undefined);
    await tick();
    assert.equal(tipsEnabled(), false);
    const lost = structuredClone(s);
    d.onState(s, { ...lost, phase: 'placement', currentPlayer: 0 }, { type: 'x' });
    assert.equal(h.says.length, 1, 'no more tips after opting out');
  });

  test('game over counts a tips game and keeps the default UI', () => {
    const d = createTipsDirector();
    assert.equal(d.onGameOver({}, {}), false);
    assert.equal(store.get(TIPS_GAMES_KEY), '1');
    assert.equal(tipsEnabled(), false);
  });
});
