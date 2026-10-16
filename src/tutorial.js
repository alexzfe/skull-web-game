// Tutorial director: replays TUTORIAL_SCRIPT through main.js's director hooks
// (TUTORIAL_SPEC.md §2). No DOM access — everything visual goes through ctl.coach.
import {
  TUTORIAL_PLAYERS, TUTORIAL_FIRST_PLAYER, TUTORIAL_SCRIPT, TUTORIAL_RNG_SEQUENCE,
} from './tutorial-script.js';

export const TUTORIAL_DONE_KEY = 'skull.tutorialDone';

const ACTION_KEYS = ['type', 'player', 'card', 'amount', 'target', 'cardIndex'];
export const sameAction = (a, b) => !!a && !!b && ACTION_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));

// The human's remembered table name (TUTORIAL_SPEC §1), if any.
function rememberedName() {
  try {
    const n = JSON.parse(localStorage.getItem('skull.settings'))?.name;
    return typeof n === 'string' && n.trim() ? n.trim().slice(0, 16) : null;
  } catch { return null; }
}

function markDone() {
  try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch { /* storage unavailable */ }
}

export function createTutorialDirector({ script = TUTORIAL_SCRIPT } = {}) {
  let ctl = null;
  let i = -1;            // index of the current step
  let pending = [];      // bot actions of the current bots step not yet applied
  let alive = true;
  let gameOver = false;
  let draws = 0;
  let acked = true;      // narrated bots step: has the player clicked Next yet?
  let holdDone = false;  // the last reveal hold has finished (it can end mid-bubble)

  const step = () => script[i];

  function begin(k) {
    if (!alive) return;
    i = k;
    const s = step();
    if (!s) return;
    const coach = ctl.coach;
    if (s.do) {
      coach?.say({ text: s.say, mood: s.mood, target: s.target, lock: true });
    } else if (s.bots) {
      pending = s.bots.slice();
      acked = !s.say;
      // Narrated bot moves play out behind the bubble; the script only moves on
      // once the player has read the line and clicked Next.
      if (s.say) {
        Promise.resolve(coach?.say({ text: s.say, mood: s.mood, target: s.target ?? null, next: true })).then(() => {
          if (!alive || step() !== s) return;
          acked = true;
          if (!pending.length) advance();
        });
      } else {
        coach?.hide();   // let the table be watched, undimmed, while the bots move
      }
      ctl.resume();
    } else if (s.hold) {
      coach?.hide();
      if (gameOver || holdDone) advance();
    } else if (s.nextRound) {
      coach?.hide();
      ctl.resume();
    } else if (s.finale) {
      ctl.setXray(false);
      Promise.resolve(coach?.say({ text: s.say, mood: s.mood, buttons: s.buttons })).then(v => {
        if (!alive) return;
        markDone();
        if (v === 'replay') ctl.startTutorial();
        else ctl.startSolo({ tips: true });
      });
    } else {
      ctl.setXray(!!s.xray);
      Promise.resolve(coach?.say({ text: s.say, mood: s.mood, target: s.target ?? null, next: true })).then(() => {
        if (alive && step() === s) advance();
      });
    }
  }

  function advance() {
    const s = step();
    if (s && s.xray && !script[i + 1]?.xray) ctl.setXray(false);
    begin(i + 1);
  }

  return {
    setup() {
      const players = TUTORIAL_PLAYERS.map(p => ({ ...p }));
      const name = rememberedName();
      if (name) players[0].name = name;
      return { players, firstPlayer: TUTORIAL_FIRST_PLAYER };
    },

    // Deterministic draws for the engine (Panthers' random card loss).
    rng: () => TUTORIAL_RNG_SEQUENCE[draws++ % TUTORIAL_RNG_SEQUENCE.length],

    autoNextRoundMs: 600,
    // Bots move at a followable pace; narrated lines are Next-gated, so their
    // pace no longer decides how long a line stays readable.
    botDelay(state) {
      return state.phase === 'reveal' ? 1100 : 850;
    },

    botAction(state, id) {
      const s = step();
      if (!s?.bots) return null;
      return pending.find(a => a.player === id) ?? null;
    },

    allowHuman(state, action) {
      const s = step();
      if (!s) return false;
      if (action?.type === 'nextRound') return !!s.nextRound;
      return !!s.do && sameAction(s.do, action);
    },

    canProceed() {
      const s = step();
      return !!s && (!!s.bots || !!s.nextRound);
    },

    onStart(c) {
      ctl = c;
      ctl.coach?.onSkip?.(() => {
        if (!alive) return;
        markDone();
        ctl.toSetup();
      });
      begin(0);
    },

    onState(prev, next, action) {
      if (!alive) return;
      const s = step();
      if (!s) return;
      if (!action) {
        holdDone = true;
        if (s.hold) advance();
        return;
      }
      holdDone = false;
      if (s.do && sameAction(s.do, action)) {
        advance();
      } else if (s.bots) {
        const k = pending.findIndex(a => sameAction(a, action));
        if (k >= 0) pending.splice(k, 1);
        if (!pending.length && acked) advance();
      } else if (s.nextRound && action.type === 'nextRound') {
        advance();
      }
    },

    onGameOver() {
      gameOver = true;
      if (alive && step()?.hold) advance();
      return true;
    },

    exit() {
      alive = false;
      ctl?.setXray?.(false);
      ctl?.coach?.hide();
    },
  };
}
