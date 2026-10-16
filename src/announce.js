// Banners and toasts for one applied action, derived from two consecutive views
// (MULTIPLAYER_SPEC §3). Works the same for solo (views of the local state) and
// multiplayer (server views + `view.lastAction`). `action.auto` marks a ⏱ move.
import { ROSE, SKULL, possessive } from './engine.js';

export function announce(ui, prev, next, action) {
  const me = next.me ?? 0;
  const who = id => (id === me ? 'You' : prev.players[id].name);
  const verb = (id, s, p) => (id === me ? p : s);
  const pl = action.player;
  const tag = action.auto ? '⏱ ' : '';

  switch (action.type) {
    case 'placeInitial':
      if (action.auto) ui.toast(`${tag}${who(pl)} ${verb(pl, 'lays', 'lay')} down a card`);
      break;
    case 'place':
      if (pl !== me || action.auto) ui.toast(`${tag}${who(pl)} ${verb(pl, 'stacks', 'stack')} another card`);
      break;
    case 'bid':
      if (prev.phase === 'placement') ui.banner(`${tag}${who(pl)} ${verb(pl, 'opens', 'open')} at ${action.amount}`, { kind: 'bid', sub: 'The challenge is on' });
      else ui.banner(`${tag}${who(pl)} ${verb(pl, 'raises', 'raise')} to ${action.amount}`, { kind: 'bid', ms: 1100 });
      break;
    case 'pass':
      ui.toast(`${tag}${who(pl)} ${verb(pl, 'passes', 'pass')}`);
      break;
    case 'reveal': {
      const t = prev.players[action.target];
      const count = prev.revealedCount + 1;
      // Mid-reveal flips are roses (a skull ends the reveal); the face may be hidden in `prev`.
      const ended = next.phase !== 'reveal';
      if (ended && next.lastResult?.type === 'lost') {
        const owner = action.target === pl ? (pl === me ? 'your own' : 'their own') : action.target === me ? 'your' : possessive(t.name);
        ui.banner(`${tag}SKULL!`, { kind: 'skull', art: SKULL, sub: `${who(pl)} hit ${owner} skull — challenge lost`, ms: 2000 });
      } else if (ended && next.lastResult?.type === 'won') {
        ui.banner(`${tag}${who(pl)} ${verb(pl, 'wins', 'win')} the challenge!`, { kind: 'rose', art: ROSE, sub: `${count} roses flipped`, ms: 2000 });
      } else {
        ui.toast(`${tag}Rose ${count}/${prev.bid.amount}`, 'good');
      }
      break;
    }
    case 'discard':
      if (pl !== me || action.auto) ui.toast(`${tag}${who(pl)} ${verb(pl, 'throws', 'throw')} away a card`);
      break;
    case 'chooseFirst':
      ui.toast(`${tag}${who(pl)} ${verb(pl, 'picks', 'pick')} ${action.target === me ? 'you' : prev.players[action.target].name} to start`);
      break;
    case 'nextRound': {
      const f = next.players[next.firstPlayer];
      ui.banner(`Round ${next.round}`, { sub: `${f.id === me ? 'You start' : f.name + ' starts'} · lay down a card` });
      break;
    }
    case 'forfeit':
      ui.banner(`${who(pl)} left the game`, { kind: 'skull', sub: 'Out for good', ms: 1700 });
      break;
  }

  if (prev.phase !== 'reveal' && next.phase === 'reveal') {
    const c = next.challenger;
    ui.banner(`${who(c)} must flip ${next.bid.amount}`, { kind: 'bid', sub: c === me ? 'Your own stack first' : 'Own stack first', ms: 1600 });
  }

  // Lost card: only the challenger learns which card it was.
  const r = next.lastResult;
  if (r && r.type === 'lost' && JSON.stringify(r) !== JSON.stringify(prev.lastResult)) {
    if (r.challenger === me && r.discarded) ui.toast(`You lost a ${r.discarded}`, r.discarded === SKULL ? 'bad' : '');
    else if (r.challenger !== me && r.skullOwner !== r.challenger) ui.toast(`${who(r.challenger)} loses a card at random`);
  }

  next.players.forEach(p => {
    if (p.eliminated && !prev.players[p.id].eliminated && action.type !== 'forfeit') {
      ui.banner(p.id === me ? 'You’re out!' : `${p.name} is out!`, { kind: 'skull', sub: 'No cards left', ms: 1700 });
    }
  });

  if (next.phase === 'game-over' && prev.phase !== 'game-over') {
    ui.banner(next.winner === me ? 'You win the game!' : `${next.players[next.winner].name} wins the game!`, { kind: 'win', ms: 2200 });
  }
}
