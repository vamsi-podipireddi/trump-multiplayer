import { S } from "../session.js";
import { $ } from "../util/dom.js";
import { serverNow } from "../net.js";
import { fitHand } from "./hand.js";

/* The trick cross is laid out in fixed pixels — cards 88px tall at ±118px — while the
   felt scales with the viewport. On a short felt the cross runs into the seats and
   leaves no clear band for the contract strip (110px of clearance on a desktop felt,
   22px on a phone's), so scale the cross to what the felt can actually hold and put
   the strip in what remains. */
function fitTable() {
  const t = $("table");
  const h = t ? t.getBoundingClientRect().height : 0;
  if (!h) return;
  /* How far the cross reaches below centre is (radius + half a card), and both
     halve at the phone breakpoint — so measure them rather than keeping a second
     copy of the numbers the stylesheet already owns. */
  const tr = $("trick");
  const probe = tr.querySelector(".card");
  const reach = (parseFloat(getComputedStyle(tr).getPropertyValue("--reach-y")) || 47)
              + (probe ? probe.offsetHeight : 93) / 2;
  const s = Math.max(0.6, Math.min(1, (h / 2 - 108) / reach));
  t.style.setProperty("--trick-scale", s.toFixed(3));
  const bandTop = h / 2 + reach * s, bandBottom = h - 66;      // south seat starts ~66px off the bottom
  t.style.setProperty("--strip-top", Math.round((bandTop + bandBottom) / 2) + "px");
}
/* Registers the resize listener. Wrapped in a function (rather than run at module
   load) so this file can still be `import()`-ed under Node with no DOM — see
   test/client-modules.test.js. Called once from index.html at boot. */
function initResize() {
  /* both fits are measured, so a resize has to re-measure them */
  addEventListener("resize", () => { const w = $("my-hand"); if (w && w.children.length) fitHand(w); fitTable(); });
}

// ---------- live countdowns (deadlines are absolute server ms) ----------
let ringEl = null, tickHandle = null;
/* renderGame() (index.html) points this at the on-clock seat's avatar on every
   render, or clears it to null. ringEl itself stays module-private — this setter
   is the only way in from outside, so nothing but tickTimers() below ever reads it. */
function setRingEl(el) { ringEl = el; }
function tickTimers() {
  if (!S.view || !S.view.room.started) return;
  const now = serverNow();
  if (ringEl && S.view.turnDeadline != null) {
    const total = (S.view.settings.turnTimerSec || 45) * 1000;
    const left = Math.max(0, S.view.turnDeadline - now);
    ringEl.style.setProperty("--p", String(Math.max(0, Math.min(1, left / total))));
    ringEl.classList.toggle("urgent", left <= 10000);
    ringEl.title = `${Math.ceil(left / 1000)}s left`;
  }
  const rc = $("ready-count");
  if (rc && S.view.roundDeadline != null) rc.textContent = `${Math.max(0, Math.ceil((S.view.roundDeadline - now) / 1000))}s`;
}
/* Wrapped rather than run at module load, same reason as initResize() above. */
function startTicking() {
  tickHandle = setInterval(tickTimers, 250);
}

export { fitTable, tickTimers, startTicking, setRingEl, initResize };
