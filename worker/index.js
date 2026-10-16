// Skull & Roses — Cloudflare Worker: static site + multiplayer API
// (MULTIPLAYER_SPEC §2–§4). `Room` wraps the pure room core; `LobbyDirectory`
// lists Open rooms in the lobby.

import { DurableObject } from 'cloudflare:workers';
import { RoomCore, CLOSE } from './room-core.js';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(b => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
}

const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const lobbyStub = env => env.LOBBIES.get(env.LOBBIES.idFromName('directory'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (path === '/api/rooms' && request.method === 'POST') {
      for (let i = 0; i < 20; i++) {
        const code = randomCode();
        const res = await roomStub(env, code).fetch('https://room/init', { method: 'POST', body: code });
        if (res.ok) return json({ code });
      }
      return json({ error: 'No free room code' }, 503);
    }

    if (path === '/api/lobbies' && request.method === 'GET') {
      return lobbyStub(env).fetch('https://lobbies/list');
    }

    const m = path.match(/^\/api\/rooms\/([A-Za-z]{4})\/ws$/);
    if (m) {
      const code = m[1].toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: 'No such room' }, 404);
      // The room decides: 404 when missing, even for a plain GET (the
      // client's not-found probe), then the token and upgrade checks.
      const token = url.searchParams.get('token') ?? '';
      return roomStub(env, code).fetch(`https://room/ws?token=${encodeURIComponent(token)}`, request);
    }

    return json({ error: 'Not found' }, 404);
  },
};

// One per room code. Sockets use the Hibernation API; the core's state is
// persisted after every event so nothing is lost when the object sleeps.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.core = null;
    this.listed = 'null';
    ctx.blockConcurrencyWhile(async () => {
      const [snap, listed] = await Promise.all([ctx.storage.get('room'), ctx.storage.get('listed')]);
      if (listed) this.listed = listed;
      if (!snap) return;
      this.core = RoomCore.fromJSON(snap);
      // Sockets dropped while we were away (e.g. a deploy) never sent a close.
      const live = new Set(ctx.getWebSockets().map(ws => ws.deserializeAttachment()?.token));
      for (const [token, m] of Object.entries(snap.members)) {
        if (!m.isBot && m.connected && !live.has(token)) await this.flush(this.core.disconnect(token));
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (this.core && !this.core.dead) return new Response('taken', { status: 409 });
      const code = await request.text();
      await this.ctx.storage.deleteAll();
      this.listed = 'null';
      this.core = new RoomCore({ code });
      await this.flush([]);
      return new Response('ok');
    }
    if (url.pathname === '/ws') {
      // Read-only until the upgrade: probing a missing code stores nothing.
      if (!this.core || this.core.dead) return json({ error: 'No such room' }, 404);
      const token = url.searchParams.get('token') ?? '';
      if (!TOKEN_RE.test(token)) return json({ error: 'Bad token' }, 400);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return json({ error: 'Expected a WebSocket' }, 426);
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // A second tab with the same token takes over the seat.
      const old = this.ctx.getWebSockets(token);
      this.ctx.acceptWebSocket(server, [token]);
      server.serializeAttachment({ token });
      for (const ws of old) {
        try { ws.close(CLOSE.replaced, 'replaced'); } catch { /* already closed */ }
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, data) {
    const token = ws.deserializeAttachment()?.token;
    if (!this.core || !token || typeof data !== 'string' || data.length > 4096) return;
    let msg;
    try { msg = JSON.parse(data); } catch { msg = null; }
    await this.flush(this.core.handle(token, msg));
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
    await this.socketGone(ws);
  }

  async webSocketError(ws) {
    await this.socketGone(ws);
  }

  async socketGone(ws) {
    const token = ws.deserializeAttachment()?.token;
    if (!this.core || !token) return;
    // Still connected through another socket (a newer tab took over).
    const others = this.ctx.getWebSockets(token).filter(s => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length) return;
    await this.flush(this.core.disconnect(token));
  }

  async alarm() {
    if (!this.core) return;
    await this.flush(this.core.tick());
  }

  // Deliver the core's outputs, then persist, re-arm the alarm and update the listing.
  async flush(out) {
    const sockets = this.ctx.getWebSockets();
    for (const o of out) {
      const targets = o.to === 'all' ? sockets : this.ctx.getWebSockets(o.to);
      if (o.close) {
        for (const ws of targets) {
          try { ws.close(o.code ?? CLOSE.left, 'bye'); } catch { /* already closed */ }
        }
        continue;
      }
      const data = JSON.stringify(o.msg);
      for (const ws of targets) {
        try { ws.send(data); } catch { /* closing */ }
      }
    }
    const core = this.core;
    const listing = core.listing();
    const listed = JSON.stringify(listing);
    if (listed !== this.listed) {
      this.listed = listed;
      await lobbyStub(this.env).fetch('https://lobbies/set', {
        method: 'POST',
        body: JSON.stringify({ code: core.s.code, listing }),
      });
    }
    if (core.dead) {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(CLOSE.notFound, 'room closed'); } catch { /* already closed */ }
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.core = null;
      this.listed = 'null';
      return;
    }
    await this.ctx.storage.put({ room: core.toJSON(), listed: this.listed });
    const at = core.nextAlarm();
    if (at == null) await this.ctx.storage.deleteAlarm();
    // Never in the past: always a fresh time after the alarm that may be running now.
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1));
  }
}

// A single instance: code -> listing for Open rooms in the lobby.
export class LobbyDirectory extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/set') {
      const { code, listing } = await request.json();
      if (listing) await this.ctx.storage.put(code, listing);
      else await this.ctx.storage.delete(code);
      return new Response('ok');
    }
    if (url.pathname === '/list') {
      const all = await this.ctx.storage.list();
      return json([...all.values()]);
    }
    return new Response('Not found', { status: 404 });
  }
}
