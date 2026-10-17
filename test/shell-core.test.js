import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVATARS, parseSettings, parseHostOptions, stepAvatar, avatarTag, findMe, lobbySummary,
  seatOrder, seatClocks, ringAt, lobbyRow, cleanName, OFF_CLOCK_MS, shouldAutoReload, RELOAD_GAP_MS,
} from '../src/shell-core.js';

test('settings: defaults, clamping, avatar from the list only', () => {
  assert.deepEqual(parseSettings(null), { name: 'Rider', opponents: 3, avatar: { emoji: '💀' } });
  assert.deepEqual(parseSettings({ name: '  Mo  ', opponents: 5, avatar: { emoji: '🐺' } }), { name: 'Mo', opponents: 5, avatar: { emoji: '🐺' } });
  assert.equal(parseSettings({ opponents: 9 }).opponents, 3);
  assert.equal(parseSettings({ name: '' }).name, '');
  assert.equal(parseSettings({ avatar: { emoji: '🍕' } }).avatar.emoji, '💀');
  assert.equal(parseSettings({ name: 'x'.repeat(30) }).name.length, 16);
  assert.equal([...cleanName('💀'.repeat(20))].length, 16);
});

test('host options: defaults Open, 30s, 4 seats; invalid values dropped', () => {
  assert.deepEqual(parseHostOptions(undefined), { seats: 4, timer: 30, open: true });
  assert.deepEqual(parseHostOptions({ seats: 6, timer: 0, open: false }), { seats: 6, timer: 0, open: false });
  assert.deepEqual(parseHostOptions({ seats: 7, timer: 45, open: 'no' }), { seats: 4, timer: 30, open: true });
});

test('avatar picker wraps both ways', () => {
  assert.equal(AVATARS.length, 12);
  assert.equal(stepAvatar(AVATARS[0], -1), AVATARS[11]);
  assert.equal(stepAvatar(AVATARS[11], 1), AVATARS[0]);
  assert.equal(stepAvatar('nope', 1), AVATARS[1]);
});

test('findMe: by avatar tag, or by lobby.me when the server sends it', () => {
  const tag = avatarTag('abc123abc123');
  assert.equal(tag, avatarTag('abc123abc123'));
  assert.notEqual(tag, avatarTag('abc123abc124'));
  const lobby = {
    hostSeat: 1, phase: 'waiting', options: { seats: 4 },
    members: [
      { seat: 0, name: 'Rider', avatar: { emoji: '💀', k: 'zzz' } },
      { seat: 1, name: 'Rider 2', avatar: { emoji: '💀', k: tag } },
      { seat: 2, name: 'Panthers', isBot: true, avatar: { emoji: '🐆' } },
    ],
  };
  assert.equal(findMe(lobby, tag).seat, 1);
  assert.equal(findMe(lobby, 'nope'), null);
  assert.equal(findMe({ ...lobby, me: 0 }, tag).seat, 0);
  const s = lobbySummary(lobby, findMe(lobby, tag));
  assert.equal(s.isHost, true);
  assert.equal(s.canStart, true);
  assert.equal(s.empty, 1);
  assert.equal(lobbySummary(lobby, findMe(lobby, 'zzz')).isHost, false);
});

test('seatOrder puts you at the bottom, opponents clockwise after you', () => {
  assert.deepEqual(seatOrder(4, 0), [1, 2, 3]);
  assert.deepEqual(seatOrder(4, 2), [3, 0, 1]);
  assert.deepEqual(seatOrder(6, 5), [0, 1, 2, 3, 4]);
});

test('seat clocks from a deadline: per-seat ats, timer length, Off fallback', () => {
  assert.deepEqual(seatClocks(null, { timer: 30 }), {});
  const d = { players: [0, 2], at: 1000, ats: { 0: 1000, 2: 4000 } };
  assert.deepEqual(seatClocks(d, { timer: 20 }), { 0: { at: 1000, total: 20000 }, 2: { at: 4000, total: 20000 } });
  assert.deepEqual(seatClocks({ players: [1], at: 500 }, { timer: 0 }), { 1: { at: 500, total: OFF_CLOCK_MS } });
  assert.deepEqual(ringAt({ at: 10_000, total: 20_000 }, 5_000), { left: 5_000, frac: 0.25 });
  assert.deepEqual(ringAt({ at: 10_000, total: 20_000 }, 12_000), { left: 0, frac: 0 });
});

test('open-lobby rows', () => {
  assert.deepEqual(lobbyRow({ code: 'KXQP', host: 'Mo', humans: 2, bots: 1, seats: 5, timer: 0 }),
    { code: 'KXQP', host: 'Mo', fill: '3/5', bots: 1, timer: 'Off', full: false });
  assert.equal(lobbyRow({ code: 'KXQP', host: '', humans: 6, bots: 0, seats: 6, timer: 30 }).full, true);
});

test('version-skew reload: at most one auto-reload per 30s', () => {
  const now = 10_000_000;
  assert.equal(RELOAD_GAP_MS, 30_000);
  assert.equal(shouldAutoReload(null, now), true);            // never reloaded
  assert.equal(shouldAutoReload('garbage', now), true);
  assert.equal(shouldAutoReload(String(now - 5_000), now), false);
  assert.equal(shouldAutoReload(String(now - 29_999), now), false);
  assert.equal(shouldAutoReload(String(now - 30_000), now), true);
  assert.equal(shouldAutoReload(String(now + 60_000), now), true);  // clock went backwards: don't get stuck
});

