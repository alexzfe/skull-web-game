// Game controller: owns the current state, routes human actions to the engine,
// paces the bots, and turns state transitions into announcements. Every game runs
// through an optional *director* (tutorial, first-game tips) — see TUTORIAL_SPEC §2.
import { ROSE, SKULL, createGame, applyAction, legalActions, possessive } from './engine.js';
import { chooseAction } from './ai.js';
import { createUI } from './ui.js';
import { createCoach } from './coach.js';

const HUMAN = 0;
const BOT_NAMES = ['Panthers', 'Snakes', 'Werewolves', 'Eagles', 'Himself', 'Vipers', 'Ravens', 'Jackals', 'Hellhounds', 'Coyotes', 'Iron Mules', 'Night Owls'];
const REVEAL_HOLD_MS = 2000;
const AUTO_NEXT_ROUND_MS = 2500;
const DEFAULT_SETTINGS = { name: 'Rider', opponents: 3 };

// The tutor's modules load lazily, so the table still works if they're missing.
const optional = path => import(path).catch(() => null);
const tipsModule = optional('./tips.js');
const tutorialModule = optional('./tutorial.js');

let state = null;
let botTimer = null;
let holdTimer = null;
let gameToken = 0;
let launchToken = 0;
let ghost = null;   // challenger's last board, shown after the engine returns their cards
let director = null;
let ctl = null;
let xray = false;
let autoNextAt = null;
let gameOverShown = false;
let gameOverUI = null;   // null until decided, then 'default' | 'director'
let shown = null;   // { state, locked } as last rendered

const coach = createCoach();

const ui = createUI({
  onPlayNow(cfg) { saveSettings(cfg); playNow(); },
  onLearn(cfg) { if (cfg) saveSettings(cfg); startTutorial(); },
  onSettings: saveSettings,
  onAction: humanAction,
  onNextRound,
  onPlayAgain() { playNow(); },
  onNewGame: toSetup,
});

// ---------- settings ----------

function loadSettings() {
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem('skull.settings'));
    if (!s) {
      // carry over the pre-quick-start keys
      const name = localStorage.getItem('skull.name');
      const opponents = Number(localStorage.getItem('skull.opponents'));
      if (name || opponents) s = { name: name || '', opponents };
    }
  } catch { /* storage unavailable or corrupt */ }
  const opponents = Number(s?.opponents);
  return {
    name: typeof s?.name === 'string' ? s.name.trim().slice(0, 16) : DEFAULT_SETTINGS.name,
    opponents: opponents >= 2 && opponents <= 5 ? opponents : DEFAULT_SETTINGS.opponents,
  };
}

function saveSettings(cfg) {
  const s = { ...loadSettings(), ...cfg };
  try { localStorage.setItem('skull.settings', JSON.stringify({ name: s.name, opponents: s.opponents })); } catch { /* ignore */ }
}

// ---------- entry points ----------

function safe(fn, fallback) {
  try { return fn(); } catch (err) { console.error(err); return fallback; }
}

async function playNow() {
  const m = await tipsModule;
  startSolo({ tips: !!(m?.tipsEnabled && safe(() => m.tipsEnabled(), false)) });
}

async function startSolo({ tips = false } = {}) {
  const token = ++launchToken;
  const m = tips ? await tipsModule : null;
  if (token !== launchToken) return;
  const d = m?.createTipsDirector ? safe(() => m.createTipsDirector(), null) : null;
  startGame(d);
}

async function startTutorial() {
  const token = ++launchToken;
  const m = await tutorialModule;
  if (token !== launchToken) return;
  const d = m?.createTutorialDirector ? safe(() => m.createTutorialDirector(), null) : null;
  if (!d) {
    startSolo({ tips: false });
    ui.toast('The tutorial isn’t ready yet — dealing a real game.');
    return;
  }
  startGame(d);
}

function toSetup() {
  launchToken++;
  leaveDirector();
  stopTimers();
  state = null;
  ui.showSetup(loadSettings());
}

// ---------- director plumbing ----------

function hook(name, ...args) {
  const fn = director?.[name];
  if (typeof fn !== 'function') return undefined;
  try { return fn.apply(director, args); } catch (err) { console.error(`director.${name} failed`, err); return undefined; }
}

const proceed = () => hook('canProceed') !== false;

function leaveDirector() {
  const d = director;
  director = null;
  ctl = null;
  xray = false;
  coach.hide();
  coach.onSkip(null);
  if (d && typeof d.exit === 'function') { try { d.exit(); } catch (err) { console.error('director.exit failed', err); } }
}

function makeCtl() {
  const token = gameToken;
  const live = () => token === gameToken;
  return {
    getState: () => state,
    resume() { if (live()) schedule(); },
    setXray(on) { if (live()) { xray = !!on; rerender(); } },
    coach,
    humanId: HUMAN,
    toSetup,
    startSolo,
    startTutorial,
  };
}

// ---------- game loop ----------

