// Reactions — multiplayer emoji pop-ups + targeted emotes (MULTIPLAYER_SPEC §9).
//
//   const rx = mountReactions({ root, send, seatEl, me? });
//   rx.handle({ e: 'react', from, kind, target? });   // route server events here
//   rx.destroy();                                     // removes every node/listener it added
//
// - send(kind, target?) talks to the server (e.g. rc.react). It may return false
//   (socket not open); then no cooldown is started.
// - seatEl(playerId) returns the seat element or null. It is re-resolved on every use
//   because the UI re-renders seats freely.
// - me (optional): your player id, or a function returning it. Used only to keep your own
//   seat out of the targets; without it, a seat with class `me` is skipped.
// Pure DOM + CSS animation, no dependencies. Nothing happens until mounted.
//
// Targeted emotes (aimed at another seat):
//   🍅 tomato   flies in an arc and splats; the seat flinches
//   💐 bouquet  floats over and bursts into petals
//   👉 accuse   a pointing beam from your seat to theirs, ‼️ over them
//   🥂 cheers   a glass glides over and clinks; if they raise one back within CHEERS_MS,
//               both seats glow and a big "Cheers!" lands between them

export const KINDS = [
  { id: 'smirk', emoji: '😏', label: 'Smirk' },
  { id: 'think', emoji: '🤔', label: 'Hmm…' },
  { id: 'skull', emoji: '💀', label: 'Skull' },
  { id: 'rose', emoji: '🌹', label: 'Rose' },
  { id: 'laugh', emoji: '😂', label: 'Laugh' },
  { id: 'tomato', emoji: '🍅', label: 'Throw a tomato', aim: 'Tap a rider to throw', verb: 'Throw a tomato at' },
  { id: 'bouquet', emoji: '💐', label: 'Toss a bouquet', aim: 'Tap a rider to toss flowers', verb: 'Toss flowers to' },
  { id: 'accuse', emoji: '👉', label: 'Accuse', aim: 'Tap a rider to accuse', verb: 'Accuse' },
  { id: 'cheers', emoji: '🥂', label: 'Cheers', aim: 'Tap a rider to raise a glass', verb: 'Raise a glass to' },
];
export const EMOJI = Object.fromEntries(KINDS.map(k => [k.id, k.emoji]));
export const TARGETED = KINDS.filter(k => k.aim).map(k => k.id);
const KIND = Object.fromEntries(KINDS.map(k => [k.id, k]));
export const COOLDOWN_MS = 2000;   // mirrors REACT_MS on the server
export const CHEERS_MS = 4000;     // a cheers raised back within this counts as a toast
export const MAX_SEATS = 6;
const MAX_FX = 24;                 // effects on screen at once; extra ones are skipped
const TRAY_IDLE_MS = 5000;         // the tray closes itself so it never covers the table for long
const AIM_IDLE_MS = 7000;
const POP_MS = 1600;
const FLY_MS = 650;
const SPLAT_MS = 1500;
const BURST_MS = 1300;
const ACCUSE_MS = 1700;
const GLOW_MS = 1400;
const TOAST_MS = 1900;

// ---------- pure helpers (tested) ----------

// Validate a server event. Returns a clean {from, kind, target?} or null.
export function parseReact(ev) {
  if (!ev || ev.e !== 'react' || !Object.hasOwn(EMOJI, ev.kind) || !Number.isInteger(ev.from)) return null;
  if (!TARGETED.includes(ev.kind)) return { from: ev.from, kind: ev.kind };
  if (!Number.isInteger(ev.target) || ev.target === ev.from) return null;
  return { from: ev.from, kind: ev.kind, target: ev.target };
}

// Client-side cooldown, same rule as the server: at most one per COOLDOWN_MS.
export function createCooldown(ms = COOLDOWN_MS) {
  let last = null;
  return {
    remaining: now => (last == null ? 0 : Math.max(0, last + ms - now)),
    ready: now => last == null || now - last >= ms,
    start: now => { last = now; },
  };
}

