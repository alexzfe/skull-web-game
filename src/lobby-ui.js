// The lobby screen (MULTIPLAYER_SPEC §5, §7): room code + share, seats with
// avatars/names/🤖/📡, host options (seats via add/remove bot, timer, Open/Private),
// Start / Rematch, kick, Leave. After a game the same lobby shows the result.
//
//   const lobbyUI = createLobbyUI({ onOption, onAddBot, onRemoveBot, onKick, onStart, onLeave, onShare });
//   lobbyUI.render({ code, lobby, me, status })   — me = your member entry or null
import { lobbySummary, timerLabel, TIMERS, MIN_SEATS, MAX_SEATS } from './shell-core.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_TEXT = {
  connecting: 'Pulling up a chair…',
  reconnecting: '📡 Reconnecting…',
};

export function createLobbyUI(h) {
  const root = document.querySelector('#lobby');
  const el = {
    code: root.querySelector('#lobby-code'), body: root.querySelector('#lobby-body'),
    share: root.querySelector('[data-lobby="share"]'), flash: root.querySelector('#lobby-flash'),
  };
  let last = null;
  let flashTimer = null;

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-lobby]');
    if (!b || b.disabled) return;
    const seat = b.dataset.seat != null ? Number(b.dataset.seat) : undefined;
    switch (b.dataset.lobby) {
      case 'share': h.onShare(); break;
      case 'leave': h.onLeave(); break;
      case 'start': h.onStart(); break;
      case 'add-bot': h.onAddBot(); break;
      case 'remove-bot': h.onRemoveBot(seat); break;
      case 'kick': h.onKick(seat); break;
      case 'seats': h.onOption({ seats: Number(b.dataset.value) }); break;
      case 'timer': h.onOption({ timer: Number(b.dataset.value) }); break;
      case 'open': h.onOption({ open: b.dataset.value === '1' }); break;
    }
  });

  function render({ code, lobby, me, status }) {
    last = { code, lobby, me, status };
    el.code.textContent = code || '····';
    if (!lobby) {
      el.body.innerHTML = `<p class="lobby-note">${esc(STATUS_TEXT[status] || STATUS_TEXT.connecting)}</p>`;
      return;
    }
    const s = lobbySummary(lobby, me);
    const o = lobby.options;
    const inGame = lobby.phase === 'in-game';
    const parts = [];

    // Off the socket nothing we send would arrive, so the host buttons wait for it.
    const offline = status !== 'open';
    if (offline) parts.push(`<p class="lobby-note warn">${STATUS_TEXT.reconnecting}</p>`);
    if (lobby.lastWinner && !inGame) {
      const w = lobby.lastWinner;
      const you = me && !me.waiting && w.name === me.name;
      parts.push(`<div class="lobby-result"><span class="lr-av">${esc(w.avatar?.emoji || '💀')}</span><div><b>${you ? 'You won the last game!' : `${esc(w.name)} won the last game`}</b><small>${you ? 'The bar is yours.' : 'Rematch?'}</small></div><span class="lr-crown" aria-hidden="true">🏆</span></div>`);
    }
    if (inGame) {
      parts.push(`<p class="lobby-note">A game is on. ${me?.waiting ? 'You’re in for the next one — hang tight.' : 'Hang tight…'}</p>`);
    }

    // seats
    const seats = s.seated.map(m => {
      const isMe = !!me && !me.waiting && m.seat === me.seat;
      const host = m.seat === lobby.hostSeat;
      const tags = [
        host && '<span class="ls-tag host" title="Host">👑 host</span>',
        m.isBot && '<span class="ls-tag bot" title="Filler bot">🤖 bot</span>',
        !m.isBot && !m.connected && '<span class="ls-tag away">📡 reconnecting…</span>',
        isMe && '<span class="ls-tag you">you</span>',
      ].filter(Boolean).join('');
      let act = '';
      if (s.isHost && !inGame && !isMe) {
        act = m.isBot
          ? `<button type="button" class="ls-x" data-lobby="remove-bot" data-seat="${m.seat}" aria-label="Remove ${esc(m.name)}" title="Remove bot">✕</button>`
          : `<button type="button" class="ls-x" data-lobby="kick" data-seat="${m.seat}" aria-label="Kick ${esc(m.name)}" title="Kick">✕</button>`;
      }
      return `<li class="ls ${isMe ? 'me' : ''} ${m.isBot ? 'bot' : ''} ${!m.isBot && !m.connected ? 'away' : ''}">
        <span class="ls-av">${esc(m.avatar?.emoji || '💀')}</span>
        <span class="ls-name">${esc(m.name)}</span>
        <span class="ls-tags">${tags}</span>${act}</li>`;
    });
    if (!inGame) {
      for (let k = 0; k < s.empty; k++) {
        seats.push(s.isHost
          ? `<li class="ls empty"><span class="ls-av">·</span><span class="ls-name">Open seat</span><button type="button" class="btn ls-add" data-lobby="add-bot">+ 🤖 Bot</button></li>`
          : `<li class="ls empty"><span class="ls-av">·</span><span class="ls-name">Open seat</span></li>`);
      }
    }
    parts.push(`<ul class="lobby-seats">${seats.join('')}</ul>`);
    if (s.waiting.length) {
      parts.push(`<p class="lobby-waiting">Next game: ${s.waiting.map(m => `${esc(m.avatar?.emoji || '💀')} ${esc(m.name)}`).join(', ')}</p>`);
    }

    // options
    if (!inGame) {
      if (s.isHost) {
        const seg = (kind, items, cur) => `<div class="lseg" role="group">${items.map(([v, label]) =>
          `<button type="button" data-lobby="${kind}" data-value="${v}" class="${String(v) === String(cur) ? 'on' : ''}" aria-pressed="${String(v) === String(cur)}">${label}</button>`).join('')}</div>`;
        parts.push(`<div class="lobby-options">
          <div class="lopt"><span>Seats</span><div class="lstep">
            <button type="button" data-lobby="seats" data-value="${o.seats - 1}" ${o.seats <= Math.max(MIN_SEATS, s.seated.filter(m => !m.isBot).length) ? 'disabled' : ''} aria-label="Fewer seats">−</button>
            <b>${o.seats}</b>
            <button type="button" data-lobby="seats" data-value="${o.seats + 1}" ${o.seats >= MAX_SEATS ? 'disabled' : ''} aria-label="More seats">+</button></div></div>
          <div class="lopt"><span>Turn timer</span>${seg('timer', TIMERS.map(t => [t, timerLabel(t)]), o.timer)}</div>
          <div class="lopt"><span>Table</span>${seg('open', [[1, 'Open'], [0, 'Private']], o.open ? 1 : 0)}</div>
        </div>`);
      } else {
        parts.push(`<p class="lobby-ro">${o.seats} seats · ⏱ ${timerLabel(o.timer)} · ${o.open ? 'Open table' : 'Private table'}</p>`);
      }
    }

    // actions
    if (!inGame) {
      if (s.isHost) {
        const label = lobby.lastWinner ? 'Rematch' : 'Start game';
        parts.push(`<div class="lobby-go"><button type="button" class="btn primary big" data-lobby="start" ${s.canStart ? '' : 'disabled'}>${label}</button>
          ${s.canStart ? '' : `<small>Need ${MIN_SEATS} at the table — add a 🤖 bot or wait for friends.</small>`}</div>`);
      } else if (me) {
        parts.push(`<p class="lobby-note">Waiting for ${s.host ? esc(s.host.name) : 'the host'} to ${lobby.lastWinner ? 'call the rematch' : 'start'}…</p>`);
      }
    }
    el.body.innerHTML = parts.join('');
    if (offline) el.body.querySelectorAll('button').forEach(b => { b.disabled = true; });
  }

  return {
    render,
    rerender() { if (last) render(last); },
    setShareLabel(text) { el.share.textContent = text; },
    // A short note under the lobby (server errors, "link copied"…).
    flash(text, kind = '') {
      el.flash.textContent = text;
      el.flash.className = `lobby-flash ${kind} on`;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { el.flash.classList.remove('on'); }, 3200);
    },
  };
}
