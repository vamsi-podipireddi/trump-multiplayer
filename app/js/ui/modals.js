import { $, esc, avatarHtml } from "../util/dom.js";
import { SUIT_NAME } from "../cards/labels.js";
import { cardEl } from "../cards/deck.js";
import { sfx } from "./sound.js";
import { requestReview, requestReport } from "../coach/client.js";
import { bonusTakenBy } from "../coach/read.js";
import { renderReview, renderReport, reviewErrorMessage, REVIEW_REJECTED_MESSAGE } from "./coach.js";
import { loadDeals } from "../util/deals.js";

/* Nothing here imports session.js or net.js (docs/STRUCTURE.md rule 6): both
   pages hand these functions their own view and their own handlers, and solo
   has no session to read.
   The one thing that cannot arrive as an argument is render(): a modal's close
   button has to repaint whatever is behind it, and render() lives in
   screens/game.js, which already imports this file — importing it back would
   make the two files import each other. So main.js and solo.js each register
   theirs at boot; until then this is a safe no-op. onRender() is exported
   because screens/lobby.js's settings modal closes the same way and must reach
   the same handler rather than stand up a second seam beside this one. */
let renderHandler = () => {};
function setRenderHandler(fn) { renderHandler = fn; }
function onRender() { renderHandler(); }

/* Help and Settings are documents, not verdicts: they read left-aligned and a
   little wider. The kind is the only thing either caller knows about, so the
   width lives here rather than in every call site. */
const WIDE = new Set(["help", "settings"]);
function setModal(kind, html) {
  $("modal").className = "modal" + (WIDE.has(kind) ? " wide" : "");
  $("modal").innerHTML = html;
  $("overlay").dataset.kind = kind;
  $("overlay").classList.add("show");
}
function hideOverlay() { $("overlay").classList.remove("show"); $("overlay").dataset.kind = ""; }

/* Both clients ask for a seat's display name, and only one of them has
   S.view.seats to ask — so it comes off the context object the table renderers
   already receive, with the wire's names as the fallback. */
function seatName(v, o, seat) {
  const info = o && typeof o.seatInfo === "function" ? o.seatInfo(seat) : null;
  return (info && info.name) || (v.names && v.names[seat]) || "";
}
function seatIsAI(o, seat) {
  const info = o && typeof o.seatInfo === "function" ? o.seatInfo(seat) : null;
  return !!(info && info.isAI);
}
/* o.sideOf() answers null until the teams are known (see screens/game.js); by
   the time anything in this file runs they are, but the fallback keeps a modal
   from rendering "undefined" if that ever stops being true. */
function sideOf(v, o, seat) {
  const s = o && typeof o.sideOf === "function" ? o.sideOf(seat) : null;
  return s || ((seat === v.declarer || seat === v.partner) ? "D" : "O");
}

// ---------- how to play ----------
/* Each page passes its own view, so the copy below quotes whatever match
   length that player actually picked rather than a hardcoded 5. The literals
   are the fallback for a view that has no consts yet — Help is wired at boot,
   the first state message is not. */
function showHelp(view) {
  const c = (view && view.consts) || { TOTAL_POINTS:250, MIN_BID:130, BID_STEP:5, TARGET_GAMES:5 };
  const steps = [
    `The deck holds <b>${c.TOTAL_POINTS} points</b>: A K Q J 10 are worth 10 each, every 5 is worth 5, and one random suit's <b>3 is worth 30</b>. That bonus suit is announced before bidding.`,
    `<b>Bid</b> the number of points your side will capture — minimum <b>${c.MIN_BID}</b>, in steps of ${c.BID_STEP} — or pass. Highest bidder wins the auction.`,
    `The bid winner picks the <b>trump</b> suit, then <b>calls a card they don't hold</b>. Whoever holds it is their partner. Teams are revealed at once.`,
    `Follow suit if you can. Highest trump takes the trick, otherwise the highest card of the led suit. The winner captures its point cards and leads next.`,
    `Make the bid and the bidding side wins the deal; fall short and the defenders take it. First side to <b>${c.TARGET_GAMES} deals</b> wins the match.`,
  ];
  setModal("help",
    `<h2>How to play</h2><p class="kicker">${c.TOTAL_POINTS} points in the deck</p>` +
    `<div class="how">` +
    steps.map((t, i) => `<div class="step"><span class="n">0${i + 1}</span><div class="t">${t}</div></div>`).join("") +
    `</div><button class="btn ghost" id="btn-close">Got it</button>`);
  $("btn-close").onclick = () => { hideOverlay(); onRender(); };
}

