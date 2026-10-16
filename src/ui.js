// DOM rendering for the Skull & Roses table. Pure view: it renders a state and
// reports the human's chosen actions via callbacks; it never applies rules itself.
import { ROSE, SKULL, totalOnMats, legalActions, possessive } from './engine.js';
import { bonesSVG } from './coach.js';

const SEAT_COLORS = ['#f5b041', '#2de2ff', '#b46cff', '#5bd46b', '#ff5d8f', '#ff8a3a'];
export const seatColor = id => SEAT_COLORS[id % SEAT_COLORS.length];

const REV_STEP = 0.62; // horizontal step between flipped cards, in card widths

const TURN_PHASES = new Set(['placement', 'bidding', 'reveal', 'discard', 'choose-first']);

const PHASE_LABELS = {
  'place-initial': 'Lay down',
  placement: 'Stack or challenge',
  bidding: 'Bidding',
  reveal: 'Reveal',
  discard: 'Discard',
  'choose-first': 'Choose starter',
  'round-over': 'Round over',
  'game-over': 'Game over',
};

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- card art ----------

const FRAME = `<rect x="7" y="7" width="86" height="126" rx="7" fill="none" stroke="#d4a64a" stroke-opacity=".55" stroke-dasharray="2 3"/>`;

const FRONT = {
  [ROSE]: `<svg viewBox="0 0 100 140" aria-label="Rose" role="img">
    <rect x="2" y="2" width="96" height="136" rx="10" fill="url(#g-rose-card)" stroke="#d4a64a" stroke-width="2.5"/>${FRAME}
    <use href="#sym-rose" x="12" y="26" width="76" height="86"/>
    <use href="#sym-rose" x="10" y="10" width="14" height="16"/>
    <use href="#sym-rose" x="10" y="10" width="14" height="16" transform="rotate(180 50 70)"/>
  </svg>`,
  [SKULL]: `<svg viewBox="0 0 100 140" aria-label="Skull" role="img">
    <rect x="2" y="2" width="96" height="136" rx="10" fill="url(#g-skull-card)" stroke="#9aa0a8" stroke-width="2.5"/>${FRAME}
    <use href="#sym-skull" x="8" y="32" width="84" height="80"/>
    <use href="#sym-skull" x="10" y="11" width="14" height="14"/>
    <use href="#sym-skull" x="10" y="11" width="14" height="14" transform="rotate(180 50 70)"/>
  </svg>`,
};

const BACK = `<svg viewBox="0 0 100 140" aria-hidden="true">
  <rect x="2" y="2" width="96" height="136" rx="10" fill="#120c0b" stroke="currentColor" stroke-width="3"/>
  <rect x="9" y="9" width="82" height="122" rx="6" fill="url(#p-leather)" stroke="currentColor" stroke-opacity=".45"/>
  <path d="M16 16h10M16 16v10M84 16h-10M84 16v10M16 124h10M16 124v-10M84 124h-10M84 124v-10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <circle cx="50" cy="70" r="25" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width="2"/>
  <circle cx="50" cy="70" r="30" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="1 4" stroke-width="2"/>
  <use href="#sym-skull-mono" x="34" y="53" width="32" height="34" style="color:currentColor"/>
</svg>`;

const MAT = {
  skull: `<svg class="mat-art" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="48" fill="url(#g-mat-skull)" stroke="currentColor" stroke-opacity=".7" stroke-width="2"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="#d4a64a" stroke-opacity=".25" stroke-dasharray="2 4"/>
    <use href="#sym-skull-mono" x="22" y="20" width="56" height="60" style="color:#efe3cf" opacity=".09"/>
  </svg>`,
  rose: `<svg class="mat-art" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="48" fill="url(#g-mat-rose)" stroke="#ff4d6a" stroke-width="2.5"/>
    <circle cx="50" cy="50" r="42" fill="none" stroke="#ffd27a" stroke-opacity=".45" stroke-dasharray="2 4"/>
    <use href="#sym-rose" x="22" y="18" width="56" height="64" opacity=".28"/>
  </svg>`,
};

