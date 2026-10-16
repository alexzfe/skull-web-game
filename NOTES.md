
## Engine agent

- On a **lost** bet, the challenger's mat is returned to their hand immediately (so they can discard / lose a card); their `mat` is `[]` and `revealed` is 0 from the `discard` phase onward. Other players' mats and `revealed` counts stay on the board until `nextRound`. Use `revealedSkullOwner` / `lastResult` to show what happened.
- `legalActions(state, anyId)` returns `[{type:'nextRound'}]` in `round-over` for every player (the UI decides who triggers it).
- In `place-initial`, `legalActions` is non-empty for every active player who hasn't placed yet (it ignores `currentPlayer`).
- Card actions are de-duplicated: at most one `place`/`placeInitial` per card type (rose, skull).
- `createGame` also accepts `firstPlayer: 'random'` (uses `rng`). The log never shows the value of placed or discarded cards.

## QA findings

Run with `cd qa && npm install && npm run e2e` (the game must be served at http://localhost:5173/). Useful env vars: `QA_ONLY=<regex>` limits which runs execute (e.g. `QA_ONLY=suicide`), and `QA_VERBOSE=1` prints every human click. Screenshots are saved to `qa/shots/<viewport>-<N>opp[-strategy]-g<game>-<phase>.png`. The script uses the cached Chromium in `~/.cache/ms-playwright`, whatever its revision.

What it does: plays full games through real clicks at 1280x800 and 390x844 with 2, 3 and 5 opponents. Each run covers Play again (2-opponent runs play the second game to the end) and Change table. There are also a "reckless" run (skull-heavy, high bids) and a "suicide" run, which forces the human to lose to their own skull until eliminated so the human gets the choose-first-player choice. The script fails on any console error or warning, page error, failed request, stuck state (no human control and no change on screen for 10s), click with no effect (3 times in a row), wrong reset after Play again, or horizontal page scroll.

Result (2026-10-15): all 10 runs passed, with 16 full games. There were **no console or page errors, no stuck states and no horizontal scroll** at either size. Every phase and every human action was exercised, including discard and choose-first at both sizes. A bot also went through choose-first correctly. No engine bugs were found (`node --test test/` passes 42/42).

### UI issues (not fixed; owner: ui agent)

1. **Banners lag behind the game state (minor, confusing).** `ui.banner` queues banners and shows each for 1.1–2.2s. A quick run of events (open bid → "must flip N" → "SKULL!" → "X is out!") therefore stays on screen several seconds after the state has moved on.
   Repro: 5 opponents, mobile. Lay your skull, bid the maximum on your first turn, and keep discarding roses. On the 4th loss the choose-first buttons appear while the banner still reads "You must flip 6" (`qa/shots/mobile-5opp-suicide-g1-phase-choose-starter.png`).
   Suggestion: when a newer banner arrives, drop queued banners from the same "beat" (for example, clear the queue when the phase changes), or cut each banner's time to ~600ms when the queue has more than one item. The current shortcut only applies when there are more than 2 queued.
2. **Toasts cover the human's controls.** The `.toasts` stack (fixed, bottom-left, up to 4 items) is drawn over the human's seat and controls. On desktop it hides the "Challenger" badge and "N cards left" (`desktop-5opp-g1-phase-round-over.png`). On mobile it covers the hand cards and the last choose-first button: the "Snakes" button sits under "You lost a skull" in `mobile-5opp-suicide-g1-phase-choose-starter.png`. Clicks still pass through (`pointer-events: none`), but the controls can't be seen.
   Suggestion: on desktop, put toasts at top-right or above the table. At ≤640px, pin them under the top bar. Or offer them through the banner layer instead.
3. **Pot count drops below the bid after a lost challenge (cosmetic).** When the challenger loses, the engine returns the challenger's mat to their hand right away (see the Engine agent notes). In discard / choose-first / round-over the centre then shows e.g. "5 cards on the table" next to "You bid 6", and the challenger's mat looks empty even though one pip shows a flipped card. The UI freezes the board for only `REVEAL_HOLD_MS` (2s). Suggestion: show "N cards on the table" from the `bid` total (or hide the pot) when `phase` isn't placement/bidding/reveal. Alternatively, keep a ghost of the challenger's revealed cards from the frozen pre-loss state.
4. **A revealed skull can be hidden under a revealed rose (minor).** When the challenger flips an opponent's top rose and then the skull under it, the stack still draws the rose on top. In round-over the board doesn't show which card was the skull; only the banner and log do (Himself's stack in `desktop-5opp-g1-phase-round-over.png`). Suggestion: fan revealed cards out sideways, or show every revealed card face-up side by side.

### Environment note
- The installed `playwright@1.64.1` expects chromium revision 1248, but the cache has 1243. The script points `executablePath` at the cached build, so no download is needed.

## Tutor agent

Delivered `src/tutorial-script.js`, `src/tutorial.js`, `src/tips.js`, `test/tutorial.test.js`, `test/tips.test.js` (`node --test test/` green).
- Tutorial director implements `setup`, `rng`, `botAction`, `allowHuman`, `canProceed`, `onStart`, `onState`, `onGameOver`, `autoNextRoundMs` (400), `exit`, plus the shell's extra `botDelay` hook (420ms, 650ms in reveal). The human uses the name remembered in `skull.settings`, so the log/seat never read "You places…" / "YOU (YOU)".
- Tips rely on the coach's own "Don't show tips" link (coach sets `skull.tipsOff`; the director checks it before each tip). Tip ids are stored in `skull.tipsSeen`; `onGameOver` increments `skull.tipsGames`.
- Headless walkthrough (Playwright, 1280x800 and 390x844, clicking Next and the spotlit target on each locked step): finishes in about 30s at both sizes, the finale's "Play a real game" sets `skull.tutorialDone=1` and starts a tips game, Skip works mid-tutorial (tested at bubbles 1, 2, 6, 14 and 26), and there are no console errors or warnings.

### Shell-side issues found (owner: shell)
1. **Banners lag behind and cover the spotlit target during the tutorial.** Bots move fast here, so queued banners stay up after the state has moved on. Examples: "You open at 1" is still centred while Bones says Panthers jumped to 4. On mobile, "You must flip 2 · Your own stack first" is still on screen after you have flipped your own card, and it covers half of Panthers' stack, which is the locked target the player has to tap (only the FLIP chip is clear of it). Suggestion: while a director with a coach guide bubble is active, drop queued banners (or cut them to ~600ms), and keep banners from sitting on top of `.coach-spot`. This is QA finding #1, made worse by tutorial pacing.
2. **Minor:** on desktop, the round-end "Here's the table" bubble floats over the centre result ("PANTHERS BID 4 / HIT YOUR SKULL") during x-ray. It could prefer placements that don't cover `[data-tut="pot"]`/`bid-display`, or dock in the empty left side of the felt.

## Shell agent

Delivered TUTORIAL_SPEC §1–3: quick-start setup screen, director hooks + `ctl` in `src/main.js`, `data-tut` targets and x-ray in `src/ui.js`, and `src/coach.js` (Bones).
- **Setup:** **Play now** (`#play-now`, still `#setup-form button[type="submit"]`) and **Learn to play** (`#learn`, `data-cmd="learn"`). Name and opponents sit in `<details id="table-settings">` and save to `skull.settings` on every change. The old `skull.name`/`skull.opponents` keys are migrated once.
- **Round over:** the next round deals after `director.autoNextRoundMs` (default 2500ms), unless `canProceed()` is false. A tap anywhere on `.table-wrap` (outside buttons) or on Next round deals at once. The button shows a countdown bar.
- **Game over:** the controls and the dialog show **Rematch** (still `data-cmd="play-again"`, which re-checks `tipsEnabled()`) and **Change table** (`data-cmd="new-game"`).
- **Director extras:** `botDelay?(state, id) → ms`, and `allowHuman(state, {type:'nextRound'})`, which gates the Next round button and table taps. All hooks are try/catch-wrapped. `ctl` is per game, so a stale `resume`/`setXray` from an exited director does nothing.
- **Coach semantics:** a plain guide `say()` (no `next`/`buttons`) resolves at once. A tip resolves when it hides. A pending Next/buttons promise resolves `undefined` if the bubble is replaced or hidden. The coach owns the "Don't show tips" link, which sets `skull.tipsOff`. Tips never block input (`pointer-events: none`), and any tap dismisses them after 0.9s. On director-set tables (`setup()` returns players), banners are cut to ≤900ms with no queue, and banners fade while a lock spotlight is up (fixes Tutor issues 1–2).
- Verified: `node --test test/` 59/59. A headless tutorial walkthrough completes at 1280x800 and 390x844 with no console errors. Skip works, and a click outside the target is swallowed on locked steps.

### QA script changes needed (qa/e2e.mjs, not edited)
1. **`startGame()` must open Table settings first.** `#player-name` and `#setup .seg label` are inside the closed `<details id="table-settings">`, so `page.fill('#player-name', …)` times out (all 10 runs fail at that step today). Add `await page.click('#table-settings summary')` before the fill. Skip it when the disclosure is already open, which is true after Change table in the same page because `<details>` keeps its open state. Alternatively, set `localStorage['skull.settings'] = JSON.stringify({name, opponents})` and reload. With only that change, all 10 runs pass, with tips on or off.
2. **Next round auto-deals after 2.5s,** so the `[data-cmd="next-round"]` button can disappear between the lookup and the click. It didn't cause failures, but new checks should wait on the round number rather than on the button.
3. **The first game has tips on by default** (Bones' tip bubbles, `.coach[data-mode="tip"]`). They don't intercept clicks, but screenshots will show them. Set `skull.tipsOff = "1"` for clean runs.
4. **New stable hooks** for the §6 walkthrough: `#play-now`, `#learn`, `.coach [data-coach="next"]`, `.coach [data-coach="skip"]`, `.coach [data-coach="tips-off"]`, `.coach-actions .btn` (finale), and `.coach-spot` (rect of the current target). On a lock step, clicking the centre of `.coach-spot` hits the target. `.table.xray` is the x-ray state.

## QA round 2

Run: `cd qa && npm run e2e` (the game must be served at http://localhost:5173/). This runs **67 runs**: the 10 game runs plus 57 tutorial/tips/quick-start scenarios from `qa/flows.mjs`. It takes about 4 minutes. Env vars: `QA_ONLY=<regex>` matches run names (e.g. `QA_ONLY=tutorial`, `QA_ONLY=skip-0[1-5]`, `QA_ONLY=tips`); `QA_NO_FLOWS=1` runs the game runs only; `QA_FLOW_CONCURRENCY` (default 6); `QA_VERBOSE=1`.

**Result (2026-10-15): ALL 67 RUNS PASSED**, on two consecutive full runs after the fixes below. `node --test test/` passes 60/60.

### What's covered now
- **Game runs (10):** start through **Table settings** → **Play now**, with `skull.tipsOff`/`skull.tutorialDone` preset so the runs stay clean. **Rematch** must be labelled "Rematch" and reach a reset Round 1 within 1s. Next round is reached three ways: the button (2-opponent runs), the ~2.5s **auto-deal** (3-opponent runs, which also fail if the deal comes in under 1.5s), and a **tap on the felt** (5-opponent runs, timed inside the page from pointerdown to deal, must be ≤400ms).
- **Tutorial walkthrough** (`desktop-tutorial-solo`, `mobile-tutorial-replay`): every scripted bubble appears in order. On every locked step:
  - a legal but off-target move and the Rules button are both clicked, and both must be swallowed;
  - no banner may sit over the target at full opacity;
  - the target, once it stops moving, must not be covered by Bones' bubble.
  
  Also checked:
  - every narrated line stays up ≥1s;
  - x-ray is on during "here's what everyone had";
  - the default game-over dialog stays hidden under the finale;
  - the whole tutorial takes ≤90s (currently about 35–40s).
  
  The finale buttons: **Play a real game** must reach a fresh 3-opponent table with no tutorial bubble, and **Replay tutorial** must go back to bubble 1 at the Panthers/Snakes table. Both set `skull.tutorialDone`.
- **Skip at every bubble** (`{desktop,mobile}-skip-01..26`, fresh page each): Skip must land on setup with the coach hidden and `skull.tutorialDone=1`. Play now must then deal a real game with no tutorial bubble leaking in.
- **Tips** (`{desktop,mobile}-tips-first-game`, from an empty localStorage): **Play now** reaches a live 2-opponent table in one click (about 100ms). In the first game, `first-player`, `lost-bet` and `last-card` must fire, and in practice `max-bid` and `elimination` fire too. Each tip shows once. `skull.tipsGames` becomes 1, and the Rematch game shows no tips.
- **Don't show tips** (`mobile-tips-off`): clicking the link on the first tip hides it and sets `skull.tipsOff`. No tips appear for the rest of that game or in a new game after Change table.

### Earlier tutor-agent issues: re-checked
1. Banners over the spotlit target: **fixed**. They now fade to 0.18 under a lock, and the check above runs on every locked step.
2. The x-ray bubble covering the pot/result: **fixed**. I saw no overlap in 3 isolated runs plus the full runs; the remaining check is a layout warning measured after the bubble settles.

### Fixed in tutor-owned files
- `src/tutorial.js`: a narrated bot step showed its line for only about 420ms before the next bubble replaced it, so "Panthers folds. Passing is for keeps." was unreadable. The first bot move of a narrated step now waits `900ms + 22ms × length of the line`. There's a unit test for this in `test/tutorial.test.js`.

### Shell-side observations (minor; none block play or tests)
1. **Mobile: the target moves after the bubble appears.** When a locked step's target is off-screen, the coach smooth-scrolls it into view and re-docks the bubble. For about 0.3–0.5s the bubble can sit where the target ends up: the tutorial step "One more… Flip theirs" at 390x844 has the Panthers stack moving from y≈123 to y≈469 while the bubble jumps from bottom to top. A fast tap lands on the bubble and is ignored, so the player has to tap twice. Repro: the mobile tutorial, bubble 8. Suggestion: delay showing the bubble (or the dock) until the scroll ends (`scrollend`), or use `behavior: 'instant'` on mobile.
2. **The finale bubble still shows "Skip tutorial".** Clicking it marks the tutorial done and goes to setup, which is harmless but odd next to "Play a real game / Replay tutorial". Suggestion: hide `.coach-skip` when `buttons` are present.
3. **Mobile tip bubbles dock over the top bar and the first opponent's name** (`qa/shots/mobile-tips-off-tip.png`). They don't block input (tap-through works), but they hide whose turn it is for up to 6s. Suggestion: dock tips at the bottom on mobile, above the hand, or shrink them to two lines.

### Shell: QA round 2 observations addressed (2026-10-16)
1. **Mobile bubble before the scroll settles:** an off-screen target is now scrolled into view with `behavior: 'instant'`, and the bubble docks against the target's final position in the same frame. The spotlight and bubble no longer slide (`left/top` transitions removed), so a spotlit target is exactly where `.coach-spot` says it is on every frame.
2. **No Skip on the finale:** a bubble with `buttons` gets `.coach.choice`, which hides `.coach-skip`. Skip also moved out of the bubble into a fixed pill in the top bar, left of the ?/new-game buttons. It never moves between bubbles, so a tap aimed at Skip can't land on a bubble that just moved (that's what caused the earlier flaky `desktop-skip-04`: Skip was clicked as bubble 5 replaced bubble 4, and the tap fell on a locked area). The selector `.coach [data-coach="skip"]` is unchanged.
3. **Mobile tips** dock at the bottom, just above `#hand` when it's on screen, and no longer cover the top bar. The tip's "Don't show tips" link only accepts taps 0.9s after the tip appears (`.coach.armed`). Without that, a tap headed for a hand card could land on the link as the tip popped in, which turned tips off for the rest of the game (the flaky `mobile-tips-first-game`, where only "max-bid" was seen).

### Remaining QA-side flake (qa/flows.mjs, owner: QA)
`{desktop-tutorial-solo, mobile-tutorial-replay}: x-ray not shown on ""` fails in roughly 1 of 2 full concurrent runs. It passes when run alone. The cause is a race in `walk()`: it reads `window.__bubbles` and `coachState()` in two separate `evaluate` calls. If a bubble appears between them, that iteration skips `onBubble` for it but still sees its **Next** button and clicks it. The next iteration then runs `onBubble` for the bubble that was just dismissed, `coachState()` returns `text: ""`, and the x-ray check fails. A page-side trace confirmed this: bubble 15 was shown at 37379ms and dismissed by a Next click at 38039ms, before `onBubble` ran for it. Suggested fix: only click Next when `c.text === BUBBLES[seen - 1]`, i.e. the bubble on screen is the last one processed. Otherwise `continue`. Or read both values in one `evaluate`.

## Server agent

Delivered: `src/view.js`, the §8 `forfeit` action in `src/engine.js`, `worker/room-core.js` (pure room state machine), `worker/index.js` (Worker + `Room` / `LobbyDirectory` Durable Objects), `wrangler.toml`, `.assetsignore`, `package.json` scripts `dev`/`deploy` + `wrangler` devDependency, `test/view.test.js`, `test/server.test.js`. `node --test test/` is green. A scripted smoke over real WebSockets against `npx wrangler dev` passed: create room, 2 sockets, add bot, start, views, alarm-driven bot moves, refresh/rejoin, reactions, Leave. Nothing was deployed.

### Protocol (exact shapes)
Every server→client message also carries `serverNow` (server epoch ms).
- **HTTP:** `POST /api/rooms` → `{code}`. `GET /api/lobbies` → `[{code, host, humans, seats, bots, timer}]` (`host` = host's name, `humans`/`bots` = seated counts, `seats` = table size, `timer` in seconds, 0 = Off). Only Open rooms in the lobby with ≥1 connected human are listed. `GET /api/rooms/:code/ws?token=…`: the code is case-insensitive. The token must match `/^[A-Za-z0-9_-]{8,64}$/` (400 otherwise). Unknown/dead room → 404, which a browser `WebSocket` sees as an `error` + `close` without ever opening.
- **hello:** `{t:'hello', name, avatar}`. The reply is a `lobby` broadcast, plus a `view` broadcast if you're seated in a running game. Name: control chars stripped, trimmed, max 16 chars, blank → "Rider", case-insensitive dedupe → "Rider 2". Avatar: any plain object ≤300 chars of JSON is passed through as-is; otherwise it becomes `{emoji:'💀'}`. Name/avatar changes on a re-hello only apply outside a running game.
- **lobby:** `{t:'lobby', lobby:{code, hostSeat, options:{seats, timer, open}, members:[{seat, name, avatar, isBot, connected, waiting}], phase:'waiting'|'in-game', lastWinner?:{seat, name, avatar, isBot}, me, meWaiting}}`. It is sent per recipient (only to hello'd, connected members): `me` = your own seat (`null` while you're a waiting late joiner) and `meWaiting` = whether you're waiting. `timer` values: `0` (Off), `20`, `30`, `60`. In the lobby, `seat` is the position (0..n-1). In a game, `seat` is the player id. Waiting late joiners have `seat:null, waiting:true`. Forfeited players are not listed. `lastWinner` is present after a game that ended with a winner (absent if the game ended because every human left).
- **view:** `{t:'view', seq, view, seats:[{name, avatar, isBot, connected, forfeited}], deadline}`. `view` = `viewFor(state, me)` + `view.lastAction`. `seq` is per room and increases across games; drop any view with `seq` ≤ last applied. A view is also re-sent (new `seq`, same `lastAction`) when someone's connection/forfeit status changes, so **animate only when `lastAction.n` changes** (`n` is a per-room action counter). `lastAction` is `null` at game start, otherwise one of: the engine action (redacted: no `card` on `place`/`placeInitial`, no `cardIndex` on `discard`) with `auto:true` for ⏱ moves (timeouts and forfeited seats), `{type:'nextRound', n}` (server-timed), or `{type:'forfeit', player, n}` (engine elimination at round end). `deadline` = `null` or `{players:[ids], at, ats:{[id]: at}}`. `at` is the earliest. `ats` has each player's own deadline: they differ only when the timer is Off and seats disconnected at different times.
- **errors** (`{t:'error', msg}`): `'Say hello first'`, `'Bad message'`, `'Only the host can do that'`, `'Game in progress'` (lobby ops mid-game), `'You are not in this game'` (waiting player sends an action), `'Table full'` (socket then closed), `'Need at least 3 players'`, `'No bot to remove'`, `'No such seat'` (kick), `'Illegal action'`, `'Room closed'`. Constants: `ERR` in `worker/room-core.js`.
- **kicked:** `{t:'kicked'}`, then the socket is closed. A kicked token gets `{t:'kicked'}` again on any later hello in that room.
- **Close codes** sent by the server (`CLOSE` in room-core): 1000 = after your `leave`, 4000 = replaced by a newer socket with the same token (another tab), 4001 = kicked, 4004 = room closed / not found, 4009 = table full. The error/kicked message always comes first.
- **leave:** `{t:'leave'}`. The server removes you and closes the socket. In a game, it forfeits your seat.
- **Reactions:** `{t:'react', kind, target?}`. The kind ids are **`smirk` 😏, `think` 🤔, `skull` 💀, `rose` 🌹, `laugh` 😂, `tomato` 🍅** (`REACTIONS` in room-core). Only seated in-game players can react, at most once per 2s. Anything else is silently dropped. `tomato` needs `target` = another player id. The broadcast is `{t:'event', e:'react', from, kind, target?}` (`from`/`target` are player ids) and goes to every socket in the room, including waiting players; ignore it outside a game.

### Behaviour choices (spec ambiguities)
- **Seats** = table size. A human joining a full lobby takes the last bot's seat. If there's no bot, the table grows by one, up to 6. Only a 7th person gets "Table full". `addBot` on a full table grows it too. Shrinking `seats` removes bots from the end and never goes below the number of seated humans.
- **Game over:** the `game-over` view stays for **4s** (server-timed). Then everyone gets `lobby` with `phase:'waiting'` and `lastWinner`. Waiting late joiners are seated at that moment, in join order, taking bot seats first. Forfeited seats are freed. `rematch` and `start` are the same op (start with the current seats/options).
- **Clocks:** with a timer, every move restarts the clock, except in place-initial, where all unplaced players share one clock started at the round start. With timer Off, a disconnected seat's 30s clock starts at max(turn start, disconnect time).
- **Abandon (90s total)** is counted per game (reset at start and at game end). In the lobby, 90s disconnected frees the seat. An abandoned/left player is removed from the room; coming back with the link makes them a waiting late joiner (seated for the rematch). A forfeited seat's name is free again, so they keep their name.
- **Host transfer** happens on Leave/abandon/kick: to the human with the earliest join, preferring seated over waiting. A host who is merely disconnected stays host until abandon (90s).
- **All humans forfeited** → the game ends at once (no `lastWinner`) and the room goes back to the lobby. Cleanup still follows the 60s no-connected-human rule. A room created by `POST` that nobody joins also dies after 60s.
- **Engine forfeit** also clears the forfeiter's mat (otherwise `nextRound` would hand those cards back). Their stack therefore disappears from the board in round-over.
- **Bot names/avatars:** Panthers 🐆, Snakes 🐍, Werewolves 🐺, Eagles 🦅, Himself 🤘, Vipers 🦂, Ravens 🐦‍⬛, Jackals 🦊. A bot takes the first name not already used in the room.
- **Persistence:** the `Room` DO saves the core's JSON after every event and uses WebSocket hibernation. On wake-up, any member marked connected without a live socket is disconnected.

### For other agents
- **shell:** `view.players[i].isHuman` is `!isBot` for every seat, so use `view.me` (not `isHuman`) to find "you". Bots' `seats[i].isBot` → 🤖 badge. Also, I added `.wrangler/` to `.gitignore` (wrangler dev's local state); please keep it.
- **net:** the client never sends `nextRound`; round-over → next round is server-timed (~4s). The clock offset is `serverNow - Date.now()` at receipt.
- **QA:** run `npm run dev` (wrangler dev on :8787 by default; static files are served too, so the game is at `http://localhost:8787/`).

## Net agent

Delivered `src/net.js` (browser ES module, no deps) and `test/net.test.js` (fake WebSocket + fake timers; `node --test test/` green). The API summary is also at the top of `src/net.js`.

### Exported API (for the shell)
- `getToken()` → per-browser hex token, created once with `crypto.getRandomValues` and stored in `localStorage['skull.token']`. If storage is blocked it falls back to one in-memory token per page load.
- `normalizeCode(str)` → `'KXPQ'` or `null`. It uppercases and ignores spaces and dashes. The code is valid only if it is exactly 4 letters from `ABCDEFGHJKLMNPQRSTUVWXYZ`.
- `cleanCode(str)` → partial input for the join box: uppercase, valid letters only, at most 4. Auto-join when `cleanCode(v).length === 4`.
- `shareLink(code)` → `${location.origin}/#/r/CODE`. `parseShareHash(location.hash)` → code or `null` (case-insensitive, trailing slash allowed).
- `createRoom()` → `Promise<{code}>` (POST `/api/rooms`). `listLobbies()` → `Promise<[{code, host, humans, seats, bots, timer}]>` (GET `/api/lobbies`). Both throw on a non-2xx response.
- `createRemoteController({ code, name, avatar, token?, base? })` connects at once and returns:
  - `onView(cb)`: `cb(view, {seq, seats, deadline})`. Only views with `seq` greater than the last applied one are passed on.
  - `onLobby(cb)`: `cb(lobby)`. `onEvent(cb)`: `cb({t:'event', e, from, kind, target?})`, so route `e === 'react'` to reactions. `onError(cb)`: `cb(msg)`.
  - `onStatus(cb)`: `'connecting' | 'open' | 'reconnecting' | 'closed' | 'kicked' | 'not-found' | 'full' | 'replaced'`. The last five are final, and the controller never reconnects after them. `'replaced'` means another tab or window took this seat with the same token (close code 4000). Show something like "Open in another tab". `status()` returns the current status.
  - Every `on*` returns an unsubscribe function. `onView`, `onLobby` and `onStatus` call a new subscriber at once with the latest value, so a screen mounted late (e.g. lobby → game) gets the current table.
  - `send(action)`: an engine action, sent as `{t:'action', action}`. `lobby(op, args)`: e.g. `lobby('options', {seats, timer, open})`, `lobby('kick', {seat})`, `lobby('start')`. `react(kind, target?)`. All three return `false` and drop the frame when the socket isn't open. Nothing is queued across a reconnect, because stale actions are worse than a re-tap.
  - `now()` → server-corrected epoch ms. Compare it against `deadline.at` for the timer ring.
  - `leave()`: sends `{t:'leave'}` (forfeit), closes, status `'closed'`. `close()`: closes for good without leaving, so the server treats the seat as disconnected. Use `close()` when the shell tears down for other reasons.
  - The `code` and `token` properties are exposed too.
- Every platform dependency (`WebSocket`, `fetch`, `storage`, `setTimeout`/`clearTimeout`, `clock`, `random`, `location`, `document`, `window`) can be passed in the same options object, for tests.

### Behaviour and choices
- `{t:'hello', name, avatar}` is sent on every socket open. The token is in the URL query (`?token=`).
- Reconnect backoff: 0.5s, 1s, 2s, 4s, then 5s (cap), each ±20% jitter. The backoff resets once a message arrives on the new socket, not just on open, so a server that accepts and then drops at once doesn't cause a hot loop. When `visibilitychange` (visible) or `online` fires during a backoff wait, it retries at once. Both listeners are guarded, so Node works without `document`/`window`.
- **Clock offset:** each message's `serverNow` gives the sample `serverNow − Date.now()`. The first sample is taken as-is, then an EMA with weight 0.25. Latency isn't compensated (≤ a few hundred ms, fine for a turn ring).
- **Seq:** `lastSeq` is kept across reconnects, as §3 says. A view whose `seq` is ≤ the last applied one is dropped, even on a fresh socket.
- **Not found:** a browser can't see the HTTP 404 behind a failed WebSocket upgrade. When a socket closes without ever opening, the controller does a plain `fetch` GET of the same `/api/rooms/:code/ws?token=…` URL. A 404 there means `'not-found'`. The server currently answers that probe with 426 before it looks the room up, so a second failed upgrade in a row while the server still answers HTTP also means `'not-found'`. Network errors (offline) keep retrying. A successful open resets the count. An invalid code goes straight to `'not-found'` without connecting.
- **Close codes** (they match the server): 4000 → `'replaced'`; 4001 → `'kicked'`; 4002 (room closed) → `'closed'`, or `'not-found'` if the socket never opened. All of these are final. The client also accepts 4004 → `'not-found'` and 4009 → `'full'`. `'Table full'` arrives as an error before the 4001, and `leave()` sets `'closed'` itself, so a later 4001 never turns either one into `'kicked'`.
- **Error-message mapping:** a `{t:'error', msg}` matching `/full/i` gives `'full'`, and one matching `/not found|no such room|unknown room|doesn't exist/i` gives `'not-found'`. Both are final. Every error also reaches `onError`. `{t:'kicked'}` gives `'kicked'`.

### Requests to the server agent
1. `GET /api/rooms/:code/ws` **without** an `Upgrade` header should answer **404** when the room doesn't exist. `worker/index.js` currently returns 426 before forwarding to the DO, so the room is never checked. The client copes (two refused upgrades → not-found, about 0.5s slower), but a room check before the 426 would make it instant and unambiguous.
2. `seq` must be monotonic for the room's whole lifetime, across rematches and DO hibernation/eviction (persist it), or clients will drop fresh views after a reconnect.
3. Put `serverNow` (epoch ms) on **every** server→client message.
4. The "Table full" error text should contain the word "full". If you'd rather use close codes, the client also understands `4001` kicked, `4004` not found and `4009` full.

### Server fixes after the net agent's requests (2026-10-16)
1. **Not-found probe:** `GET /api/rooms/:code/ws` now asks the room first. A missing or dead room → **404**, even without an `Upgrade` header. Then a bad token → 400, and a non-upgrade request to a live room → 426. The probe is read-only: the DO only reads storage, so probing an unknown code stores nothing. Verified on `wrangler dev`.
2. **`seq`** lives in the room's persisted JSON (saved after every event), so it survives hibernation/eviction and rematches. A new test restores the core from JSON mid-game and plays two games plus a rematch, checking that every `seq` is strictly increasing. **`serverNow`** is on every message (lobby, view, event, error, kicked). There's a test for that, and the test harness asserts it on every delivered message.
3. **Close codes** now match `src/net.js`: kicked 4001, full 4009, room closed 4004. Before, "Table full" also closed with 4001, which the client would have read as kicked.
4. **Flaky test hunt:** I couldn't reproduce it. That's 95 full `node --test test/` runs: 15 serial and 40 at 6× parallel load on mp-server, plus 40 at 6× on a clean checkout of master 1b37d6e. All passed. Every test's randomness is seeded or injected (engine/ai/view/server use mulberry32; net uses fake timers and `random: () => 0.5`), and no test waits on real time. My guess is outside interference (files changing mid-run during the merge, or machine load), not a test bug. If it happens again, please capture the `✖` test name.

### For the net agent
- Close code **4000** (another tab with the same token took the seat) isn't in `CLOSE_CODE_STATUS`. Today the old tab reconnects and steals the seat back, so two open tabs ping-pong forever. Suggest treating 4000 as final (e.g. status `'closed'` or a new `'replaced'`).

## Reactions agent

Delivered `src/reactions.js`, `reactions.css`, `test/reactions.test.js` (pure helpers; `node --test test/` green). Checked by hand in a scratch harness and on top of the real solo game at 390×844. Nothing in `index.html`/`styles.css` was touched.

### API (spec §9, plus one optional field)
`mountReactions({ root, send, seatEl, me? }) -> { handle(event), destroy() }`
- `send(kind, target?)`: call it like `rc.react`. If it returns `false` (socket not open), the client cooldown is not started.
- `seatEl(id)`: looked up again on every use. It must return the **seat** element for player `id` (0..5) or `null`. Note: in the current UI, `[data-player]` also matches other elements (12 hits in a 4-player game), so use something like `` `.seat[data-player="${id}"]` ``.
- `me` (optional): your player id, or a function returning it. It keeps your own seat out of the tomato targets. Without it, a seat with class `me` is skipped, which works with the current `ui.js`.
- `handle(ev)`: pass every `e:'react'` event. Invalid ones are ignored (unknown kind, a tomato without a valid `target`, `target === from`). After `destroy()` it does nothing.
- `destroy()`: removes every node, listener, timer and the injected `<link>`, plus any `.rx-hit` class it added to seats. It can be called more than once.

### Behaviour choices
- **Picker:** a 44px round button fixed to the right edge at 38% of the height, which is over the table's centre row on a phone, above the player zone. The tray opens leftward as a single pill with 😏 🤔 💀 🌹 😂 | 🍅. It closes after a pick, on a tap outside, on Esc, or by itself after 5s.
- **Tomato:** picking 🍅 enters aim mode. Pulsing red rings are drawn over every other seat; they track re-renders on each animation frame. A bar at the top says "Tap a rider to throw" and has a Cancel button. Aim mode ends after a throw, Cancel, Esc, a tap on the button, or by itself after 7s.
- **Cooldown:** 2s on the client, mirroring `REACT_MS`. While it runs, the button is disabled, greyed, and a cyan ring drains around it.
- **Effects:** a pop-up emoji floats up and fades over the sender's seat (1.6s). The tomato flies along a parabola from the sender's seat to the target's (0.65s, spinning) and lands wherever the target seat is *at landing time*. The splat lingers about 1.5s and the target seat gives a small jolt (`.rx-hit`). If the sender's seat isn't rendered, a pop-up is skipped and a tomato is lobbed from the bottom centre. With `prefers-reduced-motion`, there is no flight, only the splat.
- **Layering:** z-index 60–62, which is above the toasts (50) and below the coach (80).
- The CSS URL is resolved from `import.meta.url` (`../reactions.css`), so it works from any page path.

## Shell agent — multiplayer (2026-10-16)

Delivered MULTIPLAYER_SPEC §3 (controller seam), §5/§7 (home, join bubble, share link, lobby), §6 client side (timer ring, nudge, 📡/left seats, ⏱ tags, Leave) and the §9 reactions mount. New files: `src/shell-core.js` (pure helpers, `test/shell-core.test.js`), `src/home.js`, `src/lobby-ui.js`, `src/announce.js`, `src/sound.js`, `mp.css` (all multiplayer CSS; `styles.css` untouched). Edited: `index.html`, `src/main.js`, `src/ui.js`. `coach.js` untouched. `node --test test/` green (150).

### How it fits
- **Controller seam:** `main.js` routes table input through `controller.send/nextRound/confirmLeave`. The local controller is the old engine loop (directors, holds, ghost unchanged) and now feeds `viewFor(state, 0)` to `ui.render(view, opts)`. The tutorial x-ray is the one local-only exception (it renders the full state). `ui.js` finds "you" from `view.me` and seats opponents clockwise after you (`seatOrder`). Announcements moved to `src/announce.js` and work on two views plus the action (the reveal/skull logic no longer reads hidden faces).
- **Remote table:** banners only when `lastAction.n` changes. The final flip is held 2s with a ghost, as in solo. A new game is detected by `lastAction === null`. No Next round button or tap in multiplayer. Game over shows "Back to the lobby in a moment…", then the server's `lobby` (phase waiting) switches to the lobby with the result and **Rematch** for the host.
- **Timer ring:** an SVG ring around the seat avatar, drained by CSS animation with a negative delay computed from `deadline.ats[id]` and `rc.now()`. Re-renders don't reset it. A second animation turns it red for the last 5s. The ring length is the lobby timer (or 30s when the timer is Off and the seat is disconnected). **Nudge** at 5s on your own clock: `#me-seat.nudge` shake + one WebAudio tick (`src/sound.js`, `skull.sound`, 🔊 in the top bar, multiplayer only). No vibration.
- **Routing:** being in a room sets `#/r/CODE` and `sessionStorage['skull.room']`. A refresh with both present rejoins straight away. A link without it shows the name/avatar prompt (`#joinlink`). Joiners stay on home or the prompt until the first `lobby` arrives, so "No table with code X" / "That table is full" show inline. The host and a refresh go straight to the lobby.
- Status `replaced` → `#replaced` dialog with **Use here** (opens a new controller) or Home. `kicked` → home with a note. Room gone after joining → home with "That table has closed."
- Host options are saved to `skull.hostOptions` when the host changes them. They're applied to a fresh room the host just created (first lobby, alone, waiting).

### Ambiguities / choices
- **Who am I in the lobby?** The `lobby` message doesn't say. The client adds a public tag to its avatar, `avatar.k = FNV-1a(token)` (the token itself is never exposed), and finds itself with `findMe`. **Request to server:** add `lobby.me` (your seat, or null when waiting) per recipient. `findMe` already prefers `lobby.me` when it's an integer, so the tag can be dropped later.
- Empty seats show "Open seat" with **+ 🤖 Bot** (host). The seats stepper sets `options.seats`. ✕ removes a bot (`removeBot {seat}`) or kicks a human (`kick {seat}`), lobby only.
- Avatar picker: ◀ ▶ around the face, and tapping the face opens a 12-emoji grid. The setting is stored as `avatar: {emoji}` in `skull.settings`. Default 💀.
- Home: "Play vs bots" is still `#play-now` (submit of `#setup-form`). `#player-name` moved out of Table settings onto the home screen (still inside the form). The Table settings disclosure now only holds the opponent count. Enter in the code box joins (it doesn't submit the solo form).
- Reactions mount on `#game` with `seatEl: id => #game .seat[data-player=id]` and `me: () => view.me`, and are destroyed when the table closes (lobby or home). They load lazily; if the import fails, nothing happens.

### For QA
- Hooks: `#host-game`, `#join-game`, `#join-code`, `[data-home="go"]`, `#join-msg`, `#home-msg`, `#lobby-list .lobby-row[data-code]`, `#joinlink #jl-name #jl-go #jl-msg`, `#lobby-code`, `[data-lobby="share|leave|start|add-bot|remove-bot|kick|seats|timer|open"]` (+ `data-seat` / `data-value`), `.lobby-result`, `#game [data-cmd="leave"]` → `#leave-confirm [data-mp="leave-yes"]`, `#replaced [data-mp="use-here"]`, `#net-pill`, `.seat .ring`, `.seat.left`, `.badge.away`, `#log-list .auto-tag`, `[data-cmd="sound"]`.
- Joining a missing code makes Chrome log two console errors that the page can't suppress (`WebSocket … 404` and `Failed to load resource … 404`). Allow-list them in the not-found check.
- `qa/e2e.mjs` solo/tutorial runs still pass unchanged (checked with QA_ONLY: desktop-3opp, mobile-2opp, both tutorial runs, tips-first-game ×2, tips-off, skip-05: 9/9). They also pass when served by `wrangler dev`.
- Checked on `wrangler dev :8790` with Playwright: host + join by list and by typed lowercase code + join by link, bad code message, bot add, timer change seen read-only by a guest, start, seat rotation, rings, ⏱ log tags with an idle player, Leave with confirm (the seat greys out as "X left" + toast), refresh mid-game rejoins the same seat, full game → lobby result → Rematch. No horizontal scroll at 390px or 1280px.
- **QA fixes (2026-10-16), findings 1/3/4/5:**
  - #1: while the socket isn't `open`, the lobby shows "📡 Reconnecting…" and disables every host button (Leave and Share stay live). A lobby frame that still fails to send flashes "Not connected — try again in a sec".
  - #3: the ⏱ log tag only goes on incremental log updates, so a refresh or rejoin no longer puts it on "Round N begins".
  - #4: the remote table uses fast banners, so a newer beat replaces queued ones.
  - #5: in multiplayer, routine moves (place, pass, rose flips, discard, pick) no longer toast because the log and seats already show them. ⏱ moves, a lost card, "X left" and errors still toast. Toasts show one at a time in the top bar, left of the icon buttons. On mobile they briefly cover the status line, not the opponents or the log header.
  - Checked on `wrangler dev :8790` (desktop host, mobile guest, bot, 20s timer, idle until ⏱): ≤1 banner on screen, no toast over the seats or the log header, ⏱ tags on the right lines and none after a reload, and the lobby disabled with the 📡 note once the server was stopped.

### Server: shell request handled (2026-10-16)
- **`lobby.me`** (+ `meWaiting`) is now sent per recipient: your seat in the lobby, your player id in a game, `null` while waiting for the rematch. Tested. The `avatar.k` tag is no longer needed for `findMe`; the server still passes it through untouched (avatars stay opaque). The lobby used to be broadcast to every socket, including sockets that never sent hello. Now it only goes to members.

## Multiplayer QA findings

Run: `npm install` (repo root, for wrangler), then `cd qa && npm run mp-e2e` (or `node mp-e2e.mjs --swap` for host on mobile and joiners on desktop). The script starts its own `wrangler dev` on :8787 from a **snapshot copy of the app in a temp dir**, with fresh local state, and stops it by its process group at the end. Why the copy: see finding 2. `--url http://…/` uses a server that's already running instead. It takes about 1–2 minutes. Screenshots go to `qa/shots/mp-<step>-<player>-<size>.png`.

What it covers (MULTIPLAYER_SPEC §11), with 4 browser contexts:
- **Lobby:** the host (desktop 1280x800) hosts. **Copy link** must put `#/r/CODE` on the clipboard. The host sets a 20s timer. A scout context sees the room in the open list, then sees it **disappear when Private**, reappear when Open again, and disappear once **in-game**. A bad code shows "No table…"; only the 2 known Chrome 404 console errors are allowed, and only during that step.
- **Joining:** Ann (mobile 390x844) types the code in **lowercase** and auto-joins. Bob (mobile) uses the **share link** → name prompt → lobby. The host adds a **filler bot**. `lobby.me` must match each player's own seat, and the guest sees the 20s timer read-only.
- **A full game through real clicks**, with:
  - **Reactions:** a 😂 pop-up and a 🍅 tomato (fly + splat + seat jolt) must appear on both other clients, and the `event` frame must arrive.
  - **Refresh:** Ann refreshes mid-turn and must come back to the same seat and name, with her move still available.
  - **⏱ auto move:** the host idles on their turn until the auto move. The timer ring must show, the 5s nudge must fire, and the auto move must be a pass in bidding / a place in placement. Every client's log must show the ⏱ tag.
  - **Leave:** Bob Leaves mid-round with the confirm step. His seat must grey out as "left" at once and be **eliminated by `forfeit` at round end**. Bob then comes back by link as a **late joiner** (`meWaiting`, "you're in for the next one") and is seated for the rematch.
- **After the game:** game over → everyone is back in the same lobby with the result, the host's button reads **Rematch**, and one tap reaches a fresh Round 1 with 4 cards each. Everyone then Leaves.
- **Checked throughout:**
  - every `view` frame each client receives has no hidden face of another player (hand, unrevealed mat, `discarded`, `lastAction.card`, x-ray);
  - each page's DOM shows no face on another player's face-down card, and no `[data-face]` or peek outside your own hand or seat;
  - no console errors or warnings, no page errors, no failed requests, no server `error` frames, no horizontal scroll;
  - no ⏱ moves other than the scripted ones;
  - no stretch where the server has you on the clock for 4s+ while the UI shows no control.

**Result (2026-10-16):** with the final script, **6 consecutive runs passed with no findings** (3 default, 3 `--swap`). About 20 earlier runs while I built it also passed; the only failures were harness strictness (fixed) and the font-load stall below. **No hidden-card leaks** turned up in any view frame or DOM, and there were no console errors and no horizontal scroll at either size. The existing solo/tutorial suite (`npm run e2e`) also passes: **65/65 runs**. `node --test test/` passes 152/152. The app snapshot included other sessions' uncommitted edits in `src/` at the time (tutorial/coach/ui work in progress).

### Findings, most severe first

1. **Lobby actions are silently dropped while the socket is reconnecting (medium, owner: shell).** `lobbyUI` handlers call `mp.rc.lobby(...)` and ignore its `false` return, so **Start / Rematch / + Bot / options / kick do nothing, with no feedback**, during any reconnect gap. In the table, `controller.send` already toasts "Not connected — try again in a sec". Repro: the first QA run, while wrangler was reloading (see 2). The host clicked **Start game** about 0.4s after a socket drop (close 1006). The client reconnected and re-sent `hello`, but the `start` frame was never sent. The lobby just sat there with an enabled Start button, and no "📡 Reconnecting…" note was visible at screenshot time. Suggestion: flash "Not connected — try again" when `rc.lobby()` returns false, or disable the host buttons while `status() !== 'open'`.
2. **`wrangler dev` reloads the worker on any file write in the repo, dropping every socket (low, dev-only, owner: server).** `assets.directory = "."` makes wrangler watch the whole repo. `.assetsignore` doesn't stop the watcher, so screenshots in `qa/shots`, edits to NOTES.md or another session's edits each trigger "Reloading local server…", and every client gets close 1006. Over 4 reloads in 15s, all clients reconnected and the room state survived (good resilience), but local multiplayer testing gets flaky, and finding 1 is easy to hit. Suggestion: serve static files from a dedicated folder (e.g. `public/`), or document that `npm run dev` should run from a clean copy. The QA script works around it with the temp-dir snapshot.
3. **The ⏱ log tag lands on the wrong line after a refresh or rejoin (low, owner: shell, found by code reading).** `ui.renderLog` tags the *first* line of each newly added batch when `lastAction.auto` is set. A fresh page (`logLen = 0`) adds the whole log as one batch. So if the last move before a refresh was a ⏱ auto move, the tag goes on line 1 ("Round N begins…"), not on the auto move's line, and earlier ⏱ tags are lost (the log has no auto flags). Suggestion: on a full rebuild, tag `state.log.length - 1` (or the last line), or skip the tag.
4. **Banners lag behind the game in multiplayer too (low, owner: shell).** This is QA finding #1 again; bots move every 0.7–1.2s and banners queue. `mp-game-bidding-ann-mobile.png`: "Panthers opens at 1 — the challenge is on" is still centred while the board already says "Hosty bid 2" and it's Ann's turn to raise. The tutorial got shorter banners; the remote table didn't (`ui.setFastBanners(false)` in `enterTable`).
5. **Toasts cover content (low, owner: shell).** On desktop, toasts stack at the top right, over the Road log header and its first lines (`mp-timer-ring-host-desktop.png`, `mp-forfeit-host-desktop.png`). On mobile, they sit over the top opponents' names (`mp-game-game-over-ann-mobile.png`: "Hosty passes / Rose 1/2" hide "Panthers"; `mp-rematch-bob-mobile.png`). In multiplayer, every ⏱ / other-player action adds one, so it's busier than solo.
6. **Info: seat-status changes wait out the final-flip hold.** When a view arrives while the 2s final-flip hold is on screen (e.g. Bob leaves just as a challenge resolves), the "left" / out state shows only when the hold ends (≤2s). This is by design; the QA check allows 4s.

### Final regression (2026-10-16, master 69e03ed)

**Results:**
- `node --test test/`: **155/155**.
- Solo/tutorial `npm run e2e`: **ALL 97 RUNS PASSED** (82/82 skip-at-every-step). No `qa/` changes were needed for tap-anywhere-to-continue, because the flows still click Next, which works the same.
- `npm run mp-e2e`, final script: **3/3 PASS** (default, `--swap`, default) with **no findings**: no card leaks, no console errors, no horizontal scroll and no stray ⏱ moves.

**New automated checks** for the re-verified findings:
- offline lobby: `context.setOffline` + forced socket close → "📡 Reconnecting…" with Start disabled → back online re-enables it;
- no ⏱ tag on a "Round N begins" line, and the ⏱ tag on the idle player's own line on every client;
- an in-page banner timeline (longest time on screen, how many at once);
- no visible toast over a seat name or the Road log header.

**Earlier findings, re-checked:**
1. **#1 lobby actions dropped while reconnecting: FIXED.** Offline, the lobby shows "📡 Reconnecting…" and Start is disabled; it re-enables once the socket is back (`mp-lobby-offline-host-*.png`).
2. #2 wrangler dev reloads: fixed on the server side by `npm run dev` (worker/dev.mjs mirror). `mp-e2e` still runs wrangler from its own temp snapshot, so it doesn't depend on that.
3. **#3 ⏱ tag on the wrong line after a refresh: FIXED.** Ann's refresh never left a tag on "Round N begins", and the host's ⏱ move is tagged on "⏱ Hosty passes/places" on all three clients (`mp-forfeit-host-desktop.png`, log line 13).
4. **#4 banner lag: FIXED.** Every banner on every client lasted ≤1.21s (13–54 banners per client per run). At most 2 nodes were in the layer at once, which is the old one fading out as the new one arrives. The screenshots show the current beat, e.g. "You must flip 4" while Ann is flipping (`mp-auto-move-ann-mobile.png`).
5. **#5 toasts covering content: FIXED.** There were no toast overlaps with seat names or the log header in 3 runs. On desktop the toast sits in the top bar, left of the icon buttons (`mp-forfeit-host-desktop.png`: "Bob left the table").

**New findings (low, owner: shell):**
- **Mobile toasts hide the turn cue.** On mobile the single top-bar toast sits over the status line, which is the shell's documented trade-off. In `mp-auto-move-ann-mobile.png`, "⏱ Hosty passes" covers "ROUND 1 · YOUR MOVE" for ~2.4s right when it becomes Ann's turn. The seat glow and prompt still show it's her move, so this is minor. Option: skip the toast (or shorten it) when the status line just switched to "Your move".
- **Offline lobby: some disabled buttons don't look disabled.** While reconnecting, every lobby button is `disabled`, but only Start and the seats stepper grey out. The ✕ kick/remove-bot buttons, the timer segments and Open/Private look live, and taps do nothing (`mp-lobby-offline-host-mobile.png`). Add a `:disabled` style (opacity ~.45, `cursor: default`) for `.ls-x` and `.lseg button`.

**Harness fixes this round:**
- Screenshots are capped at 8s. The after-refresh screenshot isn't awaited: Playwright waits for web fonts, and right after a reload that took ~30s here, long enough for the refreshed player's 20s clock to run out. That caused the stray ⏱ moves on Ann. curl reaches Google Fonts in 0.1s, so this is the browser's font loading in this sandbox, not the app.
- If Bob's Leave falls in the game's last round, there's no round-over to forfeit at, so that run reports the forfeit check as not reached instead of failing.

### QA-side notes
- `page.reload({ waitUntil: 'load' })` sometimes waited ~20s for Google Fonts in the sandbox. Meanwhile the refreshed player's clock ran out and they made a ⏱ pass, which looked like an app timeout. The script now waits for `domcontentloaded` and then for the table. It also logs every ⏱ move and dumps the player's recent trail if one is unexpected.
- The solo suite expects port 5173. During this run, :5173 was already served by another session's `python3` server, which serves the same files. I didn't touch it.

### Server: QA finding #2 (wrangler dev reloads on any write) fixed (2026-10-16)
- `npm run dev` now runs `node worker/dev.mjs`. It mirrors the deployable files (whatever `.assetsignore` lets through: `index.html`, `*.css`, `src/`) into `node_modules/.cache/skull-dev-assets/`, then starts `wrangler dev --assets <mirror>`. The binding and `run_worker_first` still come from `wrangler.toml`. A recursive `fs.watch` re-copies only app files that change, and only when their bytes differ. So edits to `index.html`/`src/`/CSS still hot-reload, but writes to NOTES.md, `qa/shots`, `test/`, `worker/` (worker code still reloads through wrangler's own bundler watcher), `.md`/`.pdf` etc. never reload or drop sockets. Extra args pass through: `npm run dev -- --port 8790`.
- Why not a config option: wrangler 4.151 has no setting or CLI flag to limit its assets watcher. It only skips `.wrangler/` and the persist dir. `dev.watch:false` is reachable only from the programmatic API, and it would also disable worker reloads.
- Verified on :8791: the mirror holds exactly the deploy set (`/NOTES.md`, `/worker/index.js`, `/package.json` → 404). Writing `*.md`, `qa/shots/*.png` and `test/*` caused 0 reloads. Creating an app file reloaded and served it; deleting it reloaded and gave 404. `/api` routes are unchanged.
- Deploy is untouched (`wrangler deploy` uploads "." per `wrangler.toml`). Worker behaviour is unchanged. `qa/mp-e2e.mjs` still spawns wrangler with its own snapshot, so it doesn't depend on this, but it could switch to `node worker/dev.mjs` and drop the snapshot.

## Independent multiplayer audit (fresh context)

Run on 2026-10-16 against master `d861fe6` with `npm run dev -- --port 8795` (local wrangler). I wrote this section before reading the earlier QA notes. Method: I read MULTIPLAYER_SPEC.md + SPEC.md and the code (`worker/`, `src/view.js`, `src/net.js`, the shell's MP files). Then I ran three things. (a) Raw-WebSocket probes in Node, 3–7 clients per room. (b) Playwright at 390x844 (mobile, touch) with 4–5 contexts: host, join from the list, join by link, join by typed lowercase code, full games through real clicks. (c) Timed cases run in parallel rooms: the 30s Off-clock, 90s abandon, 60s cleanup. `node --test test/`: 155/155. Screenshots: `qa/shots/audit-*.png`, downscaled to 390px wide.

**Agility:** you get into a game fast. Host → lobby took 79ms. A guest saw the room in the open list after 34ms and was in the lobby 60ms after tapping it. Share link → name prompt → lobby took 67ms. A typed code auto-joins on the 4th letter, 274ms including typing. Host + 3 friends seated and the game started in under 6s of scripted taps.

### Spec compliance

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Phones first | **partial** | Fine at 3–4 seats. At 5–6 seats your hand and buttons are below the fold (finding A1). |
| 1/5 | Code + share link, no accounts; open list + code bubble | met | `audit-join-bubble.png`, `audit-link-prompt.png`, `audit-lobby-host.png` |
| 1/6 | A bot never replaces a human; bots only as lobby filler | met | `forfeitSeat` / `clockAt`. Forfeited and disconnected humans get ⏱ moves, never `chooseAction`. |
| 1 | Solo/tutorial offline | met (code) | `localController` path in `main.js`; no net imports used outside MP |
| 2 | Worker + Static Assets + DOs, `wrangler.toml`, `.assetsignore` | met | `/worker/room-core.js`, `/NOTES.md`, `/package.json`, `/wrangler.toml`, `/test/*`, `/qa/*`, `/.git/config` → 404; `/src/view.js` → 200 |
| 3 | `viewFor`: others' hands null, unrevealed mat null, `discarded` challenger-only, `view.me` | met | 351 view frames in a 4-seat game with a bot, plus all frames in the timed rooms: 0 leaks. Each frame was checked for hand faces, unrevealed mat cards, `discarded`, `lastAction.card` / `cardIndex` and unexpected keys. |
| 3 | No x-ray in MP; `lastAction` redacted, `auto: true` on ⏱ | met | `redactAction`; ⏱ frames carry `auto:true` (Off-clock and abandon runs) |
| 3 | Full snapshots with `seq`; client drops stale ones; current view sent on (re)connect | met | `net.js` `msg.seq <= lastSeq`; refresh mid-reveal re-rendered in 128ms (`audit-after-refresh-reveal.png`) |
| 4 | `POST /api/rooms`, `GET /api/lobbies` shape, WS 404 on a missing room | met | Listing `{code,host,humans,seats,bots,timer}`. `ZZZZ`, `OOOO` and `zz` → 404. |
| 4 | Server overwrites `action.player`, checks `legalActions`, `{t:'error'}` | met | `placeInitial` spoofed as player 2 landed on the sender's own seat. `nextRound`, `forfeit`, `bid 99` → "Illegal action". Guest `start` / `kick` → "Only the host can do that". Garbage / non-JSON → "Bad message" or dropped. |
| 4 | `view` carries `seats` + `deadline` + `serverNow` | met | Frame keys `t, seq, view, seats, deadline, serverNow`. `deadline` is null with the timer Off and everyone connected. |
| 5 | Code alphabet (no O/I), case-insensitive input | met | Typing `k0x1` keeps `KX`; a lowercase typed code joins |
| 5 | Token in `skull.token`; same token rejoins the same seat | met | Refresh mid-reveal → same seat, flip still available. A second tab takes over (old socket closes 4000 → "Open somewhere else", `audit-replaced-dialog.png`); "Use here" takes it back. |
| 5 | Host options remembered; seats 3–6; timer Off/20/30/60; Open/Private | met | `skull.hostOptions`; Private → gone from `/api/lobbies` within 400ms |
| 5 | Start with ≥3 seats, 1 human + bots OK | met | 1 human + 2/4/5 bots started (fold measurement runs) |
| 5 | Names: blank → Rider, ≤16, dedupe " 2" | met | "Ann", "Ann 2"; blank → "Rider"; the 16-char cap is in `cleanName` (code only; I didn't send a longer name) |
| 5 | Kick: host only, lobby only | met, see A2 | Kick mid-game → "Game in progress". The kick is also a permanent ban (A2). |
| 5 | Host leaves → longest-seated human | met | Leave in the lobby moved host to H2. Abandon mid-game moved host to seat 1 at 90.0s. |
| 5 | Late joiners wait (`waiting:true`), seated at rematch; in-game rooms not listed | met | `meWaiting:true`, no views. Seated after the game (took the bot's seat, see note C1). `listedInGame:false`. |
| 5 | Humans + bots + waiting ≤ 6 → "Table full" | met | 7th human in the lobby → error "Table full" + close 4009. In-game 6-seat table → same, and the link prompt says "That table is full." (`audit-table-full-ingame.png`). |
| 5 | Game over → same lobby with result; Rematch one tap | met | `audit-lobby-result.png`; rematch reached a new game |
| 5 | Cleanup 60s after the last human goes; delisted at once | met | Delisted 0.8s after all sockets closed. Probe at ~51s → 426 (alive), at ~63s → 404. |
| 6 | Clock for the active seat(s); all unplaced seats share it in place-initial | met | 20s timer: idle host auto-placed at ~20s; rings on all unplaced seats (`audit-table-start.png`) |
| 6 | ⏱ auto moves: bidding pass, place random, empty hand min bid, reveal own then random, visibly marked | met | "⏱ Alex places a card" in the log + toast (`audit-auto-move.png`). Challenger-forfeit reveals went own stack first, then random opponents. |
| 6 | 5s nudge, soft tick, no vibration, 🔊 toggle (`skull.sound`) | met | Nudge seen ~15s into a 20s clock (`audit-nudge.png`); no `vibrate` in `src/` |
| 6 | Disconnect: 📡, normal clock; timer Off → 30s clock | met | Off + disconnect: deadline 30000ms, auto `placeInitial` after 30.02s. 📡 on the seat (`audit-disconnected-seat.png`). |
| 6 | Abandon after 90s → forfeit; may return for the rematch | met | Forfeited at 90.02s (7 ⏱ moves meanwhile). Rejoin mid-game → `meWaiting:true`. |
| 6 | Forfeit: greyed "X left", instant ⏱ moves for the rest of the round, engine forfeit at round end, last active player wins | met | Challenger left after 1 of 6 flips: 5 instant auto reveals, round-over, `forfeit`, round 2 starts with the next active player. Then one of 2 left mid-round: the remaining player finished the round and won (`audit-after-leave.png`). |
| 6 | No humans left → game ends | met (code + test) | `forfeitSeat` → `finishGame` |
| 6 | Bots 700–1200ms server-side; next round ~4s, no tap-skip | met | round-over → place-initial in ~3.5–4s; `nextRound` from a client → "Illegal action" |
| 7 | Home: avatar ◀▶ + name, HOST, JOIN bubble (auto-join on 4th letter), Play vs bots, Learn | met | `audit-home.png`. The open list lives inside the bubble (spec calls that layout provisional). |
| 7 | 12 avatar emojis; `avatar` opaque `{emoji}` | met, see A5 | The server takes any object ≤300 chars JSON |
| 7 | Share link skips home: name prompt (pre-filled) → lobby | met | `audit-link-prompt.png` |
| 7 | Lobby: code + copy/share, seats with avatar/🤖/📡, host options, Start, Leave | met | `audit-lobby-full-host.png`, `audit-lobby-guest.png`, `audit-lobby-6-seats.png` |
| 7 | Game: timer ring, 📡 / greyed "left", ⏱ tags, Leave with confirm | met | `audit-leave-confirm.png` ("Leaving forfeits the game."), `audit-disconnected-seat.png` |
| 8 | Engine `forfeit` (round-over only, nextActive first player, last-standing win) + tests | met | 13 `forfeit` mentions in `test/engine.test.js`; observed live |
| 9 | 5 pop-ups + 🍅 at a target; 1 per 2s; unknown kinds dropped | met | 6 rapid `laugh` → 1 event; `nuke` / `bogus` dropped; tomato `target` delivered (`audit-reactions-open.png`, `audit-reaction-received.png`) |
| 11 | `view` / `server` / `net` tests | met | 155/155 |
| — | XSS via names/avatars from a raw client | met (safe) | `<img onerror>` name and `<svg onload>` avatar shown as text in the lobby, seats, log and "left" toast; nothing executed (`audit-xss-names.png`) |

### Findings, most severe first

**A1. At 5–6 seats on a phone, your cards and action buttons are below the fold (medium, owner: shell).**
Repro: 390x844, host, add bots to 5 or 6 seats, start. Measured with no scroll: `#me-seat` 676–850, `#controls` 860–920, `#hand` 932–1055, document 1142 tall. At 3–4 seats everything fits (hand 705–827). Nothing scrolls the controls into view when it becomes your move.
Expected: phones first (§1); a clock is running and the §6 nudge should be visible.
Actual: "YOUR MOVE" in the status line, but the cards and the bid/pass buttons are off screen. The 5s nudge shakes a seat at the bottom edge (`audit-table-6-seats.png`, `audit-nudge.png`). The same layout exists in solo with 4–5 opponents, but the turn timer makes it matter in MP.
Suggestion: make the opponent seats more compact at ≥4 opponents, or scroll `#controls` into view when your turn starts.

**A2. Kick is a one-tap, permanent ban (medium, owner: shell for the confirm, server for the ban).**
Repro: as host, tap ✕ next to a friend in the lobby. There's no confirm step. The ✕ sits beside every human's name, where a mis-tap on a phone is easy. The server puts the token in `s.kicked` for the room's lifetime. Every later `hello` from it (link, code, refresh) gets `{t:'kicked'}` + close 4001, and the client says "The host kicked you from the table."
Expected: §5 only says "host only, lobby only". A ban isn't specified, and the friends-on-voice context makes mis-kicks likely.
Actual: no confirm and no undo. The friend can't come back until the room dies.
Suggestion: add a confirm ("Kick Bea?"), and let a kicked player rejoin by link (kick = remove), or ban only on a second kick.

**A3. The multiplayer game-over moment is underplayed (low, owner: shell).**
In MP there's no game-over banner or modal. For 4s the table shows the last challenge result ("Snakes wins the challenge") with the prompt "Game over. Back to the lobby in a moment…", and the status line says "Snakes wins" (`audit-gameover-mp.png`). Then the lobby card says "Snakes won the last game" (`audit-lobby-result.png`). It works, but the win of the night reads like an ordinary round end. Suggestion: show a big winner banner (avatar + "X wins the game!") for those 4s.

**A4. The "Open somewhere else" dialog shows "📡 Reconnecting…" behind it (low, owner: shell).**
`lobby-ui.js` treats any status other than `open` as offline. With status `replaced`, the lobby behind the dialog says "📡 Reconnecting…" and greys out, but nothing is reconnecting (`audit-replaced-dialog.png`). Suggestion: show the 📡 note only for `connecting` / `reconnecting`.

**A5. An avatar can be any text (low, owner: server; shell could also clip).**
`cleanAvatar` accepts any object up to 300 chars of JSON, so a raw client can set `emoji` to a long string. It's escaped (no XSS), but it spills over the seat card and can mimic UI text such as "👑 host" (`audit-xss-names.png`). Suggestion: until the skull builder lands, clamp `emoji` to the 12 picker emojis or one short grapheme cluster, and clip `.ls-av` / seat avatars.

**A6. A ⏱ toast covers the mobile status line (low, owner: shell).** "⏱ You lay down a card" sits over "… thinking…" in the top bar (`audit-auto-move.png`).

**A7. Info (server): late joiners get reaction events.** `react` broadcasts to `'all'` sockets, including waiting late joiners and members still in the lobby. The client ignores them off the table, so this is harmless. Suggestion: send only to in-game members.

**A8. Info (server): duplicate frame on Leave.** When a Leave lands at round-over, two consecutive views carry the same `lastAction` (`forfeit`, `n=14`): `forfeitSeat` → `advance` broadcasts, then `leave()` broadcasts again. The `seq` differs and nothing breaks, so this is only an extra frame.

**A9. Info (shell): the solo subtitle sits under the wrong button.** On home, "vs 3 rival gangs · riding as Rider" sits under **Learn to play**, but it describes **Play vs bots** (`audit-home.png`).

**Notes / not findings**
- **C1 (spec ambiguity, server's documented choice):** a human joining a full lobby takes a bot's seat. This includes a waiting late joiner at game end: in my run the host-added Panthers bot was dropped to seat "Late". It's consistent with "filler" bots, but Alex may want to confirm that a bot the host added can vanish on rematch.
- **Not verified in a browser:** client-side phone-lock behaviour (your own 📡 pill). Playwright `context.setOffline(true)` didn't drop the already-open WebSocket in headless Chromium, so the pill never showed (inconclusive, not a bug). The server-side disconnect path was verified by closing a tab: 📡 on the seat, normal clock, ⏱ moves, abandon at 90s.
- **Adversarial cases that behaved per spec:** two tabs on one token; host disconnected mid-game (host kept until the 90s abandon, then moved to seat 1); forfeit as challenger mid-reveal; forfeit leaving one active player (winner at round end); 7th joiner in the lobby and in-game; timer Off + disconnect (30.0s); kick in the lobby (and rejected mid-game); late joiner; Private hidden; invalid codes; reaction spam; illegal / foreign actions; card faces in raw frames (none); cleanup at ~60s; refresh during reveal.

### Duplicates of the earlier QA notes
- **A6** duplicates "Mobile toasts hide the turn cue" (Final regression, new findings).
- **A4** is new. It's a side effect of the fix for QA #1 (the offline lobby note now also shows for the final `replaced` status).
- **C1** and the forfeit clearing the mat are documented server choices under "Server agent → Behaviour choices", so they aren't findings.
- **A1, A2, A3, A5, A7, A8, A9** are new. QA's "no horizontal scroll at 390px" still holds; A1 is about vertical fold, which they didn't check.
