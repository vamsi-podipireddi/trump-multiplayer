import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const solo = ["app/solo.html", "app/js/solo.js"]
  .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");

test("the solo game uses the shared engine and re-implements none of it", () => {
  assert.match(solo, /core\/engine/, "solo must import the shared engine");
  // Matches a `function fn(` declaration AND a `const/let/var fn =` binding
  // (arrow function or function expression) — a declaration-only check lets
  // `const buildDeck = () => {}` slip through as if it weren't a redefinition.
  for (const fn of ["buildDeck", "shuffle", "beats", "legalCards", "cardPoints",
                    "winningIndex", "trickPoints", "sortHand"])
    assert.ok(!new RegExp(`function\\s+${fn}\\s*\\(|\\b(?:const|let|var)\\s+${fn}\\s*=`).test(solo),
      `solo defines its own ${fn}() — that is the duplication this replaced`);
});

test("the root single-player copy is gone", () => {
  assert.ok(!fs.existsSync(path.join(ROOT, "index.html")),
    "root index.html held a drifted engine copy and must not come back");
});
