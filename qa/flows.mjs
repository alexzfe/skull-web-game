// TUTORIAL_SPEC §6 scenarios: tutorial walkthrough, Skip at every step, locked
// steps, first-game tips, "Don't show tips", Play now. Run from e2e.mjs, which
// passes in its helpers (h).
import { join } from 'node:path';
import { TUTORIAL_SCRIPT } from '../src/tutorial-script.js';

const plain = html => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
// One coach bubble per step that has text, in order.
const SAYS = TUTORIAL_SCRIPT.filter(s => s.say);
export const BUBBLES = SAYS.map(s => plain(s.say));
const FIRST_LINE = BUBBLES[0];

const intersects = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function coachState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.coach-root');
    const box = root?.querySelector('.coach');
    const vis = el => !!el && !el.hidden && el.getBoundingClientRect().width > 0;
    const shown = !!root && !root.hidden;
    const spot = root?.querySelector('.coach-spot');
    const rect = el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
    return {
      shown,
      mode: box?.dataset.mode || '',
      lock: shown && root.classList.contains('lock'),
      text: shown ? (root.querySelector('.coach-text')?.textContent || '').replace(/\s+/g, ' ').trim() : '',
      next: shown && vis(root.querySelector('[data-coach="next"]')),
      buttons: shown ? [...root.querySelectorAll('.coach-actions [data-coach-btn]')].map(b => b.textContent.trim()) : [],
      spot: shown && vis(spot) ? rect(spot) : null,
      box: shown && box ? rect(box) : null,
      xray: !!document.querySelector('#game .table.xray'),
      setup: !document.getElementById('setup').hidden,
      game: !document.getElementById('game').hidden,
      logLen: document.querySelectorAll('#log-list li').length,
      round: document.querySelector('#status .round')?.textContent?.trim() || '',
      phase: document.querySelector('#status .phase')?.textContent?.trim() || '',
      seats: [...document.querySelectorAll('#opponents .seat .seat-name')].map(n => n.textContent.trim()),
      bubbles: window.__bubbles || [],
      store: { done: localStorage.getItem('skull.tutorialDone'), tipsOff: localStorage.getItem('skull.tipsOff'), seen: localStorage.getItem('skull.tipsSeen'), games: localStorage.getItem('skull.tipsGames') },
    };
  });
}

const storage = page => page.evaluate(() => ({
  done: localStorage.getItem('skull.tutorialDone'), tipsOff: localStorage.getItem('skull.tipsOff'),
  seen: JSON.parse(localStorage.getItem('skull.tipsSeen') || '[]'), games: localStorage.getItem('skull.tipsGames'),
}));

