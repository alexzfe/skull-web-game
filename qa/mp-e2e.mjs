// Multiplayer end-to-end QA (MULTIPLAYER_SPEC §11). Starts `wrangler dev` on a
// fresh local state dir, then drives three real browser contexts through one
// room: host (desktop 1280x800) creates a lobby, Ann (mobile 390x844) joins by
// typed code, Bob (mobile) by the share link; the host adds a filler bot, sets a
// 20s timer, and a fourth "scout" context checks the Open/Private lobby list.
// A full game is then played through real clicks, with scripted incidents:
// reactions + tomato (seen on the other clients), Ann refreshes mid-turn (same
// seat), the host idles until ⏱ auto move, Bob Leaves mid-round (forfeit at round
// end) and comes back by link as a late joiner, then the host calls Rematch.
// Every view frame and every page's DOM is checked for hidden card faces.
//
// Usage: node mp-e2e.mjs [--port 8787] [--headed] [--swap] [--url http://localhost:8787/]
//   --swap (or QA_MP_SWAP=1): host + scout on mobile, joiners on desktop.
//   --url skips starting wrangler and uses an already running server.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SHOTS = join(HERE, 'shots');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const HEADED = argv.includes('--headed');
const PORT = Number(arg('--port', 8787));
const EXTERNAL = arg('--url', null);
const BASE = (EXTERNAL || `http://127.0.0.1:${PORT}/`).replace(/\/?$/, '/');
const GAME_TIMEOUT_MS = 12 * 60_000;
const TIMER_S = 20;
const SWAP = argv.includes('--swap') || !!process.env.QA_MP_SWAP;   // host on mobile, joiners on desktop

const DESKTOP = { viewport: { width: 1280, height: 800 } };
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...m) => console.log(stamp(), ...m);

const players = [];
const failures = [];     // hard failures (the run fails)
const findings = [];     // soft findings (reported, run still passes)
const coverage = new Set();
const fail = m => { failures.push(m); log(`FAIL: ${m}`); };
const note = m => { findings.push(m); log(`finding: ${m}`); };
class Abort extends Error {}

