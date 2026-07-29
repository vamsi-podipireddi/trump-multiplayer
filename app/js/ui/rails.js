/* The left rail — the contract, the scoreboard, and the tricks you took — plus
   the phone strip that carries the contract's two numbers while the rail is a
   closed sheet.

   Shared by the multiplayer client and solo, so nothing here may reach for
   session.js or net.js: the seat-dependent parts arrive in `o`, and the
   multiplayer settings row arrives as ready-made HTML plus a callback rather
   than as an import of screens/lobby.js, which does own net.js.

   The same three renderers run against both pages, and solo.html has no
   #settings-line, so every lookup that isn't in *both* documents is guarded. */
import { $, esc } from "../util/dom.js";
import { SUIT_KEY, suitSvg, suitSpan, suitClass } from "../cards/labels.js";
import { cardFace, miniCardEl } from "../cards/deck.js";
import { icon } from "../cards/icons.js";

/* solo's view carries names only; the multiplayer view also has a label for a
   seat nobody has taken yet ("Seat 3", "AI"), which is what belongs on screen. */
function nameOf(v, s) {
  if (s == null) return "";
  return v.names[s] || (v.seats && v.seats[s] ? v.seats[s].label : "") || "";
}

/* The bidding side's total. `partner === declarer` is the deal where the called
   card is in the caller's own hand — one seat, so its points count once. */
function declarerPts(v) {
  if (v.declarer == null || v.partner == null) return 0;
  return v.capturedPoints[v.declarer] + (v.partner === v.declarer ? 0 : v.capturedPoints[v.partner]);
}
const pairNames = v => v.partner === v.declarer
  ? nameOf(v, v.declarer)
  : nameOf(v, v.declarer) + " & " + nameOf(v, v.partner);
const pairLabel = v => pairNames(v) + (v.partner === v.declarer ? " is bidding alone" : " are bidding");
/* The 30 goes to whoever captured the trick the 3 fell in. The wire carries no
   "bonus taken by", so the trick history is where that is written down. */
function bonusTakenBy(v) {
  for (const t of v.tricks) {
    if (t.cards.some(p => p.card.rank === 3 && p.card.suit === v.bonusSuit)) return t.winner;
  }
  return null;
}
const bidOf = v => v.bid || v.highBid || 0;

// a rail thumbnail is a picture of a card, never a control
function thumb(card, dim) {
  const el = miniCardEl(card);
  el.classList.add("static");
  if (dim) el.classList.add("dim");
  return el;
}

// ---------- contract ----------
function renderContract(v, o) {
  const bid = bidOf(v), dPts = declarerPts(v);
  const onTrack = bid > 0 && dPts >= bid;
  const width = (bid ? Math.min(1, dPts / bid) * 100 : 0).toFixed(1) + "%";
  const captured = dPts + " captured";

  const su = $("contract-suit");
  su.className = "su-big" + (v.trump ? " s-" + SUIT_KEY[v.trump] : "");
  su.innerHTML = v.trump ? suitSvg(v.trump) : "";
  $("contract-bid").textContent = bid ? String(bid) : "—";
  $("contract-side").textContent = v.teamsRevealed ? pairLabel(v)
    : v.phase === "bidding" ? "auction in progress" : "not set yet";
  const fill = $("contract-fill");
  fill.style.width = width;
  fill.classList.toggle("ontrack", onTrack);            // brass while it's a target, green once it's made
  $("contract-captured").textContent = captured;
  $("contract-remain").textContent = bid ? Math.max(0, bid - dPts) + " to go" : "";

  const called = v.calledCard;                          // null until the pair is public — it names the partner
  $("called-card-row").classList.toggle("show", !!called);
  if (called) {
    const el = $("called-card");
    el.className = "mini-card static " + suitClass(called.suit);
    el.innerHTML = cardFace(called, true);
    $("called-sub").textContent = v.partner === v.declarer ? "nobody holds it" : "held by " + nameOf(v, v.partner);
  }

  const bonus = v.bonusSuit ? { suit: v.bonusSuit, rank: 3 } : null;
  const taken = bonus ? bonusTakenBy(v) : null;
  $("bonus-card-row").classList.toggle("show", !!bonus);
  if (bonus) {
    const el = $("bonus-card");
    el.className = "mini-card static " + suitClass(bonus.suit) + (taken != null ? " dim" : "");
    el.innerHTML = cardFace(bonus, true);
    const sub = $("bonus-sub");
    sub.className = "sub" + (taken == null ? " live" : "");
    sub.textContent = taken == null ? "still in someone's hand" : "taken by " + nameOf(v, taken);
  }

  /* On a phone the rail is a sheet you have to open, so the two numbers that
     decide how you play the next card ride above the hand instead. The strip is
     aria-hidden in the markup: the action bar already says this in a sentence. */
  const strip = $("contract-strip");
  // the skeleton is built once — the bar's width transition needs the same <i> to survive a repaint
  if (!strip.firstChild) strip.innerHTML = '<span class="sc"></span><span class="bid"></span><div class="bar"><i></i></div><span class="cap"></span>';
  const ssu = strip.children[0], sfill = strip.children[2].firstChild;
  ssu.className = "sc" + (v.trump ? " s-" + SUIT_KEY[v.trump] : "");
  ssu.innerHTML = v.trump ? suitSvg(v.trump) : "";
  strip.children[1].textContent = bid ? String(bid) : "—";
  sfill.style.width = width;
  sfill.classList.toggle("ontrack", onTrack);
  strip.children[3].textContent = captured;
  while (strip.children.length > 4) strip.lastElementChild.remove();
  if (bonus) strip.appendChild(thumb(bonus, taken != null));
  if (called) strip.appendChild(thumb(called, false));
}

