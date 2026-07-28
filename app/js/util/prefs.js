/* Small persisted user preferences (currently: the 4-colour deck). */
import { $ } from "./dom.js";

// ---------- 4-colour deck (persisted) ----------
function setFourColor(on) {
  document.body.classList.toggle("fourcolor", on);
  $("btn-colors").setAttribute("aria-pressed", String(on));
  try { localStorage.setItem("trump_4color", on ? "1" : "0"); } catch {}
}
/* Reads the persisted choice and applies it — called once at boot. */
function initPrefs() {
  setFourColor((() => { try { return localStorage.getItem("trump_4color") === "1"; } catch { return false; } })());
}

export { setFourColor, initPrefs };