export async function runFlows(browser, h, only) {
  const { VIEWPORTS, RunFailure, sleep, watchErrors, SHOTS, URL } = h;
  const desktop = VIEWPORTS.find(v => v.key === 'desktop'), mobile = VIEWPORTS.find(v => v.key === 'mobile');

  // Fresh context + page (empty localStorage), with error tracking.
  async function scenario(name, vp, body, { init = null } = {}) {
    const result = { name, ok: true, games: 0, winners: [], errors: [], layout: new Set(), coverage: new Set(), failure: null, lines: [] };
    const context = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    watchErrors(page, result.errors);
    const shot = async label => { await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`) }).catch(() => {}); };
    try {
      await page.goto(URL, { waitUntil: 'load' });
      await body({ page, result, shot, log: m => result.lines.push(m), cov: k => result.coverage.add(k) });
    } catch (e) {
      result.ok = false;
      result.failure = e.message;
      await shot('FAIL');
    }
    if (result.errors.length) result.ok = false;
    await context.close();
    return result;
  }

  // Walks the tutorial like a player. Returns at the finale (or after Skip at bubble `skipAt`, 1-based).
  async function walk(page, { skipAt = null, onLock = null, onBubble = null, log = () => {}, retried = null } = {}) {
    let seen = 0, lastText = '', lastChange = Date.now();
    const t0 = Date.now();
    // Bubbles are recorded inside the page (and Skip pressed there the instant bubble k shows),
    // so a slow, loaded test machine can't miss a short-lived line.
    await page.evaluate(([skipAt, plainOf]) => {
      window.__bubbles = [];
      const root = document.querySelector('.coach-root');
      const box = root.querySelector('.coach');
      const textEl = root.querySelector('.coach-text');
      let last = '';
      const check = () => {
        if (root.hidden || box.dataset.mode !== 'guide') return;
        const text = textEl.textContent.replace(/\s+/g, ' ').trim();
        if (!text || text === last) return;
        last = text;
        const kind = root.classList.contains('lock') ? 'lock' : root.querySelector('[data-coach="next"]') ? 'next' : root.querySelector('[data-coach-btn]') ? 'final' : 'line';
        window.__bubbles.push({ text, kind, t: performance.now() });
        if (skipAt === window.__bubbles.length) root.querySelector('[data-coach="skip"]').click();
      };
      new MutationObserver(check).observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      check();
    }, [skipAt]);
    while (true) {
      if (Date.now() - lastChange > 15000) throw new RunFailure(`tutorial stuck after bubble ${seen} "${lastText}"`);
      // Bubble list and on-screen state come from ONE evaluate, so a bubble that appears
      // in between can't be dismissed (Next) before onBubble has seen it.
      const c = await coachState(page);
      const all = c.bubbles;
      for (const b of all.slice(seen)) {
        const idx = BUBBLES.indexOf(b.text);
        if (idx < 0) throw new RunFailure(`unexpected coach text "${b.text}"`);
        if (idx !== seen) throw new RunFailure(`bubble ${idx + 1} shown, expected ${seen + 1} ("${BUBBLES[seen]}")`);
        // A narrated line (no Next, no lock) must stay up long enough to read.
        const prev = all[seen - 1];
        if (prev?.kind === 'line' && b.t - prev.t < 1000 && skipAt == null) {
          throw new RunFailure(`bubble "${prev.text}" was only up ${Math.round(b.t - prev.t)}ms`);
        }
        seen++; lastText = b.text; lastChange = Date.now();
        log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] #${seen} ${b.kind}: ${b.text}`);
        if (skipAt === seen) return { skipped: seen, ms: Date.now() - t0 };
        if (onBubble && seen === all.length) {
          const now = await coachState(page);
          await onBubble(now.text === b.text ? now : c, seen);
        }
      }
      // Only act on the bubble we've processed; a newer one is picked up next iteration.
      if (!seen || c.text !== BUBBLES[seen - 1]) { await sleep(40); continue; }
      if (c.buttons.length) return { finale: c, bubbles: seen, ms: Date.now() - t0 };
      if (c.next) { await page.click('.coach [data-coach="next"]', { timeout: 2000 }).catch(() => {}); await sleep(80); continue; }
      if (c.lock && c.spot) {
        // Let the spotlight settle: the coach smooth-scrolls off-screen targets into view.
        await sleep(250);
        let c2 = await coachState(page);
        for (let i = 0; i < 25; i++) {
          await sleep(120);
          const c3 = await coachState(page);
          const same = c3.spot && c2.spot && ['left', 'top', 'right', 'bottom'].every(k => Math.abs(c3.spot[k] - c2.spot[k]) < 1)
            && c3.box && c2.box && ['left', 'top'].every(k => Math.abs(c3.box[k] - c2.box[k]) < 1);
          c2 = c3;
          if (same) break;
        }
        if (c2.text !== c.text || !c2.spot) continue;
        const covered = await page.evaluate(sp => {
          const e = document.elementFromPoint((sp.left + sp.right) / 2, (sp.top + sp.bottom) / 2);
          return document.querySelector('.coach-root').contains(e) ? String(e.className?.baseVal ?? e.className) : null;
        }, c2.spot);
        if (covered) throw new RunFailure(`Bones' bubble (.${covered}) covers the centre of the spotlit target on "${c2.text}"`);
        if (onLock) await onLock(c2, seen, SAYS[BUBBLES.indexOf(c2.text)]?.target);
        const x = (c2.spot.left + c2.spot.right) / 2, y = (c2.spot.top + c2.spot.bottom) / 2;
        const hit = await page.evaluate(([x, y]) => {
          const e = document.elementFromPoint(x, y);
          const a = e?.closest('[data-action-index]');
          return `${e?.tagName}.${String(e?.className?.baseVal ?? e?.className)} action=${a ? a.dataset.actionIndex : 'none'} status="${document.querySelector('#status')?.textContent}"`;
        }, [x, y]);
        const moved = t => page.waitForFunction(t => (document.querySelector('.coach-root .coach-text')?.textContent || '').replace(/\s+/g, ' ').trim() !== t || document.querySelector('.coach-root').hidden,
          t, { timeout: 4000 }).then(() => true, () => false);
        await page.mouse.click(x, y);
        if (await moved(c2.text)) continue;
        // Seen ~1 in 100 locked clicks under full-suite load only: retry once, and report it.
        retried?.(`tap on the target of "${c2.text}" needed a second try (first hit ${hit})`);
        await page.mouse.click(x, y);
        await page.waitForFunction(t => (document.querySelector('.coach-root .coach-text')?.textContent || '').replace(/\s+/g, ' ').trim() !== t || document.querySelector('.coach-root').hidden,
          c2.text, { timeout: 4000 }).catch(async () => {
          const now = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); const a = e?.closest('[data-action-index]'); return `${e?.tagName} action=${a ? a.dataset.actionIndex : 'none'} status="${document.querySelector('#status')?.textContent}"`; }, [x, y]);
          throw new RunFailure(`clicking the spotlit target did nothing on "${c2.text}" (clicked ${hit}; 4s later ${now})`);
        });
        continue;
      }
      await sleep(40);
    }
  }

  // On a locked step: off-target clicks (a legal-but-wrong move if any, and the Rules button) must do nothing.
  // Also re-checks Tutor issue 1: banners must not sit over the spotlit target at full strength.
  function lockChecks(page, result, cov) {
    return async (c, n, target) => {
      const before = await coachState(page);
      const off = await page.evaluate(([spot, target]) => {
        const inSpot = r => r.left < spot.right && spot.left < r.right && r.top < spot.bottom && spot.top < r.bottom;
        const out = [];
        for (const sel of ['#game [data-action-index]', '#game [data-cmd="rules"]']) {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (target && el.closest(target)) continue;   // every element matching the step's target is fair game
            const top = r.width && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (!top || !el.contains(top)) continue;   // covered (e.g. by Bones' bubble)
            if (r.width && r.height && r.top >= 0 && r.bottom <= innerHeight && !inSpot(r)) { out.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, what: el.getAttribute('aria-label') || el.dataset.cmd || el.textContent.trim().slice(0, 20) }); break; }
          }
        }
        return out;
      }, [c.spot, target]);
      for (const o of off) {
        await page.mouse.click(o.x, o.y);
        await sleep(250);
        const after = await coachState(page);
        const rulesOpen = await page.evaluate(() => !!document.getElementById('rules')?.open);
        if (rulesOpen) { await page.keyboard.press('Escape'); throw new RunFailure(`locked step "${c.text}": off-target click on Rules opened the rules`); }
        if (after.logLen !== before.logLen || after.text !== before.text) throw new RunFailure(`locked step "${c.text}": off-target click on "${o.what}" was not swallowed`);
        cov('lock-swallowed-click');
      }
      const overlap = await page.evaluate(spot => {
        const layer = document.getElementById('banner-layer');
        const op = Number(getComputedStyle(layer).opacity);
        const hit = [...layer.querySelectorAll('.banner:not(.out)')].find(b => {
          const r = b.getBoundingClientRect();
          return r.left < spot.right && spot.left < r.right && r.top < spot.bottom && spot.top < r.bottom;
        });
        return hit && op > 0.5 ? `${hit.textContent.trim()} (layer opacity ${op})` : null;
      }, c.spot);
      if (overlap) throw new RunFailure(`banner "${overlap}" covers the spotlit target on "${c.text}"`);
    };
  }

  const tasks = [];
  const add = (name, fn) => { if (!only || only.test(name)) tasks.push(fn); };

  // 1) Full walkthrough at both sizes; desktop takes "Play a real game", mobile "Replay tutorial".
  for (const [vp, choice] of [[desktop, 'solo'], [mobile, 'replay']]) {
    const name = `${vp.key}-tutorial-${choice}`;
    add(name, () => scenario(name, vp, async ({ page, result, shot, log, cov }) => {
      await page.click('#learn');
      cov('click:learn');
      let xraySteps = 0;
      const r = await walk(page, {
        log, retried: m => result.layout.add(m),
        onLock: lockChecks(page, result, cov),
        onBubble: async (c, n) => {
          if (n === 1 || n % 6 === 0) await shot(`b${String(n).padStart(2, '0')}`);
          const step = TUTORIAL_SCRIPT.filter(s => s.say)[n - 1];
          if (step.xray) {
            await sleep(150);
            if (!(await coachState(page)).xray) throw new RunFailure(`x-ray not shown on "${c.text}"`);
            xraySteps++;
            // Tutor issue 2 (minor): the bubble shouldn't hide the pot/result during x-ray.
            await sleep(700);   // let the coach finish scrolling / placing
            const pot = await page.locator('[data-tut="pot"]').boundingBox().catch(() => null);
            const cs = await coachState(page);
            if (pot && intersects(cs.box, { left: pot.x, top: pot.y, right: pot.x + pot.width, bottom: pot.y + pot.height })) {
              result.layout.add(`x-ray bubble #${n} covers the pot / round result`);
              await shot(`xray-covers-pot-b${n}`);
            }
          }
        },
      });
      if (r.bubbles !== BUBBLES.length) throw new RunFailure(`saw ${r.bubbles}/${BUBBLES.length} bubbles`);
      if (!xraySteps) throw new RunFailure('no x-ray step seen');
      log(`  finished in ${(r.ms / 1000).toFixed(1)}s`);
      if (r.ms > 90_000) throw new RunFailure(`tutorial took ${(r.ms / 1000).toFixed(0)}s (> 90s)`);
      const end = await coachState(page);
      if (!/Game over|Round over/.test(end.phase) && !/Round 3/.test(end.round)) throw new RunFailure(`finale shown in unexpected state ${end.round}/${end.phase}`);
      if (await page.evaluate(() => document.getElementById('gameover').open)) throw new RunFailure('default game-over dialog shown under the finale');
      await shot('finale');
      cov('tutorial-finished');
      if (await page.locator('.coach [data-coach="skip"]').isVisible()) throw new RunFailure('"Skip tutorial" still offered on the finale');

      const label = choice === 'solo' ? 'Play a real game' : 'Replay tutorial';
      await page.locator('.coach-actions .btn', { hasText: label }).click();
      cov(`finale:${choice}`);
      await sleep(600);
      const after = await coachState(page);
      if (after.store.done !== '1') throw new RunFailure('skull.tutorialDone not set after finishing');
      if (after.xray) throw new RunFailure('x-ray still on after the finale');
      if (choice === 'solo') {
        if (!after.game || after.setup) throw new RunFailure('"Play a real game" did not open a table');
        if (!/Round 1/.test(after.round) || after.seats.length !== 3) throw new RunFailure(`"Play a real game" → expected a fresh 3-opponent table, got ${after.round} ${JSON.stringify(after.seats)}`);
        if (after.shown && after.mode === 'guide') throw new RunFailure(`tutorial bubble still up in the real game: "${after.text}"`);
      } else {
        await page.waitForFunction(t => (document.querySelector('.coach-root .coach-text')?.textContent || '').replace(/\s+/g, ' ').trim() === t, FIRST_LINE, { timeout: 3000 })
          .catch(() => { throw new RunFailure('"Replay tutorial" did not restart at the first bubble'); });
        const re = await coachState(page);
        if (JSON.stringify(re.seats) !== JSON.stringify(['Panthers', 'Snakes']) || !/Round 1/.test(re.round)) throw new RunFailure(`replay table wrong: ${re.round} ${JSON.stringify(re.seats)}`);
      }
      await shot('after-finale');
    }));
  }

  // 2) Skip at every bubble: fresh page each, lands on setup with tutorialDone set, Play now still works.
  for (const vp of [desktop, mobile]) {
    for (let k = 1; k < BUBBLES.length; k++) {   // the finale is a choice: no Skip there (checked in the walkthrough)
      const name = `${vp.key}-skip-${String(k).padStart(2, '0')}`;
      add(name, () => scenario(name, vp, async ({ page, result, log, cov }) => {
        await page.click('#learn');
        // Walk normally up to bubble k, then Skip.
        const r = await walk(page, { log, retried: m => result.layout.add(m), skipAt: k });
        if (r.skipped !== k) throw new RunFailure(`never reached bubble ${k}`);
        await page.waitForSelector('#setup:not([hidden])', { timeout: 3000 }).catch(() => { throw new RunFailure('Skip did not return to the setup screen'); });
        const s = await coachState(page);
        if (s.shown) throw new RunFailure(`coach still visible after Skip: "${s.text}"`);
        if (s.store.done !== '1') throw new RunFailure('skull.tutorialDone not set after Skip');
        await page.click('#play-now');
        await page.waitForSelector('#game:not([hidden])', { timeout: 2000 });
        await sleep(1200);
        const g = await coachState(page);
        if (!/Round 1/.test(g.round)) throw new RunFailure(`Play now after Skip: ${g.round}`);
        if (g.shown && g.mode === 'guide') throw new RunFailure(`tutorial bubble leaked into the real game: "${g.text}"`);
        cov('skip-ok');
      }));
    }
  }

  // Shared: watch Bones' tip bubbles in a real game.
  const tipWatch = () => {
    window.__tips = [];
    const poll = () => {
      const root = document.querySelector('.coach-root');
      const box = root?.querySelector('.coach');
      if (root && !root.hidden && box?.dataset.mode === 'tip') {
        const t = root.querySelector('.coach-text')?.textContent.trim();
        if (t && window.__tips.at(-1) !== t) window.__tips.push(t);
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };

  // 3) Play now → live table in one click; first real game with tips: they fire, once each; tipsGames counted.
  for (const vp of [desktop, mobile]) {
    const name = `${vp.key}-tips-first-game`;
    add(name, () => scenario(name, vp, async ({ page, result, shot, log, cov }) => {
      await page.evaluate(() => localStorage.setItem('skull.settings', JSON.stringify({ name: 'QA Tips', opponents: 2 })));
      await page.reload();
      await page.evaluate(tipWatch);
      const t0 = Date.now();
      await page.click('#play-now');
      await page.waitForFunction(() => !document.getElementById('game').hidden && /Round 1/.test(document.querySelector('#status .round')?.textContent || '') && document.querySelectorAll('#opponents .seat').length === 2, null, { timeout: 1000 })
        .catch(() => { throw new RunFailure('Play now did not reach a live 2-opponent table within 1s'); });
      log(`  Play now → table in ${Date.now() - t0}ms`);
      cov('play-now-one-click');

      const ctx = { log, rng: h.seeded(4242), shot, coverage: result.coverage, strategy: 'suicide', checkLayout() {} };
      await h.playGame(page, ctx);
      result.games++;
      const tips = await page.evaluate(() => window.__tips);
      const st = await storage(page);
      log(`  tips shown: ${JSON.stringify(tips)}; seen: ${JSON.stringify(st.seen)}`);
      for (const id of ['first-player', 'lost-bet', 'last-card']) {
        if (!st.seen.includes(id)) throw new RunFailure(`tip "${id}" never fired (seen ${JSON.stringify(st.seen)})`);
        cov(`tip:${id}`);
      }
      for (const id of st.seen) cov(`tip:${id}`);
      if (tips.length < st.seen.length) throw new RunFailure(`${st.seen.length} tips marked seen but only ${tips.length} bubbles observed`);
      if (new Set(tips).size !== tips.length) throw new RunFailure(`a tip was shown twice: ${JSON.stringify(tips)}`);
      if (st.games !== '1') throw new RunFailure(`skull.tipsGames = ${st.games} after one game, expected 1`);

      // Rematch: tips are off for the second game.
      await page.click('#gameover [data-cmd="play-again"]');
      await page.evaluate(() => { window.__tips = []; });
      const ctx2 = { ...ctx, rng: h.seeded(99) };
      const tEnd = Date.now() + 15000;
      ctx2.onTick = async () => { if (Date.now() > tEnd) throw new StopPlay(); };
      await h.playGame(page, ctx2).catch(e => { if (!(e instanceof StopPlay)) throw e; });
      const later = await page.evaluate(() => window.__tips);
      if (later.length) throw new RunFailure(`tips still shown in the second game: ${JSON.stringify(later)}`);
      cov('tips-off-after-first-game');
    }));
  }

  // 4) "Don't show tips" turns tips off for good.
  {
    const name = 'mobile-tips-off';
    add(name, () => scenario(name, mobile, async ({ page, result, shot, log, cov }) => {
      await page.evaluate(() => localStorage.setItem('skull.settings', JSON.stringify({ name: 'QA', opponents: 3 })));
      await page.reload();
      await page.evaluate(tipWatch);
      await page.click('#play-now');
      let clicked = false;
      const ctx = {
        log, rng: h.seeded(7), shot, coverage: result.coverage, strategy: 'suicide', checkLayout() {},
        async onTick() {
          if (clicked) return;
          const c = await coachState(page);
          if (c.shown && c.mode === 'tip') {
            await shot('tip');
            await page.click('.coach [data-coach="tips-off"]', { timeout: 2000 });
            clicked = true;
            await sleep(200);
            const after = await coachState(page);
            if (after.shown) throw new RunFailure('tip bubble still visible after "Don\'t show tips"');
            if (after.store.tipsOff !== '1') throw new RunFailure('skull.tipsOff not set');
            await page.evaluate(() => { window.__tips = []; });
            cov('click:tips-off');
          }
        },
      };
      await h.playGame(page, ctx);
      if (!clicked) throw new RunFailure('no tip ever appeared to switch off');
      const later = await page.evaluate(() => window.__tips);
      if (later.length) throw new RunFailure(`tips shown after "Don't show tips": ${JSON.stringify(later)}`);
      const st = await storage(page);
      if (st.seen.length !== 1) log(`  note: tipsSeen = ${JSON.stringify(st.seen)}`);
      // Play now again: still no tips
      await page.click('#gameover [data-cmd="new-game"]');
      await page.click('#play-now');
      await sleep(4000);
      if ((await page.evaluate(() => window.__tips)).length) throw new RunFailure('tips came back in a new game');
    }));
  }

  // Run with limited concurrency (each scenario is its own browser context).
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Number(process.env.QA_FLOW_CONCURRENCY) || 6 }, async () => {
    while (next < tasks.length) { const t = tasks[next++]; results.push(await t()); }
  });
  await Promise.all(workers);
  return results;
}

class StopPlay extends Error {}
