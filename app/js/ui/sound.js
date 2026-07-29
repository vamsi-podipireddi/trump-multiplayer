/* Table sound: a small synth kit, so the table carries no audio assets — no
   files to download, nothing to 404 offline, and every cue stays in one voice.
   Everything here is built from oscillators and one noise buffer. */
import { $ } from "../util/dom.js";
import { icon } from "../cards/icons.js";
import { getPref, setPref } from "../util/prefs.js";

const KEY = "trump_sound";

let ctx, master, nb;
let enabled = null;   // null until the stored pref is read — module load must not touch storage

/* The kit. Each cue is handed the three synthesis primitives built below, so
   the numbers (and only the numbers) live here. */
const KIT = {
  deal:   (tone, air)        => air(0, .085, 2900, 780, .085, 1.1),
  play:   (tone, air)        => { air(0, .085, 2100, 460, .13, 1.6); tone(165, .006, .002, .075, .05, "triangle"); },
  sweep:  (tone, air)        => air(0, .42, 1600, 240, .1, .8),
  big:    (tone, air)        => { air(0, .11, 2500, 300, .16, 1.4); tone(110, .012, .003, .3, .065, "triangle"); },
  chip:   (tone)             => { tone(1245, 0, .002, .15, .06, "triangle"); tone(1868, .012, .002, .09, .028); },
  click:  (tone)             => tone(700, 0, .001, .035, .045, "square"),
  bid:    (tone)             => { tone(392, 0, .004, .13, .06, "triangle"); tone(587, .055, .004, .16, .05, "triangle"); },
  pass:   (tone)             => tone(300, 0, .005, .16, .05, "triangle", 185),
  trump:  (tone, air, chord) => chord([392, 494, 587], .05, .42, .045),
  reveal: (tone, air, chord) => { chord([261.6, 329.6, 392, 523.3], .11, .95, .05); air(.06, .55, 800, 3400, .045, .7); },
  made:   (tone, air, chord) => chord([523.3, 659.3, 784, 1046.5], .075, .5, .055),
  set:    (tone, air, chord) => chord([392, 349.2, 293.7, 233.1], .085, .5, .055),
  win:    (tone, air, chord) => { chord([523.3, 659.3, 784, 1046.5, 1318.5], .09, .75, .055); air(.1, .7, 1200, 4000, .04, .6); },
  tick:   (tone)             => tone(1500, 0, .001, .03, .035, "square"),
};

/* Created on the first cue, never at load: constructing an AudioContext before
   a gesture leaves a suspended context (and a console warning) on every tab
   that never plays a sound, and there is no `window` at all under Node. */
function audio() {
  if (ctx === undefined) {
    try {
      const C = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
      ctx = C ? new C() : null;
    } catch { ctx = null; }
    if (ctx) { master = ctx.createGain(); master.gain.value = .5; master.connect(ctx.destination); }
  }
  // resume() rejects rather than throws when the browser has seen no gesture
  // yet, and an unhandled rejection would surface as an error on a silent tab
  if (ctx && ctx.state === "suspended") { try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch {} }
  return ctx;
}
/* One 0.6s buffer of gently decaying noise, reused by every `air` — this is the
   card-on-felt sound, and allocating it per cue would garbage the audio thread. */
function noiseBuf(ac) {
  if (!nb) {
    const n = Math.floor(ac.sampleRate * .6), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n * .35);
    nb = b;
  }
  return nb;
}
function buzz(ms) { try { if (typeof navigator !== "undefined" && navigator.vibrate && soundOn()) navigator.vibrate(ms); } catch {} }

function paintSoundBtn(on) {
  const b = $("btn-sound"); if (!b) return;
  b.dataset.ic = on ? "sound" : "mute";
  b.setAttribute("aria-pressed", String(on));
  const svg = b.querySelector("svg.ic");
  if (svg) svg.outerHTML = icon(b.dataset.ic);
  // claim paintIcons()' slot, so its one-shot pass can't add a second glyph
  else { b.insertAdjacentHTML("afterbegin", icon(b.dataset.ic)); b._ic = true; }
}

function soundOn() {
  if (enabled === null) enabled = getPref(KEY, "1") !== "0";
  return enabled;
}
/* Boot: reflect the stored choice on the button. No AudioContext yet — that
   waits for a cue, which by then is downstream of a tap. */
function initSound() { paintSoundBtn(soundOn()); return soundOn(); }

function toggleSound() {
  enabled = !soundOn();
  setPref(KEY, enabled ? "1" : "0");
  paintSoundBtn(enabled);
  // the un-mute tap is itself the gesture that lets the context start, so spend
  // it: sfx() creates and resumes, and the chip confirms it actually worked
  if (enabled) sfx("chip");
  return enabled;
}

/* `mine` marks a cue you caused yourself. The haptic is only worth it then —
   a buzz on all four cards of every trick is noise — and sfx() has no other way
   to tell your card from a bot's. */
function sfx(name, mine) {
  if (!soundOn()) return;
  const cue = KIT[name]; if (!cue) return;
  const ac = audio(); if (!ac) return;
  const t0 = ac.currentTime, out = master;
  const tone = (f, off, a, d, peak, type, f2) => {
    const t = t0 + off, os = ac.createOscillator(), gn = ac.createGain();
    os.type = type || "sine"; os.frequency.setValueAtTime(f, t);
    if (f2) os.frequency.exponentialRampToValueAtTime(f2, t + a + d);
    gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(peak, t + a); gn.gain.exponentialRampToValueAtTime(.0001, t + a + d);
    os.connect(gn); gn.connect(out); os.start(t); os.stop(t + a + d + .06);
  };
  const air = (off, dur, f0, f1, peak, q) => {
    const t = t0 + off, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), gn = ac.createGain();
    src.buffer = noiseBuf(ac); bp.type = "bandpass"; bp.Q.value = q || 1.2;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    gn.gain.setValueAtTime(0, t); gn.gain.linearRampToValueAtTime(peak, t + .007); gn.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(bp); bp.connect(gn); gn.connect(out); src.start(t); src.stop(t + dur + .06);
  };
  const chord = (fs, step, dur, peak) => fs.forEach((f, i) => tone(f, i * step, .008, dur, peak, "triangle"));
  cue(tone, air, chord);
  if (name === "play" && mine) buzz(12);
  else if (name === "big") buzz(mine ? [18, 40, 26] : 14);
}

export { initSound, toggleSound, soundOn, sfx };