const MINI = {
  [ROSE]: `<svg viewBox="-40 -40 80 90"><use href="#sym-rose" x="-40" y="-40" width="80" height="90"/></svg>`,
  [SKULL]: `<svg viewBox="-42 -38 84 80"><use href="#sym-skull" x="-42" y="-38" width="84" height="80"/></svg>`,
};

export function cardHTML({ face = null, up = false, flip = false, deal = false, peek = false, xray = false, i = 0, cls = '', attrs = '', style = '' } = {}) {
  const classes = ['card', up && 'up', flip && 'flip-in', deal && 'deal-in', xray && 'xray', cls].filter(Boolean).join(' ');
  return `<div class="${classes}" style="--i:${i};${style}" ${attrs}>
    <div class="card-inner">
      <div class="card-side card-back">${BACK}</div>
      <div class="card-side card-front">${up && face ? FRONT[face] : ''}</div>
    </div>
    ${peek && !up && face ? `<span class="peek peek-${face}" title="Your ${face}">${MINI[face]}</span>` : ''}
  </div>`;
}

// ---------- UI factory ----------

export function createUI(handlers) {
  const $ = sel => document.querySelector(sel);
  const el = {
    setup: $('#setup'), game: $('#game'), form: $('#setup-form'), name: $('#player-name'),
    settings: $('#table-settings'), playSub: $('#play-sub'), table: $('#game .table'), tableWrap: $('#game .table-wrap'),
    status: $('#status'), opponents: $('#opponents'), center: $('#center'),
    me: $('#me-seat'), controls: $('#controls'), hand: $('#hand'),
    log: $('#log-list'), logDetails: $('#log-details'),
    banners: $('#banner-layer'), toasts: $('#toasts'),
    rules: $('#rules'), gameover: $('#gameover'),
  };

  // decorate setup screen art
  el.setup.querySelectorAll('[data-face]').forEach(n => { n.innerHTML = FRONT[n.dataset.face]; });
  el.setup.querySelectorAll('[data-bones]').forEach(n => { n.innerHTML = bonesSVG({ mood: n.dataset.bones, crop: 'head' }); });
  if (window.matchMedia('(max-width: 900px)').matches) el.logDetails.open = false;

  let actions = [];           // legal actions offered to the human in the current render
  let bidValue = null;
  let last = null;            // { state, view } of the last render
  let shown = new Map();      // pid -> { len, revealed } as last rendered (for animations)
  let logLen = 0;
  let wasXray = false;

  const readSettings = () => ({
    name: el.name.value.trim().slice(0, 16),
    opponents: Number(new FormData(el.form).get('opponents')) || 3,
  });

  function fillSettings({ name = '', opponents = 3 } = {}) {
    el.name.value = name === 'Rider' ? '' : name;
    const r = el.form.querySelector(`input[name="opponents"][value="${opponents}"]`);
    if (r) r.checked = true;
    describeSettings();
  }

  function describeSettings() {
    const { name, opponents } = readSettings();
    el.playSub.textContent = `vs ${opponents} rival gangs · riding as ${name || 'Rider'}`;
  }

  el.form.addEventListener('submit', e => {
    e.preventDefault();
    handlers.onPlayNow(readSettings());
  });
  el.form.addEventListener('input', () => { describeSettings(); handlers.onSettings?.(readSettings()); });

  document.addEventListener('click', e => {
    const a = e.target.closest('[data-action-index]');
    if (a && !a.disabled) {
      const action = actions[Number(a.dataset.actionIndex)];
      if (action) handlers.onAction(action);
      return;
    }
    const c = e.target.closest('[data-cmd]');
    if (!c) return;
    switch (c.dataset.cmd) {
      case 'rules': el.rules.showModal(); break;
      case 'learn': handlers.onLearn(el.setup.hidden ? null : readSettings()); break;
      case 'new-game': closeGameOver(); handlers.onNewGame(); break;
      case 'play-again': closeGameOver(); handlers.onPlayAgain(); break;
      case 'bid-dec': stepBid(-1); break;
      case 'bid-inc': stepBid(1); break;
    }
  });

  function bidAmounts() {
    return actions.map((a, i) => ({ a, i })).filter(x => x.a.type === 'bid').sort((x, y) => x.a.amount - y.a.amount);
  }

  function stepBid(d) {
    const amounts = bidAmounts().map(x => x.a.amount);
    const idx = amounts.indexOf(bidValue);
    const next = amounts[Math.max(0, Math.min(amounts.length - 1, idx + d))];
    if (next != null && next !== bidValue) { bidValue = next; if (last) render(last.state, last.view); }
  }

  // ---------- screens ----------

  function showSetup(settings) {
    closeGameOver();
    if (settings) fillSettings(settings);
    el.game.hidden = true;
    el.setup.hidden = false;
    el.setup.querySelector('#play-now').focus({ preventScroll: true });
  }

  function showGame() {
    el.setup.hidden = true;
    el.game.hidden = false;
  }

  function reset() {
    shown = new Map();
    logLen = 0;
    el.log.innerHTML = '';
    clearBanners();
    el.toasts.innerHTML = '';
    bidValue = null;
    wasXray = false;
    closeGameOver();
  }

  // ---------- render ----------

  function render(state, view) {
    last = { state, view };
    const human = view.humanId;
    actions = view.locked ? [] : legalActions(state, human).filter(a => a.type !== 'nextRound');
    state = withGhost(state, view.ghost);

    const amounts = bidAmounts().map(x => x.a.amount);
    if (!amounts.includes(bidValue)) bidValue = amounts[0] ?? null;

    const revealTargets = new Map();
    actions.forEach((a, i) => { if (a.type === 'reveal') revealTargets.set(a.target, i); });

    const ctx = { state, view, revealTargets, xrayFresh: !!view.xray && !wasXray };
    el.table.classList.toggle('xray', !!view.xray);
    const opp = state.players.filter(p => p.id !== human);
    el.opponents.style.setProperty('--n', opp.length);
    el.opponents.innerHTML = opp.map((p, k) => seatHTML(p, ctx, k, opp.length)).join('');
    el.me.innerHTML = seatHTML(state.players[human], ctx, 0, 1, true);
    el.center.innerHTML = centerHTML(state, view);
    el.status.innerHTML = statusHTML(state, human, view);
    el.controls.innerHTML = controlsHTML(state, view);
    el.hand.innerHTML = handHTML(state, view);
    renderLog(state);

    shown = new Map(state.players.map(p => [p.id, { len: p.mat.length, revealed: p.revealed }]));
    wasXray = !!view.xray;
  }

  // After a lost challenge the engine returns the challenger's mat to their hand at
  // once; keep drawing the cards they had on the table (display only) until the
  // next round so the board and the pot still add up.
  function withGhost(state, ghost) {
    if (!ghost || !['discard', 'choose-first', 'round-over', 'game-over'].includes(state.phase)) return state;
    const p = state.players[ghost.player];
    if (!p || p.mat.length) return state;
    const players = state.players.slice();
    players[ghost.player] = { ...p, mat: ghost.mat, revealed: ghost.revealed, ghost: true };
    return { ...state, players };
  }

  function seatHTML(p, { state, view, revealTargets, xrayFresh }, k, n, isMe = false) {
    const prev = shown.get(p.id) || { len: 0, revealed: 0 };
    const isTurn = TURN_PHASES.has(state.phase) && state.currentPlayer === p.id && !(p.eliminated && state.phase !== 'choose-first' && state.phase !== 'discard');
    const thinking = !isMe && state.phase === 'place-initial' && !p.eliminated && p.mat.length === 0;
    const target = revealTargets.has(p.id);
    const bidding = state.phase === 'bidding' || state.phase === 'placement';

    const badges = [];
    if (p.id === state.firstPlayer && !['round-over', 'game-over'].includes(state.phase)) badges.push(`<span class="badge first" title="Started this round">1st</span>`);
    if (state.bid && state.bid.player === p.id && ['bidding', 'reveal'].includes(state.phase)) badges.push(`<span class="badge bid">Bid ${state.bid.amount}</span>`);
    if (state.challenger === p.id && ['reveal', 'discard', 'round-over', 'choose-first', 'game-over'].includes(state.phase) && state.challenger != null) badges.push(`<span class="badge chal">Challenger</span>`);
    if (p.passed && bidding) badges.push(`<span class="badge passed">Passed</span>`);
    if (p.eliminated) badges.push(`<span class="badge out">Out</span>`);
    if (state.winner === p.id) badges.push(`<span class="badge crown">Winner</span>`);

    // stack, bottom → top
    const len = p.mat.length;
    const freshFrom = prev.len < len ? prev.len : len;
    const xray = !!view.xray;
    const revealedFrom = len - p.revealed;
    const laidOpen = xray ? len : p.revealed;   // x-ray fans every card out face-up
    const prevRevealedFrom = len - Math.min(prev.revealed, p.revealed);
    // Face-down cards overlap tightly; flipped cards fan out to the right in flip
    // order (top of stack first), each later one drawn over the previous so the
    // last flipped card — the skull, if one was hit — is fully visible.
    const down = len - laidOpen;
    const revStart = down ? `${down - 1} * var(--fan) + ${REV_STEP} * var(--cw)` : '0px';
    const pos = j => (j < down
      ? `left:calc(${j} * var(--fan));top:calc(${j} * -3px)`
      : `left:calc(${revStart} + ${(len - 1 - j) * REV_STEP} * var(--cw));top:-6px;z-index:${10 + len - j}`);
    const stackW = !len ? '0px'
      : laidOpen ? `calc(${revStart} + ${(laidOpen - 1) * REV_STEP + 1} * var(--cw))`
      : `calc(var(--cw) + ${len - 1} * var(--fan))`;
    const cards = p.mat.map((face, j) => {
      const flipped = j >= revealedFrom;
      const up = flipped || xray;
      const known = up || isMe;
      return cardHTML({
        face: known ? face : null,
        up,
        xray: up && !flipped,
        flip: flipped ? j < prevRevealedFrom : up && xrayFresh,
        deal: j >= freshFrom,
        peek: isMe,
        i: j,
        style: pos(j),
      });
    }).join('');

    const owned = p.hand.length + (p.ghost ? 0 : p.mat.length);
    const handMini = isMe ? '' : `<div class="hand-mini" title="${p.hand.length} in hand">${
      Array.from({ length: p.hand.length }, () => `<i></i>`).join('')}<span>${p.hand.length} in hand</span></div>`;

    const wins = `<div class="wins" data-tut="wins" data-player="${p.id}" title="${p.wins} win${p.wins === 1 ? '' : 's'}">${[0, 1].map(w => `<i class="${w < p.wins ? 'on' : ''}"></i>`).join('')}</div>`;

    const arc = n > 1 ? Math.abs((k - (n - 1) / 2) / ((n - 1) / 2)) : 0;
    const classes = ['seat', isMe && 'me', isTurn && 'turn', thinking && 'thinking', target && 'target', p.eliminated && 'eliminated', p.passed && bidding && 'passed', state.winner === p.id && 'winner'].filter(Boolean).join(' ');
    const attrs = target ? `data-action-index="${revealTargets.get(p.id)}" role="button" tabindex="0" aria-label="Flip ${esc(possessive(p.name))} top card"` : '';

    return `<div class="${classes}" style="--seat:${seatColor(p.id)};--arc:${arc.toFixed(2)}" data-tut="${isMe ? 'my-seat' : 'seat'}" data-player="${p.id}" ${attrs}>
      <div class="seat-head">
        <span class="seat-name">${esc(isMe ? `${p.name} (you)` : p.name)}</span>
        ${wins}${thinking ? '<span class="thinking-dots" aria-hidden="true">…</span>' : ''}
      </div>
      <div class="mat ${p.wins > 0 ? 'rose-side' : 'skull-side'}" data-tut="${isMe ? 'my-mat' : 'stack'}" data-player="${p.id}">
        ${p.wins > 0 ? MAT.rose : MAT.skull}
        <div class="stack ${p.ghost ? 'ghost' : ''}" style="width:${stackW}">${cards}</div>
        ${len ? `<span class="stack-count">${len}</span>` : ''}
        ${target ? `<span class="flip-hint">Flip</span>` : ''}
      </div>
      <div class="badges">${badges.join('')}</div>
      ${handMini}
      ${p.eliminated ? '' : isMe ? `<div class="owned">${owned} card${owned === 1 ? '' : 's'} left</div>` : ''}
    </div>`;
  }

  function centerHTML(state, view) {
    const total = totalOnMats(state);
    const name = id => (id === view.humanId ? 'You' : esc(state.players[id].name));
    let bidLine = `<div class="bid-line muted">No challenge yet</div>`;
    let progress = '';
    if (state.bid) {
      bidLine = `<div class="bid-line"><span>${name(state.bid.player)}</span> bid <b>${state.bid.amount}</b></div>`;
    }
    if (state.bid && ['reveal', 'round-over', 'discard', 'choose-first', 'game-over'].includes(state.phase) && state.challenger != null) {
      const n = state.bid.amount;
      const got = state.revealedCount;
      const lost = state.lastResult && state.lastResult.type === 'lost';
      progress = `<div class="pips" aria-label="${got} of ${n} revealed">${Array.from({ length: n }, (_, i) => {
        const cls = i < got ? (lost && i === got - 1 ? 'skull' : 'rose') : '';
        return `<i class="${cls}"></i>`;
      }).join('')}</div>`;
    }
    let result = '';
    if (state.lastResult && ['round-over', 'discard', 'choose-first', 'game-over'].includes(state.phase)) {
      const r = state.lastResult;
      const who = name(r.challenger);
      if (r.type === 'won') result = `<div class="result won">${who} ${r.challenger === view.humanId ? 'win' : 'wins'} the challenge</div>`;
      else {
        const owner = r.skullOwner;
        const whose = owner === r.challenger ? (r.challenger === view.humanId ? 'your own' : 'their own') : `${owner === view.humanId ? 'your' : esc(possessive(state.players[owner].name))}`;
        result = `<div class="result lost">Hit ${whose} skull</div>`;
      }
    }
    return `<div class="pot" data-tut="pot">
        <div class="pot-num">${total}</div>
        <div class="pot-label">card${total === 1 ? '' : 's'} on the table</div>
      </div>
      <div class="pot-info" data-tut="bid-display">${bidLine}${progress}${result}</div>`;
  }

  function statusHTML(state, human, view) {
    const p = state.players[state.currentPlayer];
    let who = '';
    if (state.phase === 'place-initial') {
      const waiting = state.players.filter(x => !x.eliminated && x.mat.length === 0);
      who = waiting.some(x => x.id === human) ? `<b class="you">Your move</b>` : `Waiting on ${waiting.length} rider${waiting.length === 1 ? '' : 's'}…`;
    } else if (TURN_PHASES.has(state.phase) && p) {
      who = p.id === human ? `<b class="you">Your move</b>` : `<span class="dot" style="--seat:${seatColor(p.id)}"></span>${esc(p.name)} is thinking…`;
    } else if (state.phase === 'game-over' && state.winner != null) {
      who = `${state.winner === human ? 'You win!' : esc(state.players[state.winner].name) + ' wins'}`;
    }
    if (view.locked && state.phase === 'reveal') who = 'Flipping…';
    return `<span class="round">Round ${state.round}</span><span class="phase">${PHASE_LABELS[state.phase] || state.phase}</span><span class="who">${who}</span>`;
  }

  function controlsHTML(state, view) {
    const me = state.players[view.humanId];
    const has = t => actions.some(a => a.type === t);
    const idx = pred => actions.findIndex(pred);
    const prompt = (txt, cls = '') => `<p class="prompt ${cls}">${txt}</p>`;

    if (view.locked) return prompt('…', 'muted');

    if (state.phase === 'game-over') {
      if (view.gameOverControls === false) return prompt(state.winner === view.humanId ? 'Game over — you took it.' : 'Game over.', 'muted');
      return prompt(state.winner === view.humanId ? 'You rule the bar tonight.' : 'Game over.') +
        `<div class="row"><button class="btn primary" data-cmd="play-again">Rematch</button><button class="btn ghost" data-cmd="new-game">Change table</button></div>`;
    }
    if (me.eliminated && !['choose-first', 'discard'].includes(state.phase)) {
      return prompt('You’re out of cards. Kick back and watch the rest of the ride.', 'muted');
    }

    switch (state.phase) {
      case 'place-initial':
        return has('placeInitial') ? prompt('Pick a card from your hand to lay face-down.', 'go') : prompt('Waiting for the others to lay down…', 'muted');

      case 'placement': {
        if (!has('place') && !has('bid')) return prompt('Waiting…', 'muted');
        const head = has('place')
          ? prompt('Add a card to your stack — or start a challenge.', 'go')
          : prompt('No cards in hand: you must start a challenge.', 'go');
        return head + bidStepper('Challenge');
      }

      case 'bidding': {
        if (!has('bid') && !has('pass')) return prompt('Waiting for the bidding to come around…', 'muted');
        const passI = idx(a => a.type === 'pass');
        return prompt(`Current bid: <b>${state.bid.amount}</b>. Raise or pass for good.`, 'go') +
          bidStepper('Raise', passI >= 0 ? `<button class="btn danger" data-tut="pass" data-action-index="${passI}">Pass</button>` : '');
      }

      case 'reveal': {
        if (!has('reveal')) return prompt(`Challenger is flipping cards…`, 'muted');
        const own = idx(a => a.type === 'reveal' && a.target === view.humanId);
        const left = state.bid.amount - state.revealedCount;
        if (own >= 0) {
          return prompt(`Flip your own stack first — ${left} to go.`, 'go') +
            `<div class="row"><button class="btn primary" data-tut="flip-own" data-action-index="${own}">Flip my top card</button></div>`;
        }
        return prompt(`Tap a rival's stack to flip its top card — ${left} to go.`, 'go');
      }

      case 'discard':
        return has('discard') ? prompt('Your own skull got you. Choose a card to throw away.', 'danger') : prompt('Challenger is discarding…', 'muted');

      case 'choose-first': {
        if (!has('chooseFirst')) return prompt('Choosing who starts next…', 'muted');
        const btns = actions.map((a, i) => a.type === 'chooseFirst'
          ? `<button class="btn" style="--seat:${seatColor(a.target)}" data-action-index="${i}"><span class="dot"></span>${esc(state.players[a.target].name)}</button>` : '').join('');
        return prompt('You’re out — but you pick who starts the next round.', 'go') + `<div class="row wrap">${btns}</div>`;
      }

      case 'round-over': {
        const r = state.lastResult;
        let msg = 'Round over.';
        if (r) {
          if (r.type === 'won') msg = r.challenger === view.humanId ? 'You won the challenge! Your mat flips to roses.' : `${esc(state.players[r.challenger].name)} won the challenge.`;
          else if (r.challenger === view.humanId) msg = r.discarded ? `You lost a <b class="${r.discarded}">${r.discarded}</b>.` : 'You lost a card.';
          else msg = `${esc(state.players[r.challenger].name)} lost a card${r.eliminated ? ' and is out' : ''}.`;
        }
        const next = state.players[state.firstPlayer];
        const auto = view.autoNextMs != null;
        return prompt(`${msg} ${next ? `${next.id === view.humanId ? 'You start' : esc(next.name) + ' starts'} next.` : ''}`) +
          `<div class="row"><button class="btn primary next-btn" data-cmd="next-round" data-tut="next-round">Next round →${
            auto ? `<i class="countdown" style="--ms:${Math.round(view.autoNextMs)}ms" aria-hidden="true"></i>` : ''}</button>${
            auto ? '<span class="auto-hint">or tap the table</span>' : ''}</div>`;
      }
    }
    return '';
  }

  function bidStepper(label, extra = '') {
    const list = bidAmounts();
    if (!list.length) return extra ? `<div class="row">${extra}</div>` : '';
    const cur = list.find(x => x.a.amount === bidValue) || list[0];
    const min = list[0].a.amount, max = list[list.length - 1].a.amount;
    return `<div class="row bidrow">
      <div class="stepper" role="group" aria-label="Bid amount">
        <button class="step" data-cmd="bid-dec" data-tut="bid-dec" ${cur.a.amount <= min ? 'disabled' : ''} aria-label="Lower">−</button>
        <output class="bid-out" data-tut="bid-value">${cur.a.amount}</output>
        <button class="step" data-cmd="bid-inc" data-tut="bid-inc" ${cur.a.amount >= max ? 'disabled' : ''} aria-label="Higher">+</button>
      </div>
      <button class="btn primary" data-tut="bid-submit" data-action-index="${cur.i}">${label} ${cur.a.amount}</button>
      ${extra}
      <span class="range">${min}–${max}</span>
    </div>`;
  }

  function handHTML(state, view) {
    const me = state.players[view.humanId];
    if (!me.hand.length) return me.eliminated ? '' : `<div class="hand-empty">Hand empty</div>`;
    const phase = state.phase;
    return `<div class="hand-label">Your hand</div><div class="hand-cards">${me.hand.map((face, i) => {
      let ai = -1;
      if (phase === 'place-initial') ai = actions.findIndex(a => a.type === 'placeInitial' && a.card === face);
      else if (phase === 'placement') ai = actions.findIndex(a => a.type === 'place' && a.card === face);
      else if (phase === 'discard') ai = actions.findIndex(a => a.type === 'discard' && a.cardIndex === i);
      const playable = ai >= 0;
      const attrs = playable ? `data-tut="hand-card" data-face="${face}" data-action-index="${ai}" role="button" tabindex="0" aria-label="${phase === 'discard' ? 'Discard' : 'Play'} ${face}"` : '';
      return cardHTML({ face, up: true, i, cls: `in-hand ${playable ? 'playable' : ''} ${phase === 'discard' && playable ? 'discardable' : ''}`, attrs });
    }).join('')}</div>`;
  }

  function renderLog(state) {
    if (state.log.length < logLen) { el.log.innerHTML = ''; logLen = 0; }
    if (state.log.length === logLen) return;
    const frag = state.log.slice(logLen).map(line => {
      const cls = /SKULL|loses|eliminated/.test(line) ? 'bad' : /wins/.test(line) ? 'good' : /Round \d+ begins/.test(line) ? 'round' : '';
      return `<li class="${cls}">${esc(line)}</li>`;
    }).join('');
    el.log.insertAdjacentHTML('beforeend', frag);
    logLen = state.log.length;
    el.log.scrollTop = el.log.scrollHeight;
  }

  // keyboard activation for role=button elements
  document.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-action-index]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  // next-round is handled by main (no player id); in round-over a tap anywhere on
  // the table deals the next round right away
  document.addEventListener('click', e => {
    if (e.target.closest('[data-cmd="next-round"]')) { handlers.onNextRound(); return; }
    if (last?.state.phase === 'round-over' && !last.view.locked && el.tableWrap.contains(e.target) &&
        !e.target.closest('button, a, input, [data-cmd], [data-action-index]')) handlers.onNextRound();
  });

  // ---------- banners & toasts ----------

  const BANNER_PRIORITY = { skull: 2, rose: 2, win: 3 };
  const BANNER_MIN_MS = 650;   // how long a banner stays once a newer one is waiting
  const bannerQueue = [];
  let currentBanner = null;    // { node, start, ms }
  let fastBanners = false;     // director-paced tables: only the latest beat matters
  let bannerTimer = null;

  function banner(text, { kind = 'info', sub = '', ms = 1500, art = null } = {}) {
    const pri = BANNER_PRIORITY[kind] || 1;
    if (fastBanners) { bannerQueue.length = 0; ms = Math.min(ms, 900); }
    // queued banners less important than this one are stale by now
    for (let i = bannerQueue.length - 1; i >= 0; i--) if (bannerQueue[i].pri < pri) bannerQueue.splice(i, 1);
    bannerQueue.push({ text, kind, sub, ms, art, pri });
    if (currentBanner) tickBanner(); else nextBanner();
  }

  function nextBanner() {
    const b = bannerQueue.shift();
    if (!b) { currentBanner = null; return; }
    const node = document.createElement('div');
    node.className = `banner ${b.kind}`;
    node.innerHTML = `${b.art ? `<div class="banner-art">${MINI[b.art]}</div>` : ''}<div class="banner-text">${esc(b.text)}</div>${b.sub ? `<div class="banner-sub">${esc(b.sub)}</div>` : ''}`;
    el.banners.appendChild(node);
    currentBanner = { node, start: performance.now(), ms: b.ms };
    tickBanner();
  }

  function tickBanner() {
    clearTimeout(bannerTimer);
    const { node, start, ms } = currentBanner;
    const limit = bannerQueue.length ? Math.min(ms, BANNER_MIN_MS) : ms;
    const left = limit - (performance.now() - start);
    if (left > 0) { bannerTimer = setTimeout(tickBanner, left); return; }
    if (bannerQueue.length) node.remove();   // replaced: don't let two banners overlap
    else { node.classList.add('out'); setTimeout(() => node.remove(), 300); }
    nextBanner();
  }

  function clearBanners() {
    clearTimeout(bannerTimer);
    bannerQueue.length = 0;
    currentBanner = null;
    el.banners.innerHTML = '';
  }

  function toast(text, kind = '') {
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = text;
    el.toasts.appendChild(node);
    const max = window.matchMedia('(max-width: 900px)').matches ? 2 : 3;
    while (el.toasts.children.length > max) el.toasts.firstElementChild.remove();
    setTimeout(() => { node.classList.add('out'); setTimeout(() => node.remove(), 350); }, 2400);
  }

  // ---------- game over ----------

  function showGameOver(state, humanId) {
    const w = state.players[state.winner];
    const youWin = state.winner === humanId;
    $('#gameover-title').textContent = youWin ? 'You win!' : `${w.name} wins`;
    $('#gameover-sub').textContent = youWin
      ? 'The bar is yours. Drinks are on the losers.'
      : `${w.name} took the table${w.wins >= 2 ? ' with two challenges' : ' as the last rider standing'}.`;
    $('#gameover-art').innerHTML = cardHTML({ face: youWin ? ROSE : SKULL, up: true, flip: true });
    if (!el.gameover.open) el.gameover.showModal();
  }

  function closeGameOver() { if (el.gameover.open) el.gameover.close(); }

  function setFastBanners(on) { fastBanners = !!on; }

  return { render, showSetup, showGame, reset, banner, toast, showGameOver, setFastBanners };
}
