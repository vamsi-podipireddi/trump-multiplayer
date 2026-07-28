/* ============================================================
   PWA + accessibility contract.

   The install prompt, the offline fallback and the keyboard path are all
   things nobody notices breaking until a user reports it. These assert
   the pieces exist and agree with each other: manifest ↔ icons on disk,
   service-worker precache ↔ real files, client ↔ manifest/sw wiring.
   ============================================================ */
import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../scripts/build-assets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PUB = path.join(ROOT, "app");
const read = p => fs.readFileSync(path.join(PUB, p), "utf8");
// The client is index.html plus its leaf modules under app/js/ (core/ is the
// engine, not client code — same split client.test.js uses). Several checks
// below scan CLIENT as text for symbols (cardEl, RANK_NAME, ...) that now live
// in those modules instead of inline.
const jsFiles = (function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
})(path.join(PUB, "js"))
  .filter(f => f.endsWith(".js") && !f.includes(`${path.sep}core${path.sep}`));
const CLIENT = [read("index.html"), ...jsFiles.map(f => fs.readFileSync(f, "utf8"))].join("\n");
const SW = read("sw.js");
const MANIFEST = JSON.parse(read("manifest.webmanifest"));

/* PNG header: width/height live at bytes 16..24 of a well-formed file. */
function pngSize(file) {
  const b = fs.readFileSync(path.join(PUB, file));
  assert.deepStrictEqual([...b.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ---- a small stylesheet reader ----
   The layout assertions below used to be regexes over the raw CSS
   (`/#game \{ height:100vh; height:100dvh;/` and friends). That pins
   formatting rather than behaviour: reformatting the file broke the build,
   while a genuinely wrong value still sailed through. Read the declarations
   and assert on what they mean instead. */
const CSS = (CLIENT.match(/<style>([\s\S]*?)<\/style>/) || [, ""])[1].replace(/\/\*[\s\S]*?\*\//g, "");

function rules(css) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
    out.push({ sels: m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).filter(Boolean), body: m[2] });
  return out;
}
/* Every value any matching rule declares for `prop` (repeats are fallbacks). */
function declared(css, sel, prop) {
  const out = [];
  for (const r of rules(css)) {
    if (!r.sels.includes(sel)) continue;
    for (const d of r.body.split(";")) {
      const i = d.indexOf(":");
      if (i > 0 && d.slice(0, i).trim() === prop) out.push(d.slice(i + 1).trim());
    }
  }
  return out;
}
/* Every @media block matching `query` concatenated, plus the stylesheet with
   them removed — the client declares several blocks per query, so picking only
   the first one silently skips most of what it should be checking. */
function splitMedia(css, query) {
  const pat = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:/g, "\\s*:\\s*");
  const re = new RegExp("@media\\s*" + pat, "g");
  let inside = "", outside = "", i = 0, m;
  while ((m = re.exec(css))) {
    if (m.index < i) continue;
    outside += css.slice(i, m.index);
    let depth = 0, j = css.indexOf("{", m.index);
    const start = j + 1;
    for (; j < css.length; j++) { if (css[j] === "{") depth++; else if (css[j] === "}" && --depth === 0) break; }
    inside += css.slice(start, j) + "\n";
    i = j + 1;
    re.lastIndex = i;
  }
  outside += css.slice(i);
  assert.ok(inside, `no @media ${query} block`);
  return { inside, outside };
}
const mediaBlock = (css, query) => splitMedia(css, query).inside;
const pxOf = v => { const m = /(-?[\d.]+)px/.exec(v); return m ? parseFloat(m[1]) : NaN; };
/* The min-height that actually wins for `sel` in a given context, given
   stylesheet fragments in source order — at equal specificity the last
   declaration wins. Asking "does any rule anywhere declare >= 40px" would pass
   a control that a later rule shrinks; asking for the minimum would fail a
   button that is deliberately small on desktop and grown for touch. Only the
   effective value per context answers the question the floor is about. */
function touchSize(sel, ...fragments) {
  let val = NaN;
  for (const frag of fragments)
    for (const v of declared(frag, sel, "min-height")) { const n = pxOf(v); if (!Number.isNaN(n)) val = n; }
  return val;
}
/* base = neither responsive block; they are layered back on per context. */
const PHONE = splitMedia(CSS, "(max-width:900px)").inside;
const COARSE = splitMedia(CSS, "(pointer:coarse)").inside;
const BASE = splitMedia(splitMedia(CSS, "(max-width:900px)").outside, "(pointer:coarse)").outside;

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
  assert.ok(rootGame.equals(solo), "app/solo.html must stay a byte-identical copy of the root offline game");
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
  const phone = mediaBlock(CSS, "(max-width:900px)");
  assert.ok(!declared(phone, "aside", "display").includes("none"),
    "the sidebar must not be display:none on mobile — that drops score/log/chat");
  // every interactive control clears the 40px touch-target floor at phone width
  for (const sel of [".act-btn", ".mini-btn", "#sheet-tabs button", ".emote-btn", "#chat-input"]) {
    const size = touchSize(sel, BASE, PHONE);
    assert.ok(size >= 40, `${sel} is ${size}px at phone width, under the 40px floor`);
  }
});

