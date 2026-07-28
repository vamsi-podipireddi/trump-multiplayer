import { S } from "./session.js";
import { toast } from "./util/dom.js";

// ---------- invite / share ----------
function inviteUrl() { return location.origin + location.pathname + "?room=" + encodeURIComponent(S.roomCode || ""); }
async function copyInvite() {
  const url = inviteUrl();
  try { await navigator.clipboard.writeText(url); toast("Invite link copied"); }
  catch { window.prompt("Copy this invite link:", url); } // clipboard needs https + a gesture
}

export { inviteUrl, copyInvite };
