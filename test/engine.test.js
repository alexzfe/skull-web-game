import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROSE, SKULL, createGame, totalOnMats, legalActions, applyAction, activePlayers, nextActive, possessive,
} from '../src/engine.js';

const PLAYERS = n => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, isHuman: i === 0 }));

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

const act = (s, a, rng) => applyAction(s, a, rng);

// Everyone places `cards[i]` as initial card.
function placeAll(s, cards) {
  for (let i = 0; i < s.players.length; i++) {
    if (s.players[i].eliminated) continue;
    s = act(s, { type: 'placeInitial', player: i, card: cards[i] ?? ROSE });
  }
  return s;
}

// Build a game already in placement with given initial cards.
function inPlacement(n = 3, cards = [], firstPlayer = 0) {
  return placeAll(createGame({ players: PLAYERS(n), firstPlayer }), cards);
}

function sameActions(actual, expected) {
  const norm = l => l.map(a => JSON.stringify(a)).sort();
  assert.deepEqual(norm(actual), norm(expected));
}

describe('createGame', () => {
  test('initial state shape', () => {
    const s = createGame({ players: PLAYERS(4), firstPlayer: 2 });
    assert.equal(s.players.length, 4);
    for (const [i, p] of s.players.entries()) {
      assert.equal(p.id, i);
      assert.equal(p.name, `P${i}`);
      assert.deepEqual([...p.hand].sort(), [ROSE, ROSE, ROSE, SKULL].sort());
      assert.deepEqual(p.mat, []);
      assert.equal(p.revealed, 0);
      assert.equal(p.wins, 0);
      assert.equal(p.eliminated, false);
      assert.equal(p.passed, false);
    }
    assert.equal(s.players[0].isHuman, true);
    assert.equal(s.players[1].isHuman, false);
    assert.equal(s.phase, 'place-initial');
    assert.equal(s.firstPlayer, 2);
    assert.equal(s.currentPlayer, 2);
    assert.equal(s.bid, null);
    assert.equal(s.challenger, null);
    assert.equal(s.revealedCount, 0);
    assert.equal(s.revealedSkullOwner, null);
    assert.equal(s.lastResult, null);
    assert.equal(s.winner, null);
    assert.equal(s.round, 1);
    assert.ok(Array.isArray(s.log));
  });

  test('defaults firstPlayer to 0', () => {
    assert.equal(createGame({ players: PLAYERS(3) }).firstPlayer, 0);
  });

  test('rejects bad player counts and firstPlayer', () => {
    assert.throws(() => createGame({ players: PLAYERS(1) }));
    assert.throws(() => createGame({ players: PLAYERS(7) }));
    assert.throws(() => createGame({ players: PLAYERS(3), firstPlayer: 3 }));
  });

  test('state is JSON serialisable', () => {
    const s = createGame({ players: PLAYERS(3) });
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });
});

describe('helpers', () => {
  test('totalOnMats / activePlayers / nextActive', () => {
    let s = inPlacement(4);
    assert.equal(totalOnMats(s), 4);
    s = structuredClone(s);
    s.players[1].eliminated = true;
    s.players[2].eliminated = true;
    assert.deepEqual(activePlayers(s), [0, 3]);
    assert.equal(nextActive(s, 0), 3);
    assert.equal(nextActive(s, 3), 0);
    assert.equal(nextActive(s, 1), 3);
  });
});

