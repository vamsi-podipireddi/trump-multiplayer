/* The hint affordance: the search's own pick, not "what the hard bots would
   do" — true for the bid and the card, which hard bots search too, but not
   for trump and the call: bots always take those from the hand-count
   (ai/index.js), while the hint searches them anyway (ai/bid-search.js, via
   coach/worker.js). One button, wired once at boot (initCoach) and painted
   every frame (renderCoach) — the same init/render split as ui/sound.js's
   initSound()/paintSoundBtn(), because the click handler is wired long
   before the view it will act on exists, and the view arrives fresh on
   every state message while the button itself never moves in the DOM.

   The room's `coach` setting (read through coachOn, never re-tested here) is a
   table agreement, not an enforcement boundary — this file runs in every
   browser, so a devtools console can call requestHint() regardless of what the
   button says. hintEnabled() only ever governs the button's own affordance. */
import { $, esc } from "../util/dom.js";
import { coachOn, tableRead } from "../coach/read.js";
import { requestHint } from "../coach/client.js";
import { cardName, SUIT_NAME, SUITS, rankLabel, suitSpan } from "../cards/labels.js";
import { sideOf } from "../core/engine/index.js";
import { getPref, setPref } from "../util/prefs.js";

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
    // "of sampled deals" hedge, same as the play branch above: makeProb is a
    // model estimate over sampled deals, not a calibrated frequency — stated
    // unhedged it reads as a promise the search cannot actually make.
    return { cardKey: null, text: cap(`worth about ${Math.round(result.median)} · you make ${result.target} in ${pct}% of sampled deals`) };
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
    }, () => {
      // A rejection is a real path, not a hypothetical one: client.js rejects
      // every pending request when the worker dies (onerror) and again after
      // its own 10s timeout. Without this the button just silently re-enables
      // and the tray stays blank — the player pressed a button and deserves
      // evidence it did something, not a wonder-if-I-mis-clicked silence.
      // Same shape as the res.error branch above; no worker-reported reason
      // to surface here, since a rejection's Error#message is runtime/browser
      // text, not a string this file controls.
      pending = false;
      answer = { key, cardKey: null, text: cap("the hint search failed — try again") };
      doRender();
    });
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

// ---------- table read ----------
/* Public information (see coach/read.js's own file comment), so unlike
   everything above this line it is never gated behind coachOn() — it gets a
   local show/hide preference instead, the same shape as the 4-colour deck's
   own persisted toggle (util/prefs.js). Called from rails.js, which owns the
   left rail this block lives in — not from screens/game.js/solo.js's render
   chain the way renderCoach above is, because renderCoach paints two regions
   (the hand, the action tray) neither rails.js nor any other ui/*.js module
   already owns, while every byte of this block is rails.js's own DOM. */

/* Mirrors modals.js's own seatName(): both take (v, o, seat) and prefer the
   table ctx's own name over the wire's, but neither file exports its copy for
   the other to share — same minor, accepted duplication rails.js's nameOf()
   and modals.js's seatName() already have between themselves. */
function seatName(v, o, seat) {
  const info = o && typeof o.seatInfo === "function" ? o.seatInfo(seat) : null;
  return (info && info.name) || (v.names && v.names[seat]) || "";
}

/* Every seat on one side, named — the declaring pair (1 seat if playing alone,
   otherwise 2) or its complement (usually 2 defenders, 3 against a lone
   declarer). Mirrors modals.js's showReveal(): `defenders.join(" & ")` is the
   exact 3-way-join precedent for the alone case. mySeat is replaced with
   "You" wherever it falls, which is always in exactly one of the two calls
   this feeds (a seat cannot be on both sides at once). */
function sideLabel(v, o, seats, mySeat) {
  return seats.map(s => s === mySeat ? "You" : seatName(v, o, s)).join(" & ");
}

/* Pure: turns tableRead(v)'s numbers into what the panel prints, plus every
   "should this even show" decision on top of them — hiding the side split
   before the reveal (tableRead itself already nulls `needed` then; this also
   requires a real seat, so a spectator never borrows the defending side's
   total under the label "you"), wording the bonus three's three real states
   (bonusTakenBy's own comment: fallen-but-unclaimed is an honest state, not a
   bug to paper over), and dropping any seat tableRead reports with zero known
   voids, since an empty list is not information worth a row. No DOM — this is
   one of the parts of the panel worth unit-testing without one
   (test/client.test.js), the same split renderCoach/describeHint use above. */
