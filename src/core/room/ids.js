import { NAME_MAX } from "./constants.js";
import * as E from "../../../app/js/core/engine/index.js";

// ---- small helpers ----
function codePoints(s, n) { return [...String(s)].slice(0, n).join(""); } // don't split emoji
function cleanName(s) { return codePoints(String(s || "").trim(), NAME_MAX) || "Player"; }
function normCode(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8); }
/* playerId is a bearer token and a private room code is a secret, so both come
   off the CSPRNG (E.randomInt) rather than Math.random — see the note there.
   `rng` stays available for tests that need a reproducible sequence. */
function randId(n, alpha, rng) {
  const chars = alpha ? "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" : "abcdefghijklmnopqrstuvwxyz0123456789";
  const pick = rng ? () => Math.floor(rng() * chars.length) : () => E.randomInt(chars.length);
  let out = ""; for (let i = 0; i < n; i++) out += chars[pick()];
  return out;
}

export { codePoints, cleanName, normCode, randId };
