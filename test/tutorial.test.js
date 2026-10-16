import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, legalActions } from '../src/engine.js';
import { createTutorialDirector, TUTORIAL_DONE_KEY } from '../src/tutorial.js';
import { TUTORIAL_SCRIPT } from '../src/tutorial-script.js';

const HUMAN = 0;
const tick = () => new Promise(r => setImmediate(r));

function fakeStorage() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
  };
  return m;
}

// Drives a tutorial director the way src/main.js does, with a fake coach that
// clicks "Next" / the first button immediately and never resolves locked steps.
async function replay({ finaleChoice = 'solo', skipAt = null } = {}) {
  const store = fakeStorage();
  const director = createTutorialDirector();
  const says = [];
  const events = [];
  let skipFn = null;
  let xray = false;
  const xrayLog = [];

  const coach = {
    say(opts) {
      says.push(opts);
      if (skipAt != null && says.length === skipAt) { queueMicrotask(() => skipFn()); return new Promise(() => {}); }
      if (opts.next) return Promise.resolve();
      if (opts.buttons) return Promise.resolve(finaleChoice);
      return new Promise(() => {});
    },
    hide() {},
    onSkip(fn) { skipFn = fn; },
    destroy() {},
  };

  const { players, firstPlayer } = director.setup();
  let state = createGame({ players, firstPlayer });
  let handledGameOver = false;
  const ctl = {
    getState: () => state,
    resume() {},
    setXray(on) { xray = on; xrayLog.push(on); },
    coach,
    humanId: HUMAN,
    toSetup() { events.push('setup'); director.exit(); },
    startSolo(o) { events.push(['solo', o]); director.exit(); },
    startTutorial() { events.push('tutorial'); director.exit(); },
  };

  const perform = action => {
    const prev = state;
    state = applyAction(prev, action, director.rng);
    director.onState(prev, state, action, ctl);
    if (prev.phase === 'reveal' && state.phase !== 'reveal') {
      // reveal hold finished
      if (state.phase === 'game-over') handledGameOver = director.onGameOver(state, ctl);
      director.onState(state, state, null, ctl);
    }
  };

  const botToAct = () => {
    const canAct = id => !state.players[id].isHuman && legalActions(state, id).length > 0;
    if (state.phase !== 'place-initial' && canAct(state.currentPlayer)) return state.currentPlayer;
    return state.players.find(p => canAct(p.id))?.id ?? null;
  };

  director.onStart(ctl);
  let rounds = 1;
  let humanSteps = 0;
  for (let guard = 0; guard < 500 && !events.length; guard++) {
    await tick();
    if (events.length) break;
    const last = says[says.length - 1];
    const allowed = legalActions(state, HUMAN).filter(a => a.type !== 'nextRound' && director.allowHuman(state, a));

    if (allowed.length) {
      assert.equal(allowed.length, 1, `exactly one human move allowed, got ${JSON.stringify(allowed)}`);
      assert.ok(last?.lock, 'human step is locked');
      assert.ok(last?.target, 'human step has a target');
      assert.equal(director.canProceed(), false, 'bots wait during human steps');
      humanSteps++;
      perform(allowed[0]);
      continue;
    }
    if (!director.canProceed()) continue;  // waiting on a coach bubble
    if (state.phase === 'round-over') {
      assert.ok(director.allowHuman(state, { type: 'nextRound' }));
      perform({ type: 'nextRound' });
      rounds++;
      continue;
    }
    if (state.phase === 'game-over') break;
    const bot = botToAct();
    assert.notEqual(bot, null, `a bot should act in phase ${state.phase}`);
    const action = director.botAction(state, bot);
    assert.ok(action, `scripted move for bot ${bot} in phase ${state.phase}`);
    assert.ok(legalActions(state, bot).some(a => JSON.stringify(a) === JSON.stringify(action)), `legal: ${JSON.stringify(action)}`);
    perform(action);
  }
  return { state, events, says, rounds, humanSteps, store, xray, xrayLog, handledGameOver };
}

