import { $ } from "../util/dom.js";
import { EMOTES, reactionIcon, reactionName } from "../cards/icons.js";
import { syncWindow } from "./log.js";

// ---------- chat + emotes ----------
/* The bar's buttons are built once and outlive the render that made them, so
   they must not close over that render's onEmote — they call the latest one. */
let emit = null;
function renderChat(view, mySeat, onEmote) {
  const box = $("chat-log");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const msgs = view.chat || [];
  $("chat-empty").style.display = msgs.length ? "none" : "";
  const added = syncWindow(box, msgs.map(m => `${m.ts}\u0000${m.from}\u0000${m.text}`), i => {
    const m = msgs[i];
    const d = document.createElement("div");
    d.className = "msg" + (m.seat != null && m.seat === mySeat ? " you" : "");
    /* both halves are typed by another player, so neither goes near innerHTML */
    const from = document.createElement("span");
    from.className = "from";
    from.textContent = m.from + ":";
    d.append(from, " " + m.text);
    return d;
  });
  if (atBottom && added) box.scrollTop = box.scrollHeight;
  noteChatActivity(view);
  emit = onEmote;
  if (!$("emote-bar").children.length) {
    EMOTES.forEach(e => {
      const b = document.createElement("button");
      b.className = "emote-btn"; b.type = "button"; b.innerHTML = reactionIcon(e);
      b.title = reactionName(e);
      b.setAttribute("aria-label", "Send " + reactionName(e) + " reaction");
      b.onclick = () => emit && emit(e);
      $("emote-bar").appendChild(b);
    });
  }
  $("emote-bar").style.display = view.you.spectator ? "none" : ""; // seats only, per the server rule
}
const POS_CLASS = ["south", "west", "north", "east"];   // position 0..3, viewer at 0
/* Floating reaction over the sender's seat (transient — never part of state).
   The caller supplies posOf because the two clients seat you differently —
   multiplayer rotates you to south, solo is already there. */
function showEmote(seat, e, posOf) {
  // body.in-game is set by whichever client is showing the table; off it, there is no seat to float over
  if (typeof seat !== "number" || !document.body.classList.contains("in-game")) return;
  const host = $("seat-" + POS_CLASS[posOf(seat)]);
  if (!host) return;
  const d = document.createElement("div");
  d.className = "float-emote"; d.innerHTML = reactionIcon(e);
  host.appendChild(d);
  setTimeout(() => d.remove(), 2000);
}

// ---------- mobile bottom sheets ----------
/* Two rails now, and each tab belongs to exactly one of them: the score card
   lives in the left rail, the log and the chat share the right one, selected by
   its data-tab (see the max-width:1160px and max-width:900px blocks in
   responsive.css). */
const RAIL_OF = { score: "rail-left", log: "rail-right", chat: "rail-right" };
let unreadChat = 0, lastChatLen = 0;
function markTabs(open) {
  document.querySelectorAll("#sheet-tabs button").forEach(b =>
    b.setAttribute("aria-expanded", String(b.dataset.tab === open)));
}
function openSheet(tab) {
  const rail = $(RAIL_OF[tab]);
  if (!rail) return; // the tab bar is markup-driven, and solo.html carries a subset of it
  const same = rail.classList.contains("open") && rail.dataset.tab === tab;
  /* Below 900px both rails occupy the same fixed slab above the tab bar, so the
     one you didn't ask for has to slide out rather than stack underneath. */
  const other = $(rail.id === "rail-left" ? "rail-right" : "rail-left");
  if (other) other.classList.remove("open");
  rail.dataset.tab = tab;
  rail.classList.toggle("open", !same);
  markTabs(same ? null : tab);
  if (!same && tab === "chat") { unreadChat = 0; updateChatBadge(); $("chat-log").scrollTop = $("chat-log").scrollHeight; }
}
function closeSheet() {
  ["rail-left", "rail-right"].forEach(id => { const r = $(id); if (r) r.classList.remove("open"); });
  markTabs(null);
}
function updateChatBadge() {
  const el = $("chat-badge");
  el.textContent = String(unreadChat);
  el.style.display = unreadChat > 0 ? "" : "none";
}
/* Count messages that arrive while the chat panel isn't on screen. The right
   rail is already a sheet at 1160px, a full breakpoint before the left one. */
function noteChatActivity(view) {
  const msgs = (view.chat || []).length;
  const rail = $("rail-right");
  const visible = window.innerWidth > 1160 || (rail.classList.contains("open") && rail.dataset.tab === "chat");
  if (msgs > lastChatLen && !visible) { unreadChat += msgs - lastChatLen; updateChatBadge(); }
  lastChatLen = msgs;
}

/* Wrapped in a function (rather than run at module load) so this file can still
   be `import()`-ed under Node with no DOM — see test/client-modules.test.js.
   Called once from index.html at boot. */
function initKeyboardHandling() {
  /* iOS floats the keyboard over fixed elements instead of resizing the layout, so the
     chat sheet and its tab bar would end up underneath it. visualViewport reports the
     covered height; --kb lifts both above it. */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const trackKeyboard = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--kb", (covered > 60 ? covered : 0) + "px");
    };
    vv.addEventListener("resize", trackKeyboard);
    vv.addEventListener("scroll", trackKeyboard);
    trackKeyboard();
  }
  $("chat-input").addEventListener("focus", () => {
    setTimeout(() => { $("chat-log").scrollTop = $("chat-log").scrollHeight; }, 250); // after the keyboard animates in
  });
}

export { renderChat, showEmote, noteChatActivity, updateChatBadge, openSheet, closeSheet, initKeyboardHandling };