// ---------- match over ----------
/* Both callers may ask for this on any state message, and the fanfare belongs
   to the result rather than to the message — so, like the deal panel below, the
   panel is built (and sounded) once per set of final scores. A rematch takes
   the overlay off "match" on its way past, which is what lets the next match
   sound even if it ends on the same numbers. */
let matchKey = null;
/* The match-over review's own state, scoped to the one match `matchKey`
   names — same shape and same reason as showRoundResult's reviewOpen/
   reviewState below: reset alongside matchKey so a review left open on a
   decided match never bleeds into the next one. */
let matchReviewOpen = false;
let matchReviewState = null;
/* The whole-match report card's own state — same shape and the same reset
   discipline as matchReviewOpen/matchReviewState above. Kept mutually
   exclusive with them at the toggle (see matchAction): #match-body shows one
   pane at a time, so opening this one closes the deal review rather than
   leaving that button reading "open" over a pane it no longer owns. */
let matchReportOpen = false;
let matchReportState = null;

function showMatchOver(view, onRematch) {
  const key = view.scores.join(",");
  if (matchKey === key && $("overlay").dataset.kind === "match") return;
  matchKey = key;
  matchReviewOpen = false; matchReviewState = null;   // a new match — any open or in-flight review belonged to the last one
  matchReportOpen = false; matchReportState = null;   // same — a new match's report card starts closed and unfetched

  const mySeat = view.you ? view.you.seat : null;
  const best = Math.max(...view.scores);
  const champs = [0,1,2,3].filter(p => view.scores[p] === best);
  const youWon = mySeat != null && champs.includes(mySeat);
  const names = champs.map(p => esc(view.names[p])).join(" &amp; ");

  /* #match-body is what the review toggle swaps (paintMatchBody); #match-action
     — the rematch button (or "waiting for host"), plus the toggle itself —
     never moves, the exact split showRoundResult's #round-body/#round-action
     use below so the rematch path is unreachable from the body painter no
     matter which body is currently showing (Task 12's own structural
     guarantee — reviewed and approved there — ported rather than re-argued). */
  setModal("match",
    `<div class="sheen"></div><div class="kicker">Match over · first to ${view.consts.TARGET_GAMES}</div>` +
    `<div class="head${youWon ? " made" : ""}">${youWon ? "YOU WIN" : names}</div>` +
    `<p>${names} reach ${best} deal${best === 1 ? "" : "s"} first.</p>` +
    `<div class="pbar"><i class="${youWon ? "made" : ""}" style="width:100%"></i></div>` +
    `<div id="match-body"></div><div id="match-action"></div>`);
  paintMatchBody(view);
  matchAction(view, onRematch);
  sfx("win");
}
/* The standings list — showMatchOver's original inline build, pulled into its
   own function for the same reason roundSummaryHtml below was: paintMatchBody
   must rebuild it every time the review toggle flips back off, and
   recomputing off `view` costs nothing next to a snapshot that would need to
   stay in sync with showMatchOver's own copy. No `o` (table ctx) parameter —
   showMatchOver has never taken one, and nothing here needs more than
   view.you/view.names/view.scores already carry. */
