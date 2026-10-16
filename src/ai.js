// Bot decision logic for Skull & Roses. No DOM.
// Decisions are made from a sanitized "view" of the state containing only what
// the bot legitimately knows: its own hand and mat, plus public information.

import { ROSE, SKULL, legalActions } from './engine.js';

// Deterministic personality per seat: risk tolerance in [0.55, 0.9], bluff rate in [0.1, 0.45].
function personality(playerId) {
  let h = (playerId + 1) * 2654435761;
  h = (h ^ (h >>> 16)) >>> 0;
  const a = (h % 1000) / 1000;
  const b = ((h >>> 10) % 1000) / 1000;
  return { risk: 0.55 + 0.35 * a, bluff: 0.1 + 0.35 * b };
}

// Build the information-legal view of the game for player `me`.
function buildView(state, me) {
  const players = state.players.map((p) => {
    const revealedCards = p.revealed > 0 ? p.mat.slice(p.mat.length - p.revealed) : [];
    const base = {
      id: p.id,
      eliminated: p.eliminated,
      passed: p.passed,
      wins: p.wins,
      matSize: p.mat.length,
      handSize: p.hand.length,
      revealed: p.revealed,
      revealedCards,
      owned: p.mat.length + p.hand.length,
    };
    if (p.id === me) {
      base.hand = p.hand.slice();
      base.mat = p.mat.slice();
    }
    return base;
  });
  const lr = state.lastResult;
  let lastResult = null;
  if (lr) {
    lastResult = { type: lr.type, challenger: lr.challenger, skullOwner: lr.skullOwner, eliminated: lr.eliminated };
    if (lr.challenger === me) lastResult.discarded = lr.discarded;
  }
  return {
    me,
    phase: state.phase,
    players,
    self: players[me],
    bid: state.bid ? { ...state.bid } : null,
    challenger: state.challenger,
    revealedCount: state.revealedCount,
    total: players.reduce((s, p) => s + p.matSize, 0),
    lastResult,
  };
}

const key = (a) => JSON.stringify(a);

function pickFrom(legal, wanted, rng) {
  if (wanted) {
    const k = key(wanted);
    const hit = legal.find((a) => key(a) === k);
    if (hit) return hit;
  }
  return legal[Math.floor(rng() * legal.length)];
}

// Estimate how many roses this bot can probably flip, from own mat plus opponents' tops.
function estimateSafe(view, pers) {
  const me = view.self;
  if (me.mat.includes(SKULL)) return 0;
  let est = me.mat.length;
  for (const p of view.players) {
    if (p.id === view.me || p.eliminated || p.matSize === 0) continue;
    const unrevealed = p.matSize - p.revealed;
    if (unrevealed <= 0) continue;
    // Chance the opponent's skull is on their mat at all (they may not even own one).
    const pSkullOnMat = Math.min(0.9, (p.matSize / Math.max(1, p.owned)) * 0.85);
    // Bidders tend to hold roses.
    const bidder = view.bid && view.bid.player === p.id;
    let perOpp = unrevealed * (1 - pSkullOnMat) + (pSkullOnMat > 0 ? Math.min(unrevealed - 1, 1) * 0.35 : 0);
    if (bidder) perOpp += 0.5;
    est += Math.max(0, Math.min(unrevealed, perOpp)) * (0.5 + pers.risk * 0.6);
  }
  return est;
}

function bidActions(legal) {
  return legal.filter((a) => a.type === 'bid').sort((x, y) => x.amount - y.amount);
}

function chooseBidAmount(bids, target, rng) {
  if (bids.length === 0) return null;
  const ok = bids.filter((b) => b.amount <= target);
  if (ok.length === 0) return null;
  // Mostly bid the minimum acceptable; occasionally jump higher.
  if (rng() < 0.25 && ok.length > 1) return ok[Math.min(ok.length - 1, 1 + Math.floor(rng() * 2))];
  return ok[0];
}

function decidePlaceInitial(view, legal, pers, rng) {
  const hasSkull = view.self.hand.includes(SKULL);
  const roses = view.self.hand.filter((c) => c === ROSE).length;
  const pSkull = roses === 0 ? 1 : pers.bluff * 0.8;
  const card = hasSkull && rng() < pSkull ? SKULL : ROSE;
  return { type: 'placeInitial', player: view.me, card };
}