/* Regression pin. #game has three row children — header, #table-wrap, #bottom — and
   #bottom carries an explicit grid-column. With only two declared rows it was
   auto-placed into an unsized implicit third row *after* 1fr had taken the height,
   so the hand overflowed 100dvh and body{overflow:hidden} clipped it. The phone
   block always declared three rows, which is why only desktop showed it. */
test("the game grid declares a row for every row child, and the sidebar spans them", () => {
  const tracks = (v) => v.trim().split(/\s+(?![^(]*\))/).length;   // splits on spaces outside ()
  const rowDecls = declared(BASE, "#game", "grid-template-rows");
  assert.ok(rowDecls.length, "#game declares no grid-template-rows");
  assert.equal(tracks(rowDecls[rowDecls.length - 1]), 3,
    `#game must declare 3 rows for header/table/bottom (declares "${rowDecls[rowDecls.length - 1]}")`);

  const phoneRows = declared(mediaBlock(CSS, "(max-width:900px)"), "#game", "grid-template-rows");
  assert.equal(tracks(phoneRows[phoneRows.length - 1]), 3, "the phone grid must keep its three rows");

  const asideRow = declared(BASE, "aside", "grid-row");
  assert.ok(asideRow.length, "aside declares no grid-row");
  assert.match(asideRow[asideRow.length - 1].trim(), /\/\s*4$/,
    `the sidebar must span to the end of the third row (declares "${asideRow[asideRow.length - 1]}")`);
});

