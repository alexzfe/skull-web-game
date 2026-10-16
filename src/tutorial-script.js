// Tutorial script — pure data, replayed by src/tutorial.js.
// Table: you (0), Panthers (1), Snakes (2). Every bot move and every human
// move is fixed, so the engine plays out the same way every time
// (test/tutorial.test.js proves it).
//
// Step kinds:
//   { say, next: true }            Bones talks; waits for "Next". Optional xray: true
//                                  shows every card face-up while the bubble is open.
//   { do: action, say, target }    locked human step: only `action` is accepted,
//                                  only `target` is clickable.
//   { bots: [action, ...], say? }  scripted bot moves, applied in any order.
//   { hold: true }                 wait for the reveal hold (or game over) to finish.
//   { nextRound: true }            let the next round start.
//   { finale: true, say, buttons } last bubble; buttons resolve to 'solo' | 'replay'.

const R = 'rose', S = 'skull';
const YOU = 0, PANTHERS = 1, SNAKES = 2;

export const TUTORIAL_PLAYERS = [
  { name: 'Rider', isHuman: true },   // replaced by the remembered name at runtime
  { name: 'Panthers', isHuman: false },
  { name: 'Snakes', isHuman: false },
];
export const TUTORIAL_FIRST_PLAYER = PANTHERS;

const hand = face => `[data-tut="hand-card"][data-face="${face}"]`;
const stack = id => `[data-tut="stack"][data-player="${id}"]`;
const T = {
  rose: hand(R),
  skull: hand(S),
  bid: '[data-tut="bid-submit"]',
  pass: '[data-tut="pass"]',
  flipOwn: '[data-tut="flip-own"]',
  pot: '[data-tut="pot"]',
  myMat: '[data-tut="my-mat"]',
  bidDisplay: '[data-tut="bid-display"]',
};

const placeInitial = (player, card) => ({ type: 'placeInitial', player, card });
const place = (player, card) => ({ type: 'place', player, card });
const bid = (player, amount) => ({ type: 'bid', player, amount });
const pass = player => ({ type: 'pass', player });
const reveal = (player, target) => ({ type: 'reveal', player, target });

export const TUTORIAL_SCRIPT = [
  // ---- Round 1: win a bet ----
  { say: "Name's Bones. I pour drinks and bury bluffers. Win <b>two bets</b> and the table's yours, kid.", mood: 'grin', next: true },
  { do: placeInitial(YOU, R), target: T.rose, say: 'Everyone lays one card face-down. Lay a <b>Rose</b> — roses are safe.' },
  { bots: [placeInitial(PANTHERS, R), placeInitial(SNAKES, S)] },
  { say: 'Now each turn you <b>add a card</b> or <b>bet</b> how many Roses you can flip.', target: T.pot, next: true },
  { bots: [bid(PANTHERS, 1)], say: 'Panthers bets they can flip <b>1</b> Rose.', target: T.bidDisplay },
  { bots: [pass(SNAKES)] },
  { do: bid(YOU, 2), target: T.bid, say: "Snakes passed. Raise to <b>2</b> — highest bid has to deliver." },
  { bots: [pass(PANTHERS)], say: 'Panthers folds. Passing is for keeps.' },
  { do: reveal(YOU, YOU), target: T.flipOwn, say: 'You flip <b>your own stack first</b>. Always. One Rose.' },
  { do: reveal(YOU, PANTHERS), target: stack(PANTHERS), say: 'One more. Panthers bet, so they likely sit on Roses. Flip theirs.' },
  { hold: true },
  { say: "Two Roses — bet won. Your mat flips to the Rose side. Here's what everyone actually had.", mood: 'grin', target: T.myMat, xray: true, next: true },
  { say: "See that Skull under Snakes? That's why you pick your stacks careful.", xray: true, next: true },
  { nextRound: true },

  // ---- Round 2: the bluff ----
  { do: placeInitial(YOU, R), target: T.rose, say: "Winner goes first — that's an edge. Lay a Rose." },
  { bots: [placeInitial(PANTHERS, R), placeInitial(SNAKES, R)] },
  { do: place(YOU, S), target: T.skull, say: "Time to lie. Put your <b>Skull</b> on top." },
  { bots: [place(PANTHERS, R), place(SNAKES, R)] },
  { do: bid(YOU, 1), target: T.bid, say: 'Now bet like you\'ve got nothing to hide. Open at <b>1</b>.' },
  { bots: [bid(PANTHERS, 4)], say: 'Panthers smells weakness and jumps to <b>4</b>.', mood: 'grin', target: T.bidDisplay },
  { bots: [pass(SNAKES)] },
  { do: pass(YOU), target: T.pass, say: 'Let them have it. <b>Pass</b>.' },
  { bots: [reveal(PANTHERS, PANTHERS), reveal(PANTHERS, PANTHERS), reveal(PANTHERS, YOU)], say: 'Panthers flips their own two, then comes for yours...' },
  { hold: true },
  { say: "Your Skull. Panthers loses a card at random — gone for good. Here's the table.", mood: 'grin', xray: true, next: true },
  { nextRound: true },

  // ---- Round 3: close it out ----
  { do: placeInitial(YOU, R), target: T.rose, say: "Challengers lead the next round, so Panthers starts. One more win and it's yours — lay a Rose." },
  { bots: [placeInitial(PANTHERS, R), placeInitial(SNAKES, S)] },
  { bots: [place(PANTHERS, R), place(SNAKES, R)] },
  { do: place(YOU, R), target: T.rose, say: 'Stack another Rose. More Roses under you, easier bets.' },
  { bots: [bid(PANTHERS, 2), pass(SNAKES)], say: 'Watch who\'s confident. Panthers bets, Snakes ducks out.' },
  { do: bid(YOU, 3), target: T.bid, say: 'Raise to <b>3</b>: your two plus one of theirs.' },
  { bots: [pass(PANTHERS)] },
  { do: reveal(YOU, YOU), target: T.flipOwn, say: 'Own stack first. Top card.' },
  { do: reveal(YOU, YOU), target: T.flipOwn, say: 'And the one under it.' },
  { do: reveal(YOU, PANTHERS), target: stack(PANTHERS), say: "Snakes ducked — that smells like a Skull. Take the Panthers' Rose." },
  { hold: true },
  { say: "Here's what everyone had. Snakes was sitting on a Skull, sure enough.", xray: true, next: true },
  {
    finale: true, mood: 'grin',
    say: "Not bad, kid. Two bets, two wins. The real table's waiting.",
    buttons: [
      { label: 'Play a real game', value: 'solo', primary: true },
      { label: 'Replay tutorial', value: 'replay' },
    ],
  },
];

// Seeded draws for the engine: Panthers' random card loss in round 2.
export const TUTORIAL_RNG_SEQUENCE = [0];
