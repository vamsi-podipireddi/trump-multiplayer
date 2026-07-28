import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---- HTTP: serve the static client from app/ ----
const PUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "app");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".css": "text/css",
};

/* Takes the room count as a callback rather than importing registry.js directly —
   that would couple the HTTP layer to the room registry for the sake of one
   /health field. */
function createHttpServer(getRoomCount) {
  return http.createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: getRoomCount() }));
      return;
    }
    const rel = url === "/" ? "index.html" : url.slice(1);
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep) || rel.includes("..")) { res.writeHead(403); res.end("forbidden"); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
        // Client modules and stylesheets are no-cache too, same as sw.js/html:
        // before the split, all client JS lived inside index.html and inherited
        // no-cache automatically. Now a redeploy over `npm start` can serve
        // fresh HTML against up-to-an-hour-stale modules from the old
        // max-age, and with a ~20-module graph one renamed export is a blank
        // page. Cloudflare fronts the Worker adapter in production, so this
        // only matters on the node adapter — which is the path README.md
        // tells LAN/self-host users to run.
        "Cache-Control": file.endsWith("sw.js") || file.endsWith(".html") || rel.startsWith("js/") || rel.startsWith("css/")
          ? "no-cache" : "public, max-age=3600",
      });
      res.end(buf);
    });
  });
}

export { createHttpServer };
