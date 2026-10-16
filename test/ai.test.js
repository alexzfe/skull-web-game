import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, legalActions, applyAction, ROSE, SKULL } from '../src/engine.js';
import { chooseAction } from '../src/ai.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['Panthers', 'Snakes', 'Werewolves', 'Eagles', 'Himself', 'Ravens'];

function newGame(n, rng) {
  const players = NAMES.slice(0, n).map((name) => ({ name, isHuman: false }));
  return createGame({ players, firstPlayer: Math.floor(rng() * n), rng });
}

// Find a player with something to do. Returns null if nobody (e.g. round-over w/o player).
function actingPlayer(state) {
  if (legalActions(state, state.currentPlayer).length) return state.currentPlayer;
  for (const p of state.players) if (legalActions(state, p.id).length) return p.id;
  return null;
}

function step(state, rng) {
  const pid = actingPlayer(state);
  if (pid === null) {
    assert.equal(state.phase, 'round-over', `stuck in phase ${state.phase}`);
    return { state: applyAction(state, { type: 'nextRound' }, rng), pid: null };
  }
  const legal = legalActions(state, pid).map((a) => JSON.stringify(a));
  const action = chooseAction(state, pid, rng);
  assert.ok(action, `bot returned no action in phase ${state.phase}`);
  assert.ok(legal.includes(JSON.stringify(action)), `illegal action ${JSON.stringify(action)}; legal: ${legal.join(' ')}`);
  return { state: applyAction(state, action, rng), pid, action };
}

test('all-bot games: actions always legal and games end with a winner', () => {
  for (let g = 0; g < 300; g++) {
    const rng = mulberry32(1000 + g);
    const n = 3 + (g % 4);
    let state = newGame(n, rng);
    let steps = 0;
    while (state.phase !== 'game-over') {
      state = step(state, rng).state;
      assert.ok(++steps < 5000, `game ${g} did not terminate`);
    }
    assert.ok(Number.isInteger(state.winner), `game ${g} has no winner`);
    const w = state.players[state.winner];
    assert.ok(!w.eliminated, 'winner is not eliminated');
    const active = state.players.filter((p) => !p.eliminated).length;
    assert.ok(w.wins === 2 || active === 1, 'winner won 2 bets or is last standing');
  }
});

// Replace every card of every opponent that `me` cannot see with a random value.
function scrambleHidden(state, me, rng) {
  const s = structuredClone(state);
  for (const p of s.players) {
    if (p.id === me) continue;
    const hiddenOnMat = p.mat.length - p.revealed;
    for (let i = 0; i < hiddenOnMat; i++) p.mat[i] = rng() < 0.5 ? ROSE : SKULL;
    for (let i = 0; i < p.hand.length; i++) p.hand[i] = rng() < 0.5 ? ROSE : SKULL;
  }
  if (s.lastResult && s.lastResult.challenger !== me && 'discarded' in s.lastResult) {
    s.lastResult.discarded = rng() < 0.5 ? ROSE : SKULL;
  }
  return s;
}

test('bot decisions do not depend on hidden opponent cards', () => {
  let checks = 0;
  for (let g = 0; g < 80; g++) {
    const rng = mulberry32(5000 + g);
    const scrambleRng = mulberry32(9000 + g);
    let state = newGame(3 + (g % 4), rng);
    let steps = 0;
    while (state.phase !== 'game-over' && steps++ < 5000) {
      const pid = actingPlayer(state);
      if (pid !== null) {
        const seed = Math.floor(rng() * 2 ** 31);
        const base = JSON.stringify(chooseAction(state, pid, mulberry32(seed)));
        for (let k = 0; k < 3; k++) {
          const scrambled = scrambleHidden(state, pid, scrambleRng);
          const alt = JSON.stringify(chooseAction(scrambled, pid, mulberry32(seed)));
          assert.equal(alt, base, `decision changed with hidden info in phase ${state.phase}`);
          checks++;
        }
      }
      state = step(state, rng).state;
    }
  }
  assert.ok(checks > 1000);
});