describe('place-initial', () => {
  test('every active player may place, in any order', () => {
    const s = createGame({ players: PLAYERS(3), firstPlayer: 1 });
    for (let i = 0; i < 3; i++) {
      sameActions(legalActions(s, i), [
        { type: 'placeInitial', player: i, card: ROSE },
        { type: 'placeInitial', player: i, card: SKULL },
      ]);
    }
  });

  test('cannot place twice; moves to placement when all placed', () => {
    let s = createGame({ players: PLAYERS(3), firstPlayer: 1 });
    s = act(s, { type: 'placeInitial', player: 2, card: SKULL });
    assert.deepEqual(s.players[2].mat, [SKULL]);
    assert.equal(s.players[2].hand.length, 3);
    assert.ok(!s.players[2].hand.includes(SKULL));
    assert.deepEqual(legalActions(s, 2), []);
    assert.throws(() => act(s, { type: 'placeInitial', player: 2, card: ROSE }));
    s = act(s, { type: 'placeInitial', player: 0, card: ROSE });
    assert.equal(s.phase, 'place-initial');
    s = act(s, { type: 'placeInitial', player: 1, card: ROSE });
    assert.equal(s.phase, 'placement');
    assert.equal(s.currentPlayer, 1);
  });

  test('cannot place a card not in hand', () => {
    let s = createGame({ players: PLAYERS(3) });
    s = structuredClone(s);
    s.players[0].hand = [ROSE, ROSE];
    assert.throws(() => act(s, { type: 'placeInitial', player: 0, card: SKULL }));
    sameActions(legalActions(s, 0), [{ type: 'placeInitial', player: 0, card: ROSE }]);
  });

  test('other action types rejected', () => {
    const s = createGame({ players: PLAYERS(3) });
    assert.throws(() => act(s, { type: 'place', player: 0, card: ROSE }));
    assert.throws(() => act(s, { type: 'bid', player: 0, amount: 1 }));
    assert.throws(() => act(s, { type: 'nextRound' }));
    assert.throws(() => act(s, { type: 'bogus', player: 0 }));
    assert.throws(() => act(s, null));
  });
});

describe('purity', () => {
  test('applyAction never mutates the input state', () => {
    const s = createGame({ players: PLAYERS(3) });
    const snapshot = structuredClone(s);
    const s2 = act(s, { type: 'placeInitial', player: 0, card: SKULL });
    assert.deepEqual(s, snapshot);
    assert.notEqual(s2, s);
    assert.notEqual(s2.players[0], s.players[0]);
  });

  test('failed action leaves state untouched', () => {
    const s = inPlacement(3);
    const snapshot = structuredClone(s);
    assert.throws(() => act(s, { type: 'place', player: 1, card: ROSE }));
    assert.deepEqual(s, snapshot);
  });
});

describe('placement', () => {
  test('legal actions: place distinct cards + bid 1..total; only current player', () => {
    const s = inPlacement(3, [ROSE, ROSE, ROSE]);
    sameActions(legalActions(s, 0), [
      { type: 'place', player: 0, card: ROSE },
      { type: 'place', player: 0, card: SKULL },
      { type: 'bid', player: 0, amount: 1 },
      { type: 'bid', player: 0, amount: 2 },
      { type: 'bid', player: 0, amount: 3 },
    ]);
    assert.deepEqual(legalActions(s, 1), []);
    assert.deepEqual(legalActions(s, 2), []);
  });

  test('placing advances clockwise and wraps', () => {
    let s = inPlacement(3, [], 2);
    assert.equal(s.currentPlayer, 2);
    s = act(s, { type: 'place', player: 2, card: SKULL });
    assert.deepEqual(s.players[2].mat, [ROSE, SKULL]);
    assert.equal(s.currentPlayer, 0);
    assert.throws(() => act(s, { type: 'place', player: 2, card: ROSE }));
  });

  test('skips eliminated players', () => {
    let s = createGame({ players: PLAYERS(4) });
    s = structuredClone(s);
    s.players[1].eliminated = true;
    s.players[1].hand = [];
    s = placeAll(s, []);
    assert.equal(s.phase, 'placement');
    s = act(s, { type: 'place', player: 0, card: ROSE });
    assert.equal(s.currentPlayer, 2);
    assert.deepEqual(legalActions(s, 1), []);
  });

  test('player with empty hand must bid', () => {
    let s = inPlacement(3);
    s = structuredClone(s);
    s.players[0].mat.push(...s.players[0].hand);
    s.players[0].hand = [];
    const acts = legalActions(s, 0);
    assert.ok(acts.length > 0);
    assert.ok(acts.every(a => a.type === 'bid'));
    assert.throws(() => act(s, { type: 'place', player: 0, card: ROSE }));
  });

  test('bid bounds', () => {
    const s = inPlacement(3);
    assert.throws(() => act(s, { type: 'bid', player: 0, amount: 0 }));
    assert.throws(() => act(s, { type: 'bid', player: 0, amount: 4 }));
    assert.throws(() => act(s, { type: 'bid', player: 0, amount: 1.5 }));
    assert.throws(() => act(s, { type: 'pass', player: 0 }));
  });

  test('first player may bid immediately -> bidding', () => {
    let s = inPlacement(3);
    s = act(s, { type: 'bid', player: 0, amount: 2 });
    assert.equal(s.phase, 'bidding');
    assert.deepEqual(s.bid, { player: 0, amount: 2 });
    assert.equal(s.currentPlayer, 1);
  });

  test('bidding the max immediately goes to reveal', () => {
    let s = inPlacement(3);
    s = act(s, { type: 'bid', player: 0, amount: 3 });
    assert.equal(s.phase, 'reveal');
    assert.equal(s.challenger, 0);
    assert.equal(s.currentPlayer, 0);
    assert.equal(s.revealedCount, 0);
  });
});

