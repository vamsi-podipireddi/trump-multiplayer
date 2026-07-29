import { $ } from "../util/dom.js";
import { fitHand } from "./hand.js";
import { sfx } from "./sound.js";

/* The felt has no intrinsic size — it is whatever the grid leaves between the
   header and the hand — so the three things that have to clear each other on it
   cannot be expressed in the stylesheet: the trick has to stay inside the ring
   of seats, the seats have to stay off the raised action tray, and all of it has
   to survive a 115px landscape-phone felt. Measure the slab once per render and
   hand the stylesheet the numbers; every property that consumes one of these is
   in table.css. */
function fitTable() {
  const t = $("table");
  if (!t) return;
  const box = t.getBoundingClientRect();
  const tblW = box.width, tblH = box.height;
  if (!tblW || !tblH) return;                       // #game is display:none until the match starts

  /* Matches the 900px breakpoint in responsive.css rather than re-measuring the
     card, because the card sizes are what that breakpoint sets. */
  const compact = innerWidth < 900;
  const shortFelt = tblH < 300;

  /* A card on the felt is sized against the card in your hand — responsive.css
     moves --cardw per breakpoint and per pointer, and a second copy of those
     numbers here is how the two drift apart — then capped by the slab itself,
     so a 380px felt and a 1600px one both look like the same table. */
  const cardW = parseFloat(getComputedStyle(t).getPropertyValue("--cardw")) || 92;
  const trkW = Math.round(Math.max(40, Math.min(cardW * 1.05, tblW * 0.16, tblH * (shortFelt ? 0.24 : 0.28))));
  const trkH = Math.round(trkW * 1.4);

  /* ---- the trick, as a symmetric cross ----
     Four cards on one circle about the middle of the felt, at the radius that
     puts each one's corner just over its neighbour's: the reach is a property
     of the *card*, not of the felt, or the same trick reads as a tight cross on
     one window and four scattered cards on the next. Because a card is taller
     than it is wide these two numbers differ, and that difference is the whole
     point — measured in pixels the ring is very nearly round.

     The felt only ever *takes room away*: each axis is the ideal or what fits,
     whichever is smaller. Scaling both by one factor instead would keep the
     shape perfect and collapse the whole trick into a 50px pile on a landscape
     phone, where the width was never the problem. The subtrahends are the room
     the seats themselves take — a nameplate plus its pile is ~230px wide on a
     desktop and ~88px on a phone, and ~74px tall. */
  const roomX = tblW / 2 - trkW / 2 - (compact ? 88 : 230);
  const roomY = tblH / 2 - trkH / 2 - (shortFelt ? 56 : compact ? 54 : 74);
  const reachX = Math.max(26, Math.round(Math.min(trkW * 0.92, roomX)));
  const reachY = Math.max(20, Math.round(Math.min(trkH * 0.68, roomY)));
  const seatScale = Math.max(0.7, Math.min(compact ? 0.88 : 1, tblW / 470));

  /* Somebody else's hand and the pile in front of them are the same object at
     two removes, so both scale off the card on the felt rather than sitting at
     a fixed px that looks right on exactly one screen. */
  const backW = Math.max(9, Math.round(trkW * 0.22));
  const pileW = Math.max(8, Math.round(trkW * 0.19));

  /* The tray is out of flow (it hangs off the top of #hand-block), so it takes no
     grid height and the felt does not know it is there — the south seat would sit
     under it. Only measure it while it is actually shown. */
  const tray = $("action-tray");
  const rawLift = tray && tray.classList.contains("show") ? tray.offsetHeight : 0;
  /* Lift your own plate clear of the tray only as far as the felt can spare it.
     A tall felt steps the whole seat above the tray; a landscape phone's 130px
     one cannot, and lifting there would have parked your nameplate above the
     felt's top edge — so there the tray simply owns the bottom of the felt, and
     the plate stays on it. 240 is the room the trick cross and the north seat
     need between them once the plate has moved. */
  const trayLift = Math.max(0, Math.min(rawLift, Math.round(tblH - 240)));

  t.style.setProperty("--trickw", trkW + "px");
  t.style.setProperty("--trickh", trkH + "px");
  t.style.setProperty("--reach-x", Math.round(reachX) + "px");
  t.style.setProperty("--reach-y", Math.round(reachY) + "px");
  t.style.setProperty("--seat-scale", seatScale.toFixed(2));
  t.style.setProperty("--tray-lift", trayLift + "px");
  t.style.setProperty("--backw", backW + "px");
  t.style.setProperty("--backh", Math.round(backW * 1.45) + "px");
  t.style.setProperty("--pilew", pileW + "px");
  t.style.setProperty("--pileh", Math.round(pileW * 1.4) + "px");

  const med = $("medallion");
  if (med) {
    med.classList.toggle("tight", tblH < 200);
    /* Below this the tray owns the bottom of the felt and the plaque would land on
       the trick. Nothing is lost: the number it shows is already in the contract
       rail and in the prompt. Inline display, not the .show class — that class is
       renderTable()'s to own, and a resize must be able to bring the plaque back
       without a re-render. */
    med.style.display = tblH - trayLift < 200 ? "none" : "";
  }
}
/* Registers the resize listener. Wrapped in a function (rather than run at module
   load) so this file can still be `import()`-ed under Node with no DOM — see
   test/client-modules.test.js. Called once from main.js/solo.js at boot. */
