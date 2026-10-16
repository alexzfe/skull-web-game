// End-to-end QA for Skull & Roses. Plays full games as the human through real
// UI clicks at desktop and mobile sizes, failing on console errors, page errors
// and stuck states. Usage: node e2e.mjs [--url http://localhost:5173/] [--headed]
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlows } from './flows.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(HERE, 'shots');
const argv = process.argv.slice(2);
const URL = argv.includes('--url') ? argv[argv.indexOf('--url') + 1] : 'http://localhost:5173/';
const HEADED = argv.includes('--headed');
const STUCK_MS = 10_000;
const GAME_TIMEOUT_MS = 12 * 60_000;

const VIEWPORTS = [
  { key: 'desktop', viewport: { width: 1280, height: 800 } },
  { key: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];
const OPPONENTS = [2, 3, 5];

mkdirSync(SHOTS, { recursive: true });

// Use the locally cached browsers in ~/.cache/ms-playwright, whatever revision
// they are, so no download is needed.
function cachedChromium() {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  const dirs = readdirSync(root).sort().reverse();
  for (const d of dirs) {
    const candidates = d.startsWith('chromium_headless_shell-') && !HEADED
      ? [join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(root, d, 'chrome-linux', 'headless_shell')]
      : d.startsWith('chromium-') ? [join(root, d, 'chrome-linux64', 'chrome'), join(root, d, 'chrome-linux', 'chrome')] : [];
    const hit = candidates.find(existsSync);
    if (hit) return hit;
  }
  return undefined;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- page probes ----------

// Snapshot of what the human can see / do right now.
async function probe(page) {
  return page.evaluate(() => {
    const vis = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const q = s => document.querySelector(s);
    const gameover = q('#gameover');
    const setupVisible = !q('#setup').hidden;
    const phase = q('#status .phase')?.textContent?.trim() || '';
    const round = q('#status .round')?.textContent?.trim() || '';
    const controls = [...document.querySelectorAll('#game [data-action-index]:not([disabled]), #game [data-cmd="next-round"]')]
      .filter(vis);
    const mine = q('#me-seat .seat');
    const handCards = document.querySelectorAll('#hand .card').length;
    const myStack = document.querySelectorAll('#me-seat .stack .card').length;
    const ownedText = q('#me-seat .owned')?.textContent || '';
    const seats = [...document.querySelectorAll('#opponents .seat')].map(s => ({
      name: s.querySelector('.seat-name')?.textContent,
      stack: s.querySelectorAll('.stack .card').length,
      count: s.querySelector('.stack-count')?.textContent ?? null,
      hand: s.querySelectorAll('.hand-mini i').length,
      out: s.classList.contains('eliminated'),
      wins: s.querySelectorAll('.wins i.on').length,
    }));
    return {
      setupVisible,
      gameoverOpen: !!gameover?.open,
      phase, round,
      status: q('#status')?.textContent?.trim() || '',
      prompt: q('#controls .prompt')?.textContent?.trim() || '',
      logLen: document.querySelectorAll('#log-list li').length,
      lastLog: [...document.querySelectorAll('#log-list li')].slice(-1)[0]?.textContent || '',
      controlCount: controls.length,
      meOut: !!mine?.classList.contains('eliminated'),
      handCards, myStack, ownedText, seats,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

// ---------- one game ----------

class RunFailure extends Error {}

async function playGame(page, ctx) {
  const { log, rng, shot, coverage, strategy, nextMode = 'button' } = ctx;
  const start = Date.now();
  let roundOver = null;   // { round, at, how } while waiting for the next round
  let lastSig = '';
  let lastChange = Date.now();
  let lastPhase = '';
  let actions = 0;
  let unresponsive = 0;

  while (true) {
    if (Date.now() - start > GAME_TIMEOUT_MS) throw new RunFailure(`game did not finish within ${GAME_TIMEOUT_MS / 60000} min`);
    const s = await probe(page);
    ctx.checkLayout(s);
    if (ctx.onTick) await ctx.onTick(s);

    if (s.phase && s.phase !== lastPhase) {
      lastPhase = s.phase;
      coverage.add(`phase:${s.phase}`);
      await shot(`phase-${s.phase.replace(/\W+/g, '-').toLowerCase()}`);
    }
    if (s.gameoverOpen) {
      coverage.add('gameover-dialog');
      await shot('gameover');
      return s;
    }

    const sig = [s.phase, s.round, s.status, s.logLen, s.prompt, s.controlCount].join('|');
    if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }

    // Next round: 'button' clicks Next round, 'tap' taps the felt, 'auto' waits for the ~2.5s auto-deal.
    if (roundOver && s.round !== roundOver.round) {
      const ms = Date.now() - roundOver.at;
      if (roundOver.how === 'auto') {
        const inPage = await page.evaluate(r => {
          const ph = window.__phases;
          const i = ph.findLastIndex(p => p.round === r && p.phase === 'Round over');
          const j = ph.findIndex((p, k) => k > i && p.round !== r);
          return i >= 0 && j > i ? Math.round(ph[j].t - ph[i].t) : null;
        }, roundOver.round);
        if (inPage == null || inPage < 2000 || inPage > 3500) throw new RunFailure(`next round auto-dealt after ${inPage}ms in page (expected ~2500)`);
        coverage.add('auto-next-round');
      }
      if (roundOver.how === 'tap') {
        const t = await page.evaluate(() => window.__tap);
        const dt = t?.down != null && t?.dealt != null ? Math.round(t.dealt - t.down) : null;
        if (t?.dealt != null && t.down != null && t.dealt < t.down) { /* auto-deal won the race */ } else if (dt == null || dt > 400) throw new RunFailure(`tap on the table didn't deal the next round right away (in-page ${dt}ms, wall ${ms}ms, tapped ${roundOver.hit})`);
        coverage.add('tap-next-round');
      }
      roundOver = null;
    }
    if (s.phase === 'Round over' && !s.meOut && nextMode !== 'button') {
      if (!roundOver) {
        roundOver = { round: s.round, at: Date.now(), how: nextMode };
        if (nextMode === 'tap') {
          await sleep(300);
          // a visible spot on the felt that isn't a control
          const pt = await page.evaluate(() => {
            const wrap = document.querySelector('#game .table-wrap');
            const r = wrap.getBoundingClientRect();
            for (let y = Math.max(r.top, 60) + 4; y < Math.min(r.bottom, innerHeight) - 4; y += 17) {
              for (let x = r.left + 4; x < r.right - 4; x += 23) {
                const e = document.elementFromPoint(x, y);
                if (e && wrap.contains(e) && !e.closest('button, a, input, [data-cmd], [data-action-index]')) return { x, y, hit: `${e.tagName}.${e.className}` };
              }
            }
            return null;
          });
          if (!pt) throw new RunFailure('no tappable spot on the table');
          roundOver.hit = pt.hit;
          // Time tap → deal inside the page, so a loaded test machine doesn't skew it.
          const stillOver = await page.evaluate(() => {
            window.__tap = { down: null, dealt: null };
            const round = () => document.querySelector('#status .round')?.textContent;
            const r0 = round();
            addEventListener('pointerdown', () => { window.__tap.down ??= performance.now(); }, { capture: true, once: true });
            new MutationObserver((_, obs) => { if (round() !== r0) { window.__tap.dealt = performance.now(); obs.disconnect(); } })
              .observe(document.getElementById('status'), { childList: true, subtree: true, characterData: true });
            return document.querySelector('#status .phase')?.textContent === 'Round over';
          });
          // On a loaded machine the 2.5s auto-deal can beat the tap; then there's nothing to time.
          if (!stillOver) roundOver.how = 'raced';
          await page.mouse.click(pt.x, pt.y);
          roundOver.at = Date.now();
          log('  [human] tap table (Round over)');
        }
      }
      if (Date.now() - roundOver.at > 6000) {
        await shot('NO-NEXT-ROUND');
        throw new RunFailure(`next round never started (${nextMode}) — still "${s.round}" after 6s`);
      }
      await sleep(100);
      continue;
    }

    if (s.controlCount === 0) {
      if (Date.now() - lastChange > STUCK_MS) {
        await shot('STUCK');
        throw new RunFailure(`STUCK: no human control and no activity for ${STUCK_MS / 1000}s. ` +
          `phase="${s.phase}" status="${s.status}" prompt="${s.prompt}" lastLog="${s.lastLog}"`);
      }
      await sleep(150);
      continue;
    }

    // Human has something to do.
    const before = sig;
    const did = await humanMove(page, s, rng, coverage, strategy, log);
    if (!did) { await sleep(150); continue; }
    actions++;
    // Wait for the click to have an effect.
    const t0 = Date.now();
    let changed = false;
    while (Date.now() - t0 < 5000) {
      await sleep(80);
      const s2 = await probe(page).catch(() => null);
      if (!s2) break;
      const sig2 = [s2.phase, s2.round, s2.status, s2.logLen, s2.prompt, s2.controlCount].join('|');
      if (sig2 !== before || s2.gameoverOpen || s2.setupVisible) { changed = true; break; }
    }
    if (!changed) {
      unresponsive++;
      if (unresponsive >= 3) {
        await shot('UNRESPONSIVE');
        throw new RunFailure(`human click had no visible effect 3 times in a row (phase="${s.phase}", prompt="${s.prompt}")`);
      }
    } else unresponsive = 0;
  }
}

// Clicks one human control chosen by phase-aware random strategy. Returns true if clicked.
async function humanMove(page, s, rng, coverage, strategy, log) {
  const click = async (locator, label) => {
    try {
      await locator.click({ timeout: 4000 });
      coverage.add(`click:${label}`);
      log(`  [human] ${label} (${s.phase})`);
      return true;
    } catch (e) {
      log(`  [human] click failed: ${label}: ${e.message.split('\n')[0]}`);
      return false;
    }
  };
  const visibleAll = async sel => {
    const loc = page.locator(sel);
    const n = await loc.count();
    const out = [];
    for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) out.push(loc.nth(i));
    return out;
  };

  const nextRound = await visibleAll('#controls [data-cmd="next-round"]');
  if (nextRound.length) return click(nextRound[0], 'next-round');

  const handPlayable = await visibleAll('#hand .card.playable[data-action-index]');
  const ownFlip = await visibleAll('#controls button[data-action-index]:has-text("Flip my top card")');
  const targets = await visibleAll('#opponents .seat.target[data-action-index]');
  const pass = await visibleAll('#controls button[data-action-index]:has-text("Pass")');
  const bidBtn = await visibleAll('#controls .bidrow button.primary[data-action-index]');
  const chooseBtns = await visibleAll('#controls .row.wrap button[data-action-index]');

  if (ownFlip.length) return click(ownFlip[0], 'reveal-own');
  if (targets.length) return click(pick(rng, targets), 'reveal-opponent');
  if (chooseBtns.length) return click(pick(rng, chooseBtns), 'choose-first');

  if (s.phase === 'Discard' && handPlayable.length) {
    if (strategy === 'suicide') {
      const rose = await visibleAll('#hand .card.playable[aria-label="Discard rose"]');
      if (rose.length) return click(rose[0], 'discard');
    }
    return click(pick(rng, handPlayable), 'discard');
  }

  if (s.phase === 'Lay down' && handPlayable.length) {
    // skull-heavy strategy makes own-skull losses (discard / choose-first) likely
    const skull = await visibleAll('#hand .card.playable[aria-label="Play skull"]');
    if ((strategy === 'reckless' || strategy === 'suicide') && skull.length) return click(skull[0], 'place-initial-skull');
    return click(pick(rng, handPlayable), 'place-initial');
  }

  // Stepper: random number of +/- presses before bidding
  const adjustBid = async (towardsMax) => {
    const presses = towardsMax ? 12 : Math.floor(rng() * 3);
    for (let i = 0; i < presses; i++) {
      const inc = page.locator('#controls [data-cmd="bid-inc"]:not([disabled])');
      if (!(await inc.count())) break;
      await inc.first().click({ timeout: 2000 }).catch(() => {});
      coverage.add('click:bid-inc');
    }
    if (!towardsMax && rng() < 0.3) {
      const dec = page.locator('#controls [data-cmd="bid-dec"]:not([disabled])');
      if (await dec.count()) { await dec.first().click({ timeout: 2000 }).catch(() => {}); coverage.add('click:bid-dec'); }
    }
  };

  if (s.phase === 'Stack or challenge' && strategy === 'suicide' && bidBtn.length) {
    // bid the max right away: instant challenger, own skull on top -> lose to own skull
    await adjustBid(true);
    const b = await visibleAll('#controls .bidrow button.primary[data-action-index]');
    if (b.length) return click(b[0], 'bid-open');
  }
  if (s.phase === 'Stack or challenge') {
    if (handPlayable.length && rng() < (strategy === 'reckless' ? 0.15 : 0.55)) {
      const skull = await visibleAll('#hand .card.playable[aria-label="Play skull"]');
      if (strategy === 'reckless' && skull.length) return click(skull[0], 'place-skull');
      return click(pick(rng, handPlayable), 'place');
    }
    if (bidBtn.length) {
      await adjustBid(strategy === 'reckless');
      const b = await visibleAll('#controls .bidrow button.primary[data-action-index]');
      if (b.length) return click(b[0], 'bid-open');
    }
    if (handPlayable.length) return click(pick(rng, handPlayable), 'place');
  }

  if (s.phase === 'Bidding') {
    if (pass.length && (strategy === 'suicide' || rng() < 0.6 || !bidBtn.length)) return click(pass[0], 'pass');
    if (bidBtn.length) {
      await adjustBid(strategy === 'reckless' && rng() < 0.5);
      const b = await visibleAll('#controls .bidrow button.primary[data-action-index]');
      if (b.length) return click(b[0], 'bid-raise');
    }
  }

  // Fallback: any visible action control
  const any = await visibleAll('#game [data-action-index]:not([disabled])');
  if (any.length) return click(pick(rng, any), `fallback(${s.phase})`);
  return false;
}

// ---------- a run = one viewport, one table size ----------

function watchErrors(page, errors) {
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
}

async function startGame(page, opponents) {
  // Name + opponents live behind the "Table settings" disclosure (kept open after Change table).
  if (!(await page.locator('#table-settings').evaluate(d => d.open))) await page.click('#table-settings summary');
  await page.fill('#player-name', 'QA Rider');
  await page.locator('#setup .seg label', { hasText: String(opponents) }).click();
  await page.click('#play-now');
  await page.waitForSelector('#game:not([hidden])', { timeout: 5000 });
  const seats = await page.locator('#opponents .seat').count();
  if (seats !== opponents) throw new RunFailure(`expected ${opponents} opponent seats, found ${seats}`);
}

async function run(browser, vp, opponents, { seed, extraGames = 0, strategy = 'normal', tag = '', untilCovered = null, nextMode = 'button' }) {
  const name = `${vp.key}-${opponents}opp${tag}`;
  const lines = [];
  const log = m => lines.push(m);
  const errors = [];
  const layout = new Set();
  const coverage = new Set();
  const context = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
  // Clean game runs: no first-game tips, tutorial counted as done (tips/tutorial have their own scenarios).
  await context.addInitScript(() => { try { localStorage.setItem('skull.tipsOff', '1'); localStorage.setItem('skull.tutorialDone', '1'); } catch {} });
  // In-page phase timeline, for timing checks that a loaded test machine can't skew.
  await context.addInitScript(() => {
    window.__phases = [];
    addEventListener('DOMContentLoaded', () => {
      const status = document.getElementById('status');
      let last = '';
      new MutationObserver(() => {
        const phase = status.querySelector('.phase')?.textContent, round = status.querySelector('.round')?.textContent;
        const k = `${round}|${phase}`;
        if (k !== last) { last = k; window.__phases.push({ phase, round, t: performance.now() }); }
      }).observe(status, { childList: true, subtree: true, characterData: true });
    });
  });
  const page = await context.newPage();
  watchErrors(page, errors);

  let game = 0;
  const shot = async label => {
    await page.screenshot({ path: join(SHOTS, `${name}-g${game}-${label}.png`) }).catch(() => {});
  };
  const ctx = {
    log, rng: seeded(seed), shot, coverage, strategy, nextMode,
    checkLayout(s) {
      if (s.overflowX > 1) layout.add(`horizontal overflow of ${s.overflowX}px in phase "${s.phase}"`);
    },
  };

  const result = { name, ok: true, games: 0, winners: [], errors, layout, coverage, failure: null, lines };
  try {
    await page.goto(URL, { waitUntil: 'load' });
    await shot('setup');
    await startGame(page, opponents);
    for (game = 1; game <= 1 + extraGames; game++) {
      const final = await playGame(page, ctx);
      result.games++;
      result.winners.push((await page.textContent('#gameover-title'))?.trim());
      log(`game ${game} over: ${result.winners.at(-1)} (human out: ${final.meOut})`);
      // Rematch -> must give a fresh round 1, instantly (no dialog round-trip)
      if (!/Rematch/i.test(await page.textContent('#gameover [data-cmd="play-again"]'))) throw new RunFailure('game-over primary button is not "Rematch"');
      // Timed inside the page (pointerdown → fresh Round 1 rendered), so a loaded machine doesn't skew it.
      await page.evaluate(() => {
        window.__rematch = { down: null, ready: null };
        addEventListener('pointerdown', () => { window.__rematch.down ??= performance.now(); }, { capture: true, once: true });
        const done = () => !document.querySelector('#gameover').open && /Round 1\b/.test(document.querySelector('#status .round')?.textContent || '')
          && document.querySelectorAll('#log-list li').length <= 2;
        new MutationObserver((_, obs) => { if (done()) { window.__rematch.ready = performance.now(); obs.disconnect(); } })
          .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      });
      await page.click('#gameover [data-cmd="play-again"]');
      coverage.add('click:play-again');
      await page.waitForFunction(() => window.__rematch.ready != null, null, { timeout: 3000 })
        .catch(() => { throw new RunFailure('Rematch did not reach a fresh Round 1 within 3s'); });
      const rematchMs = await page.evaluate(() => Math.round(window.__rematch.ready - window.__rematch.down));
      if (rematchMs > 500) throw new RunFailure(`Rematch took ${rematchMs}ms (in page) to reach Round 1`);
      const s = await probe(page);
      if (!/Round 1\b/.test(s.round) || s.phase !== 'Lay down') throw new RunFailure(`after Play again expected Round 1 / Lay down, got "${s.round}" / "${s.phase}"`);
      const seats = s.seats;
      if (seats.length !== opponents || seats.some(x => x.out || x.stack > 1 || x.wins)) {
        throw new RunFailure(`after Play again table not reset: ${JSON.stringify(seats)}`);
      }
      if (s.handCards + s.myStack !== 4) throw new RunFailure(`after Play again human has ${s.handCards + s.myStack} cards, expected 4`);
      await shot('play-again');
      if (untilCovered && coverage.has(untilCovered)) break;
    }
    // Change table -> setup screen
    await page.click('#game [data-cmd="new-game"]');
    await page.waitForSelector('#setup:not([hidden])', { timeout: 3000 });
    coverage.add('click:new-game');
  } catch (e) {
    result.ok = false;
    result.failure = e.message;
    await shot('FAIL');
  }
  if (errors.length) result.ok = false;
  await context.close();
  return result;
}

// ---------- main ----------

const executablePath = cachedChromium();
const browser = await chromium.launch({ headless: !HEADED, executablePath });
console.log(`Browser: ${executablePath ?? 'playwright default'}\nURL: ${URL}`);

// QA_ONLY=<regex> restricts which runs execute, e.g. QA_ONLY=suicide
const ONLY = process.env.QA_ONLY ? new RegExp(process.env.QA_ONLY) : null;
const specs = [];
let seed = 1000;
for (const vp of VIEWPORTS) {
  for (const n of OPPONENTS) {
    // 2-opponent table also plays the post-"Play again" game to the end.
    // Next round via the button (2 opp), the auto-deal (3 opp) or a tap on the felt (5 opp).
    specs.push([vp, n, { seed: seed++, extraGames: n === 2 ? 1 : 0, nextMode: { 2: 'button', 3: 'auto', 5: 'tap' }[n] }]);
  }
  // Reckless human: places skulls and bids high, to hit discard / elimination.
  specs.push([vp, 3, { seed: seed++, strategy: 'reckless', extraGames: 2, tag: '-reckless' }]);
  // Suicidal human: lays the skull, opens at 1, keeps the skull -> eliminated by own skull -> choose-first.
  specs.push([vp, 5, { seed: seed++, strategy: 'suicide', extraGames: 3, tag: '-suicide', untilCovered: 'click:choose-first' }]);
}
const selected = specs.filter(([vp, n, o]) => !ONLY || ONLY.test(`${vp.key}-${n}opp${o.tag ?? ''}`));
// Game runs and the tutorial / tips / quick-start scenarios (flows.mjs) run side by side.
const helpers = { VIEWPORTS, RunFailure, sleep, seeded, watchErrors, playGame, probe, SHOTS, URL };
const [gameResults, flowResults] = await Promise.all([
  Promise.all(selected.map(([vp, n, o]) => run(browser, vp, n, o))),
  process.env.QA_NO_FLOWS ? [] : runFlows(browser, helpers, ONLY),
]);
const results = [...gameResults, ...flowResults];
await browser.close();

const allCoverage = new Set(results.flatMap(r => [...r.coverage]));
let failed = 0;
for (const r of results) {
  if (/-skip-\d+$/.test(r.name) && r.ok && !r.layout.size) continue;   // summarised below
  const status = r.ok && !r.layout.size ? 'PASS' : r.ok ? 'PASS (layout warnings)' : 'FAIL';
  if (!r.ok) failed++;
  console.log(`\n=== ${r.name}: ${status} — ${r.games} game(s); winners: ${r.winners.join(', ') || '-'}`);
  if (r.failure) console.log(`  failure: ${r.failure}`);
  for (const e of [...new Set(r.errors)]) console.log(`  ${e}`);
  for (const l of r.layout) console.log(`  layout: ${l}`);
  if (process.env.QA_VERBOSE) for (const l of r.lines) console.log(l);
}
const skips = results.filter(r => /-skip-\d+$/.test(r.name));
if (skips.length) console.log(`\n=== Skip at every tutorial step: ${skips.filter(r => r.ok).length}/${skips.length} passed`);
const wanted = ['phase:Lay down', 'phase:Stack or challenge', 'phase:Bidding', 'phase:Reveal', 'phase:Discard',
  'phase:Choose starter', 'phase:Round over', 'click:place-initial', 'click:place', 'click:bid-open', 'click:bid-raise', 'click:pass',
  'click:reveal-own', 'click:reveal-opponent', 'click:discard', 'click:choose-first', 'click:next-round', 'auto-next-round', 'tap-next-round', 'click:play-again', 'gameover-dialog',
  ...(process.env.QA_NO_FLOWS ? [] : ['tutorial-finished', 'finale:solo', 'finale:replay', 'lock-swallowed-click', 'skip-ok', 'play-now-one-click',
    'tip:first-player', 'tip:lost-bet', 'tip:last-card', 'click:tips-off', 'tips-off-after-first-game'])];
const missing = wanted.filter(w => !allCoverage.has(w) && !(w === 'click:place-initial' && allCoverage.has('click:place-initial-skull')) && !(w === 'click:place' && allCoverage.has('click:place-skull')));
console.log(`\nCoverage: ${[...allCoverage].sort().join(', ')}`);
if (missing.length) console.log(`Not exercised this run (random play): ${missing.join(', ')}`);
console.log(`\n${failed ? `FAILED: ${failed}/${results.length} runs` : `ALL ${results.length} RUNS PASSED`}`);
process.exit(failed ? 1 : 0);