describe('bidding', () => {
  function biddingState() {
    let s = inPlacement(4, [ROSE, ROSE, ROSE, ROSE]);
    for (let i = 0; i < 4; i++) s = act(s, { type: 'place', player: i, card: ROSE }); // 8 on mats
    return act(s, { type: 'bid', player: 0, amount: 2 });
  }

  test('legal: raise > current up to total, or pass', () => {
    const s = biddingState();
    const acts = legalActions(s, 1);
    sameActions(acts, [
      ...[3, 4, 5, 6, 7, 8].map(amount => ({ type: 'bid', player: 1, amount })),
      { type: 'pass', player: 1 },
    ]);
    assert.deepEqual(legalActions(s, 0), []);
    assert.throws(() => act(s, { type: 'bid', player: 1, amount: 2 }));
    assert.throws(() => act(s, { type: 'bid', player: 1, amount: 9 }));
    assert.throws(() => act(s, { type: 'place', player: 1, card: ROSE }));
    assert.throws(() => act(s, { type: 'pass', player: 2 }));
  });

  test('passed players are skipped and cannot bid again; last non-passed is challenger', () => {
    let s = biddingState();
    s = act(s, { type: 'pass', player: 1 });
    assert.equal(s.players[1].passed, true);
    assert.equal(s.currentPlayer, 2);
    s = act(s, { type: 'bid', player: 2, amount: 3 });
    assert.equal(s.currentPlayer, 3);
    s = act(s, { type: 'pass', player: 3 });
    assert.equal(s.currentPlayer, 0); // skips nobody, 0 not passed
    s = act(s, { type: 'bid', player: 0, amount: 4 });
    assert.equal(s.currentPlayer, 2); // skips passed 1
    assert.deepEqual(legalActions(s, 1), []);
    s = act(s, { type: 'pass', player: 2 });
    assert.equal(s.phase, 'reveal');
    assert.equal(s.challenger, 0);
    assert.deepEqual(s.bid, { player: 0, amount: 4 });
  });

  test('bidder of record can be the challenger after everyone passes', () => {
    let s = biddingState();
    for (const p of [1, 2, 3]) s = act(s, { type: 'pass', player: p });
    assert.equal(s.phase, 'reveal');
    assert.equal(s.challenger, 0);
  });

  test('raising to the max ends bidding immediately', () => {
    let s = biddingState();
    s = act(s, { type: 'bid', player: 1, amount: 8 });
    assert.equal(s.phase, 'reveal');
    assert.equal(s.challenger, 1);
    assert.equal(s.currentPlayer, 1);
  });
});

