# Multiplayer — Spec

Online multiplayer with friends is the real goal of this game. Product theme: **agile and
lightweight**. Getting into a game with friends must take seconds. No accounts, no libraries,
no build step.

Read SPEC.md (rules + engine contract) and TUTORIAL_SPEC.md (director/coach, quick start)
first. **Sequencing:** multiplayer work starts only after the tutorial work has landed. It
touches `main.js`/`ui.js`, and it needs a small `engine.js` change (see §8).

## 1. Decisions at a glance

| Topic | Decision |
|---|---|
| Play context | Phones first. Assume friends are on voice or in the same room. |
| Joining | Room code + share link. No accounts. Open lobby list + code bubble (.io style). |
| Backend | Cloudflare Worker + Durable Objects, **server-authoritative**. Zero dependencies. |
| Hosting | `skull.xlobax.com` (Worker custom domain). Manual `npm run deploy`. |
| Solo / tutorial | Stay **fully offline**. They never touch the network. |
| Bots | Only as **filler seats the host adds in the lobby** (full `ai.js`, 🤖 badge). A bot **never** replaces a human. |
| Disconnect | Seat waits on its normal clock. Timeout → ⏱ auto move. Gone 90s → forfeit. |
| Leave | Explicit Leave button → forfeit. |
| Turn timer | Host picks Off / 20 / 30 / 60s, default 30s (lengths to be tuned). |
| Reactions | Small v1 set (emojis + tomato throw), built by a **separate agent**. |
| Avatars | Emoji placeholders now. Mix-and-match skull builder later. |
| Speed setting | None. No animation skip-ahead (per TUTORIAL_SPEC). |

## 2. Hosting & machinery

- **Cloudflare Workers.** One Worker serves both the static site (Workers **Static Assets**)
  and the API/WebSockets, from the same origin.
- **Durable Objects (SQLite-backed, free tier):**
  - `Room`: one per lobby code (`idFromName(code)`). Holds the lobby, game state, sockets,
    timers (DO alarms) and bot turns.
  - `LobbyDirectory`: a single instance that holds the list of Open lobbies in the `waiting` state.
- **Domain:** `xlobax.com` DNS is already on Cloudflare (nameservers chip/treasure). It has a
  wildcard `*.xlobax.com` → Tailscale IP. Deploying with `custom_domain = true` creates an
  explicit `skull` record, which takes precedence over the wildcard. Other subdomains are
  untouched, and no DNS edits are needed.
- **Tooling:** `wrangler` as a devDependency. Alex runs `npx wrangler login` once.
  `npm run dev` runs `wrangler dev` (everything local). `npm run deploy` runs `wrangler deploy`.
  CI deploys come later.
- `wrangler.toml` (sketch):
  ```toml
  name = "skull"
  main = "worker/index.js"
  compatibility_date = "<today at implementation>"
  routes = [{ pattern = "skull.xlobax.com", custom_domain = true }]
  assets = { directory = ".", binding = "ASSETS", run_worker_first = ["/api/*"] }
  [[durable_objects.bindings]]
  name = "ROOM"
  class_name = "Room"
  [[durable_objects.bindings]]
  name = "LOBBIES"
  class_name = "LobbyDirectory"
  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["Room", "LobbyDirectory"]
  ```
  `.assetsignore` excludes `worker/`, `test/`, `qa/`, `node_modules/`, `*.md`, `*.pdf`,
  `wrangler.toml` and `package*.json`.
- Nothing is persisted after a room dies. There is no history and no stats in v1.

## 3. Architecture

- `src/engine.js` remains **the single rules source**. The browser (solo) and the Worker
  (multiplayer) both import it. `src/ai.js` runs on the server for filler bots.