// Cheers pairing: note(from, target, now) is true when `target` raised a glass to `from`
// within `ms`. A toast uses up both glasses, so the next cheers starts fresh.
export function createToasts(ms = CHEERS_MS) {
  const open = new Map();   // "from>target" -> time
  return {
    note(from, target, now) {
      const back = `${target}>${from}`;
      const at = open.get(back);
      if (at != null && now - at <= ms) { open.delete(back); return true; }
      open.set(`${from}>${target}`, now);
      return false;
    },
  };
}

// Where a seat's effects anchor: pops float up from its upper middle, throws land mid-seat.
export function anchor(rect, where = 'mid') {
  return { x: rect.left + rect.width / 2, y: where === 'top' ? rect.top + Math.min(rect.height * .35, 28) : rect.top + rect.height / 2 };
}

// Flight: delta from start to end and an arc height that grows with distance (scaled by `arc`).
export function flight(a, b, arc = 1) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  return { dx, dy, h: Math.round(Math.min(160, 40 + dist * .35) * arc), spin: dx < 0 ? -1 : 1 };
}

// Accuse beam: length and angle from a to b. `flip` keeps the 👉 upright when pointing left.
export function beam(a, b) {
  const deg = Math.round(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI);
  return { len: Math.round(Math.hypot(b.x - a.x, b.y - a.y)), deg, flip: Math.abs(deg) > 90 };
}

// ---------- mount ----------