describe('tutorial script', () => {
  test('replays to a human win in exactly 3 rounds', async () => {
    const r = await replay();
    assert.equal(r.state.phase, 'game-over');
    assert.equal(r.state.winner, HUMAN);
    assert.equal(r.state.round, 3);
    assert.equal(r.rounds, 3);
    assert.equal(r.state.players[HUMAN].wins, 2);
    assert.ok(r.handledGameOver, 'director suppresses default game-over UI');
    assert.deepEqual(r.events, [['solo', { tips: true }]]);
    assert.equal(r.store.get(TUTORIAL_DONE_KEY), '1');
    assert.equal(r.xray, false, 'x-ray is off at the end');
    assert.ok(r.xrayLog.includes(true), 'x-ray shown at round ends');
    assert.equal(r.humanSteps, TUTORIAL_SCRIPT.filter(s => s.do).length);
  });

  test('round 2: Panthers flips your Skull and loses a card', async () => {
    const r = await replay();
    const p = r.state.players[1];
    assert.equal(p.hand.length + p.mat.length, 3);
    assert.ok(r.state.log.some(l => /Panthers flips You' card: SKULL/.test(l) || /Panthers flips .* SKULL/.test(l)));
  });

  test('Replay tutorial restarts the tutorial', async () => {
    const r = await replay({ finaleChoice: 'replay' });
    assert.deepEqual(r.events, ['tutorial']);
    assert.equal(r.store.get(TUTORIAL_DONE_KEY), '1');
  });

  test('every step: text ≤ 160 chars; human steps have a target', () => {
    for (const s of TUTORIAL_SCRIPT) {
      if (s.say != null) assert.ok(s.say.replace(/<[^>]+>/g, '').length <= 160, `too long: ${s.say}`);
      if (s.do) {
        assert.equal(s.do.player, HUMAN);
        assert.ok(s.target, `human step needs a target: ${s.say}`);
        assert.ok(s.say, 'human step needs text');
      }
      if (s.next || s.finale) assert.ok(s.say);
    }
  });

  test('every scripted bubble is shown in the replay', async () => {
    const r = await replay();
    const shown = new Set(r.says.map(o => o.text));
    for (const s of TUTORIAL_SCRIPT) if (s.say) assert.ok(shown.has(s.say), `never shown: ${s.say}`);
  });

  test('skip works on every coach bubble and marks the tutorial done', async () => {
    const total = (await replay()).says.length;
    for (let k = 1; k <= total; k++) {
      const r = await replay({ skipAt: k });
      assert.deepEqual(r.events, ['setup'], `skip at bubble ${k}`);
      assert.equal(r.store.get(TUTORIAL_DONE_KEY), '1');
    }
  });

  test('narrated bot steps wait for Next before moving on', async () => {
    fakeStorage();
    const d = createTutorialDirector();
    const { players, firstPlayer } = d.setup();
    let state = createGame({ players, firstPlayer });
    let release = null;
    const coach = {
      say: o => (o.next ? new Promise(r => { if (/Panthers bets/.test(o.text)) release = r; else r(); }) : Promise.resolve()),
      hide() {}, onSkip() {},
    };
    d.onStart({ coach, resume() {}, setXray() {}, getState: () => state });
    await tick();
    const apply = a => { const prev = state; state = applyAction(state, a); d.onState(prev, state, a); };
    for (const s of TUTORIAL_SCRIPT.slice(0, 5)) {
      if (s.do) { apply(s.do); await tick(); }
      if (s.bots) for (const a of s.bots) { apply(d.botAction(state, a.player)); await tick(); }
    }
    // Panthers has bid; the narrated step must hold until Next is clicked.
    assert.ok(release, 'narrated line was shown with a Next button');
    assert.equal(d.botAction(state, 2), null);
    release();
    await tick();
    assert.deepEqual(d.botAction(state, 2), { type: 'pass', player: 2 });
    d.exit();
  });

  test('locked steps reject every other human move', () => {
    fakeStorage();
    const d = createTutorialDirector();
    const { players, firstPlayer } = d.setup();
    const state = createGame({ players, firstPlayer });
    const ctl = { coach: null, resume() {}, setXray() {}, getState: () => state };
    d.onStart(ctl);
    // first bubble is an info step: nothing allowed yet
    assert.equal(legalActions(state, HUMAN).filter(a => d.allowHuman(state, a)).length, 0);
    assert.equal(d.canProceed(), false);
    d.exit();
  });
});