// ---------- scoreboard ----------
function renderScoreboard(v, o) {
  const target = o.target;
  $("score-title").innerHTML = `Scoreboard<span class="count">First to ${target}</span>`;
  /* Deal-wins as pips against the target — "2" never said how close anyone was.
     Seven of them don't fit the column, so "first to 7" falls back to n / K. */
  const deals = n => target <= 5
    ? Array.from({ length: target }, (_, i) => `<i class="tally${i < n ? " on" : ""}"></i>`).join("")
    : `${n} / ${target}`;
  let html = '<tr class="head"><th class="name">Player</th><th class="pts">Points</th><th class="deals">Deals</th></tr>';
  for (let s = 0; s < 4; s++) {
    const cls = [];
    if (o.mySeat != null && s === o.mySeat) cls.push("you");
    if (v.teamsRevealed) cls.push(o.sideOf(s) === "D" ? "side-d" : "side-o");   // a rail on the row, not a dot in the cell
    html += `<tr class="${cls.join(" ")}">` +
            `<td class="name">${esc(nameOf(v, s))}${v.dealer === s ? " · D" : ""}</td>` +
            `<td class="pts">${v.capturedPoints[s]}</td>` +
            `<td class="deals">${deals(v.scores[s])}</td></tr>`;
  }
  $("scoreboard").innerHTML = html;

  const cl = $("contract-line");
  cl.innerHTML = v.teamsRevealed && v.declarer != null
    ? `<span class="chip">${suitSpan(v.trump)}<b>${esc(pairNames(v))}</b></span>` +
      `<span class="chip"><b>${declarerPts(v)}</b> / ${bidOf(v)}</span>`
    : "";                                               // .contract-line:empty hides itself

  const sl = $("settings-line");                        // multiplayer only: a solo table has no settings to negotiate
  if (!sl) return;
  sl.innerHTML = o.settingsHtml || "";
  if (o.onSettings) {
    const b = document.createElement("button");
    b.className = "mini-btn";
    b.innerHTML = icon("gear") + "<span>Change</span>";
    b.onclick = o.onSettings;
    sl.appendChild(b);
  }
}

// ---------- tricks you won ----------
let builtKey = "", builtCount = 0;

function renderTricks(v, o) {
  const sec = $("sec-tricks");
  sec.classList.toggle("show", !!v.teamsRevealed);      // before the reveal, "yours" would give the pair away
  const mine = v.tricks.filter(t => t.winner === o.mySeat);
  const pts = mine.reduce((a, t) => a + t.pts, 0);
  $("my-tricks-count").textContent = mine.length ? `${mine.length} · ${pts} pts` : "0";
  const last = v.tricks[v.tricks.length - 1];
  $("last-trick-note").textContent = last
    ? `Last trick — ${nameOf(v, last.winner)} took it, ${last.pts} pts`
    : "Nothing taken yet.";
  sec.classList.toggle("is-empty", !mine.length);

  /* .trickrow animates in, so only rows that are actually new may be built:
     rebuilding the column replayed the animation on every row of it each time
     anyone at the table played a card. */
  const host = $("my-tricks");
  const key = v.roundNumber + "|" + o.mySeat;
  if (key !== builtKey || mine.length < builtCount) { host.innerHTML = ""; builtKey = key; builtCount = 0; }
  for (let i = builtCount; i < mine.length; i++) host.insertBefore(trickRow(mine[i]), host.firstChild);
  builtCount = mine.length;
}

function trickRow(t) {
  const row = document.createElement("div"); row.className = "trickrow";
  const no = document.createElement("span"); no.className = "no"; no.textContent = String(t.no);
  const cards = document.createElement("div"); cards.className = "cards";
  t.cards.forEach(p => {
    const el = thumb(p.card, false);
    if (t.winCard && p.card.suit === t.winCard.suit && p.card.rank === t.winCard.rank) el.classList.add("win");
    cards.appendChild(el);
  });
  const pts = document.createElement("span");
  pts.className = "pts" + (t.pts >= 20 ? " fat" : "");
  pts.textContent = t.pts ? String(t.pts) : "–";
  row.appendChild(no); row.appendChild(cards); row.appendChild(pts);
  return row;
}

export { renderContract, renderScoreboard, renderTricks };
