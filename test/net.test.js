import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getToken, normalizeCode, cleanCode, shareLink, parseShareHash, createRoom, listLobbies, createRemoteController, fetchVersion,
} from '../src/net.js';

// ---------- fakes ----------

function fakeTimers() {
  let now = 1_000_000;
  let nextId = 1;
  const pending = new Map();   // id -> {at, fn}
  return {
    clock: () => now,
    setTimeout(fn, ms) { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    pendingDelays: () => [...pending.values()].map(p => p.at - now),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, p]) => p.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

function fakeSockets() {
  const all = [];
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; this.closedWith = null; all.push(this); }
    send(data) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(JSON.parse(data)); }
    close(code = 1000) { if (this.readyState === 3) return; this.closedWith = code; this.readyState = 3; }
    // test drivers
    open() { this.readyState = 1; this.onopen?.({}); }
    msg(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  }
  return { WebSocket: FakeWS, all, last: () => all[all.length - 1] };
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

function setup(extra = {}) {
  const timers = fakeTimers();
  const socks = fakeSockets();
  const fetches = [];
  const rc = createRemoteController({
    code: 'kxpq', name: 'Mo', avatar: { emoji: '🐺' }, token: 'tok', base: 'https://skull.test',
    WebSocket: socks.WebSocket, storage: null, document: null, window: null,
    fetch: async url => { fetches.push(url); return { status: extra.probeStatus ?? 426 }; },
    random: () => 0.5, ...timers, ...extra,
  });
  const statuses = [];
  rc.onStatus(s => statuses.push(s));
  return { rc, timers, socks, statuses, fetches };
}

const flush = () => new Promise(r => setImmediate(r));

// ---------- codes, links, token ----------

describe('codes and links', () => {
  test('normalizeCode uppercases, strips spaces, rejects O/I/digits/wrong length', () => {
    assert.equal(normalizeCode(' kx 4p'), null);   // 4 is not a letter
    assert.equal(normalizeCode(' kx p q '), 'KXPQ');
    assert.equal(normalizeCode('ab-cd'), 'ABCD');
    assert.equal(normalizeCode('ABCO'), null);
    assert.equal(normalizeCode('ABCI'), null);
    assert.equal(normalizeCode('ABC'), null);
    assert.equal(normalizeCode('ABCDE'), null);
    assert.equal(normalizeCode(null), null);
  });

  test('cleanCode keeps only valid letters, max 4', () => {
    assert.equal(cleanCode('k o x1p qz'), 'KXPQ');
    assert.equal(cleanCode('ab'), 'AB');
  });

  test('shareLink and parseShareHash round-trip', () => {
    const link = shareLink('KXPQ', { origin: 'https://skull.xlobax.com' });
    assert.equal(link, 'https://skull.xlobax.com/#/r/KXPQ');
    assert.equal(parseShareHash(new URL(link).hash), 'KXPQ');
    assert.equal(parseShareHash('#/r/kxpq'), 'KXPQ');
    assert.equal(parseShareHash('/r/KXPQ/'), 'KXPQ');
    assert.equal(parseShareHash('#/r/KXPO'), null);
    assert.equal(parseShareHash('#/play'), null);
    assert.equal(parseShareHash(''), null);
  });
});

describe('token', () => {
  test('created once and persisted in skull.token', () => {
    const storage = fakeStorage();
    const t = getToken({ storage });
    assert.match(t, /^[0-9a-f]{32}$/);
    assert.equal(storage.map.get('skull.token'), t);
    assert.equal(getToken({ storage }), t);
  });

  test('an existing token is reused', () => {
    assert.equal(getToken({ storage: fakeStorage({ 'skull.token': 'abc' }) }), 'abc');
  });

  test('works when storage throws', () => {
    const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const t = getToken({ storage });
    assert.ok(t.length > 0);
    assert.equal(getToken({ storage }), t);
  });
});

describe('http helpers', () => {
  test('createRoom POSTs /api/rooms', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push([url, init?.method]); return { ok: true, json: async () => ({ code: 'KXPQ' }) }; };
    assert.deepEqual(await createRoom({ fetch, base: 'http://localhost:8787/' }), { code: 'KXPQ' });
    assert.deepEqual(calls, [['http://localhost:8787/api/rooms', 'POST']]);
  });

  test('createRoom throws on failure', async () => {
    const fetch = async () => ({ ok: false, status: 500 });
    await assert.rejects(createRoom({ fetch, base: '' }));
  });

  test('listLobbies GETs /api/lobbies', async () => {
    const list = [{ code: 'KXPQ', host: 'Mo', humans: 1, seats: 4, bots: 1, timer: 30 }];
    const fetch = async url => { assert.equal(url, 'https://x.test/api/lobbies'); return { ok: true, json: async () => list }; };
    assert.deepEqual(await listLobbies({ fetch, location: { origin: 'https://x.test' } }), list);
  });
});

