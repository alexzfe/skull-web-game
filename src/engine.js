// Skull & Roses — pure rules engine. No DOM, no mutation of inputs.
// See SPEC.md "Engine API" for the contract.

export const ROSE = 'rose', SKULL = 'skull';

const STARTING_HAND = [ROSE, ROSE, ROSE, SKULL];
const WINS_TO_WIN = 2;

// ---------- helpers ----------

function clone(state) {
  return structuredClone(state);
}

function owned(p) {
  return p.hand.length + p.mat.length;
}

function log(s, msg) {
  s.log.push(msg);
}

function name(s, id) {
  return s.players[id].name;
}

// "Panthers" -> "Panthers'", "Eagle" -> "Eagle's"
export function possessive(n) {
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

export function totalOnMats(state) {
  return state.players.reduce((n, p) => n + p.mat.length, 0);
}

export function activePlayers(state) {
  return state.players.filter(p => !p.eliminated).map(p => p.id);
}

export function nextActive(state, fromId) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const id = (fromId + i) % n;
    if (!state.players[id].eliminated) return id;
  }
  return fromId;
}

// Next active player clockwise from `fromId` who has not passed in this bidding.
function nextBidder(state, fromId) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const id = (fromId + i) % n;
    const p = state.players[id];
    if (!p.eliminated && !p.passed) return id;
  }
  return fromId;
}

function distinctCards(hand) {
  return [ROSE, SKULL].filter(c => hand.includes(c));
}

function range(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

function pickIndex(rng, n) {
  const i = Math.floor(rng() * n);
  return Math.min(Math.max(i, 0), n - 1);
}

// ---------- creation ----------

export function createGame({ players, firstPlayer = 0, rng = Math.random } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error('createGame: need between 2 and 6 players');
  }
  if (firstPlayer === 'random') firstPlayer = pickIndex(rng, players.length);
  if (!Number.isInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= players.length) {
    throw new Error(`createGame: invalid firstPlayer ${firstPlayer}`);
  }
  const state = {
    players: players.map((p, id) => ({
      id,
      name: p.name ?? `Player ${id + 1}`,
      isHuman: !!p.isHuman,
      hand: [...STARTING_HAND],
      mat: [],
      revealed: 0,
      wins: 0,
      eliminated: false,
      passed: false,
    })),
    phase: 'place-initial',
    firstPlayer,
    currentPlayer: firstPlayer,
    bid: null,
    challenger: null,
    revealedCount: 0,
    revealedSkullOwner: null,
    lastResult: null,
    winner: null,
    round: 1,
    log: [],
  };
  log(state, `Round 1 begins. ${name(state, firstPlayer)} starts.`);
  return state;
}

// ---------- legal actions ----------

export function legalActions(state, playerId) {
  const p = state.players[playerId];
  if (!p && state.phase !== 'round-over') return [];

  switch (state.phase) {
    case 'place-initial': {
      if (p.eliminated || p.mat.length > 0) return [];
      return distinctCards(p.hand).map(card => ({ type: 'placeInitial', player: playerId, card }));
    }
    case 'placement': {
      if (state.currentPlayer !== playerId) return [];
      const total = totalOnMats(state);
      return [
        ...distinctCards(p.hand).map(card => ({ type: 'place', player: playerId, card })),
        ...range(1, total).map(amount => ({ type: 'bid', player: playerId, amount })),
      ];
    }
    case 'bidding': {
      if (state.currentPlayer !== playerId) return [];
      const total = totalOnMats(state);
      return [
        ...range(state.bid.amount + 1, total).map(amount => ({ type: 'bid', player: playerId, amount })),
        { type: 'pass', player: playerId },
      ];
    }
    case 'reveal': {
      if (state.challenger !== playerId) return [];
      if (p.revealed < p.mat.length) return [{ type: 'reveal', player: playerId, target: playerId }];
      return state.players
        .filter(o => o.id !== playerId && o.revealed < o.mat.length)
        .map(o => ({ type: 'reveal', player: playerId, target: o.id }));
    }
    case 'discard': {
      if (state.currentPlayer !== playerId) return [];
      return p.hand.map((_, cardIndex) => ({ type: 'discard', player: playerId, cardIndex }));
    }
    case 'choose-first': {
      if (state.currentPlayer !== playerId) return [];
      return activePlayers(state).map(target => ({ type: 'chooseFirst', player: playerId, target }));
    }
    case 'round-over':
      return [{ type: 'nextRound' }];
    default:
      return [];
  }
}

