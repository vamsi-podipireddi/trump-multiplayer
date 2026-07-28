import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(__dirname, "..", "app", "js");

const walk = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);

/* Every client module must load as a real ES module. Without this the suite only
   ever reads these files as text, so a missing export — or an import naming a
   symbol its target does not export — throws in the browser while every test
   stays green. That exact bug shipped once. */
test("every client module loads, and its imports resolve to real exports", async () => {
  const files = walk(JS).filter(f => f.endsWith(".js"));
  assert.ok(files.length >= 5, `expected client modules, found ${files.length}`);

  for (const f of files) {
    const mod = await import(f);                       // throws on a bad specifier or missing binding
    assert.ok(Object.keys(mod).length > 0 || /export\s*\{\s*\}/.test(fs.readFileSync(f, "utf8")),
      `${path.relative(JS, f)} exports nothing`);
  }

  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g))
      assert.ok(!m[1].startsWith("/"),
        `${path.relative(JS, f)} imports "${m[1]}" — absolute specifiers break node's resolver; use a relative path`);
  }
});
