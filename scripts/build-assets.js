"use strict";
/* ============================================================
   Keeps two derived files honest:

   1. app/solo.html — the byte-identical copy of the root single-player
      game that the service worker serves when there is no network (D12).
      It was previously copied by hand, so the two could silently drift.

   2. the service worker's cache VERSION — a constant nobody remembered to
      bump, which meant a deploy never evicted the old precache. It is now
      derived from the shell's own contents, so it changes exactly when the
      shipped files change and never otherwise.

   Run after touching the client:   npm run build:assets
   test/pwa.test.js fails if you forget.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const SOLO_SRC = path.join(ROOT, "index.html");
const SOLO_DST = path.join(ROOT, "app", "solo.html");
const SW = path.join(ROOT, "app", "sw.js");

/* Everything the service worker precaches, minus sw.js itself — hashing the
   file we are about to stamp would never reach a fixed point. */
const SHELL = [
  "app/index.html", "app/solo.html", "app/manifest.webmanifest",
  "app/icon-192.png", "app/icon-512.png", "app/icon-maskable-512.png",
  "app/apple-touch-icon.png", "app/favicon-32.png",
];

function shellVersion() {
  const h = crypto.createHash("sha256");
  for (const rel of SHELL) {
    h.update(rel);
    h.update(fs.readFileSync(path.join(ROOT, rel)));
  }
  return "trump-" + h.digest("hex").slice(0, 12);
}

const VERSION_RE = /const VERSION = "([^"]*)";/;

/* Returns the list of files that are stale. Empty means everything is in sync. */
function check() {
  const stale = [];
  if (!fs.existsSync(SOLO_DST) || !fs.readFileSync(SOLO_SRC).equals(fs.readFileSync(SOLO_DST)))
    stale.push("app/solo.html");
  const sw = fs.readFileSync(SW, "utf8");
  const m = sw.match(VERSION_RE);
  if (!m) stale.push("app/sw.js (no VERSION constant)");
  else if (m[1] !== shellVersion()) stale.push("app/sw.js (VERSION)");
  return stale;
}

function build() {
  fs.copyFileSync(SOLO_SRC, SOLO_DST);
  const want = shellVersion(); // computed after the copy: solo.html is part of the shell
  const sw = fs.readFileSync(SW, "utf8");
  const next = sw.replace(VERSION_RE, `const VERSION = "${want}";`);
  if (next !== sw) fs.writeFileSync(SW, next);
  return want;
}

module.exports = { shellVersion, check, build, SHELL };

if (require.main === module) {
  if (process.argv.includes("--check")) {
    const stale = check();
    if (stale.length) {
      console.error("stale generated assets: " + stale.join(", ") + "\n  run: npm run build:assets");
      process.exit(1);
    }
    console.log("generated assets are up to date");
  } else {
    console.log("built assets · sw cache version " + build());
  }
}