- **View filtering** — new pure module `src/view.js`:
  `viewFor(state, playerId) -> view`. A view has **the same shape as the engine state**,
  so `ui.js` changes stay small. The differences:
  - Other players' `hand` → `Array(n).fill(null)`, so the count is kept and the faces are hidden.
  - `mat` → `null` for each unrevealed card of other players. Revealed cards (the top
    `revealed` cards) keep their face. Your own mat is fully visible.
  - `lastResult.discarded` is present only for the challenger.
  - It adds `view.me = playerId`.
  - `log` is already value-safe (per engine notes).
  - Card faces that become public at reveal are visible to everyone. The x-ray at round end
    is **tutorial-only** and is never sent in multiplayer.
- **Controller seam (client).** `main.js` drives a game through a controller with one
  interface: `controller.onView(cb)`, `controller.send(action)`, `controller.leave()`.
  - `localController`: the engine runs in the browser, as today (solo + tutorial,
    directors still apply). It feeds `viewFor(state, 0)` to the UI.
  - `remoteController` (`src/net.js`): WebSocket to the room.
  - `ui.js` only ever renders a **view**, never raw state.
- Every message is a **full view snapshot**. State is tiny, so there are no diffs. Each view
  carries `seq`. The client drops any view whose `seq` is ≤ the last one it applied. On
  (re)connect the server sends the current view at once.
- Banners and animations are derived client-side from consecutive views plus
  `view.lastAction`. That is the last applied action, redacted: no card face for
  `place`/`placeInitial`. It carries `auto: true` when it was a ⏱ auto move.

## 4. Protocol

HTTP:
- `POST /api/rooms` → `{code}` creates a room. The caller then connects as host.
- `GET /api/lobbies` → `[{code, host, humans, seats, bots, timer}]`. Open + waiting only.
  The join bubble polls this every 3s while it's open.
- `GET /api/rooms/:code/ws?token=…` → WebSocket upgrade. 404 if the room doesn't exist.

Client → server (`{t, …}`):
- `{t:'hello', name, avatar}` is sent first on every connect. `token` is in the URL.
- `{t:'lobby', op:'options', seats?, timer?, open?}` (host only)
- `{t:'lobby', op:'addBot' | 'removeBot' | 'kick', seat?}` (host only)
- `{t:'lobby', op:'start' | 'rematch'}` (host only)
- `{t:'action', action}` is an engine action. The server overwrites `action.player` with the
  sender's seat and validates it against `legalActions`. Illegal actions get `{t:'error'}`.
- `{t:'leave'}` is an explicit Leave = forfeit (§6).
- `{t:'react', kind, target?}` (reactions, §9)

Server → client:
- `{t:'lobby', lobby}` — `{code, hostSeat, options:{seats, timer, open}, members:[{seat, name,
  avatar, isBot, connected, waiting}], phase:'waiting'|'in-game', lastWinner?}`
- `{t:'view', seq, view, seats:[{name, avatar, isBot, connected, forfeited}], deadline}`.
  `deadline` is `{players:[ids], at: serverEpochMs} | null`. The client corrects for clock
  offset using `serverNow`, which is sent in each message.
- `{t:'event', e:'react', from, kind, target?}`
- `{t:'error', msg}`, `{t:'kicked'}`

## 5. Lobby

- **Room code:** 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ` (no O/I). Input is
  case-insensitive. Share link: `https://skull.xlobax.com/#/r/KX4P`.
- **Identity:** a random per-browser `token` in localStorage (`skull.token`). The same token
  rejoins the same seat after a refresh or phone lock.
- **Host options** (remembered in `skull.hostOptions`):
  - Seats 3–6. The host adds or removes 🤖 filler bots; humans take the empty seats.
  - Turn timer Off/20/30/60s (default 30).
  - **Open** (listed, the default; randos dropping in is part of the fun) or **Private**
    (code/link only).
  - First player is always random. No house rules in v1.