// ---------- remote controller ----------

describe('remote controller', () => {
  test('connects to the room ws url and says hello on open', () => {
    const { socks, statuses } = setup();
    const ws = socks.last();
    assert.equal(ws.url, 'wss://skull.test/api/rooms/KXPQ/ws?token=tok');
    assert.deepEqual(statuses, ['connecting']);
    ws.open();
    assert.deepEqual(statuses, ['connecting', 'open']);
    assert.deepEqual(ws.sent, [{ t: 'hello', name: 'Mo', avatar: { emoji: '🐺' } }]);
  });

  test('drops views whose seq is not newer', () => {
    const { rc, socks } = setup();
    const seen = [];
    rc.onView((view, meta) => seen.push([view.n, meta.seq]));
    const ws = socks.last();
    ws.open();
    const deadline = { players: [1], at: 5 };
    ws.msg({ t: 'view', seq: 3, view: { n: 'a' }, seats: [{ name: 'Mo' }], deadline });
    ws.msg({ t: 'view', seq: 3, view: { n: 'dup' } });
    ws.msg({ t: 'view', seq: 2, view: { n: 'old' } });
    ws.msg({ t: 'view', seq: 4, view: { n: 'b' } });
    assert.deepEqual(seen, [['a', 3], ['b', 4]]);
    // a late subscriber gets the latest view straight away, with its meta
    let late = null;
    rc.onView((view, meta) => { late = [view, meta]; });
    assert.deepEqual(late, [{ n: 'b' }, { seq: 4, seats: [], deadline: null }]);
  });

  test('seq ordering survives a reconnect', () => {
    const { rc, socks, timers } = setup();
    const seen = [];
    rc.onView(v => seen.push(v.n));
    socks.last().open();
    socks.last().msg({ t: 'view', seq: 7, view: { n: 'a' } });
    socks.last().drop();
    timers.advance(1000);
    socks.last().open();
    socks.last().msg({ t: 'view', seq: 7, view: { n: 'same' } });
    socks.last().msg({ t: 'view', seq: 8, view: { n: 'b' } });
    assert.deepEqual(seen, ['a', 'b']);
  });

  test('routes lobby, event and error messages', () => {
    const { rc, socks } = setup();
    const got = [];
    rc.onLobby(l => got.push(['lobby', l.code]));
    rc.onEvent(ev => got.push(['event', ev.kind]));
    rc.onError(m => got.push(['error', m]));
    const ws = socks.last();
    ws.open();
    ws.msg({ t: 'lobby', lobby: { code: 'KX4P' } });
    ws.msg({ t: 'event', e: 'react', from: 1, kind: '🍅', target: 0 });
    ws.msg({ t: 'error', msg: 'Illegal action' });
    ws.onmessage({ data: 'not json' });
    assert.deepEqual(got, [['lobby', 'KX4P'], ['event', '🍅'], ['error', 'Illegal action']]);
    assert.equal(rc.status(), 'open');
  });

  test('send, lobby and react put the right frames on the wire', () => {
    const { rc, socks } = setup();
    assert.equal(rc.send({ type: 'pass' }), false, 'nothing goes out before open');
    const ws = socks.last();
    ws.open();
    assert.equal(rc.send({ type: 'bid', amount: 2 }), true);
    rc.lobby('options', { seats: 5, timer: 20, open: false });
    rc.lobby('start');
    rc.react('😂');
    rc.react('🍅', 2);
    assert.deepEqual(ws.sent.slice(1), [
      { t: 'action', action: { type: 'bid', amount: 2 } },
      { t: 'lobby', op: 'options', seats: 5, timer: 20, open: false },
      { t: 'lobby', op: 'start' },
      { t: 'react', kind: '😂' },
      { t: 'react', kind: '🍅', target: 2 },
    ]);
  });

  test('reconnects with growing, capped backoff and says hello again', () => {
    const { socks, timers, statuses } = setup();
    socks.last().open();
    socks.last().drop();
    assert.equal(statuses.at(-1), 'reconnecting');
    const delays = [];
    for (let i = 0; i < 7; i++) {
      delays.push(timers.pendingDelays()[0]);
      const before = socks.all.length;
      timers.advance(delays.at(-1));
      assert.equal(socks.all.length, before + 1, 'a new socket per retry');
      socks.last().drop();
    }
    // random() = 0.5 → no jitter
    assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000, 5000, 5000]);
    timers.advance(5000);
    const ws = socks.last();
    ws.open();
    assert.equal(statuses.at(-1), 'open');
    assert.deepEqual(ws.sent[0], { t: 'hello', name: 'Mo', avatar: { emoji: '🐺' } });
    // once a message arrives the backoff starts over
    ws.msg({ t: 'lobby', lobby: {} });
    ws.drop();
    assert.equal(timers.pendingDelays()[0], 500);
  });

  test('backoff has jitter', () => {
    const { socks, timers } = setup({ random: () => 0 });
    socks.last().drop();
    assert.equal(timers.pendingDelays()[0], 400);
  });

  test('no reconnect after leave', () => {
    const { rc, socks, timers, statuses } = setup();
    const ws = socks.last();
    ws.open();
    rc.leave();
    assert.deepEqual(ws.sent.at(-1), { t: 'leave' });
    assert.equal(ws.closedWith, 1000);
    assert.equal(statuses.at(-1), 'closed');
    ws.drop(1000);
    timers.advance(60_000);
    assert.equal(socks.all.length, 1);
    assert.equal(rc.send({ type: 'pass' }), false);
  });

  test('leave while reconnecting cancels the retry', () => {
    const { rc, socks, timers } = setup();
    socks.last().drop();
    rc.leave();
    timers.advance(60_000);
    assert.equal(socks.all.length, 1);
    assert.equal(rc.status(), 'closed');
  });

  test('kicked is final', () => {
    const { rc, socks, timers } = setup();
    socks.last().open();
    socks.last().msg({ t: 'kicked' });
    socks.last().drop(1000);
    timers.advance(60_000);
    assert.equal(rc.status(), 'kicked');
    assert.equal(socks.all.length, 1);
  });

  test('table full error is final', () => {
    const { rc, socks, timers } = setup();
    const errors = [];
    rc.onError(m => errors.push(m));
    socks.last().open();
    socks.last().msg({ t: 'error', msg: 'Table full' });
    timers.advance(60_000);
    assert.equal(rc.status(), 'full');
    assert.deepEqual(errors, ['Table full']);
    assert.equal(socks.all.length, 1);
  });

  test('unknown room error → not-found', () => {
    const { rc, socks } = setup();
    socks.last().open();
    socks.last().msg({ t: 'error', msg: 'Room not found' });
    assert.equal(rc.status(), 'not-found');
  });

  test('a failed upgrade that probes as 404 → not-found, no more retries', async () => {
    const { rc, socks, timers, fetches } = setup({ probeStatus: 404 });
    socks.last().drop();
    await flush();
    assert.deepEqual(fetches, ['https://skull.test/api/rooms/KXPQ/ws?token=tok']);
    assert.equal(rc.status(), 'not-found');
    timers.advance(60_000);
    assert.equal(socks.all.length, 1);
  });

  test('a failed upgrade that is not a 404 keeps retrying', async () => {
    const { rc, socks, timers } = setup({ probeStatus: 426 });
    socks.last().drop();
    await flush();
    assert.equal(rc.status(), 'reconnecting');
    timers.advance(500);
    assert.equal(socks.all.length, 2);
  });

  test('repeated failed upgrades while the server answers (426) → not-found', async () => {
    const { rc, socks, timers } = setup({ probeStatus: 426 });
    socks.last().drop();
    await flush();
    timers.advance(500);
    socks.last().drop();
    await flush();
    assert.equal(rc.status(), 'not-found');
    timers.advance(60_000);
    assert.equal(socks.all.length, 2);
  });

  test('failed upgrades while offline keep retrying', async () => {
    const { rc, socks, timers } = setup({ fetch: async () => { throw new TypeError('offline'); } });
    for (let i = 0; i < 4; i++) {
      socks.last().drop();
      await flush();
      timers.advance(5000);
    }
    assert.equal(rc.status(), 'reconnecting');
    assert.equal(socks.all.length, 5);
  });

  test('a good connection resets the failed-upgrade count', async () => {
    const { rc, socks, timers } = setup({ probeStatus: 426 });
    socks.last().drop();
    await flush();
    timers.advance(500);
    socks.last().open();
    socks.last().drop();
    timers.advance(5000);
    socks.last().drop();
    await flush();
    assert.equal(rc.status(), 'reconnecting');
  });

  test('server close codes are final', () => {
    const cases = [[4000, 'replaced'], [4001, 'kicked'], [4002, 'closed'], [4004, 'not-found'], [4005, 'reload'], [4009, 'full']];
    for (const [code, status] of cases) {
      const { rc, socks, timers } = setup();
      socks.last().open();
      socks.last().drop(code);
      assert.equal(rc.status(), status, `close ${code}`);
      timers.advance(60_000);
      assert.equal(socks.all.length, 1, `no reconnect after ${code}`);
    }
  });

  test('4002 before the socket ever opened → not-found', () => {
    const { rc, socks, timers } = setup();
    socks.last().drop(4002);
    assert.equal(rc.status(), 'not-found');
    timers.advance(60_000);
    assert.equal(socks.all.length, 1);
  });

  test("'Table full' then 4001 stays full", () => {
    const { rc, socks } = setup();
    const ws = socks.last();
    ws.open();
    ws.msg({ t: 'error', msg: 'Table full' });
    ws.drop(4001);
    assert.equal(rc.status(), 'full');
  });

  test('leave then 4001 stays closed', () => {
    const { rc, socks, statuses } = setup();
    const ws = socks.last();
    ws.open();
    rc.leave();
    ws.drop(4001);
    assert.equal(rc.status(), 'closed');
    assert.ok(!statuses.includes('kicked'));
  });

  test('invalid code goes straight to not-found', () => {
    const { rc, socks } = setup({ code: 'nope!' });
    assert.equal(rc.status(), 'not-found');
    assert.equal(socks.all.length, 0);
  });

  test('now() follows serverNow with a smoothed offset', () => {
    const { rc, socks, timers } = setup();
    assert.equal(rc.now(), timers.clock());
    const ws = socks.last();
    ws.open();
    ws.msg({ t: 'lobby', lobby: {}, serverNow: timers.clock() + 10_000 });
    assert.equal(rc.now(), timers.clock() + 10_000, 'first sample is taken as-is');
    ws.msg({ t: 'lobby', lobby: {}, serverNow: timers.clock() + 12_000 });
    assert.equal(rc.now(), timers.clock() + 10_500, 'later samples are smoothed');
    timers.advance(3000);
    assert.equal(rc.now(), timers.clock() + 10_500, 'offset holds as local time moves');
  });

  test('page becoming visible / online retries at once', () => {
    const listeners = {};
    const target = { addEventListener: (k, fn) => { listeners[k] = fn; }, removeEventListener: k => { delete listeners[k]; } };
    const document = { ...target, visibilityState: 'visible' };
    const { rc, socks, timers } = setup({ document, window: target });
    socks.last().open();
    socks.last().drop();
    timers.advance(100);
    assert.equal(socks.all.length, 1);
    listeners.visibilitychange();
    assert.equal(socks.all.length, 2, 'visible → reconnect now');
    socks.last().drop();
    listeners.online();
    assert.equal(socks.all.length, 3, 'online → reconnect now');
    socks.last().open();
    listeners.online();
    assert.equal(socks.all.length, 3, 'no extra socket while open');
    rc.close();
    assert.equal(listeners.online, undefined, 'listeners removed when closed for good');
  });
});