function matchStandingsHtml(view) {
  const mySeat = view.you ? view.you.seat : null;
  return `<div class="standings">` + [0,1,2,3].slice().sort((a,b) => view.scores[b] - view.scores[a]).map(p =>
    `<div class="${mySeat != null && p === mySeat ? "me" : ""}"><span>${esc(view.names[p])}${mySeat != null && p === mySeat ? " (you)" : ""}</span>` +
    `<span>${view.scores[p]} deal${view.scores[p] === 1 ? "" : "s"}</span></div>`).join("") + `</div>`;
}
/* #match-body's own paint: the standings above when both toggles are off,
   else whichever of the deal review or the match report card is open — at
   most one at a time (see matchAction) — computed lazily, on this first open,
   never ahead of a click (same "on demand, not automatic" contract
   paintRoundBody documents below). requestReview's/requestReport's own 10s
   timeout (client.js) is what stops a permanent "Analysing…" if the worker
   wedges. Never touches #match-action, which is what keeps the primary
   control reachable through every state this function paints. */
function paintMatchBody(view) {
  const host = $("match-body");
  if (!host) return;
  if (matchReportOpen) { paintMatchReport(view, host); return; }
  if (!matchReviewOpen) { host.innerHTML = matchStandingsHtml(view); return; }

  if (matchReviewState === "pending") { host.innerHTML = REVIEW_WAIT; return; }
  if (matchReviewState) {
    host.innerHTML = matchReviewState.ok
      ? renderReview(matchReviewState.result, view, view.you.seat)
      : `<div class="deal-review"><p class="muted">${esc(matchReviewState.message)}</p></div>`;
    return;
  }

  matchReviewState = "pending";
  host.innerHTML = REVIEW_WAIT;
  const seat = view.you.seat;
  const myKey = matchKey;   // a slow response landing after the NEXT match has already opened must not paint over it
  requestReview(view, seat).then(res => {
    if (matchKey !== myKey) return;
    matchReviewState = (res && res.ok) ? { ok: true, result: res.result } : { ok: false, message: reviewErrorMessage(res) };
    paintMatchBody(view);
  }, () => {
    /* A rejection is a real path, not a hypothetical one — see
       paintRoundBody's identical comment below: client.js rejects every
       pending request when the worker dies and again after its own 10s
       timeout, never merely because review is unavailable (that resolves
       ok:false above, via reviewErrorMessage instead). */
    if (matchKey !== myKey) return;
    matchReviewState = { ok: false, message: REVIEW_REJECTED_MESSAGE };
    paintMatchBody(view);
  });
}
/* #match-body's report pane: the whole match, via loadDeals + requestReport
   rather than requestReview — deals come off this device's own storage
   (util/deals.js), never the wire, so a second device, private browsing, a
   storage quota or joining mid-match all yield a genuinely partial set;
   describeReport's own coverage/partial lines (ui/coach.js) state that
   rather than hide it (D45). dealsInMatch rides view.dealHistory — the
   server's own count of deals actually played — rather than deals.length,
   because that count is exactly what a local, possibly-incomplete snapshot
   list cannot answer for itself.
   Grading a whole match is heavier than one deal's review — client.js's own
   comment on requestReport names this as the one caller that can plausibly
   reach TIMEOUT_MS on a slow phone — so it gets the identical pending/
   settled state machine paintMatchBody's review branch above already uses,
   including the same REVIEW_REJECTED_MESSAGE on outright rejection. Unlike
   that review branch, a failed state here does not cache forever: closing
   the toggle behind a failure clears it (see matchAction's rpb.onclick), so
   reopening genuinely retries instead of replaying the same "try again"
   message with nothing behind it. */
