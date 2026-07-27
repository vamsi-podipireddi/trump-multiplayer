function cardPoints(G, c) { if (c.rank === 3 && c.suit === G.bonusSuit) return 30; if (c.rank >= 10) return 10; if (c.rank === 5) return 5; return 0; }
function trickPoints(G, trick) { return trick.reduce((s, t) => s + cardPoints(G, t.card), 0); }
function sideOf(G, p) { return (p === G.declarer || p === G.partner) ? "D" : "O"; }
function defenders(G) { return [0,1,2,3].filter(p => p !== G.declarer && p !== G.partner); }

export { cardPoints, trickPoints, sideOf, defenders };