function describeTableRead(v, o) {
  const r = tableRead(v);
  const mySeat = v.you ? v.you.seat : null;
  let side = null;
  if (v.teamsRevealed && mySeat != null && r.needed != null) {
    // a Set, not a 2-element array: playing alone means declarer === partner,
    // one seat, not two — read.js's own tableRead() guards the same identity
    const declSeats = [...new Set([v.declarer, v.partner])];
    const defSeats = [0, 1, 2, 3].filter(s => !declSeats.includes(s));
    const onDeclaringSide = declSeats.includes(mySeat);
    const mySeats = onDeclaringSide ? declSeats : defSeats;
    const theirSeats = onDeclaringSide ? defSeats : declSeats;
    /* side.mine/theirs are partnership totals, not personal ones — a called
       partner reading a bare "you 60" could take it as their own personal
       capture. Naming every seat on each side (renderContract's pairNames()
       and renderScoreboard's per-seat rows both name real seats, never a
       pronoun) removes the ambiguity; the numbers were always correct. */
    side = { mine: r.captured.mine, theirs: r.captured.theirs, needed: r.needed,
             mineLabel: sideLabel(v, o, mySeats, mySeat), theirsLabel: sideLabel(v, o, theirSeats, mySeat) };
  }
  const bonusStatus = !r.bonus.fallen ? "still to fall"
    : r.bonus.takenBy == null ? "fallen — trick in progress"
    : "taken by " + seatName(v, o, r.bonus.takenBy);
  const voids = r.voids.filter(e => e.suits.length)
    .map(e => ({ seat: e.seat, name: seatName(v, o, e.seat), suits: e.suits }));
  return { pointsLive: r.pointsLive, side, bonusSuit: v.bonusSuit || null, bonusStatus,
           voids, outstanding: r.outstanding, trump: v.trump || null };
}

/* Pure: which rows the panel shows and how each is worded — whether the side
   rows and the bonus row appear at all, and "made it" vs a plain count once
   the contract's already there. Split out of renderTableRead for the same
   reason voidsHtml/suitsHtml below are their own functions: none of this
   touches DOM, so none of it needs one to be checked (test/client.test.js).
   Rows are plain data (kind/label/value/mine/suit), not HTML — renderTableRead
   is the only place that escapes and wraps them, same division of labour as
   describeTableRead vs. renderTableRead itself. */
function tableReadRows(s) {
  const rows = [{ kind: "num", label: "Points live", value: s.pointsLive, mine: false }];
  if (s.side) {
    rows.push({ kind: "num", label: s.side.mineLabel, value: s.side.mine, mine: true });
    rows.push({ kind: "num", label: s.side.theirsLabel, value: s.side.theirs, mine: false });
    rows.push(s.side.needed === 0
      ? { kind: "text", label: "Still needed", value: "made it", mine: false }
      : { kind: "num", label: "Still needed", value: s.side.needed, mine: false });
  }
  if (s.bonusSuit) rows.push({ kind: "text", label: "Bonus", suit: s.bonusSuit, value: s.bonusStatus, mine: false });
  return rows;
}

const READ_PREF = "trump_read";
const readShown = () => getPref(READ_PREF, "1") !== "0";

/* Applies the persisted preference to the DOM. Called both from the toggle's
   own click (instant feedback) and from every renderTableRead (so a render
   landing between two clicks — or the very first one, before any click has
   happened — still agrees with localStorage rather than whatever class was
   last left on the element). #tr-body's content is painted regardless of
   this state (see renderTableRead): collapsing only hides it, so expanding
   again never shows anything stale. */
function paintReadVisibility() {
  const sec = $("tableread"), btn = $("btn-read-toggle");
  const shown = readShown();
  if (sec) sec.classList.toggle("collapsed", !shown);
  if (btn) {
    btn.setAttribute("aria-expanded", String(shown));
    btn.textContent = shown ? "Hide" : "Show";
    // the visible label is terse like every other header control (#btn-colors:
    // "4-Colour" / aria-label "Four-colour deck"); tabbed to directly, out of
    // the <h2>'s own text, a lone "Hide, button" names an action but not a target
    btn.setAttribute("aria-label", (shown ? "Hide" : "Show") + " the table read");
  }
}
function toggleRead() { setPref(READ_PREF, readShown() ? "0" : "1"); paintReadVisibility(); }

const trRow = (label, value, mine) => `<div class="tr-row${mine ? " mine" : ""}"><span>${label}</span><span>${value}</span></div>`;