const rand = (a, b) => a + Math.random() * (b - a);
const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const sameAction = (a, b) => {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
};

function stopTimers() {
  clearTimeout(botTimer); clearTimeout(holdTimer);
  botTimer = holdTimer = null;
  autoNextAt = null;
  gameToken++;
}

function startGame(d = null) {
  leaveDirector();
  stopTimers();
  director = d;
  ctl = makeCtl();
  gameOverShown = false;
  gameOverUI = null;

  const custom = hook('setup');
  let players, firstPlayer;
  if (custom?.players?.length) {
    players = custom.players;
    firstPlayer = Number.isInteger(custom.firstPlayer) ? custom.firstPlayer : 0;
  } else {
    const s = loadSettings();
    const bots = shuffle(BOT_NAMES).slice(0, s.opponents);
    players = [{ name: s.name || DEFAULT_SETTINGS.name, isHuman: true }, ...bots.map(name => ({ name, isHuman: false }))];
    firstPlayer = Math.floor(Math.random() * players.length);
  }
  state = createGame({ players, firstPlayer, rng: director?.rng });
  ghost = null;
  ui.reset();
  ui.setFastBanners(!!custom?.players?.length);   // scripted tables move faster than the banner queue
  ui.showGame();
  render();
  const first = state.players[state.firstPlayer];
  ui.banner('Round 1', { sub: `${first.id === HUMAN ? 'You start' : first.name + ' starts'} · lay down a card` });
  hook('onStart', ctl);
  schedule();
}

function render(shownState = state, locked = !!holdTimer) {
  shown = { state: shownState, locked };
  ui.render(shownState, {
    humanId: HUMAN, locked, ghost, xray,
    // a director with onGameOver may own the ending: keep the default controls back until it declines
    gameOverControls: gameOverUI === 'default' || (gameOverUI == null && typeof director?.onGameOver !== 'function'),
    autoNextMs: autoNextAt != null && shownState === state ? Math.max(0, autoNextAt - Date.now()) : null,
  });
}

function rerender() {
  if (state && shown) render(shown.state, shown.locked);
}

function humanAction(action) {
  if (!state || holdTimer) return;
  if (!legalActions(state, HUMAN).some(a => sameAction(a, action))) return;
  if (hook('allowHuman', state, action) === false) return;
  perform(action);
}

function onNextRound() {
  if (state?.phase !== 'round-over' || holdTimer) return;
  if (hook('allowHuman', state, { type: 'nextRound' }) === false) return;
  clearTimeout(botTimer);
  botTimer = null;
  autoNextAt = null;
  perform({ type: 'nextRound' });
}

function perform(action) {
  const prev = state;
  let next;
  try {
    next = applyAction(prev, action, director?.rng);
  } catch (err) {
    console.error('Illegal action', action, err);
    ui.toast(err.message, 'bad');
    return false;
  }
  state = next;
  autoNextAt = null;
  if (next.phase === 'place-initial') ghost = null;
  announce(prev, next, action);

  if (prev.phase === 'reveal' && next.phase !== 'reveal') {
    // Hold the final flip on screen before the engine's post-reveal board
    // (the challenger's cards may already be back in hand).
    const frozen = structuredClone(prev);
    frozen.players[action.target].revealed += 1;
    frozen.revealedCount += 1;
    const c = frozen.players[frozen.challenger];
    ghost = { player: c.id, mat: c.mat, revealed: c.revealed };
    const token = gameToken;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (token !== gameToken) return;
      render();
      hook('onState', state, state, null, ctl);
      if (token === gameToken) schedule();
    }, REVEAL_HOLD_MS);
    render(frozen, true);
    hook('onState', prev, next, action, ctl);
    return true;
  }
  const token = gameToken;
  render();
  hook('onState', prev, next, action, ctl);
  if (token === gameToken) schedule();
  return true;
}

function schedule() {
  if (!state || botTimer || holdTimer) return;
  const token = gameToken;
  const later = (ms, fn) => { botTimer = setTimeout(() => { botTimer = null; if (token === gameToken) fn(); }, ms); };

  if (state.phase === 'game-over') {
    if (gameOverShown) return;
    gameOverShown = true;
    later(900, () => {
      const handled = hook('onGameOver', state, ctl) === true;
      gameOverUI = handled ? 'director' : 'default';
      if (handled) return;
      rerender();
      ui.showGameOver(state, HUMAN);
    });
    return;
  }
  if (!proceed()) return;
  if (state.phase === 'round-over') {
    const ms = Number.isFinite(director?.autoNextRoundMs) ? director.autoNextRoundMs : AUTO_NEXT_ROUND_MS;
    autoNextAt = Date.now() + ms;
    later(ms, () => {
      autoNextAt = null;
      if (state.phase === 'round-over' && proceed()) perform({ type: 'nextRound' });
    });
    rerender();
    return;
  }
  const bot = botToAct();
  if (bot == null) return;
  const custom = hook('botDelay', state, bot);
  const delay = Number.isFinite(custom) ? custom
    : state.phase === 'place-initial' ? rand(350, 700)
    : state.phase === 'reveal' ? rand(750, 1000)
    : rand(700, 1200);
  later(delay, () => runBot(bot));
}

