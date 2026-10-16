// Reactions — multiplayer emoji pop-ups + 🍅 tomato throw (MULTIPLAYER_SPEC §9).
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
//   seat out of the tomato targets; without it, a seat with class `me` is skipped.
// Pure DOM + CSS animation, no dependencies. Nothing happens until mounted.

export const KINDS = [
  { id: 'smirk', emoji: '😏', label: 'Smirk' },
  { id: 'think', emoji: '🤔', label: 'Hmm…' },
  { id: 'skull', emoji: '💀', label: 'Skull' },
  { id: 'rose', emoji: '🌹', label: 'Rose' },
  { id: 'laugh', emoji: '😂', label: 'Laugh' },
  { id: 'tomato', emoji: '🍅', label: 'Throw a tomato' },
];
export const EMOJI = Object.fromEntries(KINDS.map(k => [k.id, k.emoji]));
export const COOLDOWN_MS = 2000;   // mirrors REACT_MS on the server
export const MAX_SEATS = 6;
const TRAY_IDLE_MS = 5000;         // the tray closes itself so it never covers the table for long
const AIM_IDLE_MS = 7000;
const POP_MS = 1600;
const FLY_MS = 650;
const SPLAT_MS = 1500;

// ---------- pure helpers (tested) ----------

// Validate a server event. Returns a clean {from, kind, target?} or null.
export function parseReact(ev) {
  if (!ev || ev.e !== 'react' || !Object.hasOwn(EMOJI, ev.kind) || !Number.isInteger(ev.from)) return null;
  if (ev.kind !== 'tomato') return { from: ev.from, kind: ev.kind };
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

// Where a seat's effects anchor: pops float up from its upper middle, throws land mid-seat.
export function anchor(rect, where = 'mid') {
  return { x: rect.left + rect.width / 2, y: where === 'top' ? rect.top + Math.min(rect.height * .35, 28) : rect.top + rect.height / 2 };
}

// Tomato flight: delta from start to end and an arc height that grows with distance.
export function flight(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  return { dx, dy, h: Math.round(Math.min(160, 40 + dist * .35)), spin: dx < 0 ? -1 : 1 };
}

// ---------- mount ----------

export function mountReactions({ root, send, seatEl, me, doc = root?.ownerDocument || globalThis.document, now = () => Date.now() }) {
  const win = doc.defaultView || globalThis;
  const cool = createCooldown();
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
  for (const k of KINDS) {
    const b = el('button', `rx-pick${k.id === 'tomato' ? ' rx-pick-tomato' : ''}`, { type: 'button', role: 'menuitem', 'data-kind': k.id, 'aria-label': k.label, title: k.label });
    b.textContent = k.emoji;
    tray.appendChild(b);
  }
  const aim = el('div', 'rx-aim');
  aim.hidden = true;
  const aimBar = el('div', 'rx-aim-bar');
  aimBar.innerHTML = '<span>🍅 Tap a rider to throw</span>';
  const cancel = el('button', 'rx-aim-cancel', { type: 'button' });
  cancel.textContent = 'Cancel';
  aimBar.appendChild(cancel);
  const targets = el('div', 'rx-targets');
  aim.append(targets, aimBar);
  ui.append(tray, btn);
  root.append(fx, aim, ui);

  // ---------- picker ----------

  let trayTimer = null, aimTimer = null, aimRaf = null, coolTimer = null, destroyed = false;
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

  // Seats that can be hit: every rendered seat except yours.
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
    const list = targetSeats();
    const want = list.map(t => String(t.id)).join(',');
    if (targets.dataset.ids !== want) {
      targets.dataset.ids = want;
      targets.replaceChildren(...list.map(t => {
        const b = el('button', 'rx-target', { type: 'button', 'data-target': t.id, 'aria-label': `Throw a tomato at ${t.name}` });
        b.innerHTML = '<span>🍅</span>';
        return b;
      }));
    }
    list.forEach((t, i) => {
      const b = targets.children[i];
      b.style.left = `${t.rect.left}px`; b.style.top = `${t.rect.top}px`;
      b.style.width = `${t.rect.width}px`; b.style.height = `${t.rect.height}px`;
    });
    if (!list.length) aimBar.firstChild.textContent = 'No one to hit';
    else aimBar.firstChild.textContent = '🍅 Tap a rider to throw';
  }

  function aimLoop() {
    layoutTargets();
    aimRaf = win.requestAnimationFrame ? win.requestAnimationFrame(aimLoop) : null;
  }

  function startAim(on) {
    aim.hidden = !on;
    ui.classList.toggle('aiming', on);
    clear(aimTimer); aimTimer = null;
    if (aimRaf != null) { win.cancelAnimationFrame?.(aimRaf); aimRaf = null; }
    if (on) { aimLoop(); aimTimer = later(() => startAim(false), AIM_IDLE_MS); } else { targets.replaceChildren(); delete targets.dataset.ids; }
  }

  function onBtn() {
    if (ui.classList.contains('aiming')) { startAim(false); return; }
    openTray(tray.hidden);
  }
  function onTray(e) {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    openTray(false);
    if (b.dataset.kind === 'tomato') { if (cool.ready(now())) startAim(true); return; }
    fire(b.dataset.kind);
  }
  function onAim(e) {
    const t = e.target.closest('[data-target]');
    if (t) { startAim(false); fire('tomato', +t.dataset.target); return; }
    if (e.target.closest('.rx-aim-cancel')) startAim(false);
  }
  function onDocDown(e) {
    // Tap outside closes the tray (the tap still reaches the game).
    if (!tray.hidden && !ui.contains(e.target)) openTray(false);
  }
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (!aim.hidden) startAim(false);
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

  function spawn(node, ms) {
    fx.appendChild(node);
    later(() => node.remove(), ms);
    return node;
  }

  function pop(r) {
    const s = rectOf(r.from);
    if (!s) return;          // sender's seat isn't on screen: nothing to anchor to
    const p = anchor(s, 'top');
    const n = el('div', `rx-pop rx-pop-${r.kind}`);
    n.textContent = EMOJI[r.kind];
    n.style.left = `${p.x}px`; n.style.top = `${p.y}px`;
    n.style.setProperty('--rx-drift', `${Math.round((Math.random() - .5) * 24)}px`);
    spawn(n, POP_MS);
  }

  function splat(at, id) {
    const n = el('div', 'rx-splat');
    n.innerHTML = '<span class="rx-splat-goo"></span><span class="rx-splat-face">🍅</span>';
    n.style.left = `${at.x}px`; n.style.top = `${at.y}px`;
    n.style.setProperty('--rx-rot', `${Math.round(Math.random() * 360)}deg`);
    spawn(n, SPLAT_MS + 400);
    // Jolt the target seat (re-resolved; harmless if it re-rendered meanwhile).
    const s = seatEl(id);
    if (s) {
      s.classList.remove('rx-hit'); void s.offsetWidth; s.classList.add('rx-hit');
      hits.add(id);
      later(() => seatEl(id)?.classList.remove('rx-hit'), 500);
    }
  }

  function throwTomato(r) {
    const to = rectOf(r.target);
    if (!to) return;
    const b = anchor(to, 'mid');
    // Sender off screen (shouldn't happen): lob it in from the bottom middle.
    const from = rectOf(r.from) || { left: win.innerWidth / 2 - 30, top: win.innerHeight - 60, width: 60, height: 60 };
    const a = anchor(from, 'mid');
    if (reduced) { splat(b, r.target); return; }
    const f = flight(a, b);
    // Three nested layers: x (linear), y (linear), bump (up then down) → a parabola.
    const x = el('div', 'rx-fly');
    x.style.left = `${a.x}px`; x.style.top = `${a.y}px`;
    x.style.setProperty('--dx', `${f.dx}px`); x.style.setProperty('--dy', `${f.dy}px`);
    x.style.setProperty('--h', `${f.h}px`); x.style.setProperty('--spin', f.spin);
    x.style.setProperty('--rx-fly', `${FLY_MS}ms`);
    x.innerHTML = '<div class="rx-fly-y"><div class="rx-fly-bump"><span class="rx-fly-tomato">🍅</span></div></div>';
    spawn(x, FLY_MS + 50);
    later(() => {
      // Land where the target seat is *now*, in case it moved mid-flight.
      const end = rectOf(r.target);
      splat(end ? anchor(end, 'mid') : b, r.target);
    }, FLY_MS);
  }

  showCooldown();

  return {
    handle(ev) {
      if (destroyed) return;
      const r = parseReact(ev);
      if (!r) return;
      if (r.kind === 'tomato') throwTomato(r);
      else pop(r);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      startAim(false);
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