function voidsHtml(voids) {
  if (!voids.length) return `<div class="note">No voids spotted yet.</div>`;
  return `<div class="tr-voids">` + voids.map(e =>
    `<div class="tr-void-row"><b>${esc(e.name)}</b>${e.suits.map(suitSpan).join("")}</div>`).join("") + `</div>`;
}
// SUITS' own fixed order, not Object.keys(outstanding) — plain objects don't
// promise key order the way this suit sequence is guaranteed to read the same
// every render. Trump is marked by the tile itself (a border/background pair
// in panels.css), not a "· trump" suffix on the top-card text: "top 10" is
// already close to what a ~60px rail-width column affords, and a trump tile
// sits right beside the contract card's own trump icon, so the highlight
// alone reads as "this one" without a second, wrap-prone text cue.
function suitsHtml(outstanding, trump) {
  return `<div class="tr-suits">` + SUITS.map(s => {
    const info = outstanding[s];
    const top = info.count ? "top " + rankLabel(info.top) : "gone";
    return `<div class="tr-suit${s === trump ? " trump" : ""}">${suitSpan(s)}` +
           `<span class="cnt">${info.count}</span><span class="top">${top}</span></div>`;
  }).join("") + `</div>`;
}

function renderTableRead(v, o) {
  const sec = $("tableread");
  if (!sec) return;   // both shells always carry it; guards a stray call before boot anyway
  const btn = $("btn-read-toggle");
  if (btn) btn.onclick = toggleRead;
  paintReadVisibility();

  const s = describeTableRead(v, o);
  // tableReadRows decides *what*; only the escaping/suit-icon/<b> markup is
  // built here — labels are player names in two of these rows (mineLabel/
  // theirsLabel), the one untrusted value this function ever prints outside
  // voidsHtml, so esc() runs on every label, not just the ones expected to need it.
  const rowsHtml = tableReadRows(s).map(r => {
    const label = esc(r.label) + (r.suit ? " " + suitSpan(r.suit) : "");
    const value = r.kind === "num" ? `<b>${r.value}</b>` : esc(String(r.value));
    return trRow(label, value, r.mine);
  }).join("");

  $("tr-body").innerHTML = rowsHtml +
    `<div class="tr-block"><div class="lbl">Known voids</div>${voidsHtml(s.voids)}</div>` +
    `<div class="tr-block"><div class="lbl">Outstanding</div>${suitsHtml(s.outstanding, s.trump)}</div>`;
}

// ---------- deal review ----------
/* coach/review.js's reviewDeal() re-searches every decision from a finished
   deal's own record and grades each play against what the search would have
   picked; this section is only the wording — what a review's own findings
   say once painted into the round-result modal's review view (ui/modals.js),
   opened there on click, never automatically (nobody gets analysis thrown at
   them while the table waits on the ready gate — see modals.js's own
   comment). Same split as describeHint/describeTableRead above:
   describeReview is pure and carries every wording branch; renderReview is
   the thin painter over it. "Thin painter" here means DOM-free rather than
   DOM-light — it returns a string for modals.js to drop into #round-body,
   the same contract renderTableRead's own caller (rails.js) does not share,
   since #round-body is swapped wholesale rather than patched in place. */

/* evaluateMoves' own affordable/maxDet formula (ai/pimc.js) ceilings every
   review decision at 24 determinizations — review.js never overrides
   opts.determinizations, so that default stands — half of what a live hint
   affords itself (48, worker.js's HINT_BUDGET). A wide-open early lead (13
   legal cards, ~39 unseen at trick 1) taxes the same formula down toward
   ~15. 20 sits between the deal's ordinary case (most decisions land at or
   near the 24 cap) and that worst-case floor, so a samples count under it
   means this particular read really did run thinner than most of the deal's
   own decisions — worth saying, not just a number to print next to. */
const THIN_SAMPLES = 20;

/* Pure: result is reviewDeal's own {decisions, worst, samples}; v/seat pick
   the declaring/defending frame (below) the same way describeHint's play
   branch does. Returns plain data, not markup — renderReview is the only
   thing that turns this into HTML, same division as describeTableRead vs.
   tableReadRows/renderTableRead above. */
