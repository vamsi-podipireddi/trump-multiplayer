/* Main-thread facade over the coach worker: a promise per request, correlated
   by an incrementing id. Building a Worker at module scope would break every
   Node import of this file (test/client-modules.test.js has no `self`, no
   `Worker`) — so it is built lazily, inside the first call, never at import
   time. When no worker can be built at all — construction throws, or `Worker`
   doesn't exist — every request but "report" runs handleRequest
   synchronously, right here, at a reduced budget: the feature degrades in
   responsiveness, never in availability. "report" is the one exception —
   see gradeReportChunked below for why a single synchronous handleRequest(...)
   call is the wrong shape for it specifically. */
import { handleRequest, FALLBACK_HINT_BUDGET, gradeOneDeal } from "./worker.js";
import { matchReport } from "./report.js";

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
  if (!w) {
    /* "report" grades a whole match's worth of deals, each at full
       (worker-quality) budget — every other kind is at most one
       decision/deal's worth of work, cheap enough at FALLBACK_HINT_BUDGET to
       answer synchronously the way this always has, so only "report" needs
       the chunked path. */
    return kind === "report" ? gradeReportChunked(msg) : Promise.resolve(handleRequest({ ...msg, budget: FALLBACK_HINT_BUDGET }));
  }

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

/* Fix round I5: the no-worker path for "report" specifically. Grading itself
   is unreduced — the exact same gradeOneDeal a real worker runs, at its own
   full budget, called with no seed override so the numbers are identical to
   what handleRequest's own "report" branch would produce for the same
   input; this changes only WHEN the work happens, never what gets computed
   or how well.
   Left as a single handleRequest(...) call (the old code, and every other
   kind's fallback today), grading a whole match's worth of deals is exactly
   the freeze modals.js's own "Analysing…" wait message would otherwise
   promise and then never get a chance to paint: nothing yields back to the
   browser between that innerHTML write and this function running, so the
   tab goes unresponsive before the first frame showing it even lands — and
   once running, one deal's grading is cheap, but a whole match's worth of
   them back to back, at full worker-quality budget, is not. Yielding once
   before each deal (including the first) gives the browser a real chance to
   paint before that deal's own share of the work starts, so no single task
   ever blocks for longer than one deal, regardless of how many deals the
   match has. */
async function gradeReportChunked(msg) {
  const deals = Array.isArray(msg.deals) ? msg.deals : [];
  if (!deals.length) return { id: msg.id, ok: false, error: "no finished deal to report on" };
  try {
    const graded = [];
    for (const d of deals) {
      await yieldToBrowser();
      graded.push(gradeOneDeal(d, msg.seat));
    }
    return { id: msg.id, ok: true, result: matchReport(graded, msg.seat, msg.dealsInMatch) };
  } catch (e) {
    // Same safety net handleRequest's own try/catch gives every other kind —
    // bypassing handleRequest here must not also bypass it turning a thrown
    // exception into an honest { ok: false } rather than a rejected promise
    // modals.js has no branch for.
    return { id: msg.id, ok: false, error: String((e && e.message) || e) };
  }
}
function yieldToBrowser() { return new Promise(resolve => setTimeout(resolve, 0)); }

function requestHint(view) { return request("hint", { view }); }

/* Resolves to the graded deal worker.js's "review" branch builds (reviewDeal's
   { decisions, worst, samples }), or to { ok: false, error } if the view holds
   no finished deal. Deliberately the same request() as requestHint — one
   correlation path, one timeout, one synchronous fallback — which is why
   adding the review needed no change in this file at all. */
function requestReview(view, seat) { return request("review", { view, seat }); }

/* Rides the same request() as the hint and the review — one correlation id,
   one TIMEOUT_MS on the worker path (unchanged; still resolved by request()'s
   own Promise/setTimeout pairing above) — but not quite "one synchronous
   fallback": request() special-cases this one kind onto gradeReportChunked
   instead. A whole match's grading is heavier than a single review, so this
   is the one caller that can plausibly reach TIMEOUT_MS on a slow phone;
   modals.js surfaces that as a retry rather than a permanent spinner. */
function requestReport(deals, seat, dealsInMatch) {
  return request("report", { deals, seat, dealsInMatch });
}

/* True when a live worker backs the facade, false when every request is about
   to run synchronously on this thread. Attempts construction if nothing has
   asked yet, so a caller can check before ever making a request. */
function coachAvailable() { return !!getWorker(); }

export { requestHint, requestReview, requestReport, coachAvailable };
