import { $, paintAvatar } from "../util/dom.js";
import { cardEl, cardBackEl } from "../cards/deck.js";
import { setRingEl } from "./layout.js";
import { sfx } from "./sound.js";

/* The felt, drawn from the view and nothing else. Both clients render it:
   multiplayer rotates the table so you are always south (o.posOf), solo hands
   in the identity map. Nothing here may reach for session.js or net.js — that
   coupling is the whole reason solo used to carry a second, drifting copy of
   the seat/trick/medallion painting.

   o = { mySeat, posOf(seat), seatInfo(seat), activeSeat, role(seat),
         sideOf(seat), thinking }, where seatInfo(seat) is
   { name, isAI, connected, away } and role(seat) is { c, t } or null. */

const POS_CLASS = ["south", "west", "north", "east"];   // position 0..3, viewer at 0

/* Where a won trick — and the chips it earns — travels, keyed on position on
   screen rather than seat number. Fractions of the felt it was measured
   against, so the cards land on the plate at every width. */
function sweepTo(pos, w, h) {
  if (pos === 1) return [-w * 0.42, -h * 0.14];
  if (pos === 2) return [0, -h * 0.42];
  if (pos === 3) return [w * 0.42, -h * 0.14];
  return [0, h * 0.42];
}

/* The 250 come in 30s, 10s and 5s, so the shower says how a trick was won and
   not merely how big it was. Seven is where it stops reading as one gesture. */
function mintChips(pts) {
  const out = [];
  let left = pts;
  while (left >= 30 && out.length < 7) { out.push(30); left -= 30; }
  while (left >= 10 && out.length < 7) { out.push(10); left -= 10; }
  while (left >= 5 && out.length < 7) { out.push(5); left -= 5; }
  return out;
}

/* ---------- module state ----------
   Renders are cheap and constant here — a chat message lands, a timer ticks,
   the hand is re-sorted — and every one of them repaints the whole table. The
   memos below are what keep that from replaying animation: the beat of a won
   trick belongs to that trick, the sweep that ends it lands once, and the card
   sound belongs to the card that was actually just played. */
let beatKey = null;          // roundNumber:trickNo of the trick whose beat has run
let sweptKey = null;         // ...and of the trick that has already slid into its pile
let beatTimers = [];
let lastTrickKeys = [];      // the trick as it stood at the previous paint

const lastTrick = v => { const h = v.tricks || []; return h.length ? h[h.length - 1] : null; };
const trickKey = (v, t) => v.roundNumber + ":" + t.no;

function after(ms, fn) { beatTimers.push(setTimeout(fn, ms)); }
/* Every timer the beat sets is cancellable, but only by the next render: a new
   deal can arrive in the middle of one, and a sweep that fires afterwards would
   slide the *next* trick off the felt. A client that stops rendering instead of
   rendering something else has to call resetTable(). */
function clearBeat() {
  beatTimers.forEach(clearTimeout);
  beatTimers = [];
  $("points-chip").classList.remove("show");
  $("flash").classList.remove("on");
  $("trick-chips").replaceChildren();
}

/* Leaving the table is not a render, so clearBeat() would never be reached:
   solo's toStart() nulls its game and hides #game, and a beat still in flight
   goes on sounding into a table nobody is looking at. Clearing the memos as
   well as the timers is what lets the next match play its own beat from the
   top rather than mistaking it for one already run. */