function describeReview(result, v, seat) {
  const decisions = (result && result.decisions) || [];
  const worst = ((result && result.worst) || []).slice(0, 2);   // reviewDeal's own cap; slice guards a caller that doesn't honour it
  const samples = (result && result.samples) || 0;
  const thin = samples > 0 && samples < THIN_SAMPLES;
  if (!worst.length) return { clean: true, thin, samples, count: decisions.length, worst: [] };

  // winProb reads from the reviewed seat's own side (ai/pimc.js) — the same
  // hedge describeHint's play branch makes above: a defender's own success
  // is "sets", not "holds", or the number reads backwards for exactly the
  // seats it matters most to.
  const verb = sideOf(v, seat) === "D" ? "holds" : "sets";
  return {
    clean: false, thin, samples, count: decisions.length,
    worst: worst.map(d => ({
      trickNo: d.trickNo, grade: d.grade, verb,
      playedName: cardName(d.played), bestName: cardName(d.best),
      playedPct: Math.round(d.playedWinProb * 100), bestPct: Math.round(d.bestWinProb * 100),
    })),
  };
}

/* The one line every branch of renderReview ends on: what the numbers above
   it are actually worth (ambiguity #2: caveat a thin search rather than
   present it with false confidence). Skipped when there was nothing to
   sample at all (count 0) — a caveat about sample size means nothing next to
   a deal with no real decisions in it. */
function reviewNote(s) {
  if (!s.count) return "";
  return s.thin
    ? `Rough read — some of these decisions drew as few as ${s.samples} sampled deals.`
    : `Based on ${s.samples} sampled deals per decision.`;
}

/* result/v/seat: see describeReview above. Every interpolated card label
   runs through esc() (M9) even though cardName()'s own vocabulary is fixed,
   never view-supplied — the same blanket rule voidsHtml/renderTableRead
   apply to seat names, kept here rather than argued case by case. */
function renderReview(result, v, seat) {
  const s = describeReview(result, v, seat);
  const note = reviewNote(s);
  if (s.clean) {
    // count 0: every trick was a forced play (review.js skips a trick with
    // only one legal card rather than grading a play that was never a
    // choice) — an honest "nothing to grade", not the same claim as a real
    // decision that simply never cost the contract.
    const line = s.count
      ? `Clean deal — none of your ${s.count} decision${s.count === 1 ? "" : "s"} cost the contract.`
      : `Nothing to grade this deal — every card was forced.`;
    return `<div class="deal-review"><p class="muted">${line}</p>` +
      (note ? `<div class="note">${esc(note)}</div>` : "") + `</div>`;
  }
  const rows = s.worst.map(d =>
    `<div class="dr-dec"><div class="dr-head"><span class="dr-trick">Trick ${d.trickNo}</span>` +
    `<span class="dr-tag ${d.grade}">${d.grade}</span></div>` +
    `<div class="dr-line">You played <b>${esc(d.playedName)}</b>, which ${d.verb} the contract in ${d.playedPct}% of sampled deals.</div>` +
    `<div class="dr-line dr-alt">The search preferred <b>${esc(d.bestName)}</b>, which ${d.verb} it in ${d.bestPct}%.</div></div>`
  ).join("");
  return `<div class="deal-review">${rows}<div class="note">${esc(note)}</div></div>`;
}

/* What ui/modals.js's paintRoundBody shows when requestReview *resolves* but
   the worker declined the request — res is the raw { ok:false, error }
   response (worker.js's own review guard: "no finished deal in this view" is
   the one that can currently reach here, from a stale click racing a phase
   change). cap()'d and full-stopped the same way describeHint's own
   res.error branch above already reads one — a single house style for "the
   worker's own words, as a sentence" rather than two. Pure and exported for
   the same reason describeReview is: this is exactly the kind of wording
   branch that goes untested once it is inline inside a DOM-writing function
   (Task 10's own regression class), so it does not get to live there. */
function reviewErrorMessage(res) {
  return cap((res && res.error) || "the review could not be run") + ".";
}

/* What paintRoundBody shows when the request rejects outright instead of
   resolving — client.js's own dead-worker (onerror) and 10s-timeout paths,
   never merely "review unavailable" (that resolves ok:false and reads
   through reviewErrorMessage above instead). A fixed, honest constant rather
   than the rejection's own Error#message — same reasoning initCoach's
   hint-rejection handler above already documents: that text is
   runtime/browser text this file does not control, not a string safe to
   promise a stable reading of. */
const REVIEW_REJECTED_MESSAGE = "The review search failed — try again.";

export {
  hintEnabled, initCoach, renderCoach, resetCoach, describeHint,
  describeTableRead, tableReadRows, voidsHtml, suitsHtml, renderTableRead,
  describeReview, renderReview, reviewErrorMessage, REVIEW_REJECTED_MESSAGE,
};
