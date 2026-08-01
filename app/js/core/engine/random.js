/* ---- randomness ----
   The deal must not come off the same stream as anything an opponent can
   observe. V8's Math.random is xorshift128+, and its state is recoverable from
   a handful of outputs — i.e. from the cards a player is dealt — which would
   leak both future deals and the room core's session tokens. Dealing therefore uses
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

/* A tiny seedable PRNG for AI-internal sampling only. The coach needs a search
   whose numbers repeat when a review is reopened; the *deal* keeps randomInt/
   shuffle's CSPRNG (D9a), because that is the stream a player must not predict. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleFast(a, rnd = Math.random) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export { randomInt, shuffle, shuffleFast, mulberry32 };
