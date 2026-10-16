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

// How long a bot move's animation (and banner) gets before Bones talks about it.
const settleMs = a => (a.type === 'reveal' ? 1100 : a.type === 'bid' || a.type === 'pass' ? 950 : 750);

export function createTutorialDirector({ script = TUTORIAL_SCRIPT, settle = settleMs } = {}) {
  let ctl = null;
  let i = -1;            // index of the current step
  let pending = [];      // bot actions of the current bots step not yet applied
  let alive = true;
  let gameOver = false;
  let draws = 0;
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
      // Step by step: the bot moves with the table in plain view, the animation
      // settles, then Bones explains it and waits for Next (see narrate()).
      pending = s.bots.slice();
      coach?.hide({ block: true });
      ctl.resume();
    } else if (s.hold) {
      coach?.hide({ block: true });
      if (gameOver || holdDone) advance();
    } else if (s.nextRound) {
      coach?.hide();
      ctl.resume();
    } else if (s.finale) {
      ctl.setXray(false);
      Promise.resolve(coach?.say({ text: s.say, mood: s.mood, buttons: s.buttons, block: true })).then(v => {
        if (!alive) return;
        markDone();
        if (v === 'replay') ctl.startTutorial();
        else ctl.startSolo({ tips: true });
      });
    } else {
      ctl.setXray(!!s.xray);
      Promise.resolve(coach?.say({ text: s.say, mood: s.mood, target: s.target ?? null, next: true, block: true })).then(() => {
        if (alive && step() === s) advance();
      });
    }
  }

  // All of this step's bot moves are on the table: let them settle, then talk.
  function narrate(s, last) {
    if (!s.say) { advance(); return; }
    setTimeout(() => {
      if (!alive || step() !== s) return;
      Promise.resolve(ctl.coach?.say({ text: s.say, mood: s.mood, target: s.target ?? null, next: true, block: true })).then(() => {
        if (alive && step() === s) advance();
      });
    }, settle(last));
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
    // A short beat before each scripted bot move, so the player sees who acts.
    botDelay(state) {
      return state.phase === 'reveal' ? 800 : 650;
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

    // Bots only run while the current step still has scripted moves left. Once
    // they're done (and Bones is talking about them), the table waits for Next:
    // nothing ever falls through to the regular AI.
    canProceed() {
      const s = step();
      return !!s && ((!!s.bots && pending.length > 0) || !!s.nextRound);
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
        if (k < 0) return;
        pending.splice(k, 1);
        if (!pending.length) narrate(s, action);
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