describe('version skew', () => {
  test('the hello carries the version (string or getter, read at each connect)', () => {
    let v = null;
    const { socks, timers } = setup({ version: () => v });
    socks.last().open();
    assert.deepEqual(socks.last().sent[0], { t: 'hello', name: 'Mo', avatar: { emoji: '🐺' } });
    v = 'abc';
    socks.last().drop(1006);
    timers.advance(10_000);
    socks.last().open();
    assert.deepEqual(socks.last().sent[0], { t: 'hello', name: 'Mo', avatar: { emoji: '🐺' }, version: 'abc' });
    const fixed = setup({ version: 'xyz' });
    fixed.socks.last().open();
    assert.equal(fixed.socks.last().sent[0].version, 'xyz');
  });

  test('a reload message is final', () => {
    const { rc, socks, timers } = setup({ version: 'old' });
    socks.last().open();
    socks.last().msg({ t: 'reload', version: 'new' });
    socks.last().drop(4005);
    timers.advance(60_000);
    assert.equal(rc.status(), 'reload');
    assert.equal(socks.all.length, 1);
  });

  test('fetchVersion GETs /api/version, null on any failure', async () => {
    const calls = [];
    const ok = await fetchVersion({ base: 'https://skull.test', fetch: async url => { calls.push(url); return { ok: true, json: async () => ({ version: 'v7' }) }; } });
    assert.equal(ok, 'v7');
    assert.deepEqual(calls, ['https://skull.test/api/version']);
    assert.equal(await fetchVersion({ base: 'x', fetch: async () => ({ ok: false }) }), null);
    assert.equal(await fetchVersion({ base: 'x', fetch: async () => { throw new Error('offline'); } }), null);
    assert.equal(await fetchVersion({ base: 'x', fetch: async () => ({ ok: true, json: async () => ({}) }) }), null);
  });
});

