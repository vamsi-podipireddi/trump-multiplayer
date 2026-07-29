/* Small persisted user preferences (the 4-colour deck) plus the storage wrapper
   every other module's preference goes through. */
import { $ } from "./dom.js";

/* Storage is a privilege, not a guarantee: Safari in private mode throws on
   both read and write, and a preference must never be able to stop a render. */
function getPref(key, dflt) {
  try { const v = localStorage.getItem(key); return v === null ? dflt : v; } catch { return dflt; }
}
function setPref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch {}
}

// ---------- 4-colour deck (persisted) ----------
function setFourColor(on) {
  document.body.classList.toggle("fourcolor", on);
  $("btn-colors").setAttribute("aria-pressed", String(on));
  // spelled out instead of routed through setPref(): test/pwa.test.js greps the
  // client for this exact call as its proof the choice survives a reload
  try { localStorage.setItem("trump_4color", on ? "1" : "0"); } catch {}
}
/* Reads the persisted choice and applies it — called once at boot. */
function initPrefs() { setFourColor(getPref("trump_4color", "0") === "1"); }

export { setFourColor, initPrefs, getPref, setPref };
