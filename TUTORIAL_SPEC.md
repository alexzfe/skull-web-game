# Tutorial, First-Game Tips & Quick Start — Spec

Product theme: **agile** — players hop into a game as fast as possible. The long-term goal
is friends multiplayer (designed separately — do NOT build any networking here). Keep new
code decoupled from the game screens so a multiplayer layer can slot in later.

Read SPEC.md (rules + engine contract) first. `src/engine.js` and `src/ai.js` are FROZEN —
do not edit them.

## File ownership

| Files | Owner |
|---|---|
| `index.html`, `styles.css`, `src/ui.js`, `src/main.js`, `src/coach.js` (new) | **shell** agent |
| `src/tutorial-script.js`, `src/tutorial.js`, `src/tips.js` (all new), `test/tutorial.test.js`, `test/tips.test.js` | **tutor** agent |
| `qa/**` | QA (later) |

Don't edit files you don't own. Cross-agent requests go in `NOTES.md` under your heading.

## 1. Quick start (shell)

- Setup screen: one big primary **Play now** button → starts a solo game instantly using
  remembered settings (localStorage `skull.settings` = `{name, opponents}`; defaults
  name "Rider", 3 opponents). Next to it: **Learn to play (60s)** (starts tutorial).
  Name + opponent count move behind a small **Table settings** link/disclosure.
  Name is optional. No first-visit modal.
- Round over → next round starts automatically after ~2.5s; tapping anywhere on the
  table (or the Next round button) starts it immediately.
- Game over → **Rematch** (primary, instant restart with same settings, no dialog
  round-trip) and **Change table** (secondary, back to setup).
- No animation skip-ahead. No speed setting. Keep current bot timings.

## 2. Controller director hooks (shell implements in `src/main.js`)

`main.js` runs every game through an optional **director** object. Normal solo games use
the tips director (if tips enabled) — tutorial uses the tutorial director.

```js
// Exported from src/main.js? No — main.js imports directors and passes them in.
// main.js must call these if present on the active director:
director = {
  setup?(): { players: [{name, isHuman}], firstPlayer: number },  // override table (tutorial)
  rng?: () => number,                       // passed to applyAction (deterministic discards)
  botAction?(state, id): Action | null,     // scripted bot move; null → default ai.chooseAction
  allowHuman?(state, action): boolean,      // false → ignore the human action (locked steps)
  canProceed?(): boolean,                   // false → bots + auto-next-round wait; director calls ctl.resume()
  onStart?(ctl),                            // called once after the first render
  onState?(prev, next, action, ctl),        // after every applied action AND after the reveal hold finishes (action = null then)
  onGameOver?(state, ctl): boolean,         // true → director handled it; suppress default game-over UI
  autoNextRoundMs?: number,                 // default 2500
  exit?(),                                  // cleanup when leaving the game (new game, setup, etc.)
}

// ctl passed to the director:
ctl = {
  getState(),            // current engine state
  resume(),              // re-run the scheduler (after canProceed flips to true)
  setXray(bool),         // tutorial-only: render ALL mat cards face-up, with a visible "Tutorial view" tag
  coach,                 // the coach instance (section 3)
  humanId: 0,
  toSetup(),             // leave to setup screen
  startSolo({tips}),     // start a normal solo game with remembered settings (tips: bool)
  startTutorial(),       // restart tutorial
}
```

Entry points: Play now → `startSolo({tips: tipsEnabled()})` (import `tipsEnabled`,
`createTipsDirector` from `./tips.js`); Learn to play → `createTutorialDirector()` from
`./tutorial.js`.

### Stable DOM targets (shell adds these `data-tut` attributes; tutor selects by them)

- `[data-tut="hand-card"][data-face="rose|skull"]` — playable hand cards
- `[data-tut="bid-dec"]`, `[data-tut="bid-inc"]`, `[data-tut="bid-value"]`, `[data-tut="bid-submit"]` (open/raise button), `[data-tut="pass"]`
- `[data-tut="flip-own"]`
- `[data-tut="seat"][data-player="N"]`, `[data-tut="stack"][data-player="N"]` (opponent mats, the reveal click target)
- `[data-tut="my-seat"]`, `[data-tut="my-mat"]`, `[data-tut="pot"]` (cards-on-table), `[data-tut="bid-display"]`, `[data-tut="status"]`, `[data-tut="next-round"]`, `[data-tut="wins"][data-player="N"]`

## 3. Coach — Bones (shell implements `src/coach.js` + CSS)

