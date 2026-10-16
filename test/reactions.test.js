import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KINDS, EMOJI, COOLDOWN_MS, parseReact, createCooldown, anchor, flight } from '../src/reactions.js';
import { REACTIONS, REACT_MS } from '../worker/room-core.js';

test('kinds and cooldown mirror the server', () => {
  assert.deepEqual(KINDS.map(k => k.id), REACTIONS);
  assert.equal(COOLDOWN_MS, REACT_MS);
  assert.equal(EMOJI.tomato, '🍅');
});

test('parseReact accepts pop-ups and tomato throws', () => {
  assert.deepEqual(parseReact({ t: 'event', e: 'react', from: 2, kind: 'laugh' }), { from: 2, kind: 'laugh' });
  assert.deepEqual(parseReact({ e: 'react', from: 0, kind: 'tomato', target: 3 }), { from: 0, kind: 'tomato', target: 3 });
  // a stray target on a pop-up is ignored
  assert.deepEqual(parseReact({ e: 'react', from: 1, kind: 'rose', target: 2 }), { from: 1, kind: 'rose' });
});

test('parseReact drops junk', () => {
  for (const ev of [
    null, undefined, {}, { e: 'other', from: 0, kind: 'smirk' },
    { e: 'react', from: 0, kind: 'revolver' },
    { e: 'react', from: '0', kind: 'smirk' },
    { e: 'react', kind: 'smirk' },
    { e: 'react', from: 0, kind: 'tomato' },
    { e: 'react', from: 0, kind: 'tomato', target: 0 },
    { e: 'react', from: 0, kind: 'tomato', target: 1.5 },
    { e: 'react', from: 0, kind: '__proto__' },
  ]) assert.equal(parseReact(ev), null, JSON.stringify(ev));
});

test('cooldown allows one per 2s', () => {
  const c = createCooldown();
  assert.equal(c.ready(1000), true);
  assert.equal(c.remaining(1000), 0);
  c.start(1000);
  assert.equal(c.ready(1500), false);
  assert.equal(c.remaining(1500), 1500);
  assert.equal(c.ready(2999), false);
  assert.equal(c.ready(3000), true);
  assert.equal(c.remaining(3500), 0);
});

test('anchor and flight geometry', () => {
  const r = { left: 10, top: 20, width: 100, height: 60 };
  assert.deepEqual(anchor(r), { x: 60, y: 50 });
  assert.deepEqual(anchor(r, 'top'), { x: 60, y: 41 });
  const f = flight({ x: 0, y: 0 }, { x: -300, y: 400 });
  assert.equal(f.dx, -300); assert.equal(f.dy, 400);
  assert.equal(f.spin, -1);
  assert.equal(f.h, 160);                        // capped
  assert.equal(flight({ x: 0, y: 0 }, { x: 0, y: 0 }).h, 40);
});
