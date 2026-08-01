/* Main-thread facade over the coach worker: a promise per request, correlated
   by an incrementing id. Building a Worker at module scope would break every
   Node import of this file (test/client-modules.test.js has no `self`, no
   `Worker`) — so it is built lazily, inside the first call, never at import
   time. When no worker can be built at all — construction throws, or `Worker`
   doesn't exist — every request instead runs handleRequest synchronously,
   right here, at a reduced budget: the feature degrades in responsiveness,
   never in availability. */
import { handleRequest, FALLBACK_HINT_BUDGET } from "./worker.js";

const TIMEOUT_MS = 10000;

let worker;                  // undefined: not yet attempted. null: attempted and failed.
let nextId = 1;
const pending = new Map();   // id -> { resolve, reject, timer }

function onMessage(e) {
  const res = e.data;
  const p = pending.get(res.id);
  if (!p) return;            // a stray message, or a request that already timed out
  pending.delete(res.id);
  clearTimeout(p.timer);     // settled once — a later timeout must never reject an answered request
  p.resolve(res);
}

/* A worker-level error (a bad import, a throw outside handleRequest's own
   try/catch) isn't correlated to one id, so every in-flight request fails —
   the alternative is a spinner nothing will ever answer. Also discards the
   worker itself: one that has died stays dead, so every later request must
   fall back to the synchronous path rather than posting into the void and
   eating a full TIMEOUT_MS for nothing — the file's own promise is "degrades
   in responsiveness, never in availability," which a wedged dead worker
   would otherwise quietly break. */
function onError(err) {
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
  pending.clear();
  worker = null;
}

/* Constructed once, lazily, and reused: a Worker that fails to build once
   fails every time, so a retry on every call would only add latency. */
function getWorker() {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === "undefined") throw new Error("Worker is not available in this environment");
    worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    worker.onmessage = onMessage;
    worker.onerror = onError;
  } catch {
    worker = null;
  }
  return worker;
}

function request(kind, payload) {
  const id = nextId++;
  const seed = Math.floor(Math.random() * 0x100000000);
  // id/kind/seed spread last so a payload can never clobber the correlation
  // id — unreachable today (requestHint/requestReview build fixed-shape
  // payloads), kept impossible rather than merely unexercised.
  const msg = { ...payload, id, kind, seed };
  const w = getWorker();
  // No worker: answer synchronously through the exact same handler, at a
  // budget small enough that blocking this thread doesn't read as a stall.
  if (!w) return Promise.resolve(handleRequest({ ...msg, budget: FALLBACK_HINT_BUDGET }));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("coach worker timed out"));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      w.postMessage(msg);
    } catch (err) {
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function requestHint(view) { return request("hint", { view }); }

/* Resolves to the graded deal worker.js's "review" branch builds (reviewDeal's
   { decisions, worst, samples }), or to { ok: false, error } if the view holds
   no finished deal. Deliberately the same request() as requestHint — one
   correlation path, one timeout, one synchronous fallback — which is why
   adding the review needed no change in this file at all. */
function requestReview(view, seat) { return request("review", { view, seat }); }

/* True when a live worker backs the facade, false when every request is about
   to run synchronously on this thread. Attempts construction if nothing has
   asked yet, so a caller can check before ever making a request. */
function coachAvailable() { return !!getWorker(); }

export { requestHint, requestReview, coachAvailable };