function initResize() {
  /* both fits are measured, so a resize has to re-measure them */
  addEventListener("resize", () => { const w = $("my-hand"); if (w && w.children.length) fitHand(w); fitTable(); });
}

/* ---------- live countdowns ----------
   The deadlines are absolute ms, but on whose clock differs — the room's timers are
   server ms, solo's are plain Date.now() — so the reading is the caller's to supply
   along with the view rather than this module's to fetch. */
let ringEl = null, tickHandle = null, chimedFor = null;
/* renderTable() points this at the on-clock seat's avatar on every render, or
   clears it to null. ringEl itself stays module-private — this setter is the only
   way in from outside, so nothing but tickTimers() below ever reads it. */
function setRingEl(el) { ringEl = el; }
/* The turn clock drawn as the header's own top edge. Exported for completeness,
   but tickTimers() is what actually drives it — see below. */
function setTurnBar(pct, urgent) {
  const b = $("turn-bar");
  if (!b) return;
  b.style.width = (Math.max(0, Math.min(1, pct || 0)) * 100).toFixed(1) + "%";
  b.classList.toggle("urgent", !!urgent);
}
function tickTimers(view, now) {
  if (!view) return;                                // ticks start at boot, the first view lands later
  const deadline = view.turnDeadline;
  let frac = 0, urgent = false;
  /* ringEl is null unless a human is on the clock, which is also the only time
     there is anything to count down — a bot's think-time is not a deadline. */
  if (ringEl && deadline != null) {
    const total = (view.settings?.turnTimerSec || 45) * 1000;
    const left = Math.max(0, deadline - now);
    frac = Math.max(0, Math.min(1, left / total));
    urgent = left <= 10000;
    ringEl.style.setProperty("--p", String(frac));
    ringEl.classList.toggle("urgent", urgent);
    ringEl.title = `${Math.ceil(left / 1000)}s left`;
  }
  /* The design chimes on each of the last five seconds (TRUMP.dc.html:902), but
     this clock is polled four times a second, so that rule literally applied would
     fire four ticks a second. One chime as the clock turns urgent is the same
     warning, delivered once. The latch is the deadline itself, so the next turn's
     clock — any change of deadline — re-arms it without a separate reset. */
  if (urgent && chimedFor !== deadline) { chimedFor = deadline; sfx("tick"); }
  /* The bar and the ring are one clock drawn twice, so they are filled from one
     computation on one tick — updating the bar from the renderer instead let it
     sit a phase behind the ring it is meant to agree with. */
  setTurnBar(frac, urgent);
  /* Not in the page markup: the auto-advance countdown belongs to whichever panel
     is currently offering "ready", so the lookup has to happen per tick. */
  const rc = $("ready-count");
  if (rc && view.roundDeadline != null) rc.textContent = `${Math.max(0, Math.ceil((view.roundDeadline - now) / 1000))}s`;
}
/* Wrapped rather than run at module load, same reason as initResize() above.
   Thunks, not values: both clients replace the view object wholesale on every
   update, so a view captured at boot would be a clock frozen at deal one. */
function startTicking(getView, getNow) {
  if (tickHandle) clearInterval(tickHandle);        // a second call re-arms the clock, it does not add a second one
  tickHandle = setInterval(() => tickTimers(getView(), getNow()), 250);
}

export { fitTable, tickTimers, startTicking, setRingEl, initResize, setTurnBar };