function resetTable() {
  clearBeat();
  beatKey = null;
  sweptKey = null;
  lastTrickKeys = [];
}
// a class re-added in the same frame it was removed in does not restart its animation
function restart(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

/* ---------- seats ----------
   A plate, the cards still in that hand, and the tricks taken so far. The plate
   is the only part that carries state: lit on its turn, green when it just took
   the trick, tinted for the pair that bought the contract. */
function renderSeats(v, o) {
  setRingEl(null);                            // re-pointed below if a human seat is on the clock
  let myUrgent = false;
  const held = heldTrickNo(v);
  for (let seat = 0; seat < 4; seat++) {
    const el = $("seat-" + POS_CLASS[o.posOf(seat)]);
    const info = o.seatInfo(seat);
    const offline = !info.isAI && !info.connected;
    el.classList.toggle("active", seat === o.activeSeat);
    el.classList.toggle("won", v.phase === "trickEnd" && v.lastWinner === seat);
    el.classList.toggle("team-d", !!v.teamsRevealed && o.sideOf(seat) === "D");
    el.classList.toggle("away-seat", !!info.away);
    el.classList.toggle("thinking", o.thinking === seat);

    const np = el.querySelector(".nameplate");
    np.querySelector(".who").textContent = info.name;
    np.classList.toggle("off", offline);

    np.querySelector(".role")?.remove();
    np.querySelector(".dealer-btn")?.remove();
    const role = o.role(seat);
    if (role) {
      const r = document.createElement("span");
      r.className = "role " + role.c;
      r.textContent = role.t;
      np.querySelector(".np-line").appendChild(r);
    }
    /* The dealer button is a puck that travels round a real table, so it is one
       here too — appended last, which is where it sits in front of the player. */
    if (v.dealer === seat) {
      const d = document.createElement("span");
      d.className = "dealer-btn"; d.textContent = "D"; d.title = "Dealer";
      np.appendChild(d);
    }

    /* The countdown rings the player's own face — the one place on the plate the
       eye is already looking — instead of adding a second disc beside it. */
    const ava = np.querySelector(".avatar");
    /* Read before paintAvatar, which rewrites className: the ring's two classes
       are driven by ui/layout.js on a 250ms tick that never re-renders, so a
       repaint of the plate would otherwise blank the ring mid-turn. */
    const wasUrgent = ava.classList.contains("urgent");
    paintAvatar(ava, info.name, info.isAI);
    const onClock = seat === o.activeSeat && v.turnDeadline != null && !info.isAI && info.connected && !info.away;
    ava.classList.toggle("ticking", onClock);
    ava.classList.toggle("urgent", onClock && wasUrgent);
    if (onClock) { setRingEl(ava); if (seat === o.mySeat) myUrgent = wasUrgent; }

    // tricks, not deals: deal-wins are pips in the scoreboard, where "first to N" reads
    const tricks = v.tricksWon[seat];
    const meta = el.querySelector(".meta");
    meta.textContent = `${v.capturedPoints[seat]} pts · ${tricks} ${tricks === 1 ? "trick" : "tricks"}`;
    const zzz = info.away ? "on autopilot" : offline ? "offline" : "";
    if (zzz) {
      const z = document.createElement("span");
      z.className = "zzz"; z.textContent = " · " + zzz;
      meta.appendChild(z);
    }

    /* What each seat actually bid — the pill beside the name says the state
       (bidding / high bid / passed), this says the number, so neither repeats. */
    const bc = el.querySelector(".bidchip");
    const bid = v.phase === "bidding" ? v.bids[seat] : null;
    bc.textContent = bid != null ? String(bid) : "";
    bc.style.display = bid != null ? "" : "none";

    /* Add and remove backs rather than rebuilding the row: .card-back animates
       in, so a rebuild dealt every remaining card again on every re-render. */
    const backs = el.querySelector("[data-backs]");
    const want = seat === o.mySeat ? 0 : v.handCounts[seat];
    while (backs.childElementCount > want) backs.lastElementChild.remove();
    while (backs.childElementCount < want) backs.appendChild(cardBackEl());

    renderPile(el.querySelector("[data-pile]"), v, seat, held);
  }
  return myUrgent;
}

/* app/css/table.css: "the whole trick slides to the seat that took it, then the
   pile grows by one". The state that turns the phase to trickEnd already
   carries the resolved trick in v.tricks — a full 780ms before those cards
   leave the middle of the felt — so the winner's pile is drawn without it until
   the sweep itself appends the sliver. */
function heldTrickNo(v) {
  const t = lastTrick(v);
  if (!t || v.phase !== "trickEnd") return null;
  return trickKey(v, t) === sweptKey ? null : t.no;
}

/* One card-shaped sliver per trick this seat took. Appended to, never rebuilt,
   and the rotation is derived from the trick number rather than drawn at random
   — a re-render must land every sliver back where it already was. */
function pileSliver(t) {
  const s = document.createElement("i");
  s.style.setProperty("--pr", ((t.no * 37) % 9 - 4) + "deg");
  s.title = `Trick ${t.no} · ${t.pts} pts`;
  return s;
}
function renderPile(pile, v, seat, heldNo) {
  const won = (v.tricks || []).filter(t => t.winner === seat && t.no !== heldNo);
  if (pile.childElementCount > won.length) pile.replaceChildren();   // a new deal
  for (let i = pile.childElementCount; i < won.length; i++) pile.appendChild(pileSliver(won[i]));
}

/* ---------- centre plaque ----------
   The middle of the felt is empty exactly while nothing is being played into
   it, so that is when it carries the phase. Plain text throughout: aria-hidden
   in the markup, because the action bar and the aria-live log already narrate
   all of it. */
function renderMedallion(v, o) {
  const med = $("medallion");
  let show = false, label = "", main = "", sub = "";
  if (v.phase === "bidding") {
    show = true; label = "AUCTION";
    main = v.highBid ? String(v.highBid) : "—";
    sub = v.highBid ? "held by " + o.seatInfo(v.highBidder).name : "no bid yet · minimum " + v.consts.MIN_BID;
  } else if (v.phase === "trumpSelect") {
    show = true; label = "BID WON"; main = String(v.bid);
    sub = o.seatInfo(v.declarer).name + " is choosing trump";
  } else if (v.phase === "partnerSelect") {
    show = true; label = "TRUMP NAMED"; main = String(v.bid);
    sub = o.seatInfo(v.declarer).name + " is calling a partner";
  } else if (v.phase === "playing" || v.phase === "trickEnd") {
    const done = v.tricksWon.reduce((a, b) => a + b, 0);
    show = true; label = "TRICK"; main = Math.min(13, done + 1) + " / 13";
    sub = o.seatInfo(v.turn).name + " leads";
  }
  med.querySelector(".med-label").textContent = label;
  med.querySelector(".med-main").textContent = main;
  med.querySelector(".med-sub").textContent = sub;
  /* Only while the middle is clear — a played card must never land on type.
     ui/layout.js owns the display of the whole plaque on a short felt, which is
     why that is an inline style there and this is the class. */
  med.classList.toggle("show", show && !v.trick.length);
}

/* ---------- the trick ---------- */
function renderTrick(v, o) {
  const box = $("trick");
  const keyOf = pl => pl.player + ":" + pl.card.suit + pl.card.rank;
  const keys = v.trick.map(keyOf);
  /* Reuse the nodes already on the felt so only the card just played animates
     in: rebuilding flew all four cards back in from their seats every time a
     chat message arrived. Anything that is not still a prefix of the trick —
     a sweep, a reconnect — is a new trick and goes. */
  const existing = Array.from(box.querySelectorAll(".trick-card"));
  const prefixOk = existing.length <= keys.length && existing.every((el, i) => el.dataset.k === keys[i]);
  if (!prefixOk) existing.forEach(el => el.remove());
  const cards = Array.from(box.querySelectorAll(".trick-card"));
  v.trick.forEach((play, i) => {
    let el = cards[i];
    if (!el) {
      el = cardEl(play.card);
      el.dataset.k = keys[i];
      el.classList.add("trick-card", "pos-" + o.posOf(play.player));
      // before #points-chip: the chip and the shower of chips are drawn over the trick
      box.insertBefore(el, $("points-chip"));
    }
    el.classList.toggle("winner", v.phase === "trickEnd" && i === v.lastWinnerSlot);
  });

  /* One card landing on top of what was already there is somebody playing;
     three appearing at once is a reconnect, and a silent one. */
  const changed = keys.length !== lastTrickKeys.length || keys.some((k, i) => k !== lastTrickKeys[i]);
  const played = keys.length === 1 ||
    (keys.length === lastTrickKeys.length + 1 && lastTrickKeys.every((k, i) => k === keys[i]));
  if (changed && played) sfx("play", v.trick[v.trick.length - 1].player === o.mySeat);
  lastTrickKeys = keys;
}

/* ---------- the trick-end beat ----------
   Won trick, points chip, a flash of felt and a shower of chips for a fat one,
   then the whole trick slides to the plate that took it. Keyed on the resolved
   trick so that a re-render arriving anywhere inside those 1.5 seconds does not
   start it again from the top. */
function trickBeat(v, o) {
  const t = lastTrick(v);
  const key = t ? trickKey(v, t) : null;
  if (key === beatKey) return;
  beatKey = key;
  clearBeat();
  // a fresh deal, or a state that arrived after the beat it describes was over
  if (!t || v.phase !== "trickEnd") return;

  const box = $("table").getBoundingClientRect();
  const [sx, sy] = sweepTo(o.posOf(t.winner), box.width, box.height);
  const wonN = v.tricks.filter(x => x.winner === t.winner).length;   // what the winner's pile owes once this trick lands

  if (t.pts) {
    const chip = $("points-chip");
    chip.textContent = "+" + t.pts;
    restart(chip, "show");
  }
  /* 20 of the 250 in one pull is where a trick stops being routine, so that is
     where the felt flashes and the trick gets its own sound. */
  if (t.pts >= 20) { restart($("flash"), "on"); sfx("big", t.winner === o.mySeat); }

  const chips = $("trick-chips");
  mintChips(t.pts).forEach((val, i) => {
    const n = i + 1;
    const c = document.createElement("div");
    c.className = "chip-fly" + (val === 30 ? " big" : "");
    c.textContent = String(val);
    c.style.setProperty("--tx", Math.round(sx * 0.82) + "px");
    c.style.setProperty("--ty", Math.round(sy * 0.82) + "px");
    c.style.setProperty("--cr", ((n * 67) % 200 - 60) + "deg");
    if (val === 30) c.style.setProperty("--sz", "28px");
    c.style.animationDelay = (n * 0.105).toFixed(3) + "s";
    chips.appendChild(c);
    after(40 + n * 105, () => sfx("chip"));
  });

  /* Long enough to read the four cards, short enough that the next lead follows
     it: the engine clears the trick at ~1s, so the slide has to have started. */
  after(780, () => {
    sfx("sweep");
    $("trick").querySelectorAll(".trick-card").forEach(el => {
      el.style.setProperty("--sx", Math.round(sx) + "px");
      el.style.setProperty("--sy", Math.round(sy) + "px");
      el.classList.add("sweeping");
    });
    /* The pile grows in the same frame the cards start travelling to it, which
       heldTrickNo() has been holding it back for. Counted rather than assumed:
       a reconnect can move the phase off trickEnd before this fires, and then a
       render has already paid the sliver this owes. */
    sweptKey = key;
    const pile = $("seat-" + POS_CLASS[o.posOf(t.winner)]).querySelector("[data-pile]");
    if (pile.childElementCount < wonN) pile.appendChild(pileSliver(t));
  });
  after(1500, clearBeat);
}

function renderTable(v, o) {
  const urgent = renderSeats(v, o);
  renderMedallion(v, o);
  renderTrick(v, o);
  trickBeat(v, o);
  /* The whole surface lifts while it is your move. .urgent is the clock's, and
     the clock lives in ui/layout.js — the only thing here that knows the
     server's idea of now — so the felt reads the ring it paints rather than
     keeping a second timer of its own. */
  const mine = o.mySeat != null && o.activeSeat === o.mySeat;
  const glow = $("turn-glow");
  glow.classList.toggle("on", mine);
  glow.classList.toggle("urgent", mine && urgent);
}

export { renderTable, resetTable };
