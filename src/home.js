// Home-screen multiplayer bits (MULTIPLAYER_SPEC §7): avatar picker + name, HOST A
// GAME, the JOIN A GAME bubble (code box + live open-lobbies list), and the
// share-link prompt (`/#/r/CODE` → name/avatar → lobby). Solo "Play vs bots", the
// table settings and "Learn to play" stay in ui.js.
//
//   const home = createHome({ getSettings, saveSettings, onHost, onJoin(code, from), onHome, listLobbies });
//   home.message(text)          — show a note in the join bubble (not found, full…)
//   home.notice(text)           — a note under HOST/JOIN (e.g. the server is unreachable)
//   home.showLinkPrompt(code)   home.linkMessage(text)   home.busy(on)
import { AVATARS, stepAvatar, cleanName, lobbyRow } from './shell-core.js';
import { cleanCode, normalizeCode } from './net.js';

const POLL_MS = 3000;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createHome({ getSettings, saveSettings, onHost, onJoin, onHome, listLobbies }) {
  const $ = sel => document.querySelector(sel);
  const el = {
    setup: $('#setup'), bubble: $('#join-bubble'), toggle: $('#join-game'), code: $('#join-code'),
    msg: $('#join-msg'), notice: $('#home-msg'), list: $('#lobby-list'), host: $('#host-game'),
    link: $('#joinlink'), linkCode: $('#jl-code'), linkMsg: $('#jl-msg'), linkName: $('#jl-name'), linkGo: $('#jl-go'),
  };
  let pollTimer = null;
  let polling = false;
  let busy = false;
  let linkCode = null;

  // ---------- identity (avatar + name), on home and on the link prompt ----------

  function paintIdentity() {
    const s = getSettings();
    document.querySelectorAll('[data-identity]').forEach(box => {
      box.querySelector('.av-face').textContent = s.avatar.emoji;
      const grid = box.querySelector('.avatar-grid');
      if (!grid.hidden) paintGrid(grid, s.avatar.emoji);
    });
  }

  function paintGrid(grid, current) {
    grid.innerHTML = AVATARS.map(a => `<button type="button" class="av-opt ${a === current ? 'on' : ''}" data-home="avatar" data-avatar="${a}" aria-label="Avatar ${a}">${a}</button>`).join('');
  }

  function setAvatar(emoji) {
    saveSettings({ avatar: { emoji } });
    paintIdentity();
  }

  // ---------- join bubble ----------

  function openBubble(open) {
    el.bubble.hidden = !open;
    el.toggle.setAttribute('aria-expanded', String(open));
    el.toggle.classList.toggle('on', open);
    if (open) {
      message('');
      el.code.value = '';
      el.code.focus({ preventScroll: true });
      startPolling();
    } else {
      stopPolling();
    }
  }

  function startPolling() {
    stopPolling();
    polling = true;
    el.list.innerHTML = `<li class="lobby-empty">Looking for open tables…</li>`;
    const poll = async () => {
      let rows = null;
      try { rows = await listLobbies(); } catch { rows = null; }
      if (!polling) return;
      paintList(rows);
      pollTimer = setTimeout(poll, POLL_MS);
    };
    poll();
  }

  function stopPolling() {
    polling = false;
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function paintList(rows) {
    if (!rows) { el.list.innerHTML = `<li class="lobby-empty">Can’t reach the bar right now.</li>`; return; }
    if (!rows.length) { el.list.innerHTML = `<li class="lobby-empty">No open tables right now — host one!</li>`; return; }
    el.list.innerHTML = rows.map(lobbyRow).map(r => `<li><button type="button" class="lobby-row" data-home="pick" data-code="${esc(r.code)}" ${r.full ? 'disabled' : ''}>
        <span class="lr-host">${esc(r.host)}’s table</span>
        <span class="lr-meta"><b>${esc(r.fill)}</b>${r.bots ? ` · ${r.bots}🤖` : ''} · ⏱ ${esc(r.timer)}</span>
        <span class="lr-code">${esc(r.code)}</span>
      </button></li>`).join('');
  }

  function message(text, kind = 'bad') {
    el.msg.textContent = text || '';
    el.msg.className = `join-msg ${text ? kind : ''}`;
  }

  function notice(text, kind = 'bad') {
    el.notice.textContent = text || '';
    el.notice.className = `join-msg ${text ? kind : ''}`;
  }

  function tryJoin(raw) {
    if (busy) return;
    const code = normalizeCode(raw);
    if (!code) { message('Codes are 4 letters, like KXQP.'); return; }
    message(`Joining ${code}…`, 'info');
    onJoin(code, 'home');
  }

  el.code.addEventListener('input', () => {
    const v = cleanCode(el.code.value);
    if (el.code.value !== v) el.code.value = v;
    if (v.length === 4) tryJoin(v);
    else message('');
  });
  el.code.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); tryJoin(el.code.value); }   // not the solo form's submit
    if (e.key === 'Escape') openBubble(false);
  });

  // ---------- link prompt ----------

  function showLinkPrompt(code) {
    linkCode = code;
    stopPolling();
    el.linkCode.textContent = code;
    el.linkName.value = getSettings().name === 'Rider' ? '' : getSettings().name;
    linkMessage('');
    busyLink(false);
    document.querySelectorAll('body > .screen').forEach(n => { n.hidden = n !== el.link; });
    paintIdentity();
  }

  function linkMessage(text, kind = 'bad') {
    el.linkMsg.textContent = text || '';
    el.linkMsg.className = `join-msg ${text ? kind : ''}`;
  }

  function busyLink(on) { el.linkGo.disabled = !!on; }

  el.linkName.addEventListener('input', () => saveSettings({ name: cleanName(el.linkName.value) }));
  el.link.querySelector('form').addEventListener('submit', e => {
    e.preventDefault();
    if (!linkCode || el.linkGo.disabled) return;
    saveSettings({ name: cleanName(el.linkName.value) });
    linkMessage(`Joining ${linkCode}…`, 'info');
    busyLink(true);
    onJoin(linkCode, 'link');
  });

  // ---------- clicks ----------

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-home]');
    if (!b || b.disabled) return;
    const box = b.closest('[data-identity]');
    switch (b.dataset.home) {
      case 'av-prev': setAvatar(stepAvatar(getSettings().avatar.emoji, -1)); break;
      case 'av-next': setAvatar(stepAvatar(getSettings().avatar.emoji, 1)); break;
      case 'av-grid': {
        const grid = box.querySelector('.avatar-grid');
        grid.hidden = !grid.hidden;
        if (!grid.hidden) paintGrid(grid, getSettings().avatar.emoji);
        break;
      }
      case 'avatar':
        setAvatar(b.dataset.avatar);
        box.querySelector('.avatar-grid').hidden = true;
        break;
      case 'host':
        if (busy) return;
        openBubble(false);
        notice('');
        onHost();
        break;
      case 'join': openBubble(el.bubble.hidden); break;
      case 'go': tryJoin(el.code.value); break;
      case 'pick': el.code.value = b.dataset.code; tryJoin(b.dataset.code); break;
      case 'home': onHome(); break;
    }
  });

  paintIdentity();

  return {
    paintIdentity,
    message,
    notice,
    showLinkPrompt,
    linkMessage(text, kind) { linkMessage(text, kind); busyLink(false); },
    // While a host/join is in flight the buttons ignore taps.
    busy(on) {
      busy = !!on;
      el.host.disabled = busy;
      el.host.classList.toggle('loading', busy);
    },
    // Leaving the home screen (into a lobby or a solo game) stops the lobby poll.
    hidden() { openBubble(false); },
    resetBubble() { if (!el.bubble.hidden) { el.code.value = ''; el.code.focus({ preventScroll: true }); } },
  };
}
