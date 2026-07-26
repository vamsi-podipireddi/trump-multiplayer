"use strict";
/* ============================================================
   PWA + accessibility contract.

   The install prompt, the offline fallback and the keyboard path are all
   things nobody notices breaking until a user reports it. These assert
   the pieces exist and agree with each other: manifest ↔ icons on disk,
   service-worker precache ↔ real files, client ↔ manifest/sw wiring.
   ============================================================ */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "public");
const read = p => fs.readFileSync(path.join(PUB, p), "utf8");
const CLIENT = read("index.html");
const SW = read("sw.js");
const MANIFEST = JSON.parse(read("manifest.webmanifest"));

/* PNG header: width/height live at bytes 16..24 of a well-formed file. */
function pngSize(file) {
  const b = fs.readFileSync(path.join(PUB, file));
  assert.deepStrictEqual([...b.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test("manifest is installable: required fields + icons that exist at the declared size", () => {
  for (const f of ["name", "short_name", "start_url", "scope", "display", "background_color", "theme_color", "icons"])
    assert.ok(MANIFEST[f], `manifest is missing ${f}`);
  assert.strictEqual(MANIFEST.display, "standalone");
  assert.ok(MANIFEST.icons.length >= 2);
  for (const icon of MANIFEST.icons) {
    const [w, h] = icon.sizes.split("x").map(Number);
    const got = pngSize(icon.src.replace(/^\//, ""));
    assert.deepStrictEqual(got, { w, h }, `${icon.src} is ${got.w}x${got.h}, manifest says ${icon.sizes}`);
  }
  assert.ok(MANIFEST.icons.some(i => i.purpose === "maskable"), "need a maskable icon for adaptive launchers");
  for (const s of MANIFEST.shortcuts || [])
    assert.ok(fs.existsSync(path.join(PUB, s.url.replace(/^\//, ""))), `shortcut target ${s.url} does not exist`);
});

test("service worker precaches only files that exist, and never caches the live endpoints", () => {
  const shell = (SW.match(/const SHELL = \[([\s\S]*?)\];/) || [, ""])[1].match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  for (const url of shell) {
    if (url === "/") continue; // served as index.html
    assert.ok(fs.existsSync(path.join(PUB, url.replace(/^\//, ""))), `sw precaches missing file ${url}`);
  }
  assert.ok(shell.includes("/solo.html"), "offline fallback must be precached");
  for (const live of ["/ws", "/health", "/stats"])
    assert.ok(new RegExp(`"${live}"`).test(SW.match(/const NEVER = \[[^\]]*\]/)[0]), `${live} must bypass the cache`);
  assert.ok(/req\.method !== "GET"/.test(SW), "sw must ignore non-GET");
  assert.ok(/origin !== self\.location\.origin/.test(SW), "sw must ignore cross-origin requests");
});

test("offline fallback is the untouched root single-player game (D12)", () => {
  const rootGame = fs.readFileSync(path.join(ROOT, "index.html"));
  const solo = fs.readFileSync(path.join(PUB, "solo.html"));
  assert.ok(rootGame.equals(solo), "public/solo.html must stay a byte-identical copy of the root offline game");
  assert.ok(!solo.includes("/ws?room="), "the offline build must not need a server");
});

test("client wires up the PWA and the share affordances", () => {
  assert.ok(/rel="manifest" href="\/manifest\.webmanifest"/.test(CLIENT), "manifest not linked");
  assert.ok(/serviceWorker.*register\("\/sw\.js"\)/s.test(CLIENT), "service worker not registered");
  assert.ok(/location\.protocol === "https:" \|\| location\.hostname === "localhost"/.test(CLIENT),
    "registration should be skipped on plain-http hosts where it would throw");
  assert.ok(/property="og:title"/.test(CLIENT) && /property="og:description"/.test(CLIENT), "OpenGraph tags missing");
  assert.ok(/name="theme-color"/.test(CLIENT), "theme-color missing");
  assert.ok(/navigator\.share/.test(CLIENT) && /clipboard\.writeText/.test(CLIENT), "share/copy affordances missing");
});

test("accessibility: keyboard-reachable cards, labelled controls, live regions", () => {
  assert.ok(/createElement\(asButton \? "button" : "div"\)/.test(CLIENT), "hand cards must be real buttons");
  assert.ok(/cardEl\(card, true\)/.test(CLIENT), "the hand must build its cards as buttons");
  assert.ok(/setAttribute\("aria-label", label\)/.test(CLIENT), "hand cards need aria-labels");
  assert.ok(/RANK_NAME/.test(CLIENT) && /SUIT_NAME/.test(CLIENT), "labels should spell out rank and suit");
  assert.ok(/id="log" role="log" aria-live="polite"/.test(CLIENT), "table log must be a polite live region");
  assert.ok(/id="chat-log" aria-live="polite"/.test(CLIENT), "chat must be a polite live region");
  assert.ok(/:focus-visible/.test(CLIENT), "focus styling missing");
  assert.ok(/body\.fourcolor .card\.s-d/.test(CLIENT) && /localStorage\.setItem\("trump_4color"/.test(CLIENT),
    "4-colour deck toggle must exist and persist");
  // suit colours must be class-driven, otherwise the 4-colour deck can't override them
  assert.ok(!/style="color:\$\{RED\.has/.test(CLIENT), "suit colours must come from CSS classes, not inline styles");
});

test("mobile: the sidebar survives as a bottom sheet instead of being hidden", () => {
  assert.ok(/id="sheet-tabs"/.test(CLIENT), "no mobile tab bar");
  for (const tab of ["score", "log", "chat"])
    assert.ok(new RegExp(`data-tab="${tab}"`).test(CLIENT), `mobile tab "${tab}" missing`);
  assert.ok(!/@media \(max-width:900px\)[^}]*aside \{ display:none/.test(CLIENT),
    "the sidebar must not be display:none on mobile — that drops score/log/chat");
  // every interactive control should clear the 40px touch-target floor somewhere in its rules
  for (const sel of [".act-btn", ".mini-btn", "#sheet-tabs button", ".emote-btn", "#chat-input"])
    assert.ok(new RegExp(`${sel.replace(/[.#*]/g, m => "\\" + m)}[^}]*min-height:(4[0-9]|[5-9][0-9])px`).test(CLIENT),
      `${sel} has no >=40px touch target`);
});

test("iOS/iPad: dynamic viewport, safe areas, and touch-only pointers are handled", () => {
  // 100vh alone hides the action bar behind Safari's toolbars
  assert.ok(/#game \{ height:100vh; height:100dvh;/.test(CLIENT), "#game must fall back 100vh -> 100dvh");
  assert.ok(!/height:min\(\d+vh,/.test(CLIENT), "sheet heights should use dvh too");

  // notch / home indicator
  for (const sel of ["header", "#awaybar", "#conn", "#sheet-tabs"])
    assert.ok(new RegExp(`${sel.replace(/[.#]/g, m => "\\" + m)} \\{[^}]*env\\(safe-area-inset`).test(CLIENT),
      `${sel} ignores the safe-area inset it overlaps`);
  assert.ok(/bottom:calc\(46px \+ env\(safe-area-inset-bottom\) \+ var\(--kb\)\)/.test(CLIENT),
    "the sheet must clear the tab bar, the home indicator and the keyboard");
  assert.ok(/#bottom \{ padding-bottom:calc\(52px \+ env\(safe-area-inset-bottom\)\)/.test(CLIENT),
    "the hand must clear the home indicator");

  // iPad sits above the 900px phone breakpoint but is still touch-only
  assert.ok(/@media \(pointer:coarse\) \{/.test(CLIENT), "no coarse-pointer sizing for tablets");
  const coarse = CLIENT.match(/@media \(pointer:coarse\) \{([\s\S]*?)\n  \}/)[1];
  for (const sel of ["header button", ".mini-btn, .segbtn", ".emote-btn", "#chat-input"])
    assert.ok(new RegExp(`${sel.replace(/[.#]/g, m => "\\" + m)}[^}]*min-(height|width):(4[4-9]|[5-9][0-9])px`).test(coarse),
      `${sel} stays under 44px on touch devices wider than 900px`);

  // sticky :hover after a tap is an iOS classic
  assert.ok(/@media \(hover:hover\) \{ #my-hand \.card\.playable:hover/.test(CLIENT),
    "the card lift must be gated behind hover:hover");
  assert.ok(!/^\s*\.emote-btn:hover/m.test(CLIENT) && !/^\s*\.btn:hover/m.test(CLIENT),
    "hover effects must not apply on touch-only devices");

  assert.ok(/touch-action:manipulation/.test(CLIENT), "taps should not wait for double-tap zoom");
  assert.ok(/-webkit-text-size-adjust:100%/.test(CLIENT), "rotation must not inflate text on iOS");
  assert.ok(/visualViewport/.test(CLIENT), "the on-screen keyboard must not cover the chat sheet");
});
