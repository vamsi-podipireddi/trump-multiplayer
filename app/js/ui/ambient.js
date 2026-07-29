/* ---------- the landing's cinematic ----------
   One lamp over the table, and the table itself just out of frame. Behind the
   join panels: the lamp breathes, a hand is dealt across the room and off the
   edges of it, and suit pips drift up through the light. It is the same room the
   felt is lit in — not a video, not a canvas, and nothing you can click.

   Three rules it keeps, so it costs nothing on a phone:
     · only transform-family properties and opacity animate, so every frame is
       composited and none of it reflows the join grid it sits behind;
     · the choreography is a fixed table, not Math.random() — the deal is a shot,
       and a shot that reshuffles itself on every load can't be timed;
     · nothing here runs under prefers-reduced-motion. The blanket rule in
       responsive.css flattens durations to .01ms, which is stillness for a
       one-shot and a strobe for a loop, so that query hides this layer outright.

   The pips are the same drawn paths the deck prints — ♠♥♦♣ as a font glyph is
   the one thing this design never does. */
import { SUIT_PATH } from "../cards/labels.js";

/* Where each card lands, in viewport units from the middle of the room, and how
   long it takes to get there. The delays are what make it a deal rather than a
   burst: at any moment two or three cards are in the air, and the cycle is long
   enough (12.5s) that you never catch the same card twice while reading a panel.
   `end`/`o` are the depth: a card that finishes larger is nearer the lamp, so it
   is also the brighter one — a single flat plane of cards reads as wallpaper. */
const DEAL = [
  { x: -36, y:  17, r: -26, dur: 10.5, delay: 0,   end: 1.15, o: .2  },
  { x:  33, y: -21, r:  22, dur: 11.5, delay: 1.6, end:  .82, o: .13 },
  { x: -27, y: -25, r: -14, dur:  9.5, delay: 3.2, end:  .92, o: .15 },
  { x:  38, y:  22, r:  31, dur: 12.5, delay: 4.6, end: 1.28, o: .22 },
  { x: -43, y:  -6, r: -35, dur: 11,   delay: 6.2, end: 1.05, o: .17 },
  { x:  27, y:  28, r:  12, dur: 10,   delay: 7.6, end: 1.34, o: .21 },
  { x:   7, y: -30, r:   8, dur: 12,   delay: 9,   end:  .78, o: .12 },
];
/* Pips rising through the lamp. Small, slow, and dim enough to read as dust in
   the light rather than as content — the largest is 22px at 17% opacity, and the
   nearer (bigger) ones are the brighter ones for the same reason the deal's are. */
const MOTES = [
  { x:  7, size: 18, dur: 27, delay:  0,  drift:  26, spin:  160, o: .15 },
  { x: 19, size: 12, dur: 34, delay:  5,  drift: -18, spin: -120, o: .11 },
  { x: 31, size: 22, dur: 24, delay: 11,  drift:  34, spin:  200, o: .17 },
  { x: 44, size: 14, dur: 31, delay:  2,  drift: -28, spin: -150, o: .12 },
  { x: 57, size: 19, dur: 28, delay: 15,  drift:  20, spin:  130, o: .16 },
  { x: 68, size: 13, dur: 36, delay:  7,  drift: -34, spin: -180, o: .11 },
  { x: 79, size: 20, dur: 25, delay: 19,  drift:  30, spin:  145, o: .16 },
  { x: 89, size: 15, dur: 33, delay:  3,  drift: -22, spin: -135, o: .12 },
  { x: 96, size: 12, dur: 29, delay: 13,  drift:  16, spin:  110, o: .1  },
];
const MOTE_SUITS = ["♠", "♥", "♦", "♣"];

function layer(cls, css) {
  const el = document.createElement("i");
  el.className = cls;
  if (css) el.setAttribute("style", css);
  return el;
}

/* The lamp and the felt take a few pixels off the pointer, so the room has a
   little depth on a desktop. Written to <body> rather than to the layer itself:
   .join-hero reads the same two numbers to lean the other way, and it lives
   outside this element. Pointer-driven, so it is skipped on touch — where there
   is no pointer to drive it — and under reduced motion. */
function initParallax() {
  if (!matchMedia("(hover:hover) and (pointer:fine)").matches) return;
  if (matchMedia("(prefers-reduced-motion:reduce)").matches) return;
  let raf = 0, px = 0, py = 0;
  addEventListener("pointermove", (e) => {
    px = (e.clientX / innerWidth - .5) * 2;
    py = (e.clientY / innerHeight - .5) * 2;
    /* One write per frame at most: pointermove fires far faster than the
       compositor can use, and each write invalidates every rule that reads it. */
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      document.body.style.setProperty("--px", px.toFixed(3));
      document.body.style.setProperty("--py", py.toFixed(3));
    });
  }, { passive: true });
}

/* Fills the (empty, aria-hidden) element the page reserves for it. Idempotent:
   a second call on a layer that is already lit is a no-op, not a second deal. */
function startAmbient(root) {
  if (!root || root.dataset.lit) return;
  root.dataset.lit = "1";

  root.appendChild(layer("fx-lamp"));
  root.appendChild(layer("fx-felt"));

  const deal = document.createElement("div");
  deal.className = "fx-deal";
  for (const c of DEAL)
    deal.appendChild(layer("fx-card",
      `--dx:${c.x}vw;--dy:${c.y}vh;--r:${c.r}deg;--dur:${c.dur}s;--d:${c.delay}s;--s:${c.end};--o:${c.o}`));
  root.appendChild(deal);

  MOTES.forEach((m, i) => {
    const el = layer("fx-mote",
      `--x:${m.x}vw;--sz:${m.size}px;--dur:${m.dur}s;--d:${m.delay}s;--dx:${m.drift}px;--r:${m.spin}deg;--o:${m.o}`);
    // fixed table in, fixed table out — no interpolation of anything a user typed
    el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="${SUIT_PATH[MOTE_SUITS[i % MOTE_SUITS.length]]}"/></svg>`;
    root.appendChild(el);
  });

  initParallax();
}

export { startAmbient, DEAL, MOTES };
