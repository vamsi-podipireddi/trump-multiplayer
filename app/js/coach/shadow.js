/* A redacted view, rebuilt as a position the engine's search accepts.
   The other three hands are length-only placeholders: determinize() reads
   nothing but `.length` for them, and evaluateMoves overwrites them wholesale
   before any rollout runs. That is what makes a browser-side hint structurally
   incapable of cheating — the information required to cheat never arrives. */

function shadowFromView(v) {
  if (!v || !v.you || !Array.isArray(v.you.hand) || v.you.seat == null) return null;
  const seat = v.you.seat;
  const hands = [0, 1, 2, 3].map(s => s === seat
    ? v.you.hand.map(c => ({ suit: c.suit, rank: c.rank }))
    : new Array(v.handCounts[s]).fill(null));

  const playedCards = [];
  const voids = [{}, {}, {}, {}];
  /* Mirrors applyPlay's rule exactly: a seat is known void in the led suit when
     it followed with something else. Index 0 is the leader, which is why
     applyPlay guards on `G.trick.length > 0` and this guards on `i > 0`. */
  const note = (i, player, card, lead) => {
    playedCards.push({ suit: card.suit, rank: card.rank });
    if (i > 0 && lead && card.suit !== lead) voids[player][lead] = true;
  };
  for (const t of (v.tricks || [])) {
    const lead = t.cards[0] && t.cards[0].card.suit;
    t.cards.forEach((c, i) => note(i, c.player, c.card, lead));
  }
  (v.trick || []).forEach((t, i) => note(i, t.player, t.card, v.leadSuit));

  return {
    _silent: true,
    phase: v.phase, trump: v.trump, bonusSuit: v.bonusSuit,
    declarer: v.declarer, partner: v.partner, teamsRevealed: v.teamsRevealed,
    bid: v.bid, calledCard: v.calledCard,
    dealer: v.dealer, roundNumber: v.roundNumber,
    names: v.names.slice(), scores: v.scores.slice(),
    targetGames: v.consts ? v.consts.TARGET_GAMES : 5,
    hands,
    trick: (v.trick || []).map(t => ({ player: t.player, card: { suit: t.card.suit, rank: t.card.rank } })),
    leadSuit: v.leadSuit, turn: v.turn, leader: v.leader,
    // publicView has no trickNumber field, but completed-tricks count is the same
    // fact: applyPlay/advanceTrick keep G.trickNumber === G.tricks.length in sync
    // any time phase is "playing", so this is a derivation, not a guess.
    trickNumber: (v.tricks || []).length,
    tricksWon: v.tricksWon.slice(), capturedPoints: v.capturedPoints.slice(),
    lastWinner: v.lastWinner, lastWinnerSlot: v.lastWinnerSlot, lastResult: null,
    log: [], playedCards, voids,
  };
}

export { shadowFromView };
