/* ============================================================
   Keeps the service worker's precache SHELL and cache VERSION honest.

   Both are derived from app/'s own contents rather than hand-maintained:
   a hand-maintained SHELL silently omits new modules, and an omitted
   module is a broken offline load. A hand-maintained VERSION is a constant
   nobody remembers to bump, which means a deploy never evicts the old
   precache. Deriving both from the filesystem makes either kind of drift
   impossible.

   Run after touching the client:   npm run build:assets
   test/pwa.test.js fails if you forget.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const APP = path.join(ROOT, "app");
const SW = path.join(ROOT, "app", "sw.js");

/* The shipped shell, discovered rather than declared: a hand-maintained list
   silently omits new modules, and an omitted module is a broken offline load. */
const SKIP = new Set(["sw.js"]);   // hashing the file we are about to stamp never reaches a fixed point

function shellFiles(dir = APP, base = "") {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    if (e.isDirectory()) out.push(...shellFiles(path.join(dir, e.name), base + e.name + "/"));
    else out.push(base + e.name);
  }
  return out;
}

/* Sorting is required: readdirSync order is filesystem-dependent, and an
   unstable order would make VERSION differ between machines and CI. */
function shellVersion(files) {
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel);
    h.update(fs.readFileSync(path.join(APP, rel)));
  }
  return "trump-" + h.digest("hex").slice(0, 12);
}

const VERSION_RE = /const VERSION = "([^"]*)";/;
const SHELL_RE = /const SHELL = \[[\s\S]*?\];/;

/* The exact text build() stamps in for SHELL, shared with check() so the two
   can never disagree about what "in sync" means. */
function shellText(files) {
  const urls = ["/", ...files.map(f => "/" + f)];
  return "const SHELL = [\n  " + urls.map(u => JSON.stringify(u)).join(", ") + ",\n];";
}

/* Returns the list of files that are stale. Empty means everything is in sync. */
function check() {
  const stale = [];
  const files = shellFiles();
  const sw = fs.readFileSync(SW, "utf8");
  const gotShell = (sw.match(SHELL_RE) || [])[0];
  if (gotShell !== shellText(files)) stale.push("app/sw.js (SHELL)");
  const m = sw.match(VERSION_RE);
  if (!m) stale.push("app/sw.js (no VERSION constant)");
  else if (m[1] !== shellVersion(files)) stale.push("app/sw.js (VERSION)");
  return stale;
}

function build() {
  const files = shellFiles();
  const want = shellVersion(files);
  let sw = fs.readFileSync(SW, "utf8");
  sw = sw.replace(SHELL_RE, shellText(files));
  sw = sw.replace(VERSION_RE, `const VERSION = "${want}";`);
  fs.writeFileSync(SW, sw);
  return want;
}

export { shellFiles, shellVersion, check, build };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
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
