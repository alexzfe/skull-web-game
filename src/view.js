// Skull & Roses — per-player views (MULTIPLAYER_SPEC §3). Pure, no DOM, no
// Node APIs: runs in the browser (solo/tutorial) and in the Worker.
//
// A view has the same shape as the engine state, minus what `playerId` must
// not know: other players' hand faces, their unrevealed mat cards, and the
// discarded card of a lost bet (challenger only).

export function viewFor(state, playerId) {
  const view = structuredClone(state);
  for (const p of view.players) {
    if (p.id === playerId) continue;
    p.hand = Array(p.hand.length).fill(null);
    // Revealed cards are the top `revealed` ones (mat index 0 = bottom).
    const hidden = p.mat.length - p.revealed;
    p.mat = p.mat.map((card, i) => (i < hidden ? null : card));
  }
  if (view.lastResult && 'discarded' in view.lastResult && view.lastResult.challenger !== playerId) {
    delete view.lastResult.discarded;
  }
  view.me = playerId;
  return view;
}

// The last applied action as everyone may see it: no card face for
// place/placeInitial, no hand position for discard. `auto` marks a ⏱ move.
export function redactAction(action, { auto = false } = {}) {
  if (!action) return null;
  const out = { ...action };
  if (out.type === 'place' || out.type === 'placeInitial') delete out.card;
  if (out.type === 'discard') delete out.cardIndex;
  if (auto) out.auto = true;
  return out;
}
