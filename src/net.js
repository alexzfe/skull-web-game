// Multiplayer client: room codes, the per-browser token, the lobby HTTP calls and
// the remote controller (WebSocket to a Room). Protocol: MULTIPLAYER_SPEC §4.
// No DOM work here — the shell renders whatever this hands it.
//
//   getToken(opts?)                → per-browser token (localStorage `skull.token`)
//   normalizeCode(str)             → 'KX4P' | null      cleanCode(str) → partial input, ≤4 valid letters
//   shareLink(code, opts?)         → `${origin}/#/r/KX4P`   parseShareHash(hash) → code | null
//   createRoom(opts?)              → Promise<{code}>     listLobbies(opts?) → Promise<[{code, host, humans, seats, bots, timer}]>
//
//   const rc = createRemoteController({ code, name, avatar, token?, base? })
//   rc.onView(cb)    cb(view, {seq, seats, deadline}) — only views newer than the last applied
//   rc.onLobby(cb)   cb(lobby)
//   rc.onEvent(cb)   cb({e, from, kind, target?})       (reactions etc.)
//   rc.onError(cb)   cb(msg)                            (server {t:'error'} messages)
//   rc.onStatus(cb)  cb(status): 'connecting' | 'open' | 'reconnecting' | 'closed' | 'kicked' | 'not-found' | 'full' | 'replaced'
//                    ('replaced' = another tab took this seat with the same token)
//   rc.send(action)  engine action → true if it went out (the server fills in `player`)
//   rc.lobby(op, args?)   host lobby ops: 'options' {seats, timer, open} · 'addBot' · 'removeBot' {seat} · 'kick' {seat} · 'start' · 'rematch'
//   rc.react(kind, target?)
//   rc.now()         server-corrected epoch ms — compare against `deadline.at`
//   rc.leave()       explicit Leave (forfeit): sends {t:'leave'}, closes for good
//   rc.close()       closes for good without leaving (the seat counts as disconnected)
//
// Every on*() returns an unsubscribe function. onView/onLobby/onStatus call a new
// subscriber at once with the latest value they have, so a screen mounted late
// still gets the current table. The controller reconnects on its own after any
// close it didn't ask for; 'kicked', 'not-found', 'full', 'replaced' and 'closed' are final.
//
// Everything platform-ish (WebSocket, fetch, storage, timers, clock, location,
// document/window) can be injected through an options object, so this module
// also runs under `node --test` with fakes.

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4}$`);
const TOKEN_KEY = 'skull.token';
const BACKOFF_MS = [500, 1000, 2000, 4000, 5000];
const OFFSET_SMOOTHING = 0.25;   // weight of a new serverNow sample

const env = opts => ({
  WebSocket: opts.WebSocket ?? globalThis.WebSocket,
  fetch: opts.fetch ?? (globalThis.fetch && ((...a) => globalThis.fetch(...a))),
  storage: 'storage' in opts ? opts.storage : safeLocalStorage(),
  setTimeout: opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms)),
  clearTimeout: opts.clearTimeout ?? (id => globalThis.clearTimeout(id)),
  clock: opts.clock ?? (() => Date.now()),
  random: opts.random ?? Math.random,
  location: opts.location ?? globalThis.location,
  document: 'document' in opts ? opts.document : globalThis.document,
  window: 'window' in opts ? opts.window : globalThis.window,
});

function safeLocalStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// ---------- identity ----------

let memoryToken = null;   // when storage is unavailable, keep one token per page load

export function getToken(opts = {}) {
  const storage = 'storage' in opts ? opts.storage : safeLocalStorage();
  try {
    const t = storage?.getItem(TOKEN_KEY);
    if (t) return t;
  } catch { /* storage blocked */ }
  const t = memoryToken ?? randomToken(opts.crypto ?? globalThis.crypto);
  memoryToken = t;
  try { storage?.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
  return t;
}

function randomToken(crypto) {
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- room codes & links ----------

// For a code input box: uppercase, drop anything that can't be in a code, max 4.
export function cleanCode(str) {
  return String(str ?? '').toUpperCase().split('').filter(c => CODE_ALPHABET.includes(c)).join('').slice(0, 4);
}

// A full, valid code or null. Spaces and dashes are ignored; O/I/digits make it invalid.
export function normalizeCode(str) {
  const s = String(str ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return CODE_RE.test(s) ? s : null;
}

export function shareLink(code, opts = {}) {
  const origin = opts.origin ?? (opts.location ?? globalThis.location)?.origin ?? '';
  return `${origin}/#/r/${code}`;
}