function paintMatchReport(view, host) {
  if (matchReportState === "pending") { host.innerHTML = REVIEW_WAIT; return; }
  if (matchReportState) {
    host.innerHTML = matchReportState.ok
      ? renderReport(matchReportState.result, view, view.you.seat)
      : `<div class="deal-review"><p class="muted">${esc(matchReportState.message)}</p></div>`;
    return;
  }

  matchReportState = "pending";
  host.innerHTML = REVIEW_WAIT;
  const seat = view.you.seat;
  const room = (view.room && view.room.code) || "solo";   // solo.js's own view.room carries no code at all
  const deals = loadDeals(room, view.matchId);
  const dealsInMatch = (view.dealHistory || []).length;
  const myKey = matchKey;   // a slow response landing after the NEXT match has already opened must not paint over it
  requestReport(deals, seat, dealsInMatch).then(res => {
    if (matchKey !== myKey) return;
    matchReportState = (res && res.ok) ? { ok: true, result: res.result } : { ok: false, message: reviewErrorMessage(res) };
    paintMatchBody(view);
  }, () => {
    // A rejection is a real path, not a hypothetical one — see paintMatchBody's
    // identical comment on the review branch above: client.js rejects every
    // pending request when the worker dies and again after its own 10s timeout.
    if (matchKey !== myKey) return;
    matchReportState = { ok: false, message: REVIEW_REJECTED_MESSAGE };
    paintMatchBody(view);
  });
}
/* #match-action's own paint: the rematch button (host) or the "waiting for
   host" message — exactly what showMatchOver used to build inline — plus,
   second and third and always additive, the deal-review toggle and the
   report-card toggle. Adding them here rather than replacing the primary
   control is the whole point (same reasoning roundAction's own comment gives
   below): the host may be about to start another match regardless of what
   either toggle does, so they only ever get a neighbour, never a
   replacement. A spectator (no seat of their own) never sees either toggle —
   there is nothing of theirs to review or report on. */
function matchAction(view, onRematch) {
  const host = $("match-action");
  if (!host) return;
  host.innerHTML = view.room.isHost
    ? `<button class="btn" id="btn-rematch">Start a new match</button>`
    : `<p class="muted">Waiting for ${esc(view.room.hostName || "the host")} to start a new match…</p>`;
  if (view.room.isHost) $("btn-rematch").onclick = onRematch;

  if (view.you && view.you.seat != null) {
    const rb = document.createElement("button");
    rb.className = "btn ghost";
    paintReviewToggle(rb, matchReviewOpen);
    /* Mutates this same node rather than rebuilding #match-action: see
       roundAction's identical comment below — a keyboard/screen-reader user
       tabbed here must not lose focus the instant they activate the control
       that fired this very handler. Closes the report card (see rpb below)
       rather than leaving it open behind this one — the body panel these two
       toggles share shows a single pane, and a toggle reading "open" over a
       pane it does not own is worse than no mark at all (same discipline
       ui/coach.js's own positionKey comment states for a stale hint mark). */
    rb.onclick = () => {
      matchReviewOpen = !matchReviewOpen;
      if (matchReviewOpen) matchReportOpen = false;
      paintReviewToggle(rb, matchReviewOpen);
      paintReviewToggle(rpb, matchReportOpen, "Report card");
      paintMatchBody(view);
    };
    host.appendChild(rb);

    /* Third sibling, next to — never replacing — the rematch button above,
       per D37/D45: the whole-match report card gets its own toggle,
       additive exactly the way the deal-review toggle already is. */
    const rpb = document.createElement("button");
    rpb.className = "btn ghost";
    paintReviewToggle(rpb, matchReportOpen, "Report card");
    rpb.onclick = () => {
      matchReportOpen = !matchReportOpen;
      if (matchReportOpen) {
        matchReviewOpen = false;   // one pane at a time — see rb's own comment above
      } else if (matchReportState && matchReportState.ok === false) {
        /* Closing behind a failed attempt clears it, so the next open is a
           real retry rather than replaying the same cached failure message
           forever — a whole match's grading is heavy enough to plausibly hit
           client.js's own 10s TIMEOUT_MS on a slow phone, and "try again" in
           that message must actually mean something. A successful result is
           left cached (untouched here): toggling back and forth to glance at
           the standings must not re-run an expensive search that already
           answered. */
        matchReportState = null;
      }
      paintReviewToggle(rpb, matchReportOpen, "Report card");
      paintReviewToggle(rb, matchReviewOpen);
      paintMatchBody(view);
    };
    host.appendChild(rpb);
  }
}

