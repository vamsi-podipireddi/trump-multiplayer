import { S } from "../session.js";
import { $ } from "../util/dom.js";
import { icon } from "../cards/icons.js";
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
function renderLog() {
  const el = $("log");
  const entries = S.view.log || [];
  const added = syncWindow(el, entries.map(e => `${e.cls || ""} ${e.text}`), i => {
    const d = document.createElement("div");
    const cls = entries[i].cls || "";
    d.className = "entry " + cls;
    /* the core marks a won trick with a ★; draw it instead of printing a dingbat */
    const text = entries[i].text.replace(/^★\s*/, "");
    d.innerHTML = (cls === "win" ? icon("star") : "") + `<span>${textWithCards(text)}</span>`;
    return d;
  });
  if (added) el.scrollTop = el.scrollHeight;
}

export { syncWindow, renderLog };