export function parseShareHash(hash) {
  const m = /^#?\/r\/([^/?#]+)\/?$/i.exec(String(hash ?? '').trim());
  return m ? normalizeCode(decodeURIComponent(m[1])) : null;
}

// ---------- HTTP ----------

const httpBase = (base, e) => (base ?? e.location?.origin ?? '').replace(/\/+$/, '');

export async function createRoom(opts = {}) {
  const e = env(opts);
  const res = await e.fetch(`${httpBase(opts.base, e)}/api/rooms`, { method: 'POST' });
  if (!res.ok) throw new Error(`createRoom failed: ${res.status}`);
  const body = await res.json();
  if (!normalizeCode(body?.code)) throw new Error('createRoom: bad code from server');
  return { code: body.code };
}

export async function listLobbies(opts = {}) {
  const e = env(opts);
  const res = await e.fetch(`${httpBase(opts.base, e)}/api/lobbies`);
  if (!res.ok) throw new Error(`listLobbies failed: ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

// ---------- remote controller ----------

const FINAL = new Set(['closed', 'kicked', 'not-found', 'full', 'replaced']);

// Server {t:'error'} messages that end the session. Close codes are accepted too
// in case the server prefers them (see NOTES.md, Net agent).
function finalStatusForError(msg) {
  const m = String(msg ?? '');
  if (/full/i.test(m)) return 'full';
  if (/not found|no such room|unknown room|doesn.t exist/i.test(m)) return 'not-found';
  return null;
}
// Server close codes (NOTES.md, Server agent): 4000 replaced by another tab, 4001 kicked /
// table full / after leave, 4002 room closed. 4004/4009 are harmless extras.
// 'Table full' and leave() reach a final status first, so a later 4001 can't relabel them.
function statusForClose(code, opened) {
  if (code === 4000) return 'replaced';
  if (code === 4001) return 'kicked';
  if (code === 4002) return opened ? 'closed' : 'not-found';
  if (code === 4004) return 'not-found';
  if (code === 4009) return 'full';
  return null;
}

export function createRemoteController({ code, name, avatar, token, base, ...opts } = {}) {
  const e = env(opts);
  const roomCode = normalizeCode(code);
  const myToken = token ?? getToken({ storage: e.storage });
  const origin = httpBase(base, e);
  const path = `/api/rooms/${roomCode}/ws?token=${encodeURIComponent(myToken)}`;
  const wsUrl = origin.replace(/^http/i, 'ws') + path;

  const subs = { view: new Set(), lobby: new Set(), event: new Set(), error: new Set(), status: new Set() };
  let status = null;
  let ws = null;
  let attempt = 0;          // failed connects since the last good one
  let retryTimer = null;
  let lastSeq = -Infinity;
  const last = { view: null, lobby: null };   // view entry is [view, meta]
  let offset = null;        // serverNow − local clock, smoothed

  const emit = (kind, ...args) => {
    for (const cb of [...subs[kind]]) {
      try { cb(...args); } catch (err) { console.error(`net ${kind} listener failed`, err); }
    }
  };
  const setStatus = s => {
    if (s === status) return;
    status = s;
    emit('status', s);
  };
  const subscribe = (kind, replay) => cb => {
    subs[kind].add(cb);
    if (replay) replay(cb);
    return () => subs[kind].delete(cb);
  };

  function connect() {
    retryTimer = null;
    if (FINAL.has(status)) return;
    if (!roomCode) { finish('not-found'); return; }
    setStatus(attempt === 0 && lastSeq === -Infinity && !last.lobby ? 'connecting' : 'reconnecting');
    let sock;
    try { sock = new e.WebSocket(wsUrl); } catch { scheduleRetry(); return; }
    ws = sock;
    let opened = false;
    let heard = false;
    sock.onopen = () => {
      if (ws !== sock) return;
      opened = true;
      setStatus('open');
      sock.send(JSON.stringify({ t: 'hello', name, avatar }));
    };
    sock.onmessage = ev => {
      if (ws !== sock) return;
      if (!heard) { heard = true; attempt = 0; }
      handle(ev.data);
    };
    sock.onerror = () => { /* the close event follows */ };
    sock.onclose = ev => {
      if (ws !== sock || FINAL.has(status)) return;
      ws = null;
      const final = statusForClose(ev?.code, opened);
      if (final) { finish(final); return; }
      if (!opened) probeMissing();
      scheduleRetry();
    };
  }

  function scheduleRetry() {
    if (FINAL.has(status) || retryTimer) return;
    setStatus('reconnecting');
    const baseMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    const jitter = 0.8 + 0.4 * e.random();   // ±20%
    retryTimer = e.setTimeout(connect, Math.round(baseMs * jitter));
  }

  // A browser can't see the 404 behind a failed upgrade, so ask over plain HTTP.
  function probeMissing() {
    if (!e.fetch) return;
    Promise.resolve()
      .then(() => e.fetch(`${origin || ''}${path}`))
      .then(res => { if (res?.status === 404 && !FINAL.has(status)) finish('not-found'); })
      .catch(() => { /* offline — keep retrying */ });
  }

  function finish(s) {
    if (retryTimer) { e.clearTimeout(retryTimer); retryTimer = null; }
    const sock = ws;
    ws = null;
    if (sock) { try { sock.close(1000); } catch { /* ignore */ } }
    detachWake();
    setStatus(s);
  }

  function handle(data) {
    let msg;
    try { msg = typeof data === 'string' ? JSON.parse(data) : data; } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (typeof msg.serverNow === 'number') sampleClock(msg.serverNow);
    switch (msg.t) {
      case 'view': {
        if (typeof msg.seq !== 'number' || msg.seq <= lastSeq) return;
        lastSeq = msg.seq;
        const meta = { seq: msg.seq, seats: msg.seats ?? [], deadline: msg.deadline ?? null };
        last.view = [msg.view, meta];
        emit('view', msg.view, meta);
        return;
      }
      case 'lobby':
        last.lobby = msg.lobby;
        emit('lobby', msg.lobby);
        return;
      case 'event':
        emit('event', msg);
        return;
      case 'error': {
        emit('error', msg.msg);
        const final = finalStatusForError(msg.msg);
        if (final) finish(final);
        return;
      }
      case 'kicked':
        finish('kicked');
        return;
    }
  }

  function sampleClock(serverNow) {
    const sample = serverNow - e.clock();
    offset = offset === null ? sample : offset + OFFSET_SMOOTHING * (sample - offset);
  }

  function sendRaw(obj) {
    if (!ws || status !== 'open') return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // Phones drop sockets while locked; when the page comes back, retry at once.
  function wake() {
    if (document?.visibilityState === 'hidden') return;
    if (retryTimer) {
      e.clearTimeout(retryTimer);
      retryTimer = null;
      connect();
    }
  }
  const { document, window } = e;
  document?.addEventListener?.('visibilitychange', wake);
  window?.addEventListener?.('online', wake);
  function detachWake() {
    document?.removeEventListener?.('visibilitychange', wake);
    window?.removeEventListener?.('online', wake);
  }

  connect();

  return {
    code: roomCode,
    token: myToken,
    onView: subscribe('view', cb => { if (last.view) cb(...last.view); }),
    onLobby: subscribe('lobby', cb => { if (last.lobby) cb(last.lobby); }),
    onEvent: subscribe('event'),
    onError: subscribe('error'),
    onStatus: subscribe('status', cb => { if (status) cb(status); }),
    status: () => status,
    send: action => sendRaw({ t: 'action', action }),
    lobby: (op, args = {}) => sendRaw({ ...args, t: 'lobby', op }),
    react: (kind, target) => sendRaw(target === undefined ? { t: 'react', kind } : { t: 'react', kind, target }),
    now: () => e.clock() + (offset ?? 0),
    leave() {
      if (FINAL.has(status)) return;
      sendRaw({ t: 'leave' });
      finish('closed');
    },
    close() {
      if (!FINAL.has(status)) finish('closed');
    },
  };
}
