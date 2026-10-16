# Skull & Roses — Web Version Spec

Single-page browser game: one human player vs 2–5 AI bikers (3–6 players total).
No build step. Plain HTML/CSS + ES modules. Must work by opening via a static server
(`npx serve .` or `python3 -m http.server`). Tests run with `node --test`.

## File layout (ownership)

| File | Owner |
|---|---|
| `src/engine.js` — pure rules engine, no DOM | engine agent |
| `test/engine.test.js` | engine agent |
| `src/ai.js` — bot decision logic, no DOM | ai agent |
| `test/ai.test.js` | ai agent |
| `index.html`, `styles.css`, `src/ui.js`, `src/main.js` | ui agent |

Do not edit files you don't own. If you need a change in another module, write it in
`NOTES.md` under your agent's heading.

## Rules (from the official rulebook)

- Each player: 4 cards = 3 Roses + 1 Skull, and a mat (Skull side up = 0 wins).
- Goal: win 2 bets (first win flips mat to Rose side). Also: last player with cards wins.
- **Round start (phase "place-initial")**: every player with cards secretly places 1 card face-down on their mat. (Simultaneous; in-engine, process in any order, the human chooses via UI.)
- **Placement (phase "placement")**: starting with the first player, clockwise (index+1, skipping eliminated players), each player on their turn either:
  - places 1 more card from hand on top of their stack, or
  - starts a challenge (bid) of N cards, 1 ≤ N ≤ total cards on all mats.
  - A player with no cards in hand MUST bid.
  - The first player may bid immediately (before anyone places a second card).
- **Bidding (phase "bidding")**: clockwise from the bidder, each non-passed player either raises (any value > current bid, ≤ total cards on mats) or passes. Passed players can't bid again. Ends when all but one have passed; that one is the challenger. If someone bids the maximum (total cards on mats), bidding ends immediately and they are challenger.
- **Revelation (phase "reveal")**: challenger MUST first flip ALL cards of their own stack, top to bottom, one at a time. Then they choose any opponent's stack and flip its top unrevealed card, one at a time, until they've revealed N cards total.
  - If a Skull is revealed → bet lost immediately.
  - If N Roses revealed → bet won.
