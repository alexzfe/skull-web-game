// Bones — the skeleton biker bartender who coaches the tutorial and drops first-game
// tips. Pure presentation: directors drive him through say()/hide(); he never
// touches game state. In guide mode with `lock`, a capture-phase guard swallows
// every click outside the spotlit target and the bubble.

const MOODS = new Set(['neutral', 'grin', 'wince']);
let uid = 0;

// Inline SVG portrait. `crop: 'head'` frames just the skull (setup-screen badge).
export function bonesSVG({ mood = 'neutral', crop = null } = {}) {
  const p = `bn${++uid}`;
  const bone = `url(#${p}-bone)`;
  const ribs = [104, 111, 118, 125].map(y =>
    `<path d="M58 ${y}C51 ${y - 1} 45 ${y + 1} 42 ${y + 6}M62 ${y}C69 ${y - 1} 75 ${y + 1} 78 ${y + 6}"/>`).join('');
  const viewBox = crop === 'head' ? '22 4 90 84' : '0 0 120 140';
  return `<svg class="bones" viewBox="${viewBox}" data-mood="${MOODS.has(mood) ? mood : 'neutral'}" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${p}-bone" gradientUnits="userSpaceOnUse" x1="0" y1="8" x2="0" y2="90">
      <stop offset="0" stop-color="#fdf7e8"/><stop offset=".65" stop-color="#e4d7ba"/><stop offset="1" stop-color="#b4a585"/>
    </linearGradient>
    <linearGradient id="${p}-leather" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3d2d26"/><stop offset="1" stop-color="#110b09"/>
    </linearGradient>
    <linearGradient id="${p}-band" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ff3d62"/><stop offset="1" stop-color="#990b28"/>
    </linearGradient>
    <radialGradient id="${p}-eye">
      <stop offset="0" stop-color="#e9feff"/><stop offset=".35" stop-color="#2de2ff"/><stop offset="1" stop-color="#2de2ff" stop-opacity="0"/>
    </radialGradient>
    <pattern id="${p}-dots" width="7" height="7" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r=".9" fill="#ffe6ea" fill-opacity=".75"/><circle cx="5.5" cy="5.5" r=".6" fill="#ffe6ea" fill-opacity=".45"/>
    </pattern>
  </defs>

  <g class="bn-body">
    <path d="M38 102Q60 92 82 102L80 140H40Z" fill="#140e0c"/>
    <g fill="none" stroke-linecap="round">
      <g stroke="#2b2420" stroke-width="4.6">${ribs}</g>
      <g stroke="${bone}" stroke-width="2.8">${ribs}</g>
    </g>
    <rect x="57.5" y="97" width="5" height="34" rx="2.5" fill="${bone}" stroke="#2b2420" stroke-width=".9"/>
    <rect x="54" y="82" width="12" height="6" rx="2.5" fill="${bone}" stroke="#2b2420"/>
    <rect x="54.8" y="89" width="10.4" height="6" rx="2.5" fill="${bone}" stroke="#2b2420"/>
    <path d="M8 140C8 115 22 101 45 96L53 99L50 121L47 140Z" fill="url(#${p}-leather)" stroke="#000" stroke-opacity=".6"/>
    <path d="M112 140C112 115 98 101 75 96L67 99L70 121L73 140Z" fill="url(#${p}-leather)" stroke="#000" stroke-opacity=".6"/>
    <path d="M45 96L53 99L50 121M75 96L67 99L70 121" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="1.4"/>
    <path d="M12 138C13 117 25 105 44 100M108 138C107 117 95 105 76 100" fill="none" stroke="#e8b04a" stroke-opacity=".5" stroke-dasharray="2 2.4"/>
    <circle cx="93" cy="123" r="8.5" fill="#1d100c" stroke="#e8b04a" stroke-width="1.2"/>
    <use href="#sym-rose" x="86.5" y="115" width="13" height="15"/>
    <circle cx="74" cy="111" r="1.4" fill="#d4c7ad"/><circle cx="73" cy="128" r="1.4" fill="#d4c7ad"/>
    <g class="bn-towel">
      <path d="M18 104Q29 94 43 97L37 140H15Z" fill="#ece3d1" stroke="#7b6d5a" stroke-width=".8"/>
      <path d="M18 104Q29 94 43 97Q37 104 22 109Z" fill="#cfc4ad"/>
      <path d="M15.6 127H36.6M15.3 131.5H36.2" stroke="#ff2d6f" stroke-width="2"/>
      <path d="M15.4 129.3H36.4" stroke="#2de2ff" stroke-width="1.2"/>
      <path d="M24 112L21 138M31 106L28 138" stroke="#b9ad96" stroke-width=".8" fill="none"/>
    </g>
  </g>

  <g class="bn-head"><g class="bn-tilt">
    <path d="M60 10C36 10 26 27 26 45C26 57 31 65 38 69L40 79Q60 85 80 79L82 69C89 65 94 57 94 45C94 27 84 10 60 10Z" fill="${bone}" stroke="#2b2420" stroke-width="1.8"/>
    <path d="M32 58Q37 65 45 64M88 58Q83 65 75 64" fill="none" stroke="#a8977a" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M87 47L83 51.5L86 54.5L83 59" fill="none" stroke="#6b5a48" stroke-width="1.2" stroke-linecap="round"/>
    <path d="M93 36C100 31 106 29 111 30C107 35 104 38 99 41Z" fill="url(#${p}-band)" stroke="#5c0516"/>
    <path d="M94 41C101 43 105 48 106 55C100 52 96 50 91 46Z" fill="url(#${p}-band)" stroke="#5c0516"/>
    <path d="M25 45C25 22 40 7.5 60 7.5S95 22 95 45C88 38.5 75 35 60 35S32 38.5 25 45Z" fill="url(#${p}-band)"/>
    <path d="M25 45C25 22 40 7.5 60 7.5S95 22 95 45C88 38.5 75 35 60 35S32 38.5 25 45Z" fill="url(#${p}-dots)" stroke="#5c0516" stroke-width="1.4"/>
    <path d="M31 39C38 34 49 32 60 32S82 34 89 39" fill="none" stroke="#5c0516" stroke-opacity=".6"/>
    <path d="M40 19C45 14 51 12 57 12" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
    <circle cx="94" cy="39.5" r="3.6" fill="#c3102f" stroke="#5c0516"/>

    <g class="mood mood-neutral">
      <path d="M36 50C36 42 50 41 52 49C53 56 47 60 43 59C38 58 36 55 36 50ZM84 50C84 42 70 41 68 49C67 56 73 60 77 59C82 58 84 55 84 50Z" fill="#120d0b"/>
      <circle class="bn-eye" cx="45" cy="52" r="4.2" fill="url(#${p}-eye)"/><circle class="bn-eye" cx="75" cy="52" r="4.2" fill="url(#${p}-eye)"/>
      <path d="M35 40H53V49.5Q44 46.5 35 48.5ZM85 40H67V49.5Q76 46.5 85 48.5Z" fill="${bone}"/>
      <path d="M35.5 48.5Q44 46.5 52.5 49.5M84.5 48.5Q76 46.5 67.5 49.5" fill="none" stroke="#2b2420" stroke-width="1.8" stroke-linecap="round"/>
    </g>
    <g class="mood mood-grin">
      <path d="M36 49C36 41 50 40 52 48C53 55 47 59 43 58C38 57 36 54 36 49Z" fill="#120d0b"/>
      <circle class="bn-eye" cx="45" cy="50" r="4.4" fill="url(#${p}-eye)"/>
      <path d="M68 52Q76 43 85 51Q76 48 68 52Z" fill="#120d0b" stroke="#120d0b" stroke-width="2.4" stroke-linejoin="round"/>
      <path d="M36 41Q44 36 52 40M68 43Q76 39 84 43" fill="none" stroke="#8f7f63" stroke-width="1.4" stroke-linecap="round"/>
    </g>
    <g class="mood mood-wince">
      <path d="M38 45.5L50 51L38 56.5M82 45.5L70 51L82 56.5" fill="none" stroke="#120d0b" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M36 42Q43 40 51 44M84 42Q77 40 69 44" fill="none" stroke="#8f7f63" stroke-width="1.4" stroke-linecap="round"/>
      <path class="bn-sweat" d="M95 52C97 56 99 58 99 61A3.2 3.2 0 0 1 92.6 61C92.6 58 94 56 95 52Z" fill="#2de2ff" fill-opacity=".85"/>
    </g>

    <path d="M60 58L55.5 66.5Q60 68.5 64.5 66.5Z" fill="#120d0b"/>

    <g class="bn-mouth">
      <g class="mood mood-neutral">
        <path d="M44 72Q60 76 76 72L75 79Q60 83 45 79Z" fill="${bone}" stroke="#2b2420" stroke-width="1.2"/>
        <path d="M45 75.8Q60 79.5 75 75.8M49 73.5V80M53.5 74.3V81M58 74.8V81.6M62 74.8V81.6M66.5 74.3V81M71 73.5V80" fill="none" stroke="#3a302a" stroke-width="1.1"/>
        <path d="M71 77.5L89 70" stroke="#c9a66b" stroke-width="2" stroke-linecap="round"/>
        <path d="M86.5 71L89 70" stroke="#7a5a2c" stroke-width="2" stroke-linecap="round"/>
      </g>
      <g class="mood mood-grin">
        <path d="M39 69Q60 95 81 69Q60 78 39 69Z" fill="#120d0b"/>
        <path d="M41.5 70Q60 78.5 78.5 70L77 75Q60 82 43 75Z" fill="${bone}" stroke="#2b2420" stroke-width="1"/>
        <path d="M47 72.5V77.5M52 74V79.3M57 74.8V80.2M63 74.8V80.2M68 74V79.3M73 72.5V77.5" stroke="#3a302a" stroke-width="1"/>
        <path d="M48 83.5Q60 88.5 72 83.5L70.5 80.5Q60 84.5 49.5 80.5Z" fill="${bone}" stroke="#2b2420" stroke-width=".9"/>
        <path d="M74 75.5L75.6 79.6L77.2 75.5Z" fill="#e8b04a"/>
      </g>
      <g class="mood mood-wince">
        <path d="M42 73L78 70L78 79.5L42 80.5Z" fill="${bone}" stroke="#2b2420" stroke-width="1.2" stroke-linejoin="round"/>
        <path d="M42.5 77L47 74.6L51.5 77.6L56 74.4L60.5 77.4L65 74.2L69.5 77.2L74 74.2L77.5 76" fill="none" stroke="#3a302a" stroke-width="1.4" stroke-linejoin="round"/>
      </g>
    </g>
  </g></g>
</svg>`;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const PAD = 6;     // spotlight padding around the target
const GAP = 16;    // bubble distance from the target
const EDGE = 8;    // min distance from the viewport edge
const TIP_MIN_MS = 900;   // a tip ignores dismiss-clicks this long after it appears
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu'];

export function createCoach() {
  const root = document.createElement('div');
  root.className = 'coach-root';
  root.hidden = true;
  root.innerHTML = `
    <div class="coach-spot" hidden></div>
    <div class="coach" role="dialog" aria-label="Bones, your coach">
      <div class="coach-avatar">${bonesSVG()}</div>
      <div class="coach-bubble">
        <div class="coach-name">Bones</div>
        <div class="coach-text" aria-live="polite"></div>
        <div class="coach-actions"></div>
        <div class="coach-foot">
          <button type="button" class="coach-link coach-tipsoff" data-coach="tips-off">Don't show tips</button>
        </div>
      </div>
      <button type="button" class="coach-link coach-skip" data-coach="skip">Skip tutorial</button>
    </div>`;
  document.body.appendChild(root);

  const spot = root.querySelector('.coach-spot');
  const box = root.querySelector('.coach');
  const svg = root.querySelector('.bones');
  const text = root.querySelector('.coach-text');
  const actionsEl = root.querySelector('.coach-actions');
  const mobileMQ = window.matchMedia('(max-width: 640px)');

  let cur = null;        // { o, resolve, at, scrolled }
  let tipTimer = null;
  let raf = 0;
  let skipFn = null;
  let placed = '';       // last applied layout, to avoid restyling every frame

  // ---------- public ----------

  function say(opts = {}) {
    settle();
    clearTimeout(tipTimer);
    const o = {
      text: '', mood: 'neutral', target: null, lock: false, next: false,
      buttons: null, mode: 'guide', ms: 5000, ...opts,
    };
    if (o.mode !== 'tip') o.mode = 'guide';
    const tip = o.mode === 'tip';

    return new Promise(resolve => {
      cur = { o, resolve, at: performance.now(), scrolled: false };
      box.dataset.mode = o.mode;
      box.classList.toggle('choice', !tip && Array.isArray(o.buttons) && o.buttons.length > 0);
      root.classList.toggle('lock', !tip && !!o.lock);
      root.classList.toggle('soft', !tip && !o.lock && !!o.target);
      svg.dataset.mood = MOODS.has(o.mood) ? o.mood : 'neutral';
      text.innerHTML = o.text;

      const btns = [];
      if (!tip && Array.isArray(o.buttons)) {
        o.buttons.forEach((b, i) => btns.push(`<button type="button" class="btn ${b.primary ? 'primary' : ''}" data-coach-btn="${i}">${esc(b.label)}</button>`));
      } else if (!tip && o.next) {
        btns.push(`<button type="button" class="btn primary" data-coach="next">Next <span aria-hidden="true">→</span></button>`);
      }
      actionsEl.innerHTML = btns.join('');
      actionsEl.hidden = !btns.length;

      root.hidden = false;
      restart(box, 'pop');
      restart(svg, 'talk');
      placed = '';
      layout();
      loop();
      if (btns.length && !mobileMQ.matches) actionsEl.querySelector('.primary, .btn')?.focus({ preventScroll: true });

      // The tip's link only arms after the grace period, so a tap already headed for
      // the table can't land on it when the bubble pops in under the finger.
      box.classList.remove('armed');
      if (tip) {
        tipTimer = setTimeout(() => {
          if (cur?.o !== o) return;
          box.classList.add('armed');
          tipTimer = setTimeout(() => { if (cur?.o === o) hide(); }, Math.max(0, o.ms - TIP_MIN_MS));
        }, TIP_MIN_MS);
      }
      else if (!o.next && !o.buttons) settle();   // plain guide line: resolves as soon as it's shown
    });
  }

  function hide() {
    settle();
    clearTimeout(tipTimer);
    cancelAnimationFrame(raf);
    raf = 0;
    cur = null;
    root.hidden = true;
    spot.hidden = true;
    root.classList.remove('lock', 'soft', 'dim-all');
  }

  function onSkip(fn) { skipFn = typeof fn === 'function' ? fn : null; }

  function destroy() {
    hide();
    BLOCKED.forEach(t => window.removeEventListener(t, guard, true));
    window.removeEventListener('keydown', guardKeys, true);
    window.removeEventListener('keyup', guardKeys, true);
    window.removeEventListener('pointerdown', tipDismiss, true);
    root.remove();
  }

  // ---------- internals ----------

  function settle(value) {
    const r = cur?.resolve;
    if (cur) cur.resolve = null;
    r?.(value);
  }

  function restart(node, cls) {
    node.classList.remove(cls);
    void node.getBoundingClientRect();
    node.classList.add(cls);
  }

  function targets() {
    if (!cur?.o.target) return [];
    try { return [...document.querySelectorAll(cur.o.target)]; } catch { return []; }
  }

  function visibleTarget() {
    for (const n of targets()) {
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return { n, r };
    }
    return null;
  }

  function loop() {
    if (raf) return;
    const tick = () => {
      if (!cur) { raf = 0; return; }
      layout();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // Re-resolved every frame: the UI rebuilds its DOM on every render.
  function layout() {
    if (!cur) return;
    const { o } = cur;
    const tip = o.mode === 'tip';
    let t = visibleTarget();
    const W = window.innerWidth, H = window.innerHeight;

    // Jump (don't glide) to an off-screen target, so the bubble docks against
    // where the target ends up rather than where it was mid-scroll.
    if (t && !cur.scrolled) {
      cur.scrolled = true;
      if (t.r.top < 0 || t.r.bottom > H) { t.n.scrollIntoView({ block: 'center', behavior: 'instant' }); t = visibleTarget(); }
    }

    root.classList.toggle('dim-all', !tip && o.lock && !t);
    spot.hidden = !t;
    let key = '';
    if (t) {
      const { r } = t;
      key = `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
      Object.assign(spot.style, {
        left: `${r.left - PAD}px`, top: `${r.top - PAD}px`,
        width: `${r.width + PAD * 2}px`, height: `${r.height + PAD * 2}px`,
      });
    }

    const mobile = mobileMQ.matches;
    // mobile tips without a target rest just above the hand, clear of the top bar
    const hand = mobile && tip && !t ? document.querySelector('#hand')?.getBoundingClientRect() : null;
    const handTop = hand && hand.height && hand.top > 0 && hand.top < H ? Math.round(hand.top) : null;
    const sig = `${mobile}|${key}|${W}x${H}|${box.offsetWidth}x${box.offsetHeight}|${handTop}`;
    if (sig === placed) return;
    placed = sig;

    let dock;
    // Untargeted guide lines sit low, so the table (and its x-ray) stays readable.
    if (mobile) dock = t ? (t.r.top + t.r.height / 2 < H / 2 ? 'bottom' : 'top') : 'bottom';
    else if (!t) dock = tip ? 'corner' : 'low';
    else dock = 'float';
    box.dataset.dock = dock;
    box.classList.toggle('small', mobile || tip);

    box.style.bottom = handTop != null && handTop - box.offsetHeight > 64 ? `${H - handTop + 6}px` : '';
    if (dock !== 'float') { box.style.left = box.style.top = ''; return; }

    const { r } = t;
    const w = box.offsetWidth, h = box.offsetHeight;
    const clampX = x => Math.max(EDGE, Math.min(W - w - EDGE, x));
    const clampY = y => Math.max(EDGE, Math.min(H - h - EDGE, y));
    const cx = clampX(r.left + r.width / 2 - w / 2);
    const cy = clampY(r.top + r.height / 2 - h / 2);
    const options = [
      { ok: r.bottom + GAP + h <= H - EDGE, x: cx, y: r.bottom + GAP },
      { ok: r.top - GAP - h >= EDGE, x: cx, y: r.top - GAP - h },
      { ok: r.right + GAP + w <= W - EDGE, x: r.right + GAP, y: cy },
      { ok: r.left - GAP - w >= EDGE, x: r.left - GAP - w, y: cy },
    ];
    // prefer spots that keep the pot / bid readout visible
    const avoid = [...document.querySelectorAll('[data-tut="pot"], [data-tut="bid-display"]')]
      .filter(n => !t.n.contains(n) && !n.contains(t.n)).map(n => n.getBoundingClientRect());
    const clear = c => avoid.every(a => c.x + w <= a.left || c.x >= a.right || c.y + h <= a.top || c.y >= a.bottom);
    const pick = options.find(c => c.ok && clear(c)) || options.find(c => c.ok)
      || (H - r.bottom > r.top ? { x: cx, y: clampY(r.bottom + GAP) } : { x: cx, y: clampY(r.top - GAP - h) });
    box.style.left = `${Math.round(pick.x)}px`;
    box.style.top = `${Math.round(pick.y)}px`;
  }

  // Guide-mode lock: only the target(s) and the bubble take input.
  function allowed(node) {
    if (!(node instanceof Node)) return true;
    if (root.contains(node)) return true;
    return targets().some(n => n.contains(node));
  }

  function guard(e) {
    if (!cur || cur.o.mode !== 'guide' || !cur.o.lock) return;
    if (allowed(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function guardKeys(e) {
    if (!cur || cur.o.mode !== 'guide' || !cur.o.lock) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (allowed(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // Tips never block: any tap anywhere (after a short grace period) dismisses them.
  function tipDismiss(e) {
    if (!cur || cur.o.mode !== 'tip') return;
    if (e.target instanceof Element && e.target.closest('[data-coach="tips-off"]')) return;
    if (performance.now() - cur.at < TIP_MIN_MS) return;
    hide();
  }

  BLOCKED.forEach(t => window.addEventListener(t, guard, { capture: true, passive: false }));
  window.addEventListener('keydown', guardKeys, true);
  window.addEventListener('keyup', guardKeys, true);
  window.addEventListener('pointerdown', tipDismiss, true);

  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !cur) return;
    const { o } = cur;
    if (b.dataset.coachBtn != null) {
      const v = o.buttons?.[Number(b.dataset.coachBtn)]?.value;
      settle(v);
      if (cur?.o === o) hide();
    } else if (b.dataset.coach === 'next') {
      settle(true);
      if (cur?.o === o) hide();
    } else if (b.dataset.coach === 'skip') {
      hide();
      skipFn?.();
    } else if (b.dataset.coach === 'tips-off') {
      try { localStorage.setItem('skull.tipsOff', '1'); } catch { /* storage unavailable */ }
      hide();
    }
  });

  window.addEventListener('resize', () => { placed = ''; });

  return { say, hide, onSkip, destroy };
}