export function mountReactions({ root, send, seatEl, me, doc = root?.ownerDocument || globalThis.document, now = () => Date.now() }) {
  const win = doc.defaultView || globalThis;
  const cool = createCooldown();
  const toasts = createToasts();
  const timers = new Set();
  const later = (fn, ms) => { const id = win.setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const clear = id => { if (id != null) { win.clearTimeout(id); timers.delete(id); } };
  const reduced = !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Stylesheet (once per document; ref-counted so destroy() of one mount doesn't strip another's).
  let link = doc.querySelector('link[data-rx-css]');
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../reactions.css', import.meta.url).href;
    link.dataset.rxCss = '';
    doc.head.appendChild(link);
  }
  link.dataset.rxCount = String((+link.dataset.rxCount || 0) + 1);

  const el = (tag, cls, attrs = {}) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // Effects layer (pointer-events: none) and the picker (button + tray + aim overlay).
  const fx = el('div', 'rx-fx', { 'aria-hidden': 'true' });
  const ui = el('div', 'rx');
  const btn = el('button', 'rx-btn', { type: 'button', 'aria-label': 'Reactions', 'aria-expanded': 'false', title: 'Reactions' });
  btn.innerHTML = '<span class="rx-btn-face">😏</span><span class="rx-btn-ring"></span>';
  const tray = el('div', 'rx-tray', { role: 'menu', 'aria-label': 'Reactions' });
  tray.hidden = true;
  // Two rows: pop-ups over your seat, then the ones you aim at someone.
  const rows = [el('div', 'rx-row'), el('div', 'rx-row rx-row-aim')];
  for (const k of KINDS) {
    const b = el('button', 'rx-pick', { type: 'button', role: 'menuitem', 'data-kind': k.id, 'aria-label': k.label, title: k.label });
    b.textContent = k.emoji;
    rows[k.aim ? 1 : 0].appendChild(b);
  }
  tray.append(...rows);
  const aim = el('div', 'rx-aim');
  aim.hidden = true;
  const aimBar = el('div', 'rx-aim-bar');
  aimBar.innerHTML = '<span></span>';
  const cancel = el('button', 'rx-aim-cancel', { type: 'button' });
  cancel.textContent = 'Cancel';
  aimBar.appendChild(cancel);
  const targets = el('div', 'rx-targets');
  aim.append(targets, aimBar);
  ui.append(tray, btn);
  root.append(fx, aim, ui);

  // ---------- picker ----------

  let trayTimer = null, aimTimer = null, aimRaf = null, coolTimer = null, aimKind = null, destroyed = false;
  const hits = new Set();   // seats we added .rx-hit to, cleaned up on destroy

  const myId = () => (typeof me === 'function' ? me() : me);

  function openTray(open) {
    tray.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    ui.classList.toggle('open', open);
    clear(trayTimer); trayTimer = null;
    if (open) trayTimer = later(() => openTray(false), TRAY_IDLE_MS);
  }

  function showCooldown() {
    const left = cool.remaining(now());
    btn.disabled = left > 0;
    btn.classList.toggle('cooling', left > 0);
    btn.style.setProperty('--rx-cool', `${left}ms`);
    // Restart the ring animation.
    const ring = btn.lastChild;
    ring.style.animation = 'none';
    void ring.offsetWidth;
    ring.style.animation = '';
    clear(coolTimer); coolTimer = null;
    if (left > 0) coolTimer = later(showCooldown, left);
  }

  function fire(kind, target) {
    if (!cool.ready(now())) return;
    const ok = target === undefined ? send(kind) : send(kind, target);
    if (ok === false) return;
    cool.start(now());
    showCooldown();
  }

  // Seats that can be targeted: every rendered seat except yours.
  function targetSeats() {
    const mine = myId();
    const out = [];
    for (let id = 0; id < MAX_SEATS; id++) {
      if (id === mine) continue;
      const s = seatEl(id);
      if (!s || !s.isConnected || (mine == null && s.classList.contains('me'))) continue;
      const r = s.getBoundingClientRect();
      if (r.width && r.height) out.push({ id, rect: r, name: s.querySelector('.seat-name')?.textContent || `Player ${id + 1}` });
    }
    return out;
  }

  // Aim mode: a ring over each target seat, kept in place while the table re-renders.
  function layoutTargets() {
    const k = KIND[aimKind];
    const list = targetSeats();
    const want = `${k.id}:${list.map(t => t.id).join(',')}`;
    if (targets.dataset.ids !== want) {
      targets.dataset.ids = want;
      targets.replaceChildren(...list.map(t => {
        const b = el('button', `rx-target rx-target-${k.id}`, { type: 'button', 'data-target': t.id, 'aria-label': `${k.verb} ${t.name}` });
        b.innerHTML = `<span>${k.emoji}</span>`;
        return b;
      }));
    }
    list.forEach((t, i) => {
      const b = targets.children[i];
      b.style.left = `${t.rect.left}px`; b.style.top = `${t.rect.top}px`;
      b.style.width = `${t.rect.width}px`; b.style.height = `${t.rect.height}px`;
    });
    aimBar.firstChild.textContent = list.length ? `${k.emoji} ${k.aim}` : 'No one to pick';
  }

  function aimLoop() {
    layoutTargets();
    aimRaf = win.requestAnimationFrame ? win.requestAnimationFrame(aimLoop) : null;
  }

  function startAim(kind) {
    const on = kind != null;
    aimKind = kind;
    aim.hidden = !on;
    aim.dataset.kind = kind || '';
    ui.classList.toggle('aiming', on);
    clear(aimTimer); aimTimer = null;
    if (aimRaf != null) { win.cancelAnimationFrame?.(aimRaf); aimRaf = null; }
    if (on) { aimLoop(); aimTimer = later(() => startAim(null), AIM_IDLE_MS); } else { targets.replaceChildren(); delete targets.dataset.ids; }
  }

  function onBtn() {
    if (ui.classList.contains('aiming')) { startAim(null); return; }
    openTray(tray.hidden);
  }
  function onTray(e) {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    openTray(false);
    const kind = b.dataset.kind;
    if (TARGETED.includes(kind)) { if (cool.ready(now())) startAim(kind); return; }
    fire(kind);
  }
  function onAim(e) {
    const t = e.target.closest('[data-target]');
    if (t) { const kind = aimKind; startAim(null); fire(kind, +t.dataset.target); return; }
    if (e.target.closest('.rx-aim-cancel')) startAim(null);
  }
  function onDocDown(e) {
    // Tap outside closes the tray (the tap still reaches the game).
    if (!tray.hidden && !ui.contains(e.target)) openTray(false);
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (!aim.hidden) startAim(null);
    else if (!tray.hidden) { openTray(false); btn.focus(); }
  }
  btn.addEventListener('click', onBtn);
  tray.addEventListener('click', onTray);
  aim.addEventListener('click', onAim);
  doc.addEventListener('pointerdown', onDocDown, true);
  doc.addEventListener('keydown', onKey);

  // ---------- effects ----------

  function rectOf(id) {
    const s = id == null ? null : seatEl(id);
    if (!s || !s.isConnected) return null;
    const r = s.getBoundingClientRect();
    return r.width || r.height ? r : null;
  }

  // Sender off screen (shouldn't happen): effects start from the bottom middle.
  const fromRect = id => rectOf(id) || { left: win.innerWidth / 2 - 30, top: win.innerHeight - 60, width: 60, height: 60 };

  function spawn(node, ms) {
    if (fx.childElementCount >= MAX_FX) return node;   // busy table: skip it rather than pile up
    fx.appendChild(node);
    later(() => node.remove(), ms);
    return node;
  }

  const place = (n, p) => { n.style.left = `${p.x}px`; n.style.top = `${p.y}px`; return n; };
  const rnd = (lo, hi) => Math.round(lo + Math.random() * (hi - lo));

  function pop(r) {
    const s = rectOf(r.from);
    if (!s) return;          // sender's seat isn't on screen: nothing to anchor to
    const n = place(el('div', `rx-pop rx-pop-${r.kind}`), anchor(s, 'top'));
    n.textContent = EMOJI[r.kind];
    n.style.setProperty('--rx-drift', `${rnd(-12, 12)}px`);
    spawn(n, POP_MS);
  }

  // A soft ring over a seat (drawn in the effects layer, so seat styles stay untouched).
  function glow(id, tone) {
    const s = rectOf(id);
    if (!s) return;
    const n = el('div', `rx-glow rx-glow-${tone}`);
    n.style.left = `${s.left}px`; n.style.top = `${s.top}px`;
    n.style.width = `${s.width}px`; n.style.height = `${s.height}px`;
    spawn(n, GLOW_MS);
  }

  function jolt(id) {
    // Re-resolved; harmless if the seat re-rendered meanwhile.
    const s = seatEl(id);
    if (!s) return;
    s.classList.remove('rx-hit'); void s.offsetWidth; s.classList.add('rx-hit');
    hits.add(id);
    later(() => seatEl(id)?.classList.remove('rx-hit'), 500);
  }

  function splat(at, id) {
    const n = place(el('div', 'rx-splat'), at);
    n.innerHTML = '<span class="rx-splat-goo"></span><span class="rx-splat-face">🍅</span>';
    n.style.setProperty('--rx-rot', `${rnd(0, 360)}deg`);
    spawn(n, SPLAT_MS + 400);
    jolt(id);
  }

  // A ring of bits flying outward from `at` (petals, sparkles).
  function burst(at, cls, bits, reach) {
    const n = place(el('div', `rx-burst ${cls}`), at);
    bits.forEach((b, i) => {
      const s = el('span');
      s.textContent = b;
      const a = (i / bits.length) * Math.PI * 2 + Math.random() * .6;
      const d = reach * (.6 + Math.random() * .4);
      s.style.setProperty('--bx', `${Math.round(Math.cos(a) * d)}px`);
      s.style.setProperty('--by', `${Math.round(Math.sin(a) * d)}px`);
      s.style.setProperty('--br', `${rnd(-200, 200)}deg`);
      n.appendChild(s);
    });
    spawn(n, BURST_MS);
  }

  function petals(at, id) {
    burst(at, 'rx-petals', ['🌸', '🌹', '🌸', '🌸', '🌹', '🌸', '🌸', '🌹'], 56);
    glow(id, 'rose');
  }

  function clink(at, r, toasted) {
    burst(at, 'rx-sparks', ['✨', '✨', '✨', '✨', '✨'], 34);
    if (!toasted) return;
    glow(r.from, 'gold'); glow(r.target, 'gold');
    const a = anchor(fromRect(r.from)), b = anchor(fromRect(r.target));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = place(el('div', 'rx-toast'), mid);
    n.innerHTML = '<span class="rx-toast-glass">🥂</span><span class="rx-toast-word">Cheers!</span>';
    spawn(n, TOAST_MS);
    burst(mid, 'rx-sparks rx-sparks-big', ['✨', '🎉', '✨', '✨', '🎉', '✨', '✨', '🎉'], 90);
  }

  // Something flies from the sender's seat to the target's, then `land(at)` runs.
  function lob(r, { emoji, arc = 1, spin = 1 }, land) {
    const to = rectOf(r.target);
    if (!to) return;
    const b = anchor(to, 'mid');
    const a = anchor(fromRect(r.from), 'mid');
    if (reduced) { land(b); return; }
    const f = flight(a, b, arc);
    // Three nested layers: x (linear), y (linear), bump (up then down) → a parabola.
    const x = place(el('div', 'rx-fly'), a);
    x.style.setProperty('--dx', `${f.dx}px`); x.style.setProperty('--dy', `${f.dy}px`);
    x.style.setProperty('--h', `${f.h}px`); x.style.setProperty('--spin', f.spin * spin);
    x.style.setProperty('--rx-fly', `${FLY_MS}ms`);
    x.innerHTML = `<div class="rx-fly-y"><div class="rx-fly-bump"><span class="rx-fly-thing">${emoji}</span></div></div>`;
    spawn(x, FLY_MS + 50);
    later(() => {
      // Land where the target seat is *now*, in case it moved mid-flight.
      const end = rectOf(r.target);
      land(end ? anchor(end, 'mid') : b);
    }, FLY_MS);
  }

  function accuse(r) {
    const to = rectOf(r.target);
    if (!to) return;
    const a = anchor(fromRect(r.from), 'mid');
    const bm = beam(a, anchor(to, 'mid'));
    const n = place(el('div', `rx-accuse${bm.flip ? ' flip' : ''}`), a);
    n.style.setProperty('--len', `${bm.len}px`);
    n.style.setProperty('--deg', `${bm.deg}deg`);
    n.innerHTML = '<span class="rx-beam"></span><span class="rx-finger">👉</span>';
    spawn(n, ACCUSE_MS);
    glow(r.target, 'accuse');
    const p = place(el('div', 'rx-pop rx-pop-accused'), anchor(to, 'top'));
    p.textContent = '‼️';
    p.style.setProperty('--rx-drift', '0px');
    spawn(p, POP_MS);
    jolt(r.target);
  }

  showCooldown();

  return {
    handle(ev) {
      if (destroyed) return;
      const r = parseReact(ev);
      if (!r) return;
      switch (r.kind) {
        case 'tomato': lob(r, { emoji: '🍅' }, at => splat(at, r.target)); break;
        case 'bouquet': lob(r, { emoji: '💐', arc: .8, spin: .25 }, at => petals(at, r.target)); break;
        case 'cheers': {
          const toasted = toasts.note(r.from, r.target, now());
          lob(r, { emoji: '🥂', arc: .35, spin: 0 }, at => clink(at, r, toasted));
          break;
        }
        case 'accuse': accuse(r); break;
        default: pop(r);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      startAim(null);
      for (const id of timers) win.clearTimeout(id);
      timers.clear();
      btn.removeEventListener('click', onBtn);
      tray.removeEventListener('click', onTray);
      aim.removeEventListener('click', onAim);
      doc.removeEventListener('pointerdown', onDocDown, true);
      doc.removeEventListener('keydown', onKey);
      for (const id of hits) seatEl(id)?.classList.remove('rx-hit');
      fx.remove(); aim.remove(); ui.remove();
      const left = (+link.dataset.rxCount || 1) - 1;
      if (left <= 0) link.remove(); else link.dataset.rxCount = String(left);
    },
  };
}
