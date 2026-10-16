
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
