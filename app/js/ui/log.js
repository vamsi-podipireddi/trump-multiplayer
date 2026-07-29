import { $ } from "../util/dom.js";
import { textWithCards } from "../cards/labels.js";

/* ---------- sliding-window lists (the table log and the chat) ----------
   Both arrive as "the last N entries", and the server re-sends them with every
   state message — on every card played, every timer tick, every chat line. A
   naive redraw re-inserts every row, which in an aria-live region means a
   screen reader re-reads the entire backlog each time. Diff the incoming window
   against what is already on screen, drop what scrolled off the top, and append
   only what is genuinely new; an unchanged window touches no DOM at all.
   Pure apart from the four node operations, so test/client.test.js can run it. */
function syncWindow(box, keys, build) {
  const prev = box._winKeys || [];
  let keep = 0; // longest suffix of `prev` that is also a prefix of `keys`
  for (let n = Math.min(prev.length, keys.length); n > 0; n--) {
    let same = true;
    for (let i = 0; i < n; i++) if (prev[prev.length - n + i] !== keys[i]) { same = false; break; }
    if (same) { keep = n; break; }
  }
  if (keep === 0) box.textContent = "";
  else for (let drop = prev.length - keep; drop > 0 && box.firstChild; drop--) box.removeChild(box.firstChild);
  for (let i = keep; i < keys.length; i++) box.appendChild(build(i));
  box._winKeys = keys;
  return keys.length - keep; // rows actually added
}

/* The wire carries no timestamps: the log is a window of plain strings that the
   server re-sends whole. So the clock column is the moment *this* client first
   saw the entry, remembered against the very key syncWindow diffs on. Entries
   that have scrolled off the window lose their stamp again — a long match
   otherwise grows this Map for the life of the page. Two identical lines share
   one stamp, which is the right answer anyway: they read the same. */
const stamps = new Map();
const clockNow = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

function renderLog(view) {
  const el = $("log");
  const entries = view.log || [];
  const keys = entries.map(e => `${e.cls || ""} ${e.text}`);
  const live = new Set(keys);
  for (const k of stamps.keys()) if (!live.has(k)) stamps.delete(k);
  const seen = clockNow();
  for (const k of keys) if (!stamps.has(k)) stamps.set(k, seen);
  const added = syncWindow(el, keys, i => {
    const d = document.createElement("div");
    d.className = "entry " + (entries[i].cls || "");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = stamps.get(keys[i]);
    const body = document.createElement("span");
    /* the core marks a won trick with a ★; .entry.win already says so in colour,
       so strip the dingbat rather than printing it beside the clock */
    body.innerHTML = textWithCards(entries[i].text.replace(/^★\s*/, ""));
    d.append(t, body);
    return d;
  });
  if (added) el.scrollTop = el.scrollHeight;
}

export { syncWindow, renderLog };
