// First-game tips: Bones drops non-blocking one-time hints during a real game.
// Trigger logic is pure (prev, next) → tip ids, so it's testable without a DOM.
import { legalActions, totalOnMats } from './engine.js';

export const TIPS_OFF_KEY = 'skull.tipsOff';
export const TIPS_SEEN_KEY = 'skull.tipsSeen';
export const TIPS_GAMES_KEY = 'skull.tipsGames';
const GAMES_WITH_TIPS = 1;

function get(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function set(k, v) {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}

export function tipsEnabled() {
  return get(TIPS_OFF_KEY) !== '1' && (Number(get(TIPS_GAMES_KEY)) || 0) < GAMES_WITH_TIPS;
}

export function seenTips() {
  try { return new Set(JSON.parse(get(TIPS_SEEN_KEY) || '[]')); } catch { return new Set(); }
}
function markSeen(id) {
  const s = seenTips();
  s.add(id);
  set(TIPS_SEEN_KEY, JSON.stringify([...s]));
}

// ---------- triggers (pure) ----------

const owned = p => p.hand.length + p.mat.length;
const nameOf = (s, id, humanId) => (id === humanId ? 'you' : s.players[id].name);

export const TIP_TRIGGERS = {
  // Human's turn and bidding the whole table is on the menu.
  'max-bid'(prev, next, humanId) {
    if (!['placement', 'bidding'].includes(next.phase) || next.currentPlayer !== humanId) return null;
    const max = totalOnMats(next);
    if (!legalActions(next, humanId).some(a => a.type === 'bid' && a.amount === max)) return null;
    return { text: `Bid all <b>${max}</b> and bidding ends on the spot — nobody can top you. Better be sure, kid.` };
  },

  'lost-bet'(prev, next, humanId) {
    const r = next.lastResult;
    if (prev?.phase !== 'reveal' || r?.type !== 'lost' || r.challenger !== humanId) return null;
    return r.skullOwner === humanId
      ? { text: 'Your own Skull bit you. You pick which card to toss — for good.', mood: 'wince' }
      : { text: `${next.players[r.skullOwner].name} had the Skull. They take one of your cards blind — gone for good.`, mood: 'wince' };
  },

  elimination(prev, next, humanId) {
    if (!prev) return null;
    const out = next.players.find(p => p.eliminated && !prev.players[p.id].eliminated);
    if (!out) return null;
    const me = out.id === humanId;
    const ownSkull = next.lastResult?.skullOwner === out.id;
    const head = me ? "You're out of cards — out of the game." : `${nameOf(next, out.id, humanId)} is out of cards — and out.`;
    const tail = !ownSkull ? 'Whoever owned that Skull starts next.'
      : me ? 'Your own Skull did it, so you pick who starts.'
      : 'Their own Skull did it, so they pick who starts.';
    return { text: `${head} ${tail}`, mood: me ? 'wince' : 'grin' };
  },

  'last-card'(prev, next, humanId) {
    const p = next.players[humanId], q = prev?.players[humanId];
    if (!q || p.eliminated || owned(p) !== 1 || owned(q) <= 1) return null;
    return { text: "One card left, kid. Once it's down you're <b>stoned</b> — you must bid on your turn.", mood: 'wince' };
  },

  'first-player'(prev, next, humanId) {
    if (next.phase !== 'place-initial' || next.firstPlayer !== humanId) return null;
    if (prev && prev.phase === 'place-initial' && prev.round === next.round) return null;
    return { text: "You go first. That's an edge — you set the pace." };
  },
};

// Tip ids (in priority order) that fire for this transition, ignoring seen state.
export function triggeredTips(prev, next, humanId = 0) {
  const out = [];
  for (const [id, fn] of Object.entries(TIP_TRIGGERS)) {
    const t = fn(prev, next, humanId);
    if (t) out.push({ id, ...t });
  }
  return out;
}

// ---------- director ----------

export function createTipsDirector() {
  let ctl = null;
  let alive = true;
  let showing = false;
  const queue = [];
  const queued = new Set();

  function consider(prev, next) {
    if (!alive || get(TIPS_OFF_KEY) === '1') return;
    const seen = seenTips();
    for (const t of triggeredTips(prev, next, ctl?.humanId ?? 0)) {
      if (seen.has(t.id) || queued.has(t.id)) continue;
      queued.add(t.id);
      queue.push(t);
    }
    pump();
  }

  function pump() {
    if (showing || !queue.length || !alive || !ctl?.coach) return;
    const t = queue.shift();
    markSeen(t.id);
    showing = true;
    Promise.resolve(ctl.coach.say({
      text: t.text,
      mood: t.mood ?? 'neutral',
      mode: 'tip',
      ms: 6000,
    })).then(() => {
      // The coach's own "Don't show tips" link sets TIPS_OFF_KEY.
      showing = false;
      if (get(TIPS_OFF_KEY) === '1') { queue.length = 0; return; }
      pump();
    }, () => { showing = false; });
  }

  return {
    onStart(c) {
      ctl = c;
      consider(null, ctl.getState());
    },
    onState(prev, next, action) {
      if (action) consider(prev, next);
    },
    onGameOver() {
      set(TIPS_GAMES_KEY, String((Number(get(TIPS_GAMES_KEY)) || 0) + 1));
      return false;
    },
    exit() {
      alive = false;
      queue.length = 0;
      ctl?.coach?.hide();
    },
  };
}
