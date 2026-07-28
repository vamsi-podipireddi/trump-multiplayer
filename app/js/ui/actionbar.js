import { S } from "../session.js";
import { $, esc } from "../util/dom.js";
import { SUITS, RED, SUIT_NAME, SUIT_KEY, cardName, suitSvg, suitSpan, cardSpan } from "../cards/labels.js";
import { cardFace } from "../cards/deck.js";
import { send } from "../net.js";

/* Private mirrors of index.html's activeSeat()/sideOf(seat) — both pure functions
   of S.view that index.html's renderGame()/renderScoreboard() also use. Duplicated
   rather than shared: index.html isn't an importable module, so there is no way to
   export these from here and have index.html reach back in. */
function activeSeat() {
  if (S.view.phase === "playing") return S.view.turn;
  if (S.view.phase === "bidding") return S.view.bidTurn;
  if (S.view.phase === "trumpSelect" || S.view.phase === "partnerSelect") return S.view.declarer;
  return -1;
}
function sideOf(seat) { return (seat === S.view.declarer || seat === S.view.partner) ? "D" : "O"; }

function renderActionBar() {
  const bar = $("action-bar"); bar.innerHTML = "";
  bar.dataset.turn = S.view.you.toAct ? "you" : "other";   // drives the cue rail
  const c = S.view.consts;
  const text = (cls, html) => { const d = document.createElement("div"); d.className = cls; d.innerHTML = html; bar.appendChild(d); };
  const button = (label, cls, fn) => { const b = document.createElement("button"); b.className = "act-btn " + (cls || ""); b.innerHTML = label; b.onclick = fn; bar.appendChild(b); return b; };

  if (S.view.you.spectator) {
    // seats are handed out at deal boundaries mid-match, so say when you're in
    const q = S.view.you.pendingSeat != null
      ? ` · you take ${S.view.seats[S.view.you.pendingSeat].label} on the next deal`
      : "";
    text("status", `Spectating ${esc(S.view.room.hostName || "")}'s table — ${phaseLabel()}${q}`);
    return;
  }

  if (S.view.you.toAct) {
    if (S.view.you.actKind === "bid") {
      const ctxKey = S.view.roundNumber + "|" + (S.view.highBid || 0);
      if (S.bidCtxKey !== ctxKey) { S.bidCtxKey = ctxKey; S.humanBidValue = null; } // fresh bid context → start at the minimum
      const lo = S.view.you.minBid;
      text("prompt", `Your bid — highest so far ${S.view.highBid ? "<b>" + S.view.highBid + "</b> from " + esc(S.view.names[S.view.highBidder]) : "<b>none</b>"} · bonus ${cardSpan({ suit: S.view.bonusSuit, rank: 3 })} is worth 30`);
      button("Pass", "pass", () => { S.humanBidValue = null; send({ type: "bid", value: null }); });
      if (lo > c.MAX_BID) { text("status", "Bidding is maxed out — you can only pass."); return; }
      let v = S.humanBidValue; if (v == null || v < lo || v > c.MAX_BID) { v = lo; S.humanBidValue = v; }
      const dn = button("−" + c.BID_STEP, "step", () => { S.humanBidValue = Math.max(lo, v - c.BID_STEP); renderActionBar(); });
      dn.setAttribute("aria-label", "Lower the bid by " + c.BID_STEP);
      dn.disabled = v <= lo;
      const val = document.createElement("span"); val.className = "bidval"; val.textContent = v; bar.appendChild(val);
      const up = button("+" + c.BID_STEP, "step", () => { S.humanBidValue = Math.min(c.MAX_BID, v + c.BID_STEP); renderActionBar(); });
      up.setAttribute("aria-label", "Raise the bid by " + c.BID_STEP);
      up.disabled = v >= c.MAX_BID;
      button("Bid " + v, "", () => { S.humanBidValue = null; send({ type: "bid", value: v }); });
      return;
    }
    if (S.view.you.actKind === "trump") {
      text("prompt", `You won the bid at <b>${S.view.bid}</b>. Choose the trump suit.`);
      SUITS.forEach(s => {
        const b = button(`${suitSvg(s)}<small>${SUIT_NAME[s]}</small>`, "suit s-" + SUIT_KEY[s] + (RED.has(s) ? " red" : ""), () => send({ type: "trump", suit: s }));
        b.setAttribute("aria-label", "Choose " + SUIT_NAME[s] + " as trump");
      });
      return;
    }
    if (S.view.you.actKind === "call") {
      text("prompt", `Trump is ${suitSpan(S.view.trump)}. Now name a card you <b>don't</b> hold — whoever has it is your partner.`);
      const grid = document.createElement("div"); grid.className = "call-grid";
      const byS = {}; SUITS.forEach(s => byS[s] = []);
      (S.view.you.callable || []).forEach(cd => byS[cd.suit].push(cd));
      SUITS.forEach(s => {
        if (!byS[s].length) return;
        const row = document.createElement("div"); row.className = "call-row";
        const lab = document.createElement("span");
        lab.className = "call-suit sc s-" + SUIT_KEY[s]; lab.innerHTML = suitSvg(s); lab.setAttribute("aria-hidden", "true");
        row.appendChild(lab);
        byS[s].sort((a, b) => b.rank - a.rank).forEach(cd => {
          const m = document.createElement("button");
          m.type = "button";
          m.className = "mini-card s-" + SUIT_KEY[cd.suit] + (RED.has(cd.suit) ? " red" : "") + (cd.rank === 14 ? " ace" : "") + (cd.suit === S.view.bonusSuit && cd.rank === 3 ? " bonus" : "");
          m.innerHTML = cardFace(cd, true);
          m.setAttribute("aria-label", "Call " + cardName(cd) + (cd.suit === S.view.bonusSuit && cd.rank === 3 ? " (bonus 30 points)" : ""));
          m.onclick = () => send({ type: "call", card: { suit: cd.suit, rank: cd.rank } });
          row.appendChild(m);
        });
        grid.appendChild(row);
      });
      bar.appendChild(grid);
      return;
    }
    if (S.view.you.actKind === "play") { bannerForPlay(true); return; }
  }
  // not my turn / transitions
  if (S.view.phase === "playing" || S.view.phase === "trickEnd") { bannerForPlay(false); return; }
  if (S.view.phase === "roundEnd") {
    if (S.view.lastResult) {
      const r = S.view.lastResult;
      text("banner", `${esc(S.view.names[r.declarer])} & ${esc(S.view.names[r.partner])} captured <b>${r.dPts}</b>/${r.bid} → <b>${r.made ? "MADE" : "SET"}</b>. ${r.winners.map(p => esc(S.view.names[p])).join(" & ")} win the deal.`);
    }
    const live = S.view.seats.filter(s => s.isHuman && s.connected && !s.away);
    const ready = live.filter(s => s.ready).length;
    if (!S.view.you.spectator) {
      const b = button(S.view.you.ready ? `Ready ✓ — waiting ${ready}/${live.length}` : `Next deal — I'm ready (${ready}/${live.length})`,
        "ready", () => send({ type: "ready" }));
      b.disabled = !!S.view.you.ready;
    }
    text("status", `Next deal starts when everyone is ready — auto in <span id="ready-count">…</span>`);
    return;
  }
  text("status", `${phaseLabel()} — waiting for <b>${esc(S.view.names[activeSeat()] || "")}</b>`);
}
function bannerForPlay(myTurn) {
  if (S.mySeat == null) { return $("action-bar").appendChild(divStatus(`${phaseLabel()} — ${esc(S.view.names[S.view.turn])} to play`)); }
  const c = S.view.consts;
  const dPts = S.view.capturedPoints[S.view.declarer] + S.view.capturedPoints[S.view.partner];
  const mySide = sideOf(S.mySeat);
  const mate = mySide === "D" ? (S.mySeat === S.view.declarer ? S.view.partner : S.view.declarer) : [0,1,2,3].filter(p => p !== S.view.declarer && p !== S.view.partner && p !== S.mySeat)[0];
  const turnTxt = myTurn ? " <b>Your turn.</b>" : ` — ${esc(S.view.names[S.view.turn])} to play`;
  if (mySide === "D")
    addBanner(`<span class="d">You + ${esc(S.view.names[mate])}</span> are the bidding side — need <b>${S.view.bid}</b> pts, captured <b>${dPts}</b>.${turnTxt}`);
  else
    addBanner(`<span class="o">You + ${esc(S.view.names[mate])}</span> defend — keep them under <b>${S.view.bid}</b> pts (they have <b>${dPts}</b>).${turnTxt}`);
}
function addBanner(html) { const d = document.createElement("div"); d.className = "banner"; d.innerHTML = html; $("action-bar").appendChild(d); }
function divStatus(html) { const d = document.createElement("div"); d.className = "status"; d.innerHTML = html; return d; }
function phaseLabel() { return ({ bidding:"Bidding", trumpSelect:"Choosing trump", partnerSelect:"Calling partner", playing:"Playing", trickEnd:"Trick won", roundEnd:"Deal over", matchOver:"Match over" })[S.view.phase] || ""; }

export { renderActionBar, bannerForPlay, addBanner, divStatus, phaseLabel };