// Set up a reveal: mats given explicitly (bottom..top), challenger & amount.
function revealState(mats, challenger, amount, extra = {}) {
  let s = createGame({ players: PLAYERS(mats.length), firstPlayer: challenger });
  s = structuredClone(s);
  for (const [i, mat] of mats.entries()) {
    const p = s.players[i];
    p.hand = [...[ROSE, ROSE, ROSE, SKULL]];
    for (const c of mat) p.hand.splice(p.hand.indexOf(c), 1);
    p.mat = [...mat];
  }
  Object.assign(s, { phase: 'reveal', challenger, currentPlayer: challenger, bid: { player: challenger, amount } }, extra);
  return s;
}

describe('reveal', () => {
  test('must flip own stack first, top to bottom', () => {
    let s = revealState([[ROSE, ROSE], [ROSE], [ROSE]], 0, 4);
    sameActions(legalActions(s, 0), [{ type: 'reveal', player: 0, target: 0 }]);
    assert.throws(() => act(s, { type: 'reveal', player: 0, target: 1 }));
    assert.deepEqual(legalActions(s, 1), []);
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.players[0].revealed, 1);
    assert.equal(s.revealedCount, 1);
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.players[0].revealed, 2);
    sameActions(legalActions(s, 0), [
      { type: 'reveal', player: 0, target: 1 },
      { type: 'reveal', player: 0, target: 2 },
    ]);
    assert.throws(() => act(s, { type: 'reveal', player: 0, target: 0 }));
  });

  test('own skull on top is found before lower roses', () => {
    let s = revealState([[ROSE, SKULL], [ROSE], [ROSE]], 0, 2);
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.revealedSkullOwner, 0);
    assert.equal(s.phase, 'discard');
  });

  test('fully revealed opponents cannot be targeted', () => {
    let s = revealState([[ROSE], [ROSE], [ROSE, ROSE]], 0, 4);
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'reveal', player: 0, target: 1 });
    sameActions(legalActions(s, 0), [{ type: 'reveal', player: 0, target: 2 }]);
    assert.throws(() => act(s, { type: 'reveal', player: 0, target: 1 }));
  });

  test('bid smaller than own stack wins when reached', () => {
    let s = revealState([[ROSE, ROSE, ROSE], [ROSE], [ROSE]], 0, 2);
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.phase, 'round-over');
    assert.equal(s.players[0].wins, 1);
  });

  test('won bet -> wins++, round-over, firstPlayer = challenger, mats kept', () => {
    let s = revealState([[ROSE], [ROSE, ROSE], [SKULL]], 1, 3, { firstPlayer: 0 });
    s = act(s, { type: 'reveal', player: 1, target: 1 });
    s = act(s, { type: 'reveal', player: 1, target: 1 });
    s = act(s, { type: 'reveal', player: 1, target: 0 });
    assert.equal(s.phase, 'round-over');
    assert.equal(s.players[1].wins, 1);
    assert.equal(s.firstPlayer, 1);
    assert.deepEqual(s.lastResult, { type: 'won', challenger: 1 });
    assert.deepEqual(s.players[1].mat, [ROSE, ROSE]);
    assert.equal(s.players[1].revealed, 2);
    assert.equal(s.players[0].revealed, 1);
    assert.deepEqual(s.players[2].mat, [SKULL]);
    assert.equal(s.winner, null);
  });

  test('second win -> game-over', () => {
    let s = revealState([[ROSE], [ROSE], [ROSE]], 2, 1);
    s.players[2].wins = 1;
    s = act(s, { type: 'reveal', player: 2, target: 2 });
    assert.equal(s.phase, 'game-over');
    assert.equal(s.winner, 2);
    assert.equal(s.players[2].wins, 2);
    for (let i = 0; i < 3; i++) assert.deepEqual(legalActions(s, i), []);
    assert.throws(() => act(s, { type: 'nextRound' }));
  });

  test("lost to opponent's skull: random card removed via rng, round-over, challenger starts", () => {
    let s = revealState([[ROSE], [SKULL], [ROSE]], 0, 2, { firstPlayer: 2 });
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    // challenger hand after return: [ROSE, ROSE, SKULL, ROSE] (hand + mat). rng 0.99 -> last index.
    const before = [...s.players[0].hand, ...s.players[0].mat];
    s = act(s, { type: 'reveal', player: 0, target: 1 }, () => 0.99);
    assert.equal(s.revealedSkullOwner, 1);
    assert.equal(s.phase, 'round-over');
    assert.equal(s.firstPlayer, 0);
    const p = s.players[0];
    assert.deepEqual(p.mat, []);
    assert.equal(p.revealed, 0);
    assert.equal(p.hand.length, 3);
    assert.equal(p.eliminated, false);
    assert.deepEqual(s.lastResult, { type: 'lost', challenger: 0, skullOwner: 1, discarded: ROSE, eliminated: false });
    // card conservation
    const after = [...p.hand, s.lastResult.discarded].sort();
    assert.deepEqual(after, before.sort());
    // opponents' mats preserved for display
    assert.deepEqual(s.players[1].mat, [SKULL]);
    assert.equal(s.players[1].revealed, 1);
  });

  test('rng decides which card is lost', () => {
    const base = revealState([[], [SKULL], [ROSE]], 0, 1);
    // challenger has hand [ROSE,ROSE,ROSE,SKULL] and empty mat
    const lose = r => act(base, { type: 'reveal', player: 0, target: 1 }, () => r).lastResult.discarded;
    assert.equal(lose(0), ROSE);
    assert.equal(lose(0.8), SKULL);
  });

  test("lost to opponent's skull with last card -> eliminated, skull owner starts", () => {
    let s = revealState([[ROSE], [SKULL], [ROSE]], 0, 2, { firstPlayer: 0 });
    s.players[0].hand = [];
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'reveal', player: 0, target: 1 }, () => 0);
    assert.equal(s.players[0].eliminated, true);
    assert.equal(s.players[0].hand.length + s.players[0].mat.length, 0);
    assert.equal(s.phase, 'round-over');
    assert.equal(s.firstPlayer, 1);
    assert.equal(s.lastResult.eliminated, true);
    assert.deepEqual(activePlayers(s), [1, 2]);
  });

  test('elimination leaving one player -> game-over (last player standing)', () => {
    let s = revealState([[ROSE], [SKULL], [ROSE]], 0, 2);
    s.players[0].hand = [];
    s.players[2].eliminated = true;
    s.players[2].hand = [];
    s.players[2].mat = [];
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'reveal', player: 0, target: 1 });
    assert.equal(s.phase, 'game-over');
    assert.equal(s.winner, 1);
  });

  test('own skull -> discard phase with all cards back in challenger hand', () => {
    let s = revealState([[ROSE, SKULL], [ROSE], [ROSE]], 0, 3, { firstPlayer: 2 });
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.phase, 'discard');
    assert.equal(s.currentPlayer, 0);
    assert.equal(s.revealedSkullOwner, 0);
    assert.equal(s.players[0].hand.length, 4);
    assert.deepEqual(s.players[0].mat, []);
    sameActions(legalActions(s, 0), [0, 1, 2, 3].map(cardIndex => ({ type: 'discard', player: 0, cardIndex })));
    assert.deepEqual(legalActions(s, 1), []);
    assert.throws(() => act(s, { type: 'discard', player: 0, cardIndex: 4 }));
    assert.throws(() => act(s, { type: 'discard', player: 1, cardIndex: 0 }));
    const idx = s.players[0].hand.indexOf(SKULL);
    s = act(s, { type: 'discard', player: 0, cardIndex: idx });
    assert.equal(s.phase, 'round-over');
    assert.equal(s.firstPlayer, 0);
    assert.ok(!s.players[0].hand.includes(SKULL));
    assert.equal(s.players[0].hand.length, 3);
    assert.equal(s.lastResult.discarded, SKULL);
    assert.equal(s.lastResult.eliminated, false);
    assert.equal(s.lastResult.skullOwner, 0);
  });

  test('own skull with last card -> eliminated -> choose-first', () => {
    let s = revealState([[SKULL], [ROSE], [ROSE]], 0, 1);
    s.players[0].hand = [];
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.phase, 'discard');
    s = act(s, { type: 'discard', player: 0, cardIndex: 0 });
    assert.equal(s.players[0].eliminated, true);
    assert.equal(s.phase, 'choose-first');
    assert.equal(s.currentPlayer, 0);
    sameActions(legalActions(s, 0), [1, 2].map(target => ({ type: 'chooseFirst', player: 0, target })));
    assert.deepEqual(legalActions(s, 1), []);
    assert.throws(() => act(s, { type: 'chooseFirst', player: 0, target: 0 }));
    assert.throws(() => act(s, { type: 'chooseFirst', player: 1, target: 2 }));
    s = act(s, { type: 'chooseFirst', player: 0, target: 2 });
    assert.equal(s.phase, 'round-over');
    assert.equal(s.firstPlayer, 2);
  });

  test('own skull elimination leaving one player -> game-over', () => {
    let s = revealState([[SKULL], [ROSE]], 0, 1);
    s.players[0].hand = [];
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'discard', player: 0, cardIndex: 0 });
    assert.equal(s.phase, 'game-over');
    assert.equal(s.winner, 1);
  });
});