test("iOS/iPad: dynamic viewport, safe areas, and touch-only pointers are handled", () => {
  // 100vh alone hides the action bar behind Safari's toolbars; dvh must win
  const gameH = declared(CSS, "#game", "height");
  assert.ok(gameH.length >= 2 && /dvh/.test(gameH[gameH.length - 1]),
    `#game must end on a dvh height (declares ${JSON.stringify(gameH)})`);
  assert.ok(!/height:\s*min\(\s*\d+vh/.test(CSS), "sheet heights should use dvh too");

  // anything pinned to a screen edge has to respect the notch / home indicator
  for (const [sel, prop] of [["header", "padding"], ["#awaybar", "padding"],
                             ["#conn", "padding"], ["#sheet-tabs", "padding-bottom"]]) {
    const vals = rules(CSS).filter(r => r.sels.includes(sel)).map(r => r.body).join(";");
    assert.ok(/env\(\s*safe-area-inset/.test(vals),
      `${sel} ignores the safe-area inset it overlaps (checked ${prop} and friends)`);
  }
  const sheetBottom = declared(mediaBlock(CSS, "(max-width:900px)"), "aside", "bottom").join(" ");
  for (const need of ["safe-area-inset-bottom", "--kb"])
    assert.ok(sheetBottom.includes(need),
      `the sheet must clear ${need} as well as the tab bar (bottom: ${sheetBottom})`);
  assert.ok(declared(CSS, "#bottom", "padding-bottom").join(" ").includes("safe-area-inset-bottom"),
    "the hand must clear the home indicator");

  // iPad sits above the 900px phone breakpoint but is still touch-only
  for (const sel of ["header button", ".mini-btn", ".segbtn", ".emote-btn", "#chat-input"]) {
    const size = touchSize(sel, BASE, COARSE);
    assert.ok(size >= 44, `${sel} is ${size}px on touch devices wider than 900px, under Apple's 44px`);
  }

  // sticky :hover after a tap is an iOS classic — lift effects must be gated
  const hover = mediaBlock(CSS, "(hover:hover)");
  assert.ok(/#my-hand \.card\.playable:hover/.test(hover), "the card lift must be gated behind hover:hover");
  const ungated = splitMedia(CSS, "(hover:hover)").outside;
  for (const sel of [".emote-btn:hover", ".btn:hover", ".mini-btn:hover"])
    assert.ok(!rules(ungated).some(r => r.sels.includes(sel)),
      `${sel} applies on touch-only devices, where it sticks after a tap`);

  assert.ok(/touch-action:\s*manipulation/.test(CSS), "taps should not wait for double-tap zoom");
  assert.ok(/-webkit-text-size-adjust:\s*100%/.test(CSS), "rotation must not inflate text on iOS");
  assert.ok(/visualViewport/.test(CLIENT), "the on-screen keyboard must not cover the chat sheet");
});

test("live regions are updated incrementally, not rebuilt", () => {
  /* A polite live region that is cleared and refilled counts every row as an
     insertion, so a screen reader re-reads the whole backlog on every state
     message — one per card played. syncWindow's behaviour is tested for real in
     client.test.js; this pins that the log and chat actually route through it. */
  for (const fn of ["renderLog", "renderChat"]) {
    const body = CLIENT.slice(CLIENT.indexOf(`function ${fn}(`), CLIENT.indexOf(`function ${fn}(`) + 900);
    assert.ok(/syncWindow\(/.test(body), `${fn} must diff its window instead of redrawing`);
    assert.ok(!/\.innerHTML\s*=\s*""/.test(body.split("syncWindow")[0]),
      `${fn} still clears the live region before rendering`);
  }
  assert.ok(/id="chat-empty"/.test(CLIENT) && !/#chat-log .empty/.test(CSS),
    "the chat placeholder must live outside the live region");
});

test("the hand keeps keyboard focus across re-renders", () => {
  const at = CLIENT.indexOf("function renderHand(");
  const body = CLIENT.slice(at, CLIENT.indexOf("\n}", at));
  assert.ok(/wrap\._sig/.test(body), "an unchanged hand must not be rebuilt at all");
  assert.ok(/document\.activeElement/.test(body) && /\.focus\(\)/.test(body),
    "rebuilding the hand must restore focus, or Tab position is lost on every state message");
  assert.ok(/dataset\.k/.test(body), "focus restore needs a stable per-card key");
});

test("generated assets are in sync with their sources", () => {
  /* the service worker's precache SHELL and its cache VERSION are both derived
     from app/'s own contents; either used to be maintained by hand, so either
     could silently go stale. scripts/build-assets.js owns them now. */
  assert.deepStrictEqual(check(), [], "run: npm run build:assets");
  assert.ok(/const VERSION = "trump-[0-9a-f]{12}";/.test(SW),
    "sw VERSION must be the generated content hash, not a hand-edited constant");
});

test("every shipped js and css file is precached", () => {
  const shell = (SW.match(/const SHELL = \[([\s\S]*?)\];/) || [, ""])[1]
    .match(/"([^"]+)"/g).map(s => s.slice(1, -1));
  // app/css doesn't exist yet (a later task creates it) and app/js keeps
  // growing (later tasks add to it) — walk tolerates a missing directory so
  // this test needs no changes when either lands.
  const walk = (dir, base = "") => fs.existsSync(path.join(PUB, dir))
    ? fs.readdirSync(path.join(PUB, dir), { withFileTypes: true }).flatMap(e => e.isDirectory()
        ? walk(path.join(dir, e.name), base + e.name + "/")
        : [base + e.name])
    : [];
  for (const rel of [...walk("js").map(f => "/js/" + f), ...walk("css").map(f => "/css/" + f)])
    assert.ok(shell.includes(rel), `sw does not precache ${rel}`);
});