// ---------- deal result ----------
/* Every point in the deck is captured by someone, so the split bar closes; the
   four shades are ordered by who took the most, which is the only ranking the
   bar can carry without a second colour per side. */
const SPLIT_SHADES = ["var(--acc)", "var(--acc2)", "rgba(230,192,122,.42)", "rgba(244,242,236,.22)"];
/* screens/game.js and solo.js both call showRoundResult() on every render for
   as long as the deal is over — the ready count in the button changes under it.
   Rebuilding the panel each time would restart its entrance animation and
   replay its verdict cue, so a panel already showing this deal only has its
   button refreshed. */
let roundKey = null;
/* The review view's own state, scoped to the one round `roundKey` names —
   reset alongside it below. reviewOpen: is #round-body currently showing the
   coach's findings instead of the "where the N went" summary. reviewState:
   null (never asked), "pending" (requestReview in flight), or the settled
   { ok, result | message } — kept outside paintRoundBody so a toggle back to
   the summary and back again to the review doesn't re-run a multi-second
   search it already has the answer to. */
let reviewOpen = false;
let reviewState = null;

const REVIEW_WAIT = `<div class="deal-review"><p class="muted">Analysing your play<span class="think"><i></i><i></i><i></i></span></p></div>`;

function showRoundResult(v, o, h) {
  const r = v.lastResult;
  if (!r) return;
  const key = v.roundNumber + "|" + r.bid + "|" + r.dPts + "|" + (r.made ? 1 : 0);
  if (roundKey === key && $("overlay").dataset.kind === "round") { roundAction(v, o, h); return; }
  roundKey = key;
  reviewOpen = false; reviewState = null;   // a new deal — any open or in-flight review belonged to the last one

  const nm = seat => esc(seatName(v, o, seat));
  const tone = r.made ? "made" : "set";
  const pct = r.bid ? Math.min(1, r.dPts / r.bid) * 100 : 0;
  const pair = r.partner === r.declarer ? nm(r.declarer) + " alone" : nm(r.declarer) + " &amp; " + nm(r.partner);

  /* #round-body is the part the review toggle swaps (paintRoundBody); the
     verdict above it and #round-action below it never move, which is what
     keeps the ready button reachable regardless of which body is showing. */
  setModal("round",
    `<div class="sheen"></div><div class="kicker">Deal ${v.roundNumber} result</div>` +
    `<div class="head ${tone}">${r.made ? "MADE" : "SET"}</div>` +
    `<p>${pair} captured ${r.dPts} of ${r.bid}. ${r.winners.map(nm).join(" &amp; ")} win the deal.</p>` +
    `<div class="pbar"><i class="${tone}" style="width:${pct.toFixed(0)}%"></i></div>` +
    `<div id="round-body"></div><div id="round-action"></div>`);
  paintRoundBody(v, o);
  roundAction(v, o, h);
  sfx(r.made ? "made" : "set");
}
/* The "where the N went" breakdown plus final standings — everything
   showRoundResult used to build inline, now its own function so the review
   toggle (roundAction below) can rebuild it on demand: paintRoundBody calls
   this every time reviewOpen flips back off. Recomputed rather than cached —
   a few array maps over a deal that cannot change while its own modal is up
   — so there is no snapshot to keep in sync with showRoundResult's own. */