describe('nextRound', () => {
  test('returns cards, resets round state, firstPlayer starts', () => {
    let s = revealState([[ROSE], [ROSE, ROSE], [SKULL]], 1, 3);
    s = act(s, { type: 'reveal', player: 1, target: 1 });
    s = act(s, { type: 'reveal', player: 1, target: 1 });
    s = act(s, { type: 'reveal', player: 1, target: 0 });
    assert.equal(s.phase, 'round-over');
    for (const i of [0, 1, 2]) assert.deepEqual(legalActions(s, i), [{ type: 'nextRound' }]);
    assert.throws(() => act(s, { type: 'place', player: 1, card: ROSE }));
    s = act(s, { type: 'nextRound' });
    assert.equal(s.phase, 'place-initial');
    assert.equal(s.round, 2);
    assert.equal(s.currentPlayer, 1);
    assert.equal(s.firstPlayer, 1);
    assert.equal(s.bid, null);
    assert.equal(s.challenger, null);
    assert.equal(s.revealedCount, 0);
    assert.equal(s.revealedSkullOwner, null);
    assert.equal(s.players[1].wins, 1);
    for (const p of s.players) {
      assert.deepEqual(p.mat, []);
      assert.equal(p.hand.length, 4);
      assert.equal(p.revealed, 0);
      assert.equal(p.passed, false);
    }
  });

  test('eliminated players do not place in the next round', () => {
    let s = revealState([[SKULL], [ROSE], [ROSE]], 0, 1);
    s.players[0].hand = [];
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'discard', player: 0, cardIndex: 0 });
    s = act(s, { type: 'chooseFirst', player: 0, target: 1 });
    s = act(s, { type: 'nextRound' });
    assert.deepEqual(legalActions(s, 0), []);
    s = act(s, { type: 'placeInitial', player: 1, card: ROSE });
    s = act(s, { type: 'placeInitial', player: 2, card: ROSE });
    assert.equal(s.phase, 'placement');
    assert.equal(s.currentPlayer, 1);
    s = act(s, { type: 'place', player: 1, card: ROSE });
    assert.equal(s.currentPlayer, 2);
    s = act(s, { type: 'place', player: 2, card: ROSE });
    assert.equal(s.currentPlayer, 1);
  });

  test('player with a single card must bid on their placement turn', () => {
    let s = createGame({ players: PLAYERS(3) });
    s = structuredClone(s);
    s.players[0].hand = [ROSE];
    s = placeAll(s, []);
    assert.ok(legalActions(s, 0).every(a => a.type === 'bid'));
  });
});

