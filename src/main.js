// The shell: home, lobby and table screens, and the game *controllers* behind the
// table (MULTIPLAYER_SPEC §3). A controller has one interface — onView(cb),
// send(action), leave() — and the table only ever renders views:
// - local: the engine runs in the browser (solo + tutorial). It owns the state,
//   paces the bots, and runs every game through an optional *director* (tutorial,
//   first-game tips) — see TUTORIAL_SPEC §2. Fully offline.
// - remote (src/net.js): a WebSocket to a multiplayer room; the server owns the game.
import { ROSE, SKULL, createGame, applyAction, legalActions } from './engine.js';
import { chooseAction } from './ai.js';
import { viewFor } from './view.js';
import { createUI } from './ui.js';
import { createCoach } from './coach.js';
import { announce } from './announce.js';
import { createHome } from './home.js';
import { createLobbyUI } from './lobby-ui.js';
import { createRemoteController, createRoom, listLobbies, getToken, shareLink, parseShareHash } from './net.js';
import { parseSettings, parseHostOptions, avatarTag, findMe, seatClocks, NUDGE_MS } from './shell-core.js';
import { soundOn, setSound, tick, unlock } from './sound.js';

const HUMAN = 0;
const BOT_NAMES = ['Panthers', 'Snakes', 'Werewolves', 'Eagles', 'Himself', 'Vipers', 'Ravens', 'Jackals', 'Hellhounds', 'Coyotes', 'Iron Mules', 'Night Owls'];
const REVEAL_HOLD_MS = 2000;
const AUTO_NEXT_ROUND_MS = 2500;
const DEFAULT_SETTINGS = { name: 'Rider', opponents: 3 };

// The tutor's modules load lazily, so the table still works if they're missing.
// Reactions load only when a multiplayer table opens.
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

// The table's current controller: `local` (below) or a multiplayer room's.
let controller = null;

const ui = createUI({
  onPlayNow(cfg) { saveSettings(cfg); playNow(); },
  onLearn(cfg) { if (cfg) saveSettings(cfg); startTutorial(); },
  onSettings: saveSettings,
  onAction: action => controller?.send(action),
  onNextRound: () => controller?.nextRound?.(),
  onPlayAgain() { playNow(); },
  onNewGame: toSetup,
  onLeave: () => controller?.confirmLeave?.(),
  onSound() { setSound(!soundOn()); ui.setSoundIcon(soundOn()); },
});

// ---------- settings ----------

// `skull.settings` = {name, opponents, avatar}
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
  return parseSettings(s);
}

function saveSettings(cfg) {
  const s = { ...loadSettings(), ...cfg };
  try { localStorage.setItem('skull.settings', JSON.stringify({ name: s.name, opponents: s.opponents, avatar: s.avatar })); } catch { /* ignore */ }
}

// ---------- entry points ----------

function safe(fn, fallback) {
  try { return fn(); } catch (err) { console.error(err); return fallback; }
}