function botToAct() {
  const canAct = id => !state.players[id].isHuman && legalActions(state, id).length > 0;
  if (state.phase !== 'place-initial' && state.currentPlayer != null && canAct(state.currentPlayer)) return state.currentPlayer;
  const p = state.players.find(x => canAct(x.id));
  return p ? p.id : null;
}

function runBot(id) {
  if (!proceed()) return;   // the director paused us mid-delay; it will ctl.resume()
  const legal = legalActions(state, id);
  if (!legal.length) { schedule(); return; }
  let action = hook('botAction', state, id) ?? null;
  if (action && !legal.some(a => sameAction(a, action))) {
    console.error('Director bot action is illegal, using the AI instead', action);
    action = null;
  }
  if (!action) {
    try { action = chooseAction(state, id); } catch (err) { console.error('AI error', err); }
    if (!action || !legal.some(a => sameAction(a, action))) {
      console.warn('AI returned illegal action, falling back', action);
      action = legal[0];
    }
  }
  if (!perform(action)) { perform(legal[0]); }
}

// ---------- announcements ----------

function announce(prev, next, action) {
  const who = id => (id === HUMAN ? 'You' : prev.players[id].name);
  const verb = (id, s, p) => (id === HUMAN ? p : s);
  const pl = action.player;

  switch (action.type) {
    case 'place':
      if (pl !== HUMAN) ui.toast(`${who(pl)} stacks another card`);
      break;
    case 'bid':
      if (prev.phase === 'placement') ui.banner(`${who(pl)} ${verb(pl, 'opens', 'open')} at ${action.amount}`, { kind: 'bid', sub: 'The challenge is on' });
      else ui.banner(`${who(pl)} ${verb(pl, 'raises', 'raise')} to ${action.amount}`, { kind: 'bid', ms: 1100 });
      break;
    case 'pass':
      ui.toast(`${who(pl)} ${verb(pl, 'passes', 'pass')}`);
      break;
    case 'reveal': {
      const t = prev.players[action.target];
      const card = t.mat[t.mat.length - 1 - t.revealed];
      const count = prev.revealedCount + 1;
      if (card === SKULL) {
        const owner = action.target === pl ? (pl === HUMAN ? 'your own' : 'their own') : action.target === HUMAN ? 'your' : possessive(t.name);
        ui.banner('SKULL!', { kind: 'skull', art: SKULL, sub: `${who(pl)} hit ${owner} skull — challenge lost`, ms: 2000 });
      } else if (next.phase !== 'reveal' && next.lastResult?.type === 'won') {
        ui.banner(`${who(pl)} ${verb(pl, 'wins', 'win')} the challenge!`, { kind: 'rose', art: ROSE, sub: `${count} roses flipped`, ms: 2000 });
      } else {
        ui.toast(`Rose ${count}/${prev.bid.amount}`, 'good');
      }
      break;
    }
    case 'discard':
      if (pl !== HUMAN) ui.toast(`${who(pl)} throws away a card`);
      break;
    case 'chooseFirst':
      ui.toast(`${who(pl)} ${verb(pl, 'picks', 'pick')} ${action.target === HUMAN ? 'you' : prev.players[action.target].name} to start`);
      break;
    case 'nextRound': {
      const f = next.players[next.firstPlayer];
      ui.banner(`Round ${next.round}`, { sub: `${f.id === HUMAN ? 'You start' : f.name + ' starts'} · lay down a card` });
      break;
    }
  }

  if (prev.phase !== 'reveal' && next.phase === 'reveal') {
    const c = next.challenger;
    ui.banner(`${who(c)} must flip ${next.bid.amount}`, { kind: 'bid', sub: c === HUMAN ? 'Your own stack first' : 'Own stack first', ms: 1600 });
  }

  // Lost card: only the challenger learns which card it was.
  const r = next.lastResult;
  if (r && r.type === 'lost' && JSON.stringify(r) !== JSON.stringify(prev.lastResult) && r.discarded) {
    if (r.challenger === HUMAN) ui.toast(`You lost a ${r.discarded}`, r.discarded === SKULL ? 'bad' : '');
    else if (r.skullOwner !== r.challenger) ui.toast(`${who(r.challenger)} loses a card at random`);
  }

  next.players.forEach(p => {
    if (p.eliminated && !prev.players[p.id].eliminated) {
      ui.banner(p.id === HUMAN ? 'You’re out!' : `${p.name} is out!`, { kind: 'skull', sub: 'No cards left', ms: 1700 });
    }
  });

  if (next.phase === 'game-over' && prev.phase !== 'game-over') {
    ui.banner(next.winner === HUMAN ? 'You win the game!' : `${next.players[next.winner].name} wins the game!`, { kind: 'win', ms: 2200 });
  }
}

ui.showSetup(loadSettings());