- **Won bet**: challenger's wins += 1. At 2 wins → that player wins the game.
- **Lost bet**: challenger loses one card permanently (from all their 4-or-fewer owned cards, after all cards return to hand):
  - Skull was their own: challenger chooses which card to discard (UI: human picks; bot picks).
  - Skull was an opponent's: the opponent (Skull owner) picks a random card blindly — implement as uniformly random.
  - Only the challenger learns what the discarded card was (UI shows it to the human only if they're the challenger).
  - If challenger has 0 cards → eliminated. If only one player still has cards → they win.
- **Next round**: all cards return to hands. First player = challenger. Exception: if challenger was eliminated:
  - if they revealed their own Skull, they choose next first player (bot/human choice; simplest: human picks, bot picks random active player);
  - else the owner of the revealed Skull is first player.
- A player with exactly 1 card who is first player or whose turn comes in placement must bid (falls out of "no cards in hand" rule naturally).

## Engine API (`src/engine.js`) — CONTRACT, do not deviate

All functions are pure: they return a NEW state, never mutate input. Throw `Error` on illegal action.
Randomness via optional injected `rng` (function returning [0,1)), default `Math.random`.

```js
export const ROSE = 'rose', SKULL = 'skull';

export function createGame({ players, firstPlayer = 0, rng }) // players: [{name, isHuman}]
// -> state

// state shape:
{
  players: [{
    id: number,            // index
    name: string,
    isHuman: boolean,
    hand: ('rose'|'skull')[],     // cards in hand (owned, not on mat)
    mat: ('rose'|'skull')[],      // stack, index 0 = bottom, last = top
    revealed: number,             // how many cards from top of mat are flipped this reveal
    wins: number,                 // 0..2
    eliminated: boolean,
    passed: boolean,              // passed in current bidding
  }],
  phase: 'place-initial' | 'placement' | 'bidding' | 'reveal' | 'discard' | 'choose-first' | 'round-over' | 'game-over',
  firstPlayer: number,
  currentPlayer: number,        // whose turn (placement/bidding/reveal=challenger/discard=chooser/choose-first=chooser)
  bid: { player: number, amount: number } | null,   // highest bid
  challenger: number | null,
  revealedCount: number,        // cards revealed so far in reveal phase
  revealedSkullOwner: number | null,
  lastResult: null | { type: 'won'|'lost', challenger: number, skullOwner?: number, discarded?: 'rose'|'skull', eliminated?: boolean },
  winner: number | null,
  round: number,
  log: string[],                // human readable event log, append-only
}

export function totalOnMats(state) -> number
export function legalActions(state, playerId) -> Action[]   // empty if not their turn
export function applyAction(state, action, rng?) -> state

// Action types:
{ type: 'placeInitial', player, card: 'rose'|'skull' }  // phase place-initial; phase -> placement once all active players placed; currentPlayer = firstPlayer
{ type: 'place', player, card }                          // phase placement
{ type: 'bid', player, amount }                          // placement (starts bidding) or bidding (raise)
{ type: 'pass', player }                                 // bidding
{ type: 'reveal', player, target }                       // reveal; target = player id whose top unrevealed card flips. Engine rejects opponents' stacks until own stack fully revealed.
{ type: 'discard', player, cardIndex }                   // phase discard: only when challenger revealed own skull; player = challenger, cardIndex into challenger's hand (after cards returned)
{ type: 'chooseFirst', player, target }                  // phase choose-first
{ type: 'nextRound' }                                    // phase round-over -> place-initial (cards back to hands, reset revealed/passed/bid)
```

Phase flow after reveal ends:
- won → wins++; if wins==2 → `game-over` with winner. Else → `round-over` (firstPlayer = challenger).
- lost, opponent's skull → cards return to hands, random card removed from challenger (via rng) → if eliminated & only 1 active remains → `game-over`; else `round-over` with firstPlayer = skull owner if eliminated else challenger.
- lost, own skull → cards return to hands → phase `discard` (currentPlayer = challenger) → after discard: if eliminated → `choose-first` (currentPlayer = challenger, who is eliminated but still chooses) or `game-over` if 1 active left; else `round-over` (firstPlayer = challenger).
- In `round-over`, mats keep their cards and `revealed` counts so the UI can show the final board; `nextRound` clears them.

Also export a helper for views:
```js
export function activePlayers(state) -> number[]   // ids not eliminated
export function nextActive(state, fromId) -> number // next non-eliminated clockwise
```

## AI API (`src/ai.js`)

```js
export function chooseAction(state, playerId, rng = Math.random) -> Action
```
Must always return an action contained in `legalActions(state, playerId)` (compare by JSON).
Only use information that player legitimately knows: their own hand and mat, public
info (mat sizes, revealed cards, bids, wins, hand sizes). Never peek at others' card values.
Reasonable strategy: bluff sometimes, bid around estimated safe count, reveal own stack then
pick opponents with fewer cards/who bid (likely roses), sometimes play skull. Varied personalities
per bot (risk tolerance from playerId seed) welcome.

## UI (`index.html`, `styles.css`, `src/ui.js`, `src/main.js`)

- Setup screen: player name, number of opponents (2–5), start.
- Table view: opponents arranged around top, human at bottom. Each seat shows name,
  mat (Skull side or Rose side if 1 win; win count), card stack on mat (count obvious,
  face-down; flipped cards show face), hand size, passed/eliminated badges, current-turn highlight.
- Human hand: clickable cards (face visible to human only).
- Controls depend on phase: place card / bid (number selector, min..max) / pass /
  click an opponent's stack to reveal / discard choice / choose first player / next round.
- Bots act automatically with ~700–1200ms delay so the human can follow. Animate card flips.
- Event log panel. Clear announcement banners ("Panthers bids 4", "SKULL! Bet lost").
- Rules/help modal summarizing the rules.
- Game over screen with play again.
- Biker / bar theme: dark, leather & neon, skulls & roses. Use inline SVG or CSS for card art (no external images). Responsive down to phone width.
- Bot names from the rulebook flavor: Panthers, Snakes, Werewolves, Eagles, Himself... plus others.
