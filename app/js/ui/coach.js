/* The hint affordance: "what would the hard AI play here." One button, wired
   once at boot (initCoach) and painted every frame (renderCoach) — the same
   init/render split as ui/sound.js's initSound()/paintSoundBtn(), because the
   click handler is wired long before the view it will act on exists, and the
   view arrives fresh on every state message while the button itself never
   moves in the DOM.

   The room's `coach` setting (read through coachOn, never re-tested here) is a
   table agreement, not an enforcement boundary — this file runs in every
   browser, so a devtools console can call requestHint() regardless of what the
   button says. hintEnabled() only ever governs the button's own affordance. */
import { $ } from "../util/dom.js";
import { coachOn } from "../coach/read.js";
import { requestHint } from "../coach/client.js";
import { cardName, SUIT_NAME } from "../cards/labels.js";
import { sideOf } from "../core/engine/index.js";

/* actKind is not tested here: every decision kind handleRequest's hint branch
   answers (play, bid, trump, call) is a case worth a button, so "your turn,
   and the table agreed to hints" is the whole predicate. Composes coachOn
   rather than re-testing settings.coach itself — one place decides what "off"
   means, so the lobby, the table and this button can never disagree. */
function hintEnabled(v) {
  return !!(v && v.you && v.you.toAct && coachOn(v.settings));
}

let pending = false;       // a request is already in flight — the click is a button, not a queue
let latestView = null;     // stashed every render so the click handler (wired once) can act on "now"
let lastKey = null;        // the decision `answer` was computed for
let answer = null;         // { key, cardKey, text } | null
let doRender = () => {};   // the repaint callback handed to initCoach

/* Every seat that has passed gets dealt fresh cards and starts bidding over —
   same roundNumber, same empty highBid, same minBid — and redealCount is not
   on the wire for this to key on instead (publicView never sends it). The hand
   itself is: a redeal is a fresh deal(G) underneath, so folding it into the key
   is what tells "the opening bid, again" apart from "the opening bid, after a
   redeal" without needing a field the view doesn't carry. */
const handKey = hand => Array.isArray(hand) ? hand.map(c => c.suit + c.rank).sort().join(",") : "";

/* One key per decision on offer: seat, deal, phase, kind and the asker's own
   hand, plus enough of the phase's own progress (trick count for a play, the
   live high bid for a bid) to change the instant the SAME decision context
   could no longer mean the same thing. A new key is a new decision — see
   renderCoach below, which clears `answer` the moment this stops matching what
   it was computed for, per the design note "a stale mark pointing at a card
   from two tricks ago is worse than no mark at all." */
function positionKey(v) {
  const you = v && v.you;
  if (!you || you.seat == null) return "";
  const k = [you.seat, v.roundNumber, v.phase, you.actKind, handKey(you.hand)];
  if (you.actKind === "play") k.push((v.tricks || []).length, (v.trick || []).length);
  if (you.actKind === "bid") k.push(v.highBid || 0, you.minBid || 0);
  return k.join("|");
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/* Turns a worker response into what the tray prints and which card (if any)
   gets marked. winProb is already stated from the asking seat's own side (see
   ai/pimc.js) — declaring and defending read the identical number as opposite
   events, so the verb has to flip with it or a defender's hint would call its
   own success rate "holds the contract", which is backwards. Bid/trump/call
   have no card to mark: cardKey stays null and renderCoach clears any mark
   already on the hand. */
function describeHint(v, result) {
  if (result.kind === "play") {
    const card = result.best.card;
    const declaring = sideOf(v, v.you.seat) === "D";
    const pct = Math.round(result.best.winProb * 100);
    return { cardKey: card.suit + card.rank,
             text: cap(`${cardName(card)} — ${declaring ? "holds" : "sets"} the contract in ${pct}% of sampled deals`) };
  }
  if (result.kind === "bid") {
    const pct = Math.round(result.makeProb * 100);
    return { cardKey: null, text: cap(`worth about ${Math.round(result.median)} · you make ${result.target} in ${pct}%`) };
  }
  if (result.kind === "trump")
    return { cardKey: null, text: cap(`${SUIT_NAME[result.suit]} — the search's pick for trump`) };
  // "call"
  return { cardKey: null, text: cap(`${cardName(result.card)} — the search's pick to call`) };
}

/* Wires the click once. `render` is a no-arg repaint — screens/game.js's own
   `render()` (reads S.view) or solo.js's `paint()` (rebuilds v from G) — called
   after the async round trip settles, since nothing else will re-enter the
   render chain on the coach's own schedule. */
function initCoach(render) {
  doRender = render || (() => {});
  const btn = $("btn-hint");
  if (!btn) return;
  btn.onclick = () => {
    const v = latestView;
    if (pending || !v || !hintEnabled(v)) return;
    const key = positionKey(v);
    pending = true;
    doRender();   // reflect the in-flight request immediately, not just on the round trip
    requestHint(v).then(res => {
      pending = false;
      // positionKey(latestView), not `key`: only commit an answer the position
      // now current still asked for — a slow response to a decision that has
      // since moved on must not resurrect it.
      if (res && res.ok) { if (positionKey(latestView) === key) answer = { key, ...describeHint(v, res.result) }; }
      else if (res && res.error) answer = { key, cardKey: null, text: cap(res.error) };
      doRender();
    }, () => { pending = false; doRender(); });
  };
}

/* o (table ctx) and h (action handlers) are accepted, not read: D25's contract
   is "view first, handlers second" for every renderer under ui/, and matching
   it here costs nothing — a future hint (e.g. "play it for me") would need h
   without changing every call site again. */
function renderCoach(v, o, h) {
  latestView = v;
  const key = positionKey(v);
  if (key !== lastKey) { lastKey = key; answer = null; }   // the position moved on — see positionKey's own comment

  const btn = $("btn-hint");
  if (btn) {
    btn.disabled = pending || !hintEnabled(v);
    btn.setAttribute("aria-busy", String(pending));
  }

  const shown = answer && answer.key === key ? answer : null;
  paintHandMark(shown && shown.cardKey);
  paintTrayLine(shown && shown.text);
}

function paintHandMark(cardKey) {
  const wrap = $("my-hand");
  if (!wrap) return;
  for (const el of wrap.children) el.classList.toggle("hint", !!cardKey && el.dataset.k === cardKey);
}

/* #hand-hint already belongs to renderActionBar's own contextual tip (ui/actionbar.js),
   repainted on every render before this runs — so a real answer overrides it and a
   cleared one leaves that tip standing rather than blanking the tray. */
function paintTrayLine(text) {
  const el = $("hand-hint");
  if (!el || !text) return;
  el.textContent = text;
  el.classList.add("show");
}

/* Match-scoped, like hand.js's resetHandFor() and actionbar.js's resetActionBar():
   positionKey is round+phase+seat+actKind-shaped, and a new match restarts at
   round 1 — the exact key an old match's opening bid decision once had — so a
   stale answer could otherwise resurface at the first decision of a new one.
   Solo is the only caller: leaving a multiplayer room reloads the page, which
   clears every module's state for free. */
function resetCoach() { pending = false; lastKey = null; answer = null; }

export { hintEnabled, initCoach, renderCoach, resetCoach };
