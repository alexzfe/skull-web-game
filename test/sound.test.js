import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, ROSE, SKULL } from '../src/engine.js';
import { viewFor } from '../src/view.js';
import { cuesFor } from '../src/sound.js';

const players = [{ name: 'Me', isHuman: true }, { name: 'Bot', isHuman: false }];
const step = (s, a) => { const n = applyAction(s, a, () => 0); return [n, cuesFor(viewFor(s, 0), viewFor(n, 0), a)]; };

test('cues: cards thud, your turn chimes, bids and passes', () => {
  let s = createGame({ players, firstPlayer: 0 });
  let c;
  [s, c] = step(s, { type: 'placeInitial', player: 0, card: ROSE });
  assert.deepEqual(c, ['card']);
  [s, c] = step(s, { type: 'placeInitial', player: 1, card: SKULL });
  assert.deepEqual(c, ['card']);   // already my turn: no chime
  [s, c] = step(s, { type: 'bid', player: 0, amount: 1 });
  assert.deepEqual(c, ['bid']);
  [s, c] = step(s, { type: 'pass', player: 1 });
  assert.deepEqual(c, ['pass', 'turn']);   // I must flip
  [s, c] = step(s, { type: 'reveal', player: 0, target: 0 });
  assert.deepEqual(c, ['won']);
});

test('cues: hitting a skull, and the game-over sting', () => {
  let s = createGame({ players, firstPlayer: 0 });
  s = applyAction(s, { type: 'placeInitial', player: 0, card: ROSE });
  s = applyAction(s, { type: 'placeInitial', player: 1, card: SKULL });
  s = applyAction(s, { type: 'bid', player: 0, amount: 2 });   // the max bid starts the reveal
  let c;
  [s, c] = step(s, { type: 'reveal', player: 0, target: 0 });
  assert.deepEqual(c, ['flip']);
  [s, c] = step(s, { type: 'reveal', player: 0, target: 1 });
  assert.deepEqual(c, ['skull']);

  const won = structuredClone(s);
  won.phase = 'game-over'; won.winner = 1;
  assert.deepEqual(cuesFor(viewFor(s, 0), viewFor(won, 0), { type: 'reveal', player: 0, target: 1 }).at(-1), 'lose');
  assert.deepEqual(cuesFor(viewFor(s, 1), viewFor(won, 1), { type: 'reveal', player: 0, target: 1 }).at(-1), 'win');
});