- The host can start whenever there are 3 or more seats (humans + bots). 1 human + bots is allowed.
- **Names:** optional, blank → "Rider", max 16 chars. Duplicates in a room get " 2", " 3".
- **Kick:** host only, lobby only. Mid-game, use the disconnect/forfeit rules instead.
- **Host leaves:** host passes to the longest-seated human.
- **Late joiners** (via code/link while a game is in progress) wait in the lobby (`waiting:
  true`) and are seated at the next rematch. Humans + bots + waiting ≤ 6, otherwise the
  server answers "Table full". In-game lobbies don't appear in the list.
- **Game over:** everyone returns to **the same lobby**, which shows the result. The host has
  **Rematch** (one tap, same seats and options). Anyone can Leave. Seats of players who left
  or abandoned are freed.
- **Room cleanup:** a room is deleted **60s** after the last human leaves or disconnects. It
  is removed from `LobbyDirectory` at once, and also whenever it goes in-game or Private.

## 6. Turns, timers, disconnects, forfeits

- **Clock:** the active player(s) get the lobby timer. In `place-initial` every player who
  hasn't placed yet has a clock at the same time. The server owns deadlines through DO alarms.
- **⏱ Auto move** on timeout. It's the least interactive legal move, and visibly marked
  (⏱ in the banner/log), so it never reads as a player's strategy:
  - bidding → **pass**
  - place-initial / placement → **random card from hand**. With an empty hand → bid the
    **minimum legal amount**.
  - reveal → own stack first, then the top of a **random** opponent stack that isn't fully revealed
  - discard → random card · choose-first → random active player · round-over → n/a (server-timed)
- **Turn nudge:** at 5s left on your own clock, your seat shakes and a soft tick plays.
  **No phone vibration.** 🔊 sound toggle in the top bar (`skull.sound`). There is no other
  penalty for timeouts while connected.
- **Disconnect** = the socket closed without `{t:'leave'}`. It covers refresh, phone lock,
  closed tab and network loss. The seat shows 📡 *reconnecting…* and **waits on its normal
  clock**. Reconnecting in time means you play your own turn. If the clock runs out first,
  the seat makes a ⏱ auto move. If the lobby timer is **Off**, a disconnected seat still gets
  a **30s** clock so the table never freezes.
- **Abandon:** disconnected for **90s** in total → forfeit.
- **Forfeit** (Leave or abandon): the player is out of the game. The seat is greyed out
  ("Mo left") and plays the **rest of the current round on instant ⏱ auto moves** (no clock).
  At round end the player is eliminated through the engine (§8). If only one active player
  remains, they win. The player cannot rejoin that game. A player who abandoned can return
  to the lobby for the rematch.
- If no humans are left in-game (all forfeited or gone), the game ends and the room follows
  the cleanup rule.
- **Bots:** filler bots use `ai.chooseAction` with a 700–1200ms delay, run server-side.
  Bots never take over human seats.
- **Next round** auto-starts **~4s** after `round-over`, timed by the server. There is no
  ready check, and tapping doesn't skip it in multiplayer.

## 7. Client screens (shell)

Home:
```
 [avatar ◀ ▶]  [ name____ ]
 [  HOST A GAME  ]            → POST /api/rooms, straight into your lobby
 [  JOIN A GAME  ]            → bubble: Code [_ _ _ _] GO (auto-joins on 4th letter)
 Play vs bots · Learn to play                ── or open lobbies ── (live list, tap to join)
```
- Name + avatar sit on the home screen and are saved in `skull.settings` (now `{name,
  opponents, avatar}`). "Play vs bots" is the current Play now (solo, offline). The join
  bubble layout is provisional; revisit once we can see it.
- **Avatars (placeholder):** tap from about 12 emojis: 💀 🌹 🐍 🐺 🦅 🐆 🤘 🔥 🍺 🃏 🏍️ 👻.
  The protocol sends `avatar` as an **opaque small object**, now `{emoji:'🐺'}`. Later it
  becomes `{shape, hat, eyes, teeth, …}` for the skull builder, with no protocol change.
  Bots get fixed avatars that match their names.
