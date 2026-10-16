import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ROSE, SKULL, createGame, applyAction } from '../src/engine.js';
import { chooseAction } from '../src/ai.js';
import { viewFor, redactAction } from '../src/view.js';

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

const PLAYERS = n => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isHuman: false }));

// Every view of `s` must hide exactly what its viewer may not know.
function checkViews(s) {
  for (const me of s.players.map(p => p.id)) {
    const v = viewFor(s, me);
    assert.equal(v.me, me);
    assert.equal(v.players.length, s.players.length);
    for (const [i, p] of v.players.entries()) {
      const real = s.players[i];
      assert.equal(p.hand.length, real.hand.length, 'hand count kept');
      assert.equal(p.mat.length, real.mat.length, 'mat count kept');
      if (i === me) {
        assert.deepEqual(p.hand, real.hand);
        assert.deepEqual(p.mat, real.mat);
        continue;
      }
      assert.ok(p.hand.every(c => c === null), 'other hand hidden');
      const hidden = real.mat.length - real.revealed;
      for (const [j, c] of p.mat.entries()) {
        if (j < hidden) assert.equal(c, null, 'unrevealed card hidden');
        else assert.equal(c, real.mat[j], 'revealed card public');
      }
    }
    if (s.lastResult) {
      if (me === s.lastResult.challenger) assert.equal(v.lastResult.discarded, s.lastResult.discarded);
      else assert.ok(!('discarded' in v.lastResult), 'discarded only for challenger');
    }
    // Nothing else differs from the real state.
    const strip = x => {
      const c = structuredClone(x);
      for (const p of c.players) { delete p.hand; delete p.mat; }
      if (c.lastResult) delete c.lastResult.discarded;
      delete c.me;
      return c;
    };
    assert.deepEqual(strip(v), strip(s));
  }
}

describe('viewFor', () => {
  test('hides other hands and unrevealed mat cards, keeps own', () => {
    let s = createGame({ players: PLAYERS(3) });
    s = applyAction(s, { type: 'placeInitial', player: 0, card: SKULL });
    s = applyAction(s, { type: 'placeInitial', player: 1, card: ROSE });
    const v = viewFor(s, 1);
    assert.deepEqual(v.players[0].mat, [null]);
    assert.deepEqual(v.players[0].hand, [null, null, null]);
    assert.deepEqual(v.players[1].mat, [ROSE]);
    assert.equal(v.players[1].hand.length, 3);
    assert.deepEqual(v.players[2].hand, [null, null, null, null]);
    assert.equal(s.players[0].mat[0], SKULL, 'input untouched');
  });

  test('accepts a viewer with no seat (sees no faces)', () => {
    let s = createGame({ players: PLAYERS(3) });
    s = applyAction(s, { type: 'placeInitial', player: 0, card: SKULL });
    const v = viewFor(s, null);
    assert.equal(v.me, null);
    assert.ok(v.players.every(p => p.hand.every(c => c === null) && p.mat.every(c => c === null)));
  });

  test('fuzz: 100 bot games, no hidden face ever leaks into any view', () => {
    let discards = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const rng = seeded(seed);
      const n = 3 + (seed % 4);
      let s = createGame({ players: PLAYERS(n), firstPlayer: 'random', rng });
      checkViews(s);
      for (let steps = 0; s.phase !== 'game-over'; steps++) {
        assert.ok(steps < 2000, 'game terminates');
        let a;
        if (s.phase === 'round-over') a = { type: 'nextRound' };
        else if (s.phase === 'place-initial') {
          const id = s.players.find(p => !p.eliminated && p.mat.length === 0).id;
          a = chooseAction(s, id, rng);
        } else a = chooseAction(s, s.currentPlayer, rng);
        s = applyAction(s, a, rng);
        if (s.lastResult?.discarded) discards++;
        checkViews(s);
      }
    }
    assert.ok(discards > 0, 'discard visibility exercised');
  });
});

describe('redactAction', () => {
  test('strips card faces and hand positions, flags auto moves', () => {
    assert.deepEqual(redactAction({ type: 'place', player: 1, card: SKULL }), { type: 'place', player: 1 });
    assert.deepEqual(redactAction({ type: 'placeInitial', player: 1, card: ROSE }, { auto: true }),
      { type: 'placeInitial', player: 1, auto: true });
    assert.deepEqual(redactAction({ type: 'discard', player: 2, cardIndex: 0 }), { type: 'discard', player: 2 });
    assert.deepEqual(redactAction({ type: 'bid', player: 0, amount: 3 }), { type: 'bid', player: 0, amount: 3 });
    assert.deepEqual(redactAction({ type: 'reveal', player: 0, target: 2 }, { auto: true }),
      { type: 'reveal', player: 0, target: 2, auto: true });
    assert.equal(redactAction(null), null);
  });
});