function decidePlacement(view, legal, pers, rng) {
  const me = view.self;
  const places = legal.filter((a) => a.type === 'place');
  const bids = bidActions(legal);
  const mySkullDown = me.mat.includes(SKULL);
  const opponents = view.players.filter((p) => p.id !== view.me && !p.eliminated);

  if (places.length === 0) {
    // Must bid. Bid low; if holding a skull on our mat, hope to be outbid.
    const safe = estimateSafe(view, pers);
    return chooseBidAmount(bids, Math.max(1, Math.floor(safe)), rng) || bids[0];
  }

  // Consider starting a bid.
  const safe = estimateSafe(view, pers);
  const placementDepth = view.total / Math.max(1, opponents.length + 1);
  let pBid = 0;
  if (!mySkullDown) {
    pBid = 0.15 + 0.25 * pers.risk + 0.2 * Math.max(0, placementDepth - 1);
    if (safe < 1) pBid = 0;
  } else {
    // Bluff bid with a skull down, hoping someone raises into our skull.
    pBid = pers.bluff * 0.5 * Math.min(1, placementDepth / 2);
  }
  if (bids.length && rng() < pBid) {
    const target = mySkullDown ? 1 + Math.floor(rng() * 2) : Math.max(1, Math.floor(safe));
    const b = chooseBidAmount(bids, target, rng);
    if (b) return b;
  }

  // Place a card.
  const hasSkull = me.hand.includes(SKULL);
  const hasRose = me.hand.includes(ROSE);
  let card = ROSE;
  if (hasSkull && !mySkullDown && (!hasRose || rng() < pers.bluff)) card = SKULL;
  if (!hasRose) card = SKULL;
  return { type: 'place', player: view.me, card };
}

function decideBidding(view, legal, pers, rng) {
  const bids = bidActions(legal);
  const pass = legal.find((a) => a.type === 'pass');
  if (bids.length === 0) return pass;
  const me = view.self;
  if (me.mat.includes(SKULL)) {
    // Raising makes us challenger with our own skull exposed; only bluff very low bids.
    if (pass && rng() < pers.bluff * 0.3 && view.bid && view.bid.amount + 1 < view.total) return bids[0];
    return pass || bids[0];
  }
  const safe = estimateSafe(view, pers);
  const fudge = (rng() - 0.5) * 0.8;
  const b = chooseBidAmount(bids, Math.floor(safe + fudge), rng);
  if (b) return b;
  return pass || bids[0];
}

function decideReveal(view, legal, pers, rng) {
  const reveals = legal.filter((a) => a.type === 'reveal');
  const own = reveals.find((a) => a.target === view.me);
  if (own) return own;
  if (reveals.length === 0) return null;
  const need = view.bid ? view.bid.amount - view.revealedCount : 1;
  let best = null;
  let bestScore = -Infinity;
  for (const a of reveals) {
    const p = view.players[a.target];
    const unrevealed = p.matSize - p.revealed;
    // Stacks already showing roses: owner's skull (if on mat) is deeper; small stacks often
    // just hold the opening card, which bots/humans tend to play as rose.
    let score = 0;
    score -= (p.matSize / Math.max(1, p.owned)) * 2; // committed more cards -> more likely skull among them
    if (p.revealed > 0) score += 0.6;
    if (unrevealed >= need) score += 0.3; // can finish here
    if (p.handSize === 0) score -= 0.8; // played everything, including any skull
    if (view.bid && view.bid.player === p.id) score += 0.5;
    score += rng() * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function decideDiscard(view, legal, pers, rng) {
  const hand = view.self.hand;
  const discards = legal.filter((a) => a.type === 'discard');
  const roseIdx = discards.filter((a) => hand[a.cardIndex] === ROSE);
  const skullIdx = discards.filter((a) => hand[a.cardIndex] === SKULL);
  // Usually keep the skull — it's the only defensive card.
  if (roseIdx.length && (skullIdx.length === 0 || rng() < 0.85)) return roseIdx[0];
  return skullIdx[0] || discards[0];
}

function decideChooseFirst(view, legal, pers, rng) {
  return legal[Math.floor(rng() * legal.length)];
}

export function chooseAction(state, playerId, rng = Math.random) {
  const legal = legalActions(state, playerId);
  if (legal.length === 0) {
    if (state.phase === 'round-over') return { type: 'nextRound' };
    return null;
  }
  if (legal.length === 1) return legal[0];
  const view = buildView(state, playerId);
  const pers = personality(playerId);
  let wanted = null;
  switch (view.phase) {
    case 'place-initial': wanted = decidePlaceInitial(view, legal, pers, rng); break;
    case 'placement': wanted = decidePlacement(view, legal, pers, rng); break;
    case 'bidding': wanted = decideBidding(view, legal, pers, rng); break;
    case 'reveal': wanted = decideReveal(view, legal, pers, rng); break;
    case 'discard': wanted = decideDiscard(view, legal, pers, rng); break;
    case 'choose-first': wanted = decideChooseFirst(view, legal, pers, rng); break;
    default: wanted = legal[0];
  }
  return pickFrom(legal, wanted, rng);
}