function cachedChromium() {
  const root = join(homedir(), '.cache', 'ms-playwright');
  if (!existsSync(root)) return undefined;
  for (const d of readdirSync(root).sort().reverse()) {
    const c = d.startsWith('chromium_headless_shell-') && !HEADED
      ? [join(root, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'), join(root, d, 'chrome-linux', 'headless_shell')]
      : d.startsWith('chromium-') ? [join(root, d, 'chrome-linux64', 'chrome'), join(root, d, 'chrome-linux', 'chrome')] : [];
    const hit = c.find(existsSync);
    if (hit) return hit;
  }
  return undefined;
}

// ---------- wrangler dev ----------

let wrangler = null;
let persistDir = null;

// wrangler dev watches its whole asset directory (the repo root), and any write
// there (our own screenshots, another session's edits) reloads the worker and
// drops every socket. So it runs from a snapshot of the app in a temp dir.
function snapshotApp(dir) {
  const skip = new Set(['node_modules', 'qa', 'test', '.git', '.wrangler']);
  for (const name of readdirSync(ROOT)) {
    if (skip.has(name) || /\.(md|pdf)$/.test(name)) continue;
    cpSync(join(ROOT, name), join(dir, name), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
}

async function startWrangler() {
  persistDir = mkdtempSync(join(tmpdir(), 'skull-mp-qa-'));
  const app = join(persistDir, 'app');
  mkdirSync(app);
  snapshotApp(app);
  const bin = join(ROOT, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(bin)) throw new Error('wrangler not installed: run `npm install` in the repo root');
  // Own process group, so stopping it also stops the workerd child it spawns (and nothing else).
  wrangler = spawn(bin, ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', join(persistDir, 'state')],
    { cwd: app, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  log(`wrangler dev started, pid ${wrangler.pid}`);
  const out = [];
  wrangler.stdout.on('data', d => { out.push(String(d)); if (/Reloading local server/.test(String(d))) note('wrangler dev reloaded mid-run (all sockets dropped)'); });
  wrangler.stderr.on('data', d => out.push(String(d)));
  for (let i = 0; i < 120; i++) {
    if (wrangler.exitCode != null) throw new Error(`wrangler exited early:\n${out.join('')}`);
    try { if ((await fetch(`${BASE}api/lobbies`)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`wrangler dev not ready after 60s:\n${out.join('').slice(-2000)}`);
}

function stopWrangler() {
  if (!wrangler || wrangler.exitCode != null) return;
  try { process.kill(-wrangler.pid, 'SIGTERM'); } catch { try { wrangler.kill('SIGTERM'); } catch { /* gone */ } }
  log(`wrangler dev (pid ${wrangler.pid}) stopped`);
  if (persistDir) try { rmSync(persistDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('SIGINT', () => { stopWrangler(); process.exit(130); });

// ---------- players ----------

// What a page's socket has seen: latest view/lobby, every event and error.
function trackSocket(p) {
  p.ws = { view: null, seq: 0, lobby: null, events: [], errors: [], views: 0, leaks: [], autos: [] };
  p.ws.sent = [];
  p.page.on('websocket', ws => {
    ws.on('framesent', f => { p.ws.sent.push(`${stamp()} ${String(f.payload).slice(0, 120)}`); });
    ws.on('framereceived', f => {
      let m;
      try { m = JSON.parse(f.payload); } catch { return; }
      if (m.t === 'view') {
        p.ws.views++;
        p.ws.view = m.view; p.ws.seq = m.seq; p.ws.meta = m;
        for (const l of viewLeaks(m.view)) p.ws.leaks.push(`seq ${m.seq}: ${l}`);
        const a = m.view.lastAction;
        if (a?.auto && !p.ws.autos.some(x => x.n === a.n)) {
          p.ws.autos.push({ ...a, at: Date.now() });
          if (p.key === 'host') log(`⏱ auto move by player ${a.player}: ${a.type}`);
        }
      } else if (m.t === 'lobby') p.ws.lobby = m.lobby;
      else if (m.t === 'event') p.ws.events.push({ ...m, at: Date.now() });
      else if (m.t === 'error') p.ws.errors.push(m.msg);
    });
  });
}

// No hidden face of another player may reach this client (§3 view filtering).
function viewLeaks(v) {
  const out = [];
  for (const pl of v.players) {
    if (pl.id === v.me) continue;
    if (pl.hand.some(c => c != null)) out.push(`player ${pl.id} hand faces visible`);
    const hidden = pl.mat.length - pl.revealed;
    for (let i = 0; i < hidden; i++) if (pl.mat[i] != null) out.push(`player ${pl.id} unrevealed mat[${i}] = ${pl.mat[i]}`);
  }
  if (v.lastResult && 'discarded' in v.lastResult && v.lastResult.challenger !== v.me) out.push('lastResult.discarded sent to a non-challenger');
  const a = v.lastAction;
  if (a && (a.type === 'place' || a.type === 'placeInitial') && 'card' in a) out.push(`lastAction ${a.type} carries card`);
  if (a && a.type === 'discard' && ('cardIndex' in a || 'card' in a)) out.push('lastAction discard carries the card');
  if (v.xray) out.push('x-ray sent in multiplayer');
  return out;
}

const ALLOWED_404 = [/WebSocket connection to .* failed.*404/i, /Failed to load resource.*404/i];

function watchPage(p) {
  p.errors = [];
  p.allow404 = false;
  const push = e => {
    if (p.allow404 && ALLOWED_404.some(r => r.test(e))) { coverage.add('allowed-404'); return; }
    p.errors.push(e);
  };
  p.page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') push(`console.${m.type()}: ${m.text()}`); });
  p.page.on('pageerror', e => push(`pageerror: ${e.message}`));
  p.page.on('requestfailed', r => {
    const why = r.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(why) && p.navigating) return;   // in-flight requests cut by our own reload
    push(`requestfailed: ${r.url()} ${why}`);
  });
}

async function makePlayer(browser, key, name, vp) {
  const context = await browser.newContext({ ...vp });
  await context.addInitScript(n => {
    try {
      localStorage.setItem('skull.tipsOff', '1');
      localStorage.setItem('skull.tutorialDone', '1');
      if (!localStorage.getItem('skull.settings')) localStorage.setItem('skull.settings', JSON.stringify({ name: n, opponents: 3 }));
    } catch { /* ignore */ }
  }, name);
  // Record every socket close (code/reason) in the page, for diagnosing reconnects.
  await context.addInitScript(() => {
    window.__wsCloses = [];
    const W = window.WebSocket;
    window.WebSocket = class extends W {
      constructor(...a) {
        super(...a);
        const t0 = performance.now();
        this.addEventListener('close', e => window.__wsCloses.push({ code: e.code, reason: e.reason, clean: e.wasClean, lived: Math.round(performance.now() - t0) }));
      }
    };
  });
  const page = await context.newPage();
  const p = { key, name, vp, context, page, size: vp === MOBILE ? 'mobile' : 'desktop', phasesShot: new Set(), maxOverflow: 0 };
  trackSocket(p);
  watchPage(p);
  players.push(p);
  return p;
}

const shot = (p, label) => p.page.screenshot({ path: join(SHOTS, `mp-${label}-${p.key}-${p.size}.png`) }).catch(() => {});

// Snapshot of what this player can see/do, plus DOM-level hiding checks.
async function probe(p) {
  return p.page.evaluate(() => {
    const q = s => document.querySelector(s);
    const vis = el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    const screen = ['setup', 'joinlink', 'lobby', 'game'].find(id => { const n = document.getElementById(id); return n && !n.hidden; }) || '';
    const leaks = [];
    if (screen === 'game') {
      // Opponents: a face-down card must have an empty front and no peek.
      document.querySelectorAll('#opponents .seat').forEach(seat => {
        seat.querySelectorAll('.card').forEach((c, i) => {
          if (c.classList.contains('up')) return;
          if (c.querySelector('.card-front')?.innerHTML.trim()) leaks.push(`face-down card ${i} of seat ${seat.dataset.player} has a face in its front`);
          if (c.querySelector('.peek')) leaks.push(`face-down card ${i} of seat ${seat.dataset.player} has a peek`);
        });
      });
      document.querySelectorAll('#game .peek').forEach(n => { if (!n.closest('#me-seat')) leaks.push('peek outside my seat'); });
      document.querySelectorAll('#game [data-face]').forEach(n => { if (!n.closest('#hand')) leaks.push(`[data-face=${n.dataset.face}] outside my hand`); });
      document.querySelectorAll('#opponents .hand-mini').forEach(h => { if (h.querySelector('svg, [data-face]')) leaks.push('opponent hand-mini shows a face'); });
    }
    const controls = screen === 'game'
      ? [...document.querySelectorAll('#game [data-action-index]:not([disabled])')].filter(vis).length : 0;
    const meSeat = q('#me-seat .seat');
    return {
      screen,
      phase: q('#status .phase')?.textContent?.trim() || '',
      round: q('#status .round')?.textContent?.trim() || '',
      prompt: q('#controls .prompt')?.textContent?.trim() || '',
      logLen: document.querySelectorAll('#log-list li').length,
      autoTags: document.querySelectorAll('#log-list .auto-tag').length,
      controls,
      meId: meSeat ? Number(meSeat.dataset.player) : null,
      meName: q('#me-seat .seat-name')?.textContent || '',
      meOut: !!meSeat?.classList.contains('eliminated'),
      myRing: !!q('#me-seat .seat .ring'),
      nudge: !!q('#me-seat.nudge'),
      lobbyResult: q('#lobby .lobby-result')?.textContent?.trim() || '',
      startLabel: q('#lobby [data-lobby="start"]')?.textContent?.trim() || '',
      lobbyText: q('#lobby-body')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      gameoverOpen: !!q('#gameover')?.open,
      leaks,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    };
  }).catch(() => null);
}

function checkProbe(p, s) {
  if (!s) return;
  if (s.overflowX > 1 && s.overflowX > p.maxOverflow) {
    p.maxOverflow = s.overflowX;
    note(`${p.key} (${p.size}): horizontal scroll of ${s.overflowX}px on ${s.screen}${s.phase ? ` / ${s.phase}` : ''}`);
    shot(p, `OVERFLOW-${s.screen}`);
  }
  for (const l of s.leaks) if (!p.leakSeen?.has(l)) {
    (p.leakSeen ??= new Set()).add(l);
    fail(`${p.key}: DOM shows a hidden card: ${l}`);
    shot(p, 'LEAK');
  }
  if (s.screen === 'game' && s.phase && !p.phasesShot.has(s.phase)) {
    p.phasesShot.add(s.phase);
    coverage.add(`phase:${s.phase}`);
    shot(p, `game-${s.phase.replace(/\W+/g, '-').toLowerCase()}`);
  }
}

async function waitFor(p, pred, ms, what) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await probe(p);
    checkProbe(p, s);
    if (s && pred(s)) return s;
    await sleep(120);
  }
  await shot(p, `TIMEOUT-${what.replace(/\W+/g, '-')}`);
  throw new Abort(`${p.key}: timed out after ${ms / 1000}s waiting for ${what} (screen=${s?.screen} phase=${s?.phase} prompt="${s?.prompt}")` +
    `\n    socket closes: ${JSON.stringify(await p.page.evaluate(() => window.__wsCloses).catch(() => null))}` +
    `\n    last frames sent: ${p.ws.sent.slice(-4).join(' | ')}\n    server errors: ${p.ws.errors.join(', ') || 'none'}; lobby phase ${p.ws.lobby?.phase}`);
}

async function waitWs(p, pred, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(p.ws)) return true;
    await sleep(100);
  }
  throw new Abort(`${p.key}: timed out after ${ms / 1000}s waiting for ${what}`);
}

// ---------- one human move through the UI ----------

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

async function visibleAll(page, sel) {
  const loc = page.locator(sel);
  const n = await loc.count().catch(() => 0);
  const out = [];
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) out.push(loc.nth(i));
  return out;
}

async function humanMove(p, s) {
  const { page } = p;
  const click = async (loc, label) => {
    try { await loc.click({ timeout: 3000 }); coverage.add(`click:${label}`); return true; } catch { return false; }
  };
  const ownFlip = await visibleAll(page, '#controls button[data-action-index]:has-text("Flip my top card")');
  if (ownFlip.length) return click(ownFlip[0], 'reveal-own');
  const targets = await visibleAll(page, '#opponents .seat.target[data-action-index]');
  if (targets.length) return click(pick(targets), 'reveal-opponent');
  const choose = await visibleAll(page, '#controls .row.wrap button[data-action-index]');
  if (choose.length) return click(pick(choose), 'choose-first');
  const hand = await visibleAll(page, '#hand .card.playable[data-action-index]');
  if (s.phase === 'Discard' && hand.length) return click(pick(hand), 'discard');
  if (s.phase === 'Lay down' && hand.length) return click(pick(hand), 'place-initial');
  const bid = await visibleAll(page, '#controls .bidrow button.primary[data-action-index]');
  const pass = await visibleAll(page, '#controls button[data-action-index]:has-text("Pass")');
  const bump = async () => {
    for (let i = Math.floor(Math.random() * 3); i > 0; i--) {
      const inc = page.locator('#controls [data-cmd="bid-inc"]:not([disabled])');
      if (await inc.count()) await inc.first().click({ timeout: 2000 }).catch(() => {});
    }
  };
  if (s.phase === 'Stack or challenge') {
    if (hand.length && Math.random() < 0.5) return click(pick(hand), 'place');
    if (bid.length) { await bump(); const b = await visibleAll(page, '#controls .bidrow button.primary[data-action-index]'); if (b.length) return click(b[0], 'bid-open'); }
    if (hand.length) return click(pick(hand), 'place');
  }
  if (s.phase === 'Bidding') {
    if (pass.length && (Math.random() < 0.6 || !bid.length)) return click(pass[0], 'pass');
    if (bid.length) { await bump(); const b = await visibleAll(page, '#controls .bidrow button.primary[data-action-index]'); if (b.length) return click(b[0], 'bid-raise'); }
  }
  const any = await visibleAll(page, '#game [data-action-index]:not([disabled])');
  if (any.length) return click(pick(any), `fallback(${s.phase})`);
  return false;
}

// Plays this player's turns until `stop(s)` is true; `hook(s)` may run a scripted incident first.
async function playLoop(p, { stop, hook }) {
  const start = Date.now();
  let unresponsive = 0;
  while (true) {
    if (Date.now() - start > GAME_TIMEOUT_MS) throw new Abort(`${p.key}: game did not finish within ${GAME_TIMEOUT_MS / 60000} min`);
    const s = await probe(p);
    checkProbe(p, s);
    if (!s) { await sleep(150); continue; }
    const tr = `${s.screen}|${s.phase}|${s.round}|controls=${s.controls}|${s.prompt}`;
    if (tr !== p.lastTrail) { p.lastTrail = tr; (p.trail ??= []).push(`${stamp()} ${tr}`); }
    if (stop(s)) return s;
    // The server says it's my move (I'm on the clock) but the UI offers nothing: a hidden control.
    const d = p.ws.meta?.deadline, me = p.ws.view?.me;
    if (s.screen === 'game' && !s.controls && d && me != null && (d.ats?.[me] != null || d.players?.includes(me))) {
      p.noCtl ??= { since: Date.now() };
      if (!p.noCtl.reported && Date.now() - p.noCtl.since > 4000) {
        p.noCtl.reported = true;
        note(`${p.key} (${p.size}): on the clock for 4s+ but no control shown (phase "${s.phase}", prompt "${s.prompt}", server phase ${p.ws.view.phase})`);
        await shot(p, 'NO-CONTROLS');
      }
    } else p.noCtl = null;
    if (hook && await hook(s)) continue;
    if (s.screen !== 'game' || !s.controls) { await sleep(120); continue; }
    const sig = `${s.phase}|${s.round}|${s.logLen}|${s.prompt}|${s.controls}`;
    const t1 = Date.now();
    const did = await humanMove(p, s);
    (p.trail ??= []).push(`${stamp()}   move ${did ? 'clicked' : 'none'} (${Date.now() - t1}ms) ${[...coverage].length}`);
    if (!did) { await sleep(150); continue; }
    let changed = false;
    for (let t = Date.now(); Date.now() - t < 4000;) {
      await sleep(80);
      const s2 = await probe(p);
      if (!s2 || s2.screen !== 'game' || `${s2.phase}|${s2.round}|${s2.logLen}|${s2.prompt}|${s2.controls}` !== sig) { changed = true; break; }
    }
    if (changed) unresponsive = 0;
    else if (++unresponsive >= 3) { await shot(p, 'UNRESPONSIVE'); throw new Abort(`${p.key}: click had no effect 3 times in a row (phase ${s.phase}, prompt "${s.prompt}")`); }
  }
}

// ---------- scenario steps ----------

async function lobbyCodes(scout) {
  return scout.page.$$eval('#lobby-list .lobby-row[data-code]', rows => rows.map(r => r.dataset.code)).catch(() => []);
}

async function expectListed(scout, code, want, what) {
  // The join bubble polls every 3s.
  const end = Date.now() + 9000;
  while (Date.now() < end) {
    const codes = await lobbyCodes(scout);
    if (codes.includes(code) === want) { coverage.add(`list:${what}`); return true; }
    await sleep(250);
  }
  fail(`open lobby list: ${code} ${want ? 'missing' : 'still listed'} when ${what}`);
  await shot(scout, `LIST-${what}`);
  return false;
}

async function setupLobby({ host, ann, bob, scout }) {
  for (const p of [host, ann, bob, scout]) {
    await p.page.goto(BASE, { waitUntil: 'load' });
  }
  // Host: name on the home screen, Host a game → lobby.
  await host.page.fill('#player-name', host.name);
  await host.page.click('#host-game');
  await host.page.waitForSelector('#lobby:not([hidden])', { timeout: 8000 });
  await host.page.waitForFunction(() => /^[A-Z]{4}$/.test(document.querySelector('#lobby-code')?.textContent || ''), null, { timeout: 8000 });
  const code = (await host.page.textContent('#lobby-code')).trim();
  log(`room ${code} created`);
  await host.page.waitForSelector('#lobby .ls.me', { timeout: 5000 });
  coverage.add('host-lobby');

  // Share button → link on the clipboard (desktop has no navigator.share).
  await host.page.click('[data-lobby="share"]');
  let link = await host.page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  if (!link.includes(`#/r/${code}`)) { note(`share button did not put the link on the clipboard (got "${link}")`); link = `${BASE}#/r/${code}`; }
  else coverage.add('share-link-copied');

  // Host options: timer 20s (Open is the default).
  await host.page.click(`[data-lobby="timer"][data-value="${TIMER_S}"]`);
  await waitWs(host, w => w.lobby?.options?.timer === TIMER_S, 4000, 'timer option');
  if (!host.ws.lobby.options.open) fail('a new lobby is not Open by default');

  // Scout: the open list shows the room; a bad code says so.
  await scout.page.click('#join-game');
  await expectListed(scout, code, true, 'open');
  await shot(scout, 'home-open-list');
  scout.allow404 = true;
  const bad = code === 'ZZZZ' ? 'YYYY' : 'ZZZZ';
  await scout.page.fill('#join-code', '');
  await scout.page.type('#join-code', bad.toLowerCase(), { delay: 40 });
  await scout.page.waitForFunction(() => /No table/i.test(document.querySelector('#join-msg')?.textContent || ''), null, { timeout: 8000 })
    .then(() => coverage.add('bad-code-message'))
    .catch(async () => { fail('bad code: no "No table…" message in the join bubble'); await shot(scout, 'BAD-CODE'); });
  await sleep(500);
  scout.allow404 = false;

  // Private hides it, Open shows it again.
  await host.page.click('[data-lobby="open"][data-value="0"]');
  await expectListed(scout, code, false, 'private');
  await shot(scout, 'home-private-hidden');
  await host.page.click('[data-lobby="open"][data-value="1"]');
  await expectListed(scout, code, true, 'reopened');

  // Ann: Join a game → types the code in lowercase → auto-joins on the 4th letter.
  await ann.page.fill('#player-name', ann.name);
  await ann.page.click('#join-game');
  await ann.page.type('#join-code', code.toLowerCase(), { delay: 60 });
  await ann.page.waitForSelector('#lobby:not([hidden])', { timeout: 8000 });
  coverage.add('join-by-code');

  // Bob: the share link → name prompt → lobby.
  await bob.page.goto(link, { waitUntil: 'load' });
  await bob.page.waitForSelector('#joinlink:not([hidden])', { timeout: 5000 });
  if ((await bob.page.textContent('#jl-code')).trim() !== code) fail('link prompt shows the wrong code');
  await bob.page.fill('#jl-name', bob.name);
  await shot(bob, 'joinlink');
  await bob.page.click('#jl-go');
  await bob.page.waitForSelector('#lobby:not([hidden])', { timeout: 8000 });
  coverage.add('join-by-link');

  // Filler bot.
  await host.page.click('[data-lobby="add-bot"]');
  for (const p of [host, ann, bob]) {
    await waitWs(p, w => w.lobby?.members?.filter(m => !m.waiting).length === 4 && w.lobby.members.some(m => m.isBot), 5000, 'bot in the lobby');
    await p.page.waitForFunction(() => document.querySelectorAll('#lobby .ls:not(.empty)').length === 4 && document.querySelector('#lobby .ls.bot'), null, { timeout: 4000 })
      .catch(() => fail(`${p.key}: lobby does not show 3 humans + bot`));
    const me = p.ws.lobby.members.find(m => m.seat === p.ws.lobby.me);
    if (!me || me.name !== p.name) fail(`${p.key}: lobby.me is ${p.ws.lobby.me}, expected the seat named ${p.name}`);
  }
  coverage.add('bot-added');
  const ro = await ann.page.textContent('#lobby .lobby-ro').catch(() => '');
  if (!ro.includes(String(TIMER_S))) fail(`guest lobby does not show the ${TIMER_S}s timer ("${ro}")`);
  for (const p of [host, ann, bob]) { checkProbe(p, await probe(p)); await shot(p, 'lobby'); }
  return { code, link };
}

async function doReactions(host, others) {
  const { page } = host;
  await page.waitForSelector('.rx-btn', { timeout: 5000 });
  await page.click('.rx-btn');
  await page.click('.rx-pick[data-kind="laugh"]');
  const sentAt = Date.now() - 50;
  for (const o of others) {
    await waitWs(o, w => w.events.some(e => e.kind === 'laugh' && e.at >= sentAt), 4000, 'laugh event');
    const seen = await o.page.waitForSelector('.rx-pop', { timeout: 3000 }).then(() => true).catch(() => false);
    if (!seen) fail(`${o.key}: no 😂 pop-up shown for the host's reaction`);
  }
  await shot(others[0], 'reaction-pop');
  coverage.add('reaction');
  await sleep(2300);   // 2s rate limit
  await page.click('.rx-btn');
  await page.click('.rx-pick[data-kind="tomato"]');
  const target = page.locator('.rx-target').first();
  await target.waitFor({ timeout: 3000 });
  const targetId = Number(await target.getAttribute('data-target'));
  const t1 = Date.now() - 50;
  // Record the flight/splat nodes as they are added (they're short-lived and fixed-position).
  for (const o of others) {
    await o.page.evaluate(() => {
      window.__rx = { fly: false, splat: false, hit: false };
      new MutationObserver(recs => {
        for (const r of recs) {
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            if (n.matches('.rx-fly')) window.__rx.fly = true;
            if (n.matches('.rx-splat')) window.__rx.splat = true;
          }
          if (r.type === 'attributes' && r.target.classList?.contains('rx-hit')) window.__rx.hit = true;
        }
      }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });
  }
  await target.click();
  for (const o of others) {
    await waitWs(o, w => w.events.some(e => e.kind === 'tomato' && e.target === targetId && e.at >= t1), 4000, 'tomato event');
    if (o.key === others[0].key) { await sleep(800); await shot(o, 'tomato'); }
    const rx = await o.page.waitForFunction(() => window.__rx.splat && window.__rx.hit && window.__rx, null, { timeout: 4000 })
      .then(h => h.jsonValue()).catch(async () => o.page.evaluate(() => window.__rx));
    if (!rx.fly || !rx.splat || !rx.hit) fail(`${o.key}: tomato at player ${targetId} not fully animated (${JSON.stringify(rx)})`);
  }
  coverage.add('tomato');
}

// The refresh check: same seat, same name, still has a move.
async function doRefresh(p) {
  const before = { me: p.ws.view?.me, name: (await probe(p))?.meName };
  log(`${p.key} refreshes mid-turn (player ${before.me})`);
  p.navigating = true;
  const r0 = Date.now();
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  const r1 = Date.now();
  const s = await waitFor(p, x => x.screen === 'game' && x.meId != null, 10000, 'table after refresh');
  const r2 = Date.now();
  p.navigating = false;
  log(`${p.key} back at the table: reload ${r1 - r0}ms, table ${r2 - r1}ms, controls=${s.controls}, phase ${s.phase}`);
  await waitWs(p, w => w.view && w.view.me != null, 5000, 'view after refresh');
  if (p.ws.view.me !== before.me || s.meId !== before.me) fail(`${p.key}: after refresh seat ${s.meId}/${p.ws.view.me}, expected ${before.me}`);
  if (s.meName !== before.name) fail(`${p.key}: after refresh my seat reads "${s.meName}", was "${before.name}"`);
  const s2 = await waitFor(p, x => x.controls > 0 || x.phase === 'Round over', 4000, 'controls after refresh').catch(e => { fail(e.message); return null; });
  if (s2 && !s2.controls) note(`${p.key}: after refresh mid-turn the turn had already passed`);
  await shot(p, 'after-refresh');
  coverage.add('refresh-rejoin');
}

// The host does nothing on its turn until the server makes a ⏱ auto move.
async function doTimeout(p, others) {
  const me = p.ws.view.me;
  const phase = (await probe(p)).phase;
  log(`${p.key} idles on its turn (${phase}) for the ⏱ auto move`);
  const autosBefore = p.ws.autos.length;
  let sawRing = false, sawNudge = false, shotRing = false;
  const end = Date.now() + (TIMER_S + 10) * 1000;
  while (Date.now() < end) {
    const s = await probe(p);
    checkProbe(p, s);
    if (s?.myRing) { sawRing = true; if (!shotRing) { shotRing = true; await shot(p, 'timer-ring'); } }
    if (s?.nudge) sawNudge = true;
    if (p.ws.autos.slice(autosBefore).some(a => a.player === me)) break;
    await sleep(100);
  }
  const auto = p.ws.autos.slice(autosBefore).find(a => a.player === me);
  if (!auto) { fail(`${p.key}: no ⏱ auto move within ${TIMER_S + 10}s of idling`); return; }
  log(`auto move: ${JSON.stringify(auto)}`);
  const want = phase === 'Bidding' ? 'pass' : 'place';
  if (phase === 'Bidding' && auto.type !== 'pass') fail(`timeout in bidding made "${auto.type}", expected pass`);
  if (phase === 'Stack or challenge' && !['place', 'bid'].includes(auto.type)) fail(`timeout in placement made "${auto.type}", expected ${want}`);
  if (!sawRing) fail(`${p.key}: no timer ring on my seat while it was my turn`);
  if (!sawNudge) fail(`${p.key}: no nudge (#me-seat.nudge) seen at 5s left`);
  coverage.add('timeout-auto');
  await sleep(400);
  for (const o of [p, ...others]) {
    const s = await probe(o);
    if (!s?.autoTags) fail(`${o.key}: no ⏱ tag in the log after the auto move`);
  }
  await shot(others[0], 'auto-move');
}

// ---------- main ----------

let exitCode = 1;
let browser;
try {
  if (!EXTERNAL) await startWrangler();
  const executablePath = cachedChromium();
  browser = await chromium.launch({ headless: !HEADED, executablePath });
  log(`browser ${executablePath ?? 'playwright default'}, base ${BASE}`);
  const host = await makePlayer(browser, 'host', 'Hosty', SWAP ? MOBILE : DESKTOP);
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE.replace(/\/$/, '') });
  const ann = await makePlayer(browser, 'ann', 'Ann', SWAP ? DESKTOP : MOBILE);
  const bob = await makePlayer(browser, 'bob', 'Bob', SWAP ? DESKTOP : MOBILE);
  const scout = await makePlayer(browser, 'scout', 'Scout', SWAP ? MOBILE : DESKTOP);
  const humans = [host, ann, bob];

  const { code, link } = await setupLobby({ host, ann, bob, scout });

  // Start.
  await host.page.click('[data-lobby="start"]');
  for (const p of humans) await waitFor(p, s => s.screen === 'game' && s.phase === 'Lay down', 8000, 'game start');
  coverage.add('start');
  await expectListed(scout, code, false, 'in-game');
  await scout.page.click('#join-game').catch(() => {});   // close the bubble: stop polling
  const ids = Object.fromEntries(humans.map(p => [p.key, p.ws.view.me]));
  const botId = host.ws.view.players.find(pl => !Object.values(ids).includes(pl.id))?.id;
  log(`seats: ${JSON.stringify(ids)}, bot ${botId}`);
  if (new Set(Object.values(ids)).size !== 3) fail(`humans don't have distinct seats: ${JSON.stringify(ids)}`);

  const done = { reactions: false, refresh: false, timer: false, leave: false, forfeit: false, latejoin: false };
  let leftAt = null;
  const gameOver = s => s.screen === 'lobby' && !!s.lobbyResult;

  const hostLoop = playLoop(host, {
    stop: gameOver,
    async hook(s) {
      if (s.screen !== 'game') return false;
      if (!done.reactions) { await doReactions(host, [ann, bob]); done.reactions = true; return true; }
      if (done.refresh && !done.timer && s.controls && ['Stack or challenge', 'Bidding'].includes(s.phase)) {
        await doTimeout(host, [ann, bob]); done.timer = true; return true;
      }
      if (done.leave && !done.forfeit && leftAt) {
        const v = host.ws.view;
        if (v?.players[ids.bob]?.eliminated) {
          done.forfeit = true;
          const la = v.lastAction;
          log(`bob eliminated by forfeit (lastAction ${JSON.stringify(la)}), phase ${v.phase}`);
          // The final flip of a challenge is held on screen for 2s, so allow for that.
          const ok = await host.page.waitForFunction(id => {
            const seat = document.querySelector(`#game .seat[data-player="${id}"]`);
            return !seat || /eliminated|left/.test(seat.className);
          }, ids.bob, { timeout: 4000 }).then(() => true).catch(() => false);
          if (!ok) fail(`host: Bob's seat not shown as out/left within 4s of the forfeit`);
          await shot(host, 'forfeit');
          coverage.add('forfeit-at-round-end');
        }
      }
      return false;
    },
  });

  const annLoop = playLoop(ann, {
    stop: gameOver,
    async hook(s) {
      if (!done.refresh && done.reactions && s.screen === 'game' && s.controls) { await doRefresh(ann); done.refresh = true; return true; }
      return false;
    },
  });

  const bobLoop = (async () => {
    await playLoop(bob, {
      stop: s => done.leave,
      async hook(s) {
        if (!done.timer || done.leave || s.screen !== 'game' || s.meOut || ['Round over', ''].includes(s.phase)) return false;
        const v = host.ws.view;
        if (v.phase === 'round-over' || v.phase === 'game-over') return false;
        log(`bob leaves mid-round (${s.phase}, ${s.round})`);
        await bob.page.click('#game [data-cmd="leave"]');
        await bob.page.waitForSelector('#leave-confirm[open]', { timeout: 3000 });
        await shot(bob, 'leave-confirm');
        leftAt = Date.now();
        await bob.page.click('#leave-confirm [data-mp="leave-yes"]');
        await waitFor(bob, x => x.screen === 'setup', 5000, 'home after Leave');
        done.leave = true;
        coverage.add('leave');
        // Others see the seat greyed out as "Bob left" at once.
        for (const o of [host, ann]) {
          const ok = await o.page.waitForFunction(id => {
            const seat = document.querySelector(`#game .seat[data-player="${id}"]`);
            return seat && (seat.classList.contains('left') || /left/.test(seat.querySelector('.seat-name')?.textContent || ''));
          }, ids.bob, { timeout: 4000 }).then(() => true).catch(() => false);
          if (!ok && !gameOver(await probe(o) || {})) fail(`${o.key}: Bob's seat not shown as left after Leave`);
        }
        await shot(host, 'seat-left');
        return true;
      },
    });
    // Back by the link while the game runs → a waiting late joiner.
    await sleep(1000);
    bob.navigating = true;
    await bob.page.goto(link, { waitUntil: 'load' });
    bob.navigating = false;
    const lp = await waitFor(bob, s => s.screen === 'joinlink' || s.screen === 'lobby', 5000, 'link prompt after leaving');
    if (lp.screen === 'joinlink') { await bob.page.fill('#jl-name', bob.name); await bob.page.click('#jl-go'); }
    await waitFor(bob, s => s.screen === 'lobby', 8000, 'lobby as late joiner');
    await waitWs(bob, w => w.lobby, 3000, 'lobby');
    if (bob.ws.lobby.phase === 'in-game') {
      if (!bob.ws.lobby.meWaiting) fail('late joiner: lobby.meWaiting is not true while the game runs');
      const s = await probe(bob);
      if (!/next one/i.test(s.lobbyText)) note(`late joiner lobby text: "${s.lobbyText}"`);
      await shot(bob, 'late-joiner-waiting');
      coverage.add('late-joiner');
      done.latejoin = true;
    } else note('Bob rejoined after the game had already ended (late-joiner path not exercised)');
    return waitFor(bob, gameOver, GAME_TIMEOUT_MS, 'lobby result after the game');
  })();

  const results = await Promise.allSettled([hostLoop, annLoop, bobLoop]);
  for (const r of results) if (r.status === 'rejected') throw r.reason;
  coverage.add('game-finished');
  for (const [k, v] of Object.entries(done)) if (!v) fail(`scripted step "${k}" never happened (the game ended first?)`);

  // Game over → everyone is back in the same lobby with the result.
  const winner = host.ws.lobby?.lastWinner;
  log(`game over, winner: ${winner?.name}`);
  for (const p of humans) {
    const s = await probe(p);
    await shot(p, 'lobby-result');
    if (!s.lobbyResult) fail(`${p.key}: lobby shows no result after the game`);
  }
  const hs = await probe(host);
  if (hs.startLabel !== 'Rematch') fail(`host start button reads "${hs.startLabel}", expected "Rematch"`);
  if (!bob.ws.lobby?.members?.some(m => m.name === bob.name && !m.waiting)) fail('Bob (late joiner) not seated for the rematch');

  // Unexpected ⏱ moves: only the host's idle turn and Bob's forfeited seat should have any.
  const unexpected = host.ws.autos.filter(a => !(a.player === ids.host) && !(a.player === ids.bob && leftAt && a.at >= leftAt));
  if (unexpected.length) {
    note(`unexpected ⏱ auto moves (the script was too slow, or a control was hidden): ${JSON.stringify(unexpected.map(a => [a.player, a.type]))}`);
    for (const a of unexpected) {
      const who = humans.find(p => ids[p.key] === a.player);
      if (who) console.log(`  trail of ${who.key} before its ⏱ move:\n${(who.trail || []).filter(l => parseFloat(l) * 1000 >= a.at - t0 - 30000 && parseFloat(l) * 1000 <= a.at - t0 + 1000).map(l => `    ${l}`).join('\n')}`);
    }
  }

  // Rematch: one tap, everyone back at a fresh table.
  await host.page.click('[data-lobby="start"]');
  for (const p of humans) {
    const s = await waitFor(p, x => x.screen === 'game' && /Round 1\b/.test(x.round) && x.phase === 'Lay down', 8000, 'rematch round 1');
    const cards = await p.page.evaluate(() => document.querySelectorAll('#hand .card').length + document.querySelectorAll('#me-seat .stack .card').length);
    if (cards !== 4) fail(`${p.key}: rematch starts with ${cards} cards, expected 4`);
    if (s.meOut) fail(`${p.key}: eliminated at the start of the rematch`);
  }
  coverage.add('rematch');
  // Everyone lays down a card, then a couple of seconds of play for the hiding checks.
  for (const p of humans) {
    const s = await waitFor(p, x => x.controls > 0, 5000, 'rematch first move');
    await humanMove(p, s);
  }
  await sleep(1500);
  for (const p of humans) { checkProbe(p, await probe(p)); await shot(p, 'rematch'); }

  // Leaving from the lobby/table ends cleanly for everyone.
  for (const p of humans) {
    const s = await probe(p);
    if (s.screen === 'game') {
      await p.page.click('#game [data-cmd="leave"]');
      await p.page.click('#leave-confirm [data-mp="leave-yes"]');
    } else if (s.screen === 'lobby') await p.page.click('[data-lobby="leave"]');
    await waitFor(p, x => x.screen === 'setup', 5000, 'home after the final Leave');
  }

  // Socket-level results.
  for (const p of humans) {
    for (const l of [...new Set(p.ws.leaks)]) fail(`${p.key}: hidden card in a view frame: ${l}`);
    for (const e of p.ws.errors) fail(`${p.key}: server error message "${e}"`);
    log(`${p.key}: ${p.ws.views} views received, ${p.ws.events.length} events`);
  }
  exitCode = 0;
} catch (e) {
  fail(e instanceof Abort ? e.message : e.stack || String(e));
  for (const p of players) await shot(p, 'FAIL');
}

for (const p of players) for (const e of [...new Set(p.errors)]) fail(`${p.key} (${p.size}): ${e}`);
await browser?.close().catch(() => {});
stopWrangler();

const wanted = ['host-lobby', 'share-link-copied', 'list:open', 'bad-code-message', 'list:private', 'list:reopened', 'join-by-code', 'join-by-link',
  'bot-added', 'start', 'list:in-game', 'reaction', 'tomato', 'refresh-rejoin', 'timeout-auto', 'leave', 'late-joiner', 'forfeit-at-round-end',
  'game-finished', 'rematch', 'phase:Lay down', 'phase:Stack or challenge', 'phase:Bidding', 'phase:Reveal', 'phase:Round over'];
console.log(`\nCoverage: ${[...coverage].sort().join(', ')}`);
const missing = wanted.filter(w => !coverage.has(w));
if (missing.length) console.log(`Not covered: ${missing.join(', ')}`);
if (findings.length) console.log(`\nFindings (${findings.length}):\n${findings.map(f => `  - ${f}`).join('\n')}`);
if (failures.length) console.log(`\nFAILURES (${failures.length}):\n${failures.map(f => `  - ${f}`).join('\n')}`);
const ok = exitCode === 0 && !failures.length;
console.log(`\nMULTIPLAYER E2E: ${ok ? 'PASS' : 'FAIL'} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
process.exit(ok ? 0 : 1);