describe('log', () => {
  test('possessive: names ending in s take a bare apostrophe', () => {
    assert.equal(possessive('Panthers'), "Panthers'");
    assert.equal(possessive('HELLHOUNDS'), "HELLHOUNDS'");
    assert.equal(possessive('Himself'), "Himself's");
    assert.equal(possessive('Eagle'), "Eagle's");
  });

  test('reveal and card-loss logs use correct possessives', () => {
    let s = revealState([[ROSE], [ROSE], [SKULL]], 0, 3);
    s.players[1].name = 'Panthers';
    s.players[2].name = 'Himself';
    s.players[0].name = 'Snakes';
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    s = act(s, { type: 'reveal', player: 0, target: 1 });
    assert.match(s.log.at(-1), /flips Panthers' card: rose/);
    s = act(s, { type: 'reveal', player: 0, target: 2 });
    assert.ok(s.log.includes("Snakes flips Himself's card: SKULL."));
    assert.ok(s.log.includes("Himself takes away one of Snakes' cards."));
    assert.ok(!s.log.some(l => /s's\b/.test(l)), 'no "s\'s" in log');
  });

  test('is append-only and never leaks placed card values', () => {
    let s = createGame({ players: PLAYERS(3) });
    const prev = s.log.length;
    s = act(s, { type: 'placeInitial', player: 0, card: SKULL });
    assert.ok(s.log.length > prev);
    assert.ok(!/skull/i.test(s.log.at(-1)));
  });
});

// ---------- randomized simulation ----------

function checkInvariants(s, lost) {
  const total = s.players.reduce((n, p) => n + p.hand.length + p.mat.length, 0);
  const lostTotal = lost.reduce((a, b) => a + b, 0);
  assert.equal(total + lostTotal, 4 * s.players.length, 'card conservation');
  for (const p of s.players) {
    const all = [...p.hand, ...p.mat];
    assert.equal(all.length, 4 - lost[p.id]);
    assert.ok(all.filter(c => c === SKULL).length <= 1);
    assert.ok(all.every(c => c === ROSE || c === SKULL));
    assert.ok(p.revealed >= 0 && p.revealed <= p.mat.length);
    assert.ok(p.wins >= 0 && p.wins <= 2);
    assert.equal(p.eliminated, all.length === 0);
  }
  assert.ok(activePlayers(s).length >= 1);
  if (s.phase === 'placement' || s.phase === 'bidding' || s.phase === 'reveal') {
    assert.ok(!s.players[s.currentPlayer].eliminated);
    assert.ok(legalActions(s, s.currentPlayer).length > 0);
  }
  if (s.phase === 'reveal') assert.ok(s.revealedCount < s.bid.amount);
  if (s.phase === 'round-over') assert.ok(!s.players[s.firstPlayer].eliminated);
  if (s.bid) assert.ok(s.bid.amount >= 1);
}

function playRandomGame(seed) {
  const rng = seeded(seed);
  const n = 3 + Math.floor(rng() * 4);
  let s = createGame({ players: PLAYERS(n), firstPlayer: Math.floor(rng() * n) });
  const lost = new Array(n).fill(0);
  let steps = 0;
  while (s.phase !== 'game-over') {
    assert.ok(++steps < 20000, 'game should terminate');
    const actions = s.phase === 'round-over'
      ? legalActions(s, 0)
      : s.players.flatMap(p => legalActions(s, p.id));
    assert.ok(actions.length > 0, `no legal actions in phase ${s.phase}`);
    const a = actions[Math.floor(rng() * actions.length)];
    const prev = s;
    const prevJson = JSON.stringify(prev);
    s = applyAction(s, a, rng);
    assert.equal(JSON.stringify(prev), prevJson, 'input mutated');
    if (s.lastResult && s.lastResult.discarded && !(prev.lastResult && prev.lastResult.discarded)) {
      lost[s.lastResult.challenger]++;
    }
    checkInvariants(s, lost);
    if (s.phase === 'place-initial') assert.equal(totalOnMats(s) <= s.players.length, true);
  }
  assert.ok(Number.isInteger(s.winner));
  const w = s.players[s.winner];
  assert.ok(!w.eliminated);
  assert.ok(w.wins === 2 || activePlayers(s).length === 1);
  for (const p of s.players) assert.deepEqual(legalActions(s, p.id), []);
  return s;
}

test('500 random games: invariants hold and a winner always emerges', () => {
  let byWins = 0, byStanding = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const s = playRandomGame(seed);
    if (s.players[s.winner].wins === 2) byWins++; else byStanding++;
  }
  assert.equal(byWins + byStanding, 500);
  assert.ok(byWins > 0, 'some games won by 2 wins');
  assert.ok(byStanding > 0, 'some games won by last player standing');
});

describe('forfeit (multiplayer §8)', () => {
  // P0 bids 1 on their own rose and wins -> round-over, P0 starts next.
  function roundOver(n = 3) {
    let s = inPlacement(n, Array(n).fill(ROSE));
    s = act(s, { type: 'bid', player: 0, amount: 1 });
    for (let i = 1; i < n; i++) s = act(s, { type: 'pass', player: i });
    s = act(s, { type: 'reveal', player: 0, target: 0 });
    assert.equal(s.phase, 'round-over');
    return s;
  }

  test('eliminates the player, clears hand and mat, logs it', () => {
    const s0 = roundOver(4);
    const s = act(s0, { type: 'forfeit', player: 2 });
    assert.equal(s.players[2].eliminated, true);
    assert.deepEqual(s.players[2].hand, []);
    assert.deepEqual(s.players[2].mat, []);
    assert.equal(s.phase, 'round-over');
    assert.equal(s.firstPlayer, 0);
    assert.match(s.log.at(-1), /P2 forfeits/);
    assert.equal(s0.players[2].eliminated, false, 'input not mutated');
    const next = act(s, { type: 'nextRound' });
    assert.deepEqual(next.players[2].hand, []);
    assert.deepEqual(legalActions(next, 2), []);
  });

  test('forfeiting next first player moves first player to nextActive', () => {
    const s = act(roundOver(4), { type: 'forfeit', player: 0 });
    assert.equal(s.firstPlayer, 1);
    assert.equal(s.currentPlayer, 1);
    assert.equal(act(s, { type: 'nextRound' }).currentPlayer, 1);
  });

  test('one active player left -> game-over with that winner', () => {
    let s = act(roundOver(3), { type: 'forfeit', player: 1 });
    assert.equal(s.phase, 'round-over');
    s = act(s, { type: 'forfeit', player: 0 });
    assert.equal(s.phase, 'game-over');
    assert.equal(s.winner, 2);
  });

  test('rejected outside round-over and for eliminated players', () => {
    const s = inPlacement(3);
    assert.throws(() => act(s, { type: 'forfeit', player: 1 }), /Illegal/);
    assert.throws(() => act(createGame({ players: PLAYERS(3) }), { type: 'forfeit', player: 0 }), /Illegal/);
    const f = act(roundOver(4), { type: 'forfeit', player: 3 });
    assert.throws(() => act(f, { type: 'forfeit', player: 3 }), /Illegal/);
    assert.throws(() => act(f, { type: 'forfeit', player: 9 }), /Illegal/);
  });

  test('is never offered by legalActions', () => {
    const s = roundOver(3);
    for (const p of s.players) assert.ok(legalActions(s, p.id).every(a => a.type !== 'forfeit'));
  });
});