- **Share link** `/#/r/CODE` skips the home screen: name/avatar prompt (pre-filled) → lobby.
- **Lobby screen:** code + copy-link/share button, seats with avatars/names/🤖/📡, host
  options and Start (host), Leave.
- **Game screen:** the existing table, rendering views. Additions: a timer ring on the
  active seat(s), 📡 / greyed "left" states, ⏱ tags, an in-game **Leave** button with a
  confirm step ("Leaving forfeits the game").

## 8. Engine change (after the tutorial unfreezes `engine.js`)

Add a pure `forfeit` helper/action. It is applied by the server **when the round reaches
`round-over`** (or at once if already between rounds):
`{ type: 'forfeit', player }` → player `eliminated = true`, hand cleared. If only 1 active
remains → `game-over` with that winner. If the forfeiter was the next `firstPlayer` →
`nextActive`. It is rejected outside `round-over`. Add tests to `test/engine.test.js`.

## 9. Reactions (separate agent)

- v1: 4–6 pop-up reactions over your seat (e.g. 😏 🤔 💀 🌹 😂) + a **🍅 tomato** thrown
  at a chosen player (it flies from seat to seat and splats).
- Targeted emotes (aimed at another seat, `target` required): 🍅 tomato, 💐 bouquet (bursts
  into petals), 👉 accuse (a beam from seat to seat, ‼️ over them), 🥂 cheers (clinks; if the
  target raises one back within 4s, both seats glow and a big "Cheers!" lands between them —
  worked out on each client from the event stream, no extra server state).
- The server rate-limits to 1 per player per 2s and broadcasts `{t:'event', e:'react',
  from, kind, target?}`. Unknown `kind` values are dropped.
- Client module `src/reactions.js` + `reactions.css`:
  `mountReactions({ root, send, seatEl(playerId) }) -> { handle(event), destroy() }`. It owns
  its own picker button/UI. The shell mounts it only in multiplayer games and routes
  `e:'react'` events to it.
- Later: the 🔫 revolver, more throwables, text chat.

## 10. File ownership

| Files | Owner |
|---|---|
| `worker/**`, `wrangler.toml`, `.assetsignore`, `package.json` (scripts/devDeps), `src/view.js`, `test/view.test.js`, `test/server.test.js`, the §8 change in `src/engine.js` + its tests | **server** agent |
| `src/net.js` (remoteController: socket, reconnect with backoff, seq, clock offset), `test/net.test.js` | **net** agent |
| `index.html`, `styles.css`, `src/ui.js`, `src/main.js` (controller seam, localController), home/join bubble/lobby screens, avatars placeholder, timer ring, nudge + sound | **shell** agent |
| `src/reactions.js`, `reactions.css` | **reactions** agent |
| `qa/**` | **QA** agent |

Cross-agent requests go in `NOTES.md` under your heading, as before.

## 11. Testing

- `test/view.test.js`: no hidden card face of another player ever appears in any view,
  across full replayed games (fuzz with bots). `discarded` is visible only to the challenger.
- `test/server.test.js`: drive the Room logic without sockets (keep it a pure core the DO
  wraps). Covers timeouts → correct auto move, disconnect clock, 90s abandon, forfeit at
  round end, host transfer, rematch, name dedupe, the full-table rule, illegal action rejection.
- `qa/`: a Playwright run against `wrangler dev` with 3 browser contexts. It covers host +
  2 joiners (code and link), a filler bot, a full game, a refresh mid-turn (rejoin the same
  seat), Leave mid-round (forfeit), rematch, Private lobby hidden from the list, and the
  desktop + mobile viewports.

## 12. Later (not v1)

Skull avatar builder (shape/hat/eyes/teeth) · text chat · revolver and more throwables ·
stronger AI that profiles human players across a session · CI deploys · spectators ·
house rules · tuning the timer lengths.