**Bones**: skeleton biker bartender, gravelly veteran, dry humor, calls you "kid". Inline
SVG (bandana, bar towel over shoulder, maybe a leather vest), 3 moods:
`neutral`, `grin`, `wince`. Must look great in the existing dark neon theme.

```js
export function createCoach(): {
  say({
    text,                 // string, may contain <b>
    mood = 'neutral',
    target = null,        // CSS selector; spotlight it (re-resolve every frame — ui re-renders DOM)
    lock = false,         // guide mode: dim everything, only target clickable (overlay blocks other clicks)
    next = false,         // show a "Next" button; promise resolves when clicked
    buttons = null,       // [{label, value, primary?}] → promise resolves with value
    mode = 'guide',       // 'guide' (tutorial, with Skip tutorial button) | 'tip' (non-blocking, auto-hide)
    ms = 5000,            // tip mode auto-hide; click also dismisses
  }): Promise<any>,
  hide(),
  onSkip(fn),             // Skip tutorial clicked (guide mode)
  destroy(),
}
```
- Desktop: bubble near the spotlit target (or centered if none), Bones avatar beside it.
- Mobile (≤640px): bubble docks to top or bottom edge, whichever is away from the target;
  Bones becomes a small avatar.
- Tip mode never blocks input and never dims.

## 4. Tutorial (tutor implements)

Table: you (id 0) + **Panthers** (1) + **Snakes** (2). ~60–90s total. Bot moves near-instant
(use short delays). Every step that expects a human move is **locked** to exactly that
move (coach `lock:true` + `allowHuman`). Bubbles ≤ 2 short sentences, one where possible;
merge explanations into action steps ("Lay a Rose — roses are safe.").
Skip tutorial available on every step. Finishing or skipping sets
localStorage `skull.tutorialDone = "1"`.

Script lives as data in `src/tutorial-script.js`; runner in `src/tutorial.js`.

Rounds (adjust details as needed for engine legality — test must prove the script replays):
1. **Win a bet.** Place a Rose. Bots place. Panthers opens bid 1. You raise; flip your own
   cards first (all Roses), then flip a bot's Rose → you win; your mat flips to the Rose
   side (1 win). Teaches: placing, adding vs challenging, bidding/passing, own-stack-first,
   choosing stacks, winning a bet.
2. **The bluff.** Bones suggests putting your Skull on top and bidding anyway. A bot outbids
   you, flips your Skull and loses a card at random (deterministic via director rng).
   Teaches bluffing + what an opponent's Skull costs.
3. **Close it out.** You win your second bet → you win the game (2 wins).

Light strategy hints woven in (from rulebook Advice): first player is an advantage; bluff by
bidding over your own Skull; watch who's confident.

End of each round: `ctl.setXray(true)` briefly — "Here's what everyone actually had." — then off.

Finale: Bones (grin) "Not bad, kid." with buttons **Play a real game** →
`ctl.startSolo({tips:true})` and **Replay tutorial** → `ctl.startTutorial()`.

`test/tutorial.test.js` (node:test): replay the whole script against the real engine with the
director's rng/botAction/allowHuman → every scripted action legal, ends game-over with human
winner after exactly 3 rounds; every step has text ≤ 160 chars; every human step has a target.

## 5. First-game tips (tutor implements `src/tips.js`)

```js
export function tipsEnabled(): boolean      // !skull.tipsOff && completed games with tips < 1
export function createTipsDirector(): director
```
Non-blocking Bones `mode:'tip'` bubbles, each shown at most once ever (localStorage
`skull.tipsSeen` = JSON array of ids):
- `max-bid`: first time the human could bid the maximum (explain it ends bidding instantly)
- `lost-bet`: first time the human loses a bet (random card if opponent's Skull; you choose if your own)
- `elimination`: first time anyone is eliminated (and who picks the next starter)
- `last-card`: human down to 1 card total ("stoned" — must bid when your hand is empty)
- `first-player`: human is first player ("going first is an advantage")
Tip bubbles include a small "Don't show tips" link → sets `skull.tipsOff = "1"`.
After one completed game with tips, tips auto-disable (`skull.tipsGames`).
`test/tips.test.js`: trigger logic as pure functions over (prev, next) states.

## 6. QA (later)

Extend `qa/e2e.mjs`: full tutorial walkthrough at desktop + mobile, Skip at every step,
tips firing in a first real game, Play now → game in one click, Rematch, auto next round.