function roundSummaryHtml(v, o) {
  const r = v.lastResult;
  const total = v.consts.TOTAL_POINTS;
  const nm = seat => esc(seatName(v, o, seat));

  const order = [0,1,2,3].slice().sort((a,b) => v.capturedPoints[b] - v.capturedPoints[a]);
  const splitBar = order.map((s, i) =>
    `<i style="width:${(v.capturedPoints[s] / total * 100).toFixed(2)}%;background:${SPLIT_SHADES[i]}"></i>`).join("");
  const legend = order.map((s, i) =>
    `<span><i style="background:${SPLIT_SHADES[i]}"></i>${nm(s)}<b>${v.capturedPoints[s]}</b></span>`).join("");

  /* The trick history is new on the wire; a client talking to a server that has
     not shipped it yet drops these rows rather than inventing them. */
  const tricks = Array.isArray(v.tricks) ? v.tricks : [];
  /* The 30-point 3 is the deal's single biggest swing, so the panel names who
     ended up with it — which the trick history knows and the score does not.
     coach/read.js's bonusTakenBy, not a second copy of the same loop: the rail
     and this modal showing different owners of the same 30 points is exactly
     the drift M10's Task 4 relocated that function out of rails.js to end. */
  const bonusTaker = bonusTakenBy(v);
  const fat = tricks.slice().sort((a, b) => b.pts - a.pts || a.no - b.no)[0];
  // declarer === partner is applyCall()'s unreachable safety; counting the seat twice would not be
  const dTricks = r.partner === r.declarer ? v.tricksWon[r.declarer] : v.tricksWon[r.declarer] + v.tricksWon[r.partner];
  const played = v.tricksWon.reduce((a, b) => a + b, 0);
  const rows = [];
  if (tricks.length) {
    rows.push(["", `Bonus 3 of ${SUIT_NAME[v.bonusSuit] || ""} · 30 pts`, bonusTaker != null ? nm(bonusTaker) : "never taken"]);
    rows.push(["", `Biggest trick — ${nm(fat.winner)}`, fat.pts + " pts"]);
  }
  rows.push(["", "Tricks — bidding / defending", dTricks + " / " + (played - dTricks)]);
  rows.push(r.made && r.dPts === r.bid
    ? ["good", "Margin", "exactly on the number"]
    : [r.made ? "good" : "bad", r.made ? "Made it by" : "Short by", (r.made ? r.dPts - r.bid : r.bid - r.dPts) + " pts"]);
  const review = `<div class="review"><div class="lbl">Where the ${total} went</div>` +
    `<div class="splitbar">${splitBar}</div><div class="legend">${legend}</div>` +
    rows.map(([cls, label, val]) => `<div class="rrow${cls ? " " + cls : ""}"><span>${label}</span><span>${val}</span></div>`).join("") +
    `</div>`;

  const mySeat = o ? o.mySeat : null;
  const standings = [0,1,2,3].map(s =>
    `<div class="${mySeat != null && s === mySeat ? "me" : ""}">` +
    `<span>${nm(s)} · ${sideOf(v, o, s) === "D" ? "bidding" : "defending"}</span>` +
    `<span>${v.capturedPoints[s]} pts · ${v.scores[s]} deal${v.scores[s] === 1 ? "" : "s"}</span></div>`).join("");

  return review + `<div class="standings">${standings}</div>`;
}
/* #round-body's own paint: the summary above when the toggle is off, else
   the review — computed lazily, on this first open, never ahead of a click
   (ambiguity #4: on demand, not automatic). requestReview's own 10s timeout
   (client.js) is what stops a permanent "Analysing…" if the worker wedges.
   Never touches #round-action, which is what keeps the ready button
   reachable through every state this function paints. */