async function playNow() {
  closeRoom();
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
  controller = null;
  closeRoom();
  ui.setMode({ mp: false });
  ui.showSetup(loadSettings());
  home.paintIdentity();
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

// ---------- local controller ----------

// The in-browser engine path. The table subscribes with onView; human actions come
// back through send(). Everything else (bots, directors, holds) stays in this file.
const local = {
  sink: null,
  onView(cb) { this.sink = cb; },
  send(action) { humanAction(action); },
  nextRound() { onNextRound(); },
  leave() { toSetup(); },
};

// What the local table shows: player 0's view. The tutorial's x-ray is the one
// exception: it shows every mat card face-up (local only, never sent anywhere).
function localView(s) {
  if (!xray) return viewFor(s, HUMAN);
  const v = structuredClone(s);
  v.me = HUMAN;
  return v;
}

function maskGhost(g) {
  if (!g || xray || g.player === HUMAN) return g;
  const hidden = g.mat.length - g.revealed;
  return { ...g, mat: g.mat.map((c, i) => (i < hidden ? null : c)) };
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
  closeRoom();
  home.hidden();
  controller = local;
  local.onView((view, opts) => ui.render(view, opts));
  ui.setMode({ mp: false });
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
  local.sink?.(localView(shownState), {
    locked, ghost: maskGhost(ghost), xray,
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
  announce(ui, viewFor(prev, HUMAN), viewFor(next, HUMAN), action);

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

// ---------- multiplayer: home, lobby, remote table ----------

const ROOM_KEY = 'skull.room';            // sessionStorage: the room this tab is in (refresh rejoins)
const HOST_OPTIONS_KEY = 'skull.hostOptions';

let mp = null;          // the open room session, see openRoom()

const home = createHome({
  getSettings: loadSettings,
  saveSettings,
  listLobbies: () => listLobbies(),
  onHost: hostGame,
  onJoin: (code, from) => openRoom(code, { from }),
  onHome() { clearRoomHash(); toSetup(); },
});

const lobbyUI = createLobbyUI({
  onOption(patch) {
    if (!mp) return;
    saveHostOptions(patch);
    mp.rc.lobby('options', patch);
  },
  onAddBot: () => mp?.rc.lobby('addBot'),
  onRemoveBot: seat => mp?.rc.lobby('removeBot', { seat }),
  onKick: seat => mp?.rc.lobby('kick', { seat }),
  onStart: () => mp?.rc.lobby(mp.lobby?.lastWinner ? 'rematch' : 'start'),
  onLeave: leaveRoom,
  onShare: shareRoom,
});

function loadHostOptions() {
  try { return parseHostOptions(JSON.parse(localStorage.getItem(HOST_OPTIONS_KEY))); } catch { return parseHostOptions(null); }
}

function saveHostOptions(patch) {
  try { localStorage.setItem(HOST_OPTIONS_KEY, JSON.stringify({ ...loadHostOptions(), ...patch })); } catch { /* ignore */ }
}

function setRoomHash(code) {
  try { sessionStorage.setItem(ROOM_KEY, code); } catch { /* ignore */ }
  if (location.hash !== `#/r/${code}`) history.replaceState(null, '', `#/r/${code}`);
}

function clearRoomHash() {
  try { sessionStorage.removeItem(ROOM_KEY); } catch { /* ignore */ }
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

async function hostGame() {
  home.busy(true);
  let code;
  try {
    ({ code } = await createRoom());
  } catch {
    home.busy(false);
    home.notice('Can’t reach the bar right now. Try again in a moment.');
    return;
  }
  home.busy(false);
  openRoom(code, { from: 'host' });
}

// Connects to a room. `from`: 'host' (we just created it), 'home' (join bubble),
// 'link' (share-link prompt) or 'rejoin' (a refresh while in the room).
function openRoom(code, { from }) {
  closeRoom();
  leaveSolo();
  const s = loadSettings();
  const tag = avatarTag(getToken());
  const rc = createRemoteController({ code, name: s.name, avatar: { ...s.avatar, k: tag } });
  const session = {
    rc, code, tag, from,
    lobby: null, me: null, joined: false, optionsSent: false,
    view: null, meta: null, ghost: null, screen: null,
    holdTimer: null, nudgeTimer: null, nudgedAt: null, rx: null, unsubs: [],
  };
  mp = session;
  const live = fn => (...args) => { if (mp === session) fn(...args); };
  session.unsubs.push(
    rc.onStatus(live(onStatus)),
    rc.onLobby(live(onLobby)),
    rc.onView(live(onView)),
    rc.onEvent(live(ev => { if (ev.e === 'react' && mp.screen === 'game') mp.rx?.handle(ev); })),
    rc.onError(live(onServerError)),
  );
  // The host (and a refresh) go straight to the lobby; joiners wait on the home
  // screen until the room answers, so "not found" / "full" can show right there.
  if (from === 'host' || from === 'rejoin') showLobby();
}

// Drops the session without telling the server (the seat counts as disconnected).
function closeRoom() {
  if (!mp) return;
  const s = mp;
  mp = null;
  s.unsubs.forEach(u => u());
  clearTimeout(s.holdTimer);
  clearTimeout(s.nudgeTimer);
  destroyReactions(s);
  s.rc.close();
  if (controller === s.controller) controller = null;
  closeDialogs();
}

function leaveRoom() {
  if (!mp) return;
  mp.rc.leave();
  closeRoom();
  clearRoomHash();
  toSetup();
}

function leaveSolo() {
  launchToken++;
  leaveDirector();
  stopTimers();
  state = null;
}

function closeDialogs() {
  for (const id of ['leave-confirm', 'replaced']) {
    const d = document.getElementById(id);
    if (d.open) d.close();
  }
  document.getElementById('net-pill').hidden = true;
}

function failJoin(text) {
  const from = mp?.from;
  closeRoom();
  clearRoomHash();
  if (from === 'link') { home.linkMessage(text); return; }
  if (from === 'home') { home.message(text); return; }
  toSetup();
  home.notice(text);
}

function onStatus(st) {
  const pill = document.getElementById('net-pill');
  pill.hidden = !(st === 'reconnecting' && mp.joined && mp.screen === 'game');
  if (mp.screen === 'lobby') renderLobby();
  switch (st) {
    case 'not-found':
      if (mp.joined) { failJoin('That table has closed.'); return; }
      failJoin(`No table with code ${mp.code}. Check the letters?`);
      return;
    case 'full': failJoin('That table is full.'); return;
    case 'kicked': failJoin('The host kicked you from the table.'); return;
    case 'replaced': {
      const d = document.getElementById('replaced');
      if (!d.open) d.showModal();
      return;
    }
  }
}

function onServerError(msg) {
  if (/full/i.test(msg)) return;   // handled by the 'full' status
  if (mp.screen === 'game') ui.toast(msg, 'bad');
  else if (mp.screen === 'lobby') lobbyUI.flash(msg, 'bad');
}

function onLobby(lobby) {
  mp.lobby = lobby;
  mp.me = findMe(lobby, mp.tag);
  if (!mp.joined) {
    mp.joined = true;
    setRoomHash(mp.code);
  }
  // A fresh room we host gets the options we used last time.
  const me = mp.me;
  if (!mp.optionsSent && me && lobby.hostSeat === me.seat && lobby.phase === 'waiting' && !lobby.lastWinner &&
      lobby.members.length === 1 && mp.from === 'host') {
    mp.optionsSent = true;
    const o = loadHostOptions();
    mp.rc.lobby('options', { seats: o.seats, timer: o.timer, open: o.open });
  }
  if (lobby.phase === 'waiting' && mp.screen === 'game') {
    // the game is over: everyone is back in the same lobby
    endTable();
    showLobby();
    return;
  }
  if (mp.screen !== 'game') showLobby();
}

function showLobby() {
  if (mp.screen !== 'lobby') {
    mp.screen = 'lobby';
    home.hidden();
    controller = null;
    ui.showScreen('lobby');
    lobbyUI.setShareLabel(navigator.share ? 'Share link' : 'Copy link');
  }
  renderLobby();
}

function renderLobby() {
  lobbyUI.render({ code: mp.code, lobby: mp.lobby, me: mp.me, status: mp.rc.status() });
}

async function shareRoom() {
  if (!mp) return;
  const url = shareLink(mp.code);
  if (navigator.share) {
    try { await navigator.share({ title: 'Skull & Roses', text: `Pull up a chair — table ${mp.code}`, url }); } catch { /* cancelled */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    lobbyUI.setShareLabel('Copied!');
    setTimeout(() => lobbyUI.setShareLabel('Copy link'), 1500);
  } catch {
    lobbyUI.flash(url);
  }
}

// ---------- the remote table ----------

function enterTable() {
  mp.screen = 'game';
  mp.ghost = null;
  const session = mp;
  session.controller = {
    send(action) {
      if (!session.rc.send(action)) ui.toast('Not connected — try again in a sec', 'bad');
    },
    leave: leaveRoom,
    confirmLeave() {
      const d = document.getElementById('leave-confirm');
      if (!d.open) d.showModal();
    },
  };
  controller = session.controller;
  leaveDirector();
  ui.reset();
  ui.setFastBanners(false);
  ui.setMode({ mp: true, sound: soundOn() });
  ui.showGame();
  document.getElementById('net-pill').hidden = true;
  // Reactions live in their own module; the table works without them.
  import('./reactions.js').then(m => {
    if (mp !== session || session.screen !== 'game' || session.rx || typeof m?.mountReactions !== 'function') return;
    try {
      session.rx = m.mountReactions({
        root: document.getElementById('game'),
        send: (kind, target) => session.rc.react(kind, target),
        seatEl: id => document.querySelector(`#game .seat[data-player="${id}"]`),
        me: () => session.view?.me,
      });
    } catch (err) { console.error('reactions failed to mount', err); }
  }).catch(() => {});
}

function destroyReactions(s) {
  try { s.rx?.destroy(); } catch { /* ignore */ }
  s.rx = null;
}

// Back to the lobby after a game.
function endTable() {
  clearTimeout(mp.holdTimer);
  clearTimeout(mp.nudgeTimer);
  mp.holdTimer = mp.nudgeTimer = null;
  destroyReactions(mp);
  closeDialogs();
  mp.view = null;
  mp.meta = null;
  mp.ghost = null;
}

function onView(view, meta) {
  if (mp.lobby && mp.lobby.phase === 'waiting' && mp.screen !== 'game' && view.phase === 'game-over') return;   // stale
  const entering = mp.screen !== 'game';
  if (entering) enterTable();
  let prev = mp.view;
  const a = view.lastAction;
  // A new game: lastAction is null until the first move.
  if (prev && ((a == null && prev.lastAction != null) || view.round < prev.round)) { ui.reset(); prev = null; }
  noteSeatChanges(mp.meta?.seats, meta.seats, view);
  mp.view = view;
  mp.meta = meta;
  if (!prev) {
    const f = view.players[view.firstPlayer];
    if (a == null) ui.banner(`Round ${view.round}`, { sub: `${f.id === view.me ? 'You start' : f.name + ' starts'} · lay down a card` });
  }
  const fresh = prev && a && a.n !== prev.lastAction?.n;
  if (view.phase === 'place-initial') mp.ghost = null;
  if (fresh) {
    announce(ui, prev, view, a);
    if (a.type === 'reveal' && prev.phase === 'reveal' && view.phase !== 'reveal') {
      holdFinalFlip(prev, view, a);
      scheduleNudge();
      return;
    }
  }
  if (!mp.holdTimer) renderTable();
  scheduleNudge();
}

// Like the local game: keep the last flip on screen for a moment before the
// post-reveal board (the challenger's cards may already be back in hand).
function holdFinalFlip(prev, view, a) {
  const frozen = structuredClone(prev);
  const t = frozen.players[a.target];
  t.revealed += 1;
  frozen.revealedCount += 1;
  const i = t.mat.length - t.revealed;
  if (t.mat[i] == null) t.mat[i] = view.lastResult?.type === 'lost' ? SKULL : ROSE;
  const c = frozen.players[frozen.challenger];
  mp.ghost = { player: c.id, mat: c.mat, revealed: c.revealed };
  clearTimeout(mp.holdTimer);
  const session = mp;
  mp.holdTimer = setTimeout(() => {
    session.holdTimer = null;
    if (mp === session && session.screen === 'game') renderTable();
  }, REVEAL_HOLD_MS);
  renderTable(frozen, true);
}

function renderTable(shownView = mp.view, locked = !!mp.holdTimer) {
  if (!shownView) return;
  ui.render(shownView, {
    mp: true, locked, ghost: mp.ghost,
    seats: mp.meta?.seats ?? [],
    clocks: seatClocks(mp.meta?.deadline, { timer: mp.lobby?.options?.timer ?? 0 }),
    now: mp.rc.now(),
  });
}

function noteSeatChanges(before, after, view) {
  if (!before || !after) return;
  after.forEach((x, id) => {
    if (x.forfeited && !before[id]?.forfeited && id !== view.me) ui.toast(`${x.name} left the table`);
  });
}

// Turn nudge: 5s before your own clock runs out, your seat shakes and a soft tick plays.
function scheduleNudge() {
  clearTimeout(mp.nudgeTimer);
  mp.nudgeTimer = null;
  const d = mp.meta?.deadline;
  const me = mp.view?.me;
  const at = d ? (d.ats?.[me] ?? (d.players?.includes(me) ? d.at : null)) : null;
  if (at == null || at === mp.nudgedAt) return;
  const wait = at - NUDGE_MS - mp.rc.now();
  if (wait < -NUDGE_MS / 2) return;   // too late to be useful (e.g. just reconnected)
  const session = mp;
  mp.nudgeTimer = setTimeout(() => {
    if (mp !== session || session.screen !== 'game') return;
    session.nudgeTimer = null;
    session.nudgedAt = at;
    ui.nudge();
    tick();
  }, Math.max(0, wait));
}

// Dialog buttons (leave confirm, seat taken in another tab).
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mp]');
  if (!b) return;
  switch (b.dataset.mp) {
    case 'leave-yes': leaveRoom(); break;
    case 'use-here': if (mp) openRoom(mp.code, { from: 'rejoin' }); break;
    case 'go-home': closeRoom(); clearRoomHash(); toSetup(); break;
  }
});

// Audio may only start after a gesture; any tap at a multiplayer table unlocks it.
document.addEventListener('pointerdown', () => { if (mp && soundOn()) unlock(); }, { passive: true });

// ---------- boot ----------

function route() {
  const code = parseShareHash(location.hash);
  if (!code) return false;
  let current = null;
  try { current = sessionStorage.getItem(ROOM_KEY); } catch { /* ignore */ }
  if (current === code) openRoom(code, { from: 'rejoin' });   // a refresh: straight back in
  else home.showLinkPrompt(code);
  return true;
}

window.addEventListener('hashchange', () => {
  if (mp || state) return;   // already at a table
  if (!route()) toSetup();
});

ui.showSetup(loadSettings());
route();
