/* DOM helpers shared across the client: element lookup, HTML escaping, the
   toast, and the per-player avatar (a coloured disc whose hue comes from the
   name itself, so the same player reads as the same colour to everyone). */
import { icon } from "../cards/icons.js";

const $ = id => document.getElementById(id);

// escapes ' as well as " — everything here is interpolated into innerHTML, and
// a name landing in a single-quoted attribute must not be able to break out
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, ch => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[ch])); }
let toastT = null;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2200); }

/* ---------- who you are at this table ----------
   A name is the one thing you bring, so it gets a face. The hue comes from the
   name itself, so the same player is the same colour on everyone's screen. */
function nameHue(name) {
  const s = String(name || "").trim();
  /* An empty field is not a player yet, and hue 0 — which is what the fold below
     returns for one — is a hot pink that reads as an error on the join screen.
     42 is the brass the rest of the interface is lit in. */
  if (!s) return 42;
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function paintAvatar(el, name, isAI) {
  el.className = "avatar" + (isAI ? " ai" : "") + (el.classList.contains("lg") ? " lg" : "");
  if (isAI) { el.innerHTML = icon("bot"); el.style.removeProperty("--h"); return; }
  const initial = (String(name || "").trim()[0] || "").toUpperCase();
  el.style.setProperty("--h", nameHue(name));
  el.textContent = initial || "·";
}
const avatarHtml = (name, isAI) => isAI
  ? `<span class="avatar ai">${icon("bot")}</span>`
  : `<span class="avatar" style="--h:${nameHue(name)}">${esc((String(name || "").trim()[0] || "·").toUpperCase())}</span>`;

export { $, esc, toast, nameHue, paintAvatar, avatarHtml };