function paintRoundBody(v, o) {
  const host = $("round-body");
  if (!host) return;
  if (!reviewOpen) { host.innerHTML = roundSummaryHtml(v, o); return; }

  if (reviewState === "pending") { host.innerHTML = REVIEW_WAIT; return; }
  if (reviewState) {
    host.innerHTML = reviewState.ok
      ? renderReview(reviewState.result, v, v.you.seat)
      : `<div class="deal-review"><p class="muted">${esc(reviewState.message)}</p></div>`;
    return;
  }

  reviewState = "pending";
  host.innerHTML = REVIEW_WAIT;
  const seat = v.you.seat;
  const myKey = roundKey;   // a slow response landing after the NEXT deal has already opened must not paint over it
  requestReview(v, seat).then(res => {
    if (roundKey !== myKey) return;
    reviewState = (res && res.ok) ? { ok: true, result: res.result } : { ok: false, message: reviewErrorMessage(res) };
    paintRoundBody(v, o);
  }, () => {
    if (roundKey !== myKey) return;
    /* A rejection is a real path, not a hypothetical one — client.js rejects
       every pending request when the worker dies and again after its own
       10s timeout, never merely because review is unavailable (that comes
       back as ok:false above, via reviewErrorMessage instead). See
       REVIEW_REJECTED_MESSAGE (coach.js) for why the message is a fixed,
       honest constant rather than the rejection's own Error#message. */
    reviewState = { ok: false, message: REVIEW_REJECTED_MESSAGE };
    paintRoundBody(v, o);
  });
}
/* One primary button, and which one depends on who is driving the deal:
   multiplayer waits for every live seat to ready up, solo deals the moment
   you say so — plus, second and always additive, the review toggle. Adding
   it here rather than replacing the primary button is the whole point: three
   other players (or the 30s fallback, D5) are waiting on that button
   regardless of what the toggle does, so it only ever gets a neighbour, never
   a replacement. Spectators return above before reaching the toggle — there
   is nothing of their own to review. */
function roundAction(v, o, h) {
  const host = $("round-action");
  if (!host) return;
  host.innerHTML = "";
  if (h && h.ready) {
    if (v.you.spectator) { host.innerHTML = `<p class="muted">Watching — the next deal starts when the players are ready.</p>`; return; }
    const live = (v.seats || []).filter(s => s.isHuman && s.connected && !s.away);
    const ready = live.filter(s => s.ready).length;
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = v.you.ready ? `Ready ✓ — waiting ${ready}/${live.length}` : `Next deal — I'm ready (${ready}/${live.length})`;
    b.disabled = !!v.you.ready;
    b.onclick = () => h.ready();
    host.appendChild(b);
  } else if (h && h.nextDeal) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = `Deal ${v.roundNumber + 1}`;
    b.onclick = () => h.nextDeal();
    host.appendChild(b);
  }
  if (v.you && v.you.seat != null) {
    const rb = document.createElement("button");
    rb.className = "btn ghost";
    paintReviewToggle(rb, reviewOpen);
    /* Mutates this same node rather than re-running roundAction(): the click
       that fires this handler must not delete the element it fired on out
       from under itself — a keyboard/screen-reader user tabbed to this
       button would otherwise lose focus the instant they activate it. */
    rb.onclick = () => { reviewOpen = !reviewOpen; paintReviewToggle(rb, reviewOpen); paintRoundBody(v, o); };
    host.appendChild(rb);
  }
}
/* `open` is passed in rather than read off a module-level flag: this is
   shared across three toggles now — roundAction's own reviewOpen, and
   matchAction's matchReviewOpen and matchReportOpen — each tracking its own
   flag, which is the one thing that always differs between callers. `label`
   defaults to the original "Review this deal" text, so both pre-existing
   callers are unaffected; matchAction's report-card toggle is the only one
   that passes its own. */
function paintReviewToggle(btn, open, label = "Review this deal") {
  btn.textContent = open ? "‹ Back" : `${label} ▸`;
  btn.setAttribute("aria-expanded", String(open));
}

