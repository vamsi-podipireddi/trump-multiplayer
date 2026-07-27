/* ---- randomness ----
   The deal must not come off the same stream as anything an opponent can
   observe. V8's Math.random is xorshift128+, and its state is recoverable from
   a handful of outputs — i.e. from the cards a player is dealt — which would
   leak both future deals and room.js's session tokens. Dealing therefore uses
   the platform CSPRNG (present in node >=19 and in Workers), with rejection
   sampling so the modulo is unbiased. AI-internal randomness has nothing to
   protect and stays on the cheap generator. */
function randomInt(n) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== "function") return Math.floor(Math.random() * n);
  const limit = Math.floor(0x100000000 / n) * n; // drop the biased tail of the 32-bit range
  const buf = new Uint32Array(1);
  let v;
  do { c.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return v % n;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function shuffleFast(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export { randomInt, shuffle, shuffleFast };