const ACTION_KEYS = ['type', 'player', 'card', 'amount', 'target', 'cardIndex'];
function actionKey(a) {
  return JSON.stringify(ACTION_KEYS.map(k => a[k] ?? null));
}

// ---------- apply ----------

export function applyAction(state, action, rng = Math.random) {
  if (!action || typeof action.type !== 'string') throw new Error('applyAction: missing action type');
  if (state.phase === 'game-over') throw new Error('Game is over');
  if (action.type === 'forfeit') return doForfeit(state, action);

  const legal = action.type === 'nextRound'
    ? legalActions(state, 0)
    : legalActions(state, action.player);
  const key = actionKey(action);
  if (!legal.some(a => actionKey(a) === key)) {
    throw new Error(`Illegal action ${JSON.stringify(action)} in phase ${state.phase}`);
  }

  const s = clone(state);
  switch (action.type) {
    case 'placeInitial': doPlaceInitial(s, action); break;
    case 'place': doPlace(s, action); break;
    case 'bid': doBid(s, action); break;
    case 'pass': doPass(s, action); break;
    case 'reveal': doReveal(s, action, rng); break;
    case 'discard': doDiscard(s, action); break;
    case 'chooseFirst': doChooseFirst(s, action); break;
    case 'nextRound': doNextRound(s); break;
    default: throw new Error(`Unknown action type ${action.type}`);
  }
  return s;
}

function removeCard(hand, card) {
  hand.splice(hand.indexOf(card), 1);
}

function doPlaceInitial(s, { player, card }) {
  const p = s.players[player];
  removeCard(p.hand, card);
  p.mat.push(card);
  log(s, `${p.name} places a card.`);
  if (s.players.every(o => o.eliminated || o.mat.length > 0)) {
    s.phase = 'placement';
    s.currentPlayer = s.firstPlayer;
    log(s, `All cards down. ${name(s, s.firstPlayer)} to play.`);
  }
}

function doPlace(s, { player, card }) {
  const p = s.players[player];
  removeCard(p.hand, card);
  p.mat.push(card);
  log(s, `${p.name} adds a card.`);
  s.currentPlayer = nextActive(s, player);
}

function doBid(s, { player, amount }) {
  if (s.phase === 'placement') {
    s.phase = 'bidding';
    for (const p of s.players) p.passed = false;
    log(s, `${name(s, player)} starts a challenge: ${amount}.`);
  } else {
    log(s, `${name(s, player)} raises to ${amount}.`);
  }
  s.bid = { player, amount };
  if (amount === totalOnMats(s)) {
    startReveal(s);
  } else {
    s.currentPlayer = nextBidder(s, player);
  }
}

function doPass(s, { player }) {
  s.players[player].passed = true;
  log(s, `${name(s, player)} passes.`);
  const remaining = s.players.filter(p => !p.eliminated && !p.passed);
  if (remaining.length <= 1) {
    startReveal(s);
  } else {
    s.currentPlayer = nextBidder(s, player);
  }
}

function startReveal(s) {
  s.phase = 'reveal';
  s.challenger = s.bid.player;
  s.currentPlayer = s.bid.player;
  s.revealedCount = 0;
  s.revealedSkullOwner = null;
  log(s, `${name(s, s.challenger)} must reveal ${s.bid.amount} card${s.bid.amount === 1 ? '' : 's'}.`);
}

function doReveal(s, { player, target }, rng) {
  const t = s.players[target];
  const card = t.mat[t.mat.length - 1 - t.revealed];
  t.revealed++;
  s.revealedCount++;
  const whose = target === player ? 'own' : possessive(t.name);
  log(s, `${name(s, player)} flips ${whose} card: ${card === SKULL ? 'SKULL' : 'rose'}.`);
  if (card === SKULL) {
    s.revealedSkullOwner = target;
    loseBet(s, player, target, rng);
  } else if (s.revealedCount >= s.bid.amount) {
    winBet(s, player);
  }
}

