"use strict";
import { S, leaveRoom } from "./session.js";
import { $, paintAvatar } from "./util/dom.js";
import { setFourColor, initPrefs } from "./util/prefs.js";
import { SUITS, SUIT_KEY, suitSvg } from "./cards/labels.js";
import { icon, paintIcons } from "./cards/icons.js";
import { cardEl } from "./cards/deck.js";
import { send, setViewHandler, setEmoteHandler } from "./net.js";
import { inviteUrl, copyInvite } from "./share.js";
import { registerServiceWorker } from "./pwa.js";
import { showEmote, openSheet, closeSheet, initKeyboardHandling } from "./ui/chat.js";
import { showHelp, setRenderHandler } from "./ui/modals.js";
import { startTicking, initResize } from "./ui/layout.js";
import { doJoin, doSolo, loadStats, showNotice } from "./screens/join.js";
import { render } from "./screens/game.js";

/* Three seams survive even though render(), showEmote() and renderSettings()
   are all real modules now: net.js (setViewHandler/setEmoteHandler) and
   ui/modals.js (setRenderHandler) still can't import render()/showEmote()
   directly without creating an import cycle back to themselves — see the
   comments in net.js and ui/modals.js for the exact cycle each one closes.
   main.js sits at the top of the whole import graph, so it is the one place
   that can import every real function and hand it to the module that needs
   it. The fourth seam this pattern used to need, setRenderSettingsHandler, is
   gone: ui/modals.js now imports renderSettings directly from screens/lobby.js
   — lobby.js never imports modals.js (or anything that does), so that
   direction was never actually a cycle. */
function boot() {
  setViewHandler(render);
  setEmoteHandler(showEmote);
  setRenderHandler(render);

  // ---------- join UI ----------
  $("btn-solo").onclick = doSolo;
  $("btn-join").onclick = () => doJoin(false);
  $("btn-create").onclick = () => doJoin(true);
  $("join-name").value = localStorage.getItem("trump_name") || "";
  loadStats();
  { const p = new URLSearchParams(location.search).get("room"); if (p) $("join-code").value = p.toUpperCase(); }
  showNotice();
  $("btn-leave").onclick = () => leaveRoom("");
  $("btn-help").onclick = showHelp;

  initResize();

  $("chat-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $("chat-input"), text = input.value.trim();
    if (!text) return;
    send({ type: "chat", text });
    input.value = "";
  });
  $("btn-back").onclick = () => send({ type: "back" });
  $("btn-stand").onclick = () => {
    if (confirm("Give up your seat? An AI will finish the match for you.")) send({ type: "stand" });
  };

  startTicking();

  // ---------- invite / share ----------
  $("btn-copy").onclick = copyInvite;
  if (navigator.share) {
    $("btn-share").style.display = "";
    $("btn-share").onclick = () => navigator.share({
      title: "TRUMP — join my table",
      text: `Join my TRUMP game — room ${S.roomCode}`,
      url: inviteUrl(),
    }).catch(() => {});
  }

  /* ---------- first paint ----------
     Runs down here, not beside the join-screen handlers: it draws real cards, and
     the deck's tables are `const`s further up the file — calling into them any
     earlier throws on the temporal dead zone and takes the rest of the boot with it. */
  paintIcons(document);
  (function dressChrome() {
    const fan = $("brand-fan");
    [{ suit:"♠", rank:14 }, { suit:"♥", rank:12 }, { suit:"♦", rank:3 }].forEach((c, i) => {
      const el = cardEl(c);
      el.style.transform = `rotate(${(i - 1) * 9}deg) translateY(${Math.abs(i - 1) * 7}px)`;
      el.style.animationDelay = (i * 70) + "ms";
      fan.appendChild(el);
    });
    const pips = SUITS.map(s => `<span class="sc s-${SUIT_KEY[s]}">${suitSvg(s)}</span>`).join("");
    for (const id of ["brand-colophon", "lobby-colophon"])
      $(id).innerHTML = `<i class="bar"></i>${pips}<i class="bar"></i>`;
    $("awaybar-msg").innerHTML = icon("moon") + "<span>You're away — an AI is playing your seat.</span>";
    $("conn").innerHTML = icon("plug") + "<span>Disconnected — reconnecting…</span>";
    const nameField = $("join-name"), face = $("join-avatar");
    const syncFace = () => paintAvatar(face, nameField.value.trim(), false);
    nameField.addEventListener("input", syncFace);
    syncFace();
  })();

  initPrefs();
  $("btn-colors").onclick = () => setFourColor(!document.body.classList.contains("fourcolor"));

  document.querySelectorAll("#sheet-tabs button").forEach(b => { b.onclick = () => openSheet(b.dataset.tab); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  initKeyboardHandling();

  registerServiceWorker();
}
/* Wrapped and guarded, unlike a plain top-level boot sequence: this file is the
   entry point actually loaded by the page (index.html's only script
   reference), so its top level would otherwise run immediately — including
   under test/client-modules.test.js, which imports every file under app/js/
   with no DOM. typeof, not a direct reference, so checking on Node (where
   `document` is never declared at all) doesn't itself throw. */
if (typeof document !== "undefined") boot();

export {};