// ---------- the partner reveal ----------
/* Presentational only: this game has no reveal phase, so nothing in the view
   marks the moment teams became known — it is simply the first state of a deal
   in which they are. Without the memo every later state message would replay
   the whole beat; clearing it whenever teams are *not* revealed re-arms it for
   the next deal and, because a new match also deals from scratch, for a second
   deal 1 as well. */
let revealedRound = null;
let revealTimers = [];

function clearRevealTimers() { revealTimers.forEach(clearTimeout); revealTimers = []; }
// deliberately leaves the memo alone: a tap dismisses the beat, it does not queue it up again
function hideReveal() { clearRevealTimers(); $("reveal").classList.remove("show"); }
function maybeShowReveal(v, o) {
  if (!v.teamsRevealed || v.declarer == null || v.partner == null) {
    if (revealedRound != null) { revealedRound = null; hideReveal(); }   // a new deal cuts a running beat short
    return;
  }
  if (revealedRound === v.roundNumber) return;
  revealedRound = v.roundNumber;
  showReveal(v, o);
}
function revealBlock(cls) { const d = document.createElement("div"); d.className = cls; return d; }
function revealWho(v, o, seat, slot) {
  const name = seatName(v, o, seat);
  return `<div class="reveal-who ${slot}">${avatarHtml(name, seatIsAI(o, seat))}<span>${esc(name)}</span></div>`;
}
function showReveal(v, o) {
  const el = $("reveal");
  clearRevealTimers();
  const alone = v.partner === v.declarer;   // applyCall()'s unreachable safety, kept honest here
  /* The card is the subject of the shot, so it is sized off the viewport rather
     than off the felt — the felt is behind a blur at this point. */
  const w = window.innerWidth, cw = Math.min(w * 0.17, window.innerHeight * 0.26);
  const revW = Math.round(Math.max(96, Math.min(w < 900 ? 124 : 172, cw)));
  el.style.setProperty("--revw", revW + "px");
  el.style.setProperty("--revh", Math.round(revW * 1.4) + "px");

  /* Every stage animates on entry, and a CSS entry animation only runs on a
     node that has just been inserted — so each stage swaps its element in
     rather than filling one that has been sitting in the markup since load. */
  el.innerHTML = "";
  const kicker = revealBlock("reveal-kicker");
  kicker.textContent = alone ? "NOBODY HOLDS IT" : "THE CALLED CARD";
  el.appendChild(kicker);
  const cardHost = revealBlock("reveal-card");
  if (v.calledCard) cardHost.appendChild(cardEl(v.calledCard));
  el.appendChild(cardHost);
  const pair = revealBlock("reveal-pair");
  el.appendChild(pair);
  const tail = revealBlock("reveal-tail");
  el.appendChild(tail);

  el.onclick = hideReveal;
  el.classList.add("show");
  sfx("reveal");

  revealTimers.push(setTimeout(() => {
    if (alone) return;
    pair.innerHTML = revealWho(v, o, v.declarer, "a") + `<span class="reveal-amp">&amp;</span>` + revealWho(v, o, v.partner, "b");
  }, 820));
  revealTimers.push(setTimeout(() => {
    const defenders = [0,1,2,3].filter(s => s !== v.declarer && s !== v.partner).map(s => esc(seatName(v, o, s)));
    const line = alone
      ? `${esc(seatName(v, o, v.declarer))} holds the called card and plays alone`
      : `against ${defenders.join(" &amp; ")}`;
    const fresh = revealBlock("reveal-tail");
    // the table is already live behind the blur, so this dismisses the shot — it does not start the deal
    fresh.innerHTML = `<div class="line">${line} · ${v.bid} to make</div><div class="tap">TAP TO CONTINUE</div>`;
    el.replaceChild(fresh, tail);
  }, 1680));
  revealTimers.push(setTimeout(hideReveal, 3400));
}

export {
  setModal, hideOverlay, showHelp, showMatchOver,
  showRoundResult, maybeShowReveal, hideReveal, setRenderHandler, onRender,
};