function winBet(s, c) {
  const p = s.players[c];
  p.wins++;
  s.lastResult = { type: 'won', challenger: c };
  log(s, `${p.name} wins the challenge! (${p.wins} win${p.wins === 1 ? '' : 's'})`);
  if (p.wins >= WINS_TO_WIN) {
    endGame(s, c);
  } else {
    s.phase = 'round-over';
    s.firstPlayer = c;
    s.currentPlayer = c;
  }
}

// Challenger's cards return to hand so one can be discarded. Other mats stay
// on the board (for display) until nextRound.
function returnChallengerCards(s, c) {
  const p = s.players[c];
  p.hand.push(...p.mat);
  p.mat = [];
  p.revealed = 0;
}

function eliminateIfEmpty(s, c) {
  const p = s.players[c];
  if (owned(p) === 0 && !p.eliminated) {
    p.eliminated = true;
    log(s, `${p.name} has no cards left and is eliminated.`);
  }
  return p.eliminated;
}

function checkLastStanding(s) {
  const active = activePlayers(s);
  if (active.length === 1) {
    endGame(s, active[0]);
    return true;
  }
  return false;
}

function loseBet(s, c, skullOwner, rng) {
  returnChallengerCards(s, c);
  const p = s.players[c];
  log(s, `${p.name} loses the challenge.`);
  if (skullOwner === c) {
    s.lastResult = { type: 'lost', challenger: c, skullOwner };
    s.phase = 'discard';
    s.currentPlayer = c;
    return;
  }
  const idx = pickIndex(rng, p.hand.length);
  const [discarded] = p.hand.splice(idx, 1);
  log(s, `${name(s, skullOwner)} takes away one of ${possessive(p.name)} cards.`);
  const eliminated = eliminateIfEmpty(s, c);
  s.lastResult = { type: 'lost', challenger: c, skullOwner, discarded, eliminated };
  if (eliminated && checkLastStanding(s)) return;
  s.phase = 'round-over';
  s.firstPlayer = eliminated ? skullOwner : c;
  s.currentPlayer = s.firstPlayer;
}

function doDiscard(s, { player, cardIndex }) {
  const p = s.players[player];
  const [discarded] = p.hand.splice(cardIndex, 1);
  log(s, `${p.name} discards a card.`);
  const eliminated = eliminateIfEmpty(s, player);
  s.lastResult = { ...s.lastResult, discarded, eliminated };
  if (eliminated) {
    if (checkLastStanding(s)) return;
    s.phase = 'choose-first';
    s.currentPlayer = player;
    return;
  }
  s.phase = 'round-over';
  s.firstPlayer = player;
  s.currentPlayer = player;
}

function doChooseFirst(s, { player, target }) {
  log(s, `${name(s, player)} chooses ${name(s, target)} to start the next round.`);
  s.phase = 'round-over';
  s.firstPlayer = target;
  s.currentPlayer = target;
}

function endGame(s, winner) {
  s.phase = 'game-over';
  s.winner = winner;
  s.currentPlayer = winner;
  log(s, `${name(s, winner)} wins the game!`);
}

// Multiplayer: a player who left or abandoned is eliminated between rounds
// (MULTIPLAYER_SPEC §8). Not part of legalActions; only the server applies it.
function doForfeit(state, { player }) {
  if (state.phase !== 'round-over') throw new Error(`Illegal action forfeit in phase ${state.phase}`);
  const p = state.players[player];
  if (!p || p.eliminated) throw new Error(`Illegal action forfeit for player ${player}`);
  const s = clone(state);
  const f = s.players[player];
  f.eliminated = true;
  f.hand = [];
  // Its mat would come back to hand at nextRound, so it goes too.
  f.mat = [];
  f.revealed = 0;
  log(s, `${f.name} forfeits.`);
  if (checkLastStanding(s)) return s;
  if (s.firstPlayer === player) {
    s.firstPlayer = nextActive(s, player);
    s.currentPlayer = s.firstPlayer;
  }
  return s;
}

function doNextRound(s) {
  for (const p of s.players) {
    p.hand.push(...p.mat);
    p.mat = [];
    p.revealed = 0;
    p.passed = false;
  }
  s.bid = null;
  s.challenger = null;
  s.revealedCount = 0;
  s.revealedSkullOwner = null;
  s.lastResult = null;
  s.round++;
  s.phase = 'place-initial';
  s.currentPlayer = s.firstPlayer;
  log(s, `Round ${s.round} begins. ${name(s, s.firstPlayer)} starts.`);
}
