export const EMOTES = ["👏","😂","😱","🔥","🤝","💀"];   // must match src/core/room/constants.js EMOTES

/* ---------- iconography ----------
   Nothing in this interface is an emoji. An emoji is a font: it renders as a
   different picture on every platform, it can't take the colour of the control
   it sits in, and below 16px it is mud. These are paths on a 24-unit grid with
   one stroke weight, so they read as one set. */
const ICONS = {
  bot:   '<rect x="4.2" y="8" width="15.6" height="12" rx="3.4"/><path d="M12 4.2V8M2.4 12.6v3.2M21.6 12.6v3.2"/><circle cx="9.4" cy="13.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="14.6" cy="13.4" r="1.15" fill="currentColor" stroke="none"/><path d="M9.8 16.9h4.4"/><circle cx="12" cy="3" r="1.3"/>',
  users: '<path d="M15.6 20.4v-1.7a3.6 3.6 0 0 0-3.6-3.6H6.6A3.6 3.6 0 0 0 3 18.7v1.7"/><circle cx="9.3" cy="7.6" r="3.4"/><path d="M21 20.4v-1.7a3.6 3.6 0 0 0-2.7-3.48M15.4 4.3a3.6 3.6 0 0 1 0 6.6"/>',
  table: '<ellipse cx="12" cy="11" rx="9" ry="5.4"/><path d="M3 11v2.2c0 3 4 5.4 9 5.4s9-2.4 9-5.4V11"/>',
  gear:  '<circle cx="12" cy="12" r="3.1"/><path d="M19.2 14.6a1.5 1.5 0 0 0 .3 1.66l.06.05a1.82 1.82 0 1 1-2.58 2.58l-.05-.06a1.5 1.5 0 0 0-1.66-.3 1.5 1.5 0 0 0-.91 1.38v.15a1.82 1.82 0 0 1-3.64 0v-.08a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.66.3l-.05.06A1.82 1.82 0 1 1 4.45 16.4l.06-.05a1.5 1.5 0 0 0 .3-1.66 1.5 1.5 0 0 0-1.38-.91h-.15a1.82 1.82 0 0 1 0-3.64h.08a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.66l-.06-.05A1.82 1.82 0 1 1 7.6 4.45l.05.06a1.5 1.5 0 0 0 1.66.3h.07a1.5 1.5 0 0 0 .91-1.38v-.15a1.82 1.82 0 0 1 3.64 0v.08a1.5 1.5 0 0 0 .91 1.37 1.5 1.5 0 0 0 1.66-.3l.05-.06a1.82 1.82 0 1 1 2.58 2.58l-.06.05a1.5 1.5 0 0 0-.3 1.66v.07a1.5 1.5 0 0 0 1.38.91h.15a1.82 1.82 0 0 1 0 3.64h-.08a1.5 1.5 0 0 0-1.37.91Z"/>',
  help:  '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 0 1 5.25.9c0 1.8-2.7 2.7-2.7 2.7"/><circle cx="12" cy="17" r="1.05" fill="currentColor" stroke="none"/>',
  stand: '<path d="M12 3v9.5M8.6 6.4 12 3l3.4 3.4"/><path d="M4.6 14.4v3.4a2.6 2.6 0 0 0 2.6 2.6h9.6a2.6 2.6 0 0 0 2.6-2.6v-3.4"/>',
  exit:  '<path d="M9.4 20.4H5.6A2.2 2.2 0 0 1 3.4 18.2V5.8a2.2 2.2 0 0 1 2.2-2.2h3.8"/><path d="m15.6 16.4 4.4-4.4-4.4-4.4M20 12H9.4"/>',
  deck:  '<rect x="3.2" y="6.4" width="11.4" height="14.4" rx="2.2"/><path d="M8.4 3.4h9a3.4 3.4 0 0 1 3.4 3.4v9.4"/>',
  star:  '<path d="m12 3.6 2.6 5.5 5.9.85-4.25 4.2 1 5.95L12 17.25 6.75 20.1l1-5.95L3.5 9.95l5.9-.85Z"/>',
  copy:  '<rect x="8.4" y="8.4" width="12" height="12" rx="2.2"/><path d="M16 5.6a2.2 2.2 0 0 0-2.2-2.2H5.6a2.2 2.2 0 0 0-2.2 2.2v8.2A2.2 2.2 0 0 0 5.6 16"/>',
  share: '<circle cx="18" cy="5.4" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.6" r="2.6"/><path d="m8.3 10.75 7.4-4.1M8.3 13.25l7.4 4.1"/>',
  moon:  '<path d="M20.4 13.4A8.4 8.4 0 1 1 10.6 3.6a6.6 6.6 0 0 0 9.8 9.8Z"/>',
  plug:  '<path d="M18.4 5.6 5.6 18.4M8.4 3.6v3.2M3.6 8.4h3.2M15.6 17.2v3.2M17.2 15.6h3.2"/><circle cx="12" cy="12" r="4.4"/>',
  cup:   '<path d="M7.4 3.6h9.2v5.6a4.6 4.6 0 0 1-9.2 0Z"/><path d="M7.4 5.4H4.9a2.3 2.3 0 0 0 0 4.6h2.5M16.6 5.4h2.5a2.3 2.3 0 0 1 0 4.6h-2.5M9.6 13.6h4.8l-.6 4.4H10.2ZM7.6 20.4h8.8"/>',
  /* sound/mute share the cone so the toggle changes one thing — the waves become
     a cross and the button does not jump when you press it */
  sound: '<path d="M11.4 4.6 6.8 8.6H3.6a1 1 0 0 0-1 1v4.8a1 1 0 0 0 1 1h3.2l4.6 4Z"/><path d="M15.6 9.2a4 4 0 0 1 0 5.6M18.4 6.4a8 8 0 0 1 0 11.2"/>',
  mute:  '<path d="M11.4 4.6 6.8 8.6H3.6a1 1 0 0 0-1 1v4.8a1 1 0 0 0 1 1h3.2l4.6 4Z"/><path d="m16 9.6 5.4 4.8M21.4 9.6 16 14.4"/>',
};
function icon(name, cls) {
  const d = ICONS[name]; if (!d) return "";
  return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
         `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

/* ---------- the faces ----------
   A player used to be the first letter of their name, which is not a face: half a
   table reads "A · A · A", and a letter carries nothing you can recognise across
   the felt at 28px. These are emblems instead — the kind of mark that gets printed
   on a chip — drawn on the same 24-unit grid and the same single stroke weight as
   the icons above, so a seat is one silhouette rather than a character in a font.

   Which one you get is derived from the name, not chosen: nothing about an avatar
   travels over the wire (the room sends names, and only names), so deriving it is
   the only way the same player wears the same face on every screen at the table.
   Twelve marks against 360 hues — the pair is what identifies you, and the hue is
   folded from a different multiplier so the two don't move together. */
const FACES = {
  chip:      '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.9"/><path d="M12 3.6v2.6M12 17.8v2.6M3.6 12h2.6M17.8 12h2.6"/>',
  crown:     '<path d="M4.5 17.4 3.3 7.6l5.1 3.5L12 5l3.6 6.1 5.1-3.5-1.2 9.8Z"/><path d="M5.2 20.2h13.6"/>',
  dice:      '<rect x="3.7" y="3.7" width="16.6" height="16.6" rx="4.2"/><circle cx="8.2" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="8.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.2" cy="15.8" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.8" cy="15.8" r="1.15" fill="currentColor" stroke="none"/>',
  /* two concentric arcs, not one stroke and two nail heads: at 19px the heads
     merged into the ends and the whole mark read as a plain arch */
  horseshoe: '<path d="M7.4 20.4c-1.9-2.1-2.9-4.5-2.9-7.2a7.5 7.5 0 0 1 15 0c0 2.7-1 5.1-2.9 7.2"/><path d="M9.9 19.9c-1.4-1.7-2.1-3.6-2.1-5.7a4.2 4.2 0 0 1 8.4 0c0 2.1-.7 4-2.1 5.7"/>',
  anchor:    '<circle cx="12" cy="4.8" r="2.3"/><path d="M12 7.1v13.5M7.8 10.4h8.4"/><path d="M5.2 14.2a6.8 6.8 0 0 0 13.6 0"/>',
  compass:   '<circle cx="12" cy="12" r="8.4"/><path d="m15.5 8.5-2.2 5-5 2.2 2.2-5Z"/>',
  /* the inner ring is what keeps this a key: a bow with no hole and short teeth
     reads as a magnifying glass at avatar size */
  key:       '<circle cx="8.8" cy="8.8" r="4.4"/><circle cx="8.8" cy="8.8" r="1.35"/><path d="m11.9 11.9 7.3 7.3M15.1 15.1l-2.7 2.7M17.5 17.5l-2.7 2.7"/>',
  bolt:      '<path d="M13.4 2.8 5.2 13.6h6.2l-.8 7.6 8.2-10.8h-6.2Z"/>',
  flame:     '<path d="M12 21.2a6.5 6.5 0 0 0 6.5-6.5c0-4.7-4.3-6.5-4.3-10.8 0 0-3.3 2-3.3 5.7 0 1.6-1 2.5-1.8 1.8-.8-.6-.8-2.3-.8-2.3-1.7 2-3.1 3.9-3.1 6.3a6.5 6.5 0 0 0 6.5 6.5Z"/>',
  moon:      '<path d="M20 13.6A8.3 8.3 0 1 1 10.4 4a6.5 6.5 0 0 0 9.6 9.6Z"/><path d="M6 3.6v2.4M4.8 4.8h2.4"/>',
  cat:       '<path d="M4.6 10.2 4.2 4.4l4.7 3.1a8.6 8.6 0 0 1 6.2 0l4.7-3.1-.4 5.8a7.7 7.7 0 1 1-14.8 0Z"/><circle cx="9.3" cy="12.4" r="1.05" fill="currentColor" stroke="none"/><circle cx="14.7" cy="12.4" r="1.05" fill="currentColor" stroke="none"/><path d="M10.7 16.2c.8.7 1.8.7 2.6 0"/>',
  owl:       '<path d="M4.6 11.2a7.4 7.4 0 0 1 14.8 0v2.2a7.4 7.4 0 0 1-14.8 0Z"/><circle cx="9.2" cy="11" r="2.1"/><circle cx="14.8" cy="11" r="2.1"/><path d="m10.9 14.4 1.1 1.6 1.1-1.6"/><path d="M5.4 6.6 7.2 3.8M18.6 6.6 16.8 3.8"/>',
};
const FACE_KEYS = Object.keys(FACES);
/* An empty field is not a player yet, so it gets the blank token — the same
   reason nameHue() hands an empty name the brass the interface is lit in. */
function faceKey(name) {
  const s = String(name || "").trim();
  if (!s) return "chip";
  let h = 0;
  for (const ch of s) h = (h * 131 + ch.codePointAt(0)) % 100003;
  return FACE_KEYS[h % FACE_KEYS.length];
}
function faceIcon(name, cls) {
  const d = FACES[faceKey(name)];
  return `<svg class="ic ${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
         `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
/* Reactions. Filled marks rather than outlines — they float over the felt at
   30px and need to hold their shape against a busy background. */
const REACTIONS = {
  "👏": { name: "applause", d: '<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9.4 20.9a5.9 5.9 0 0 1-4.2-1.75L2.6 16.6a1.45 1.45 0 0 1 2.05-2.05l1.5 1.5V8.5a1.4 1.4 0 0 1 2.8 0v3.9"/><path d="M8.95 12.4V7.2a1.4 1.4 0 0 1 2.8 0v5.1"/><path d="M11.75 12.3V8.1a1.4 1.4 0 0 1 2.8 0v4.3"/><path d="M14.55 12.5V9.9a1.4 1.4 0 0 1 2.8 0v5.3a5.7 5.7 0 0 1-5.7 5.7H9.4"/><path d="m18.6 3.9 1.5-1.5M20.1 7.3h2.1M16.9 5.9l1-1.9"/></g>' },
  "😂": { name: "laughing", d: '<path fill-rule="evenodd" d="M12 2.3a9.7 9.7 0 1 0 0 19.4 9.7 9.7 0 0 0 0-19.4Zm-5.6 10.3h11.2a5.6 5.6 0 0 1-11.2 0ZM6.85 9.85c.95-1.5 2.65-1.5 3.6 0 .3.5-.45 1-.8.5-.5-.75-1.5-.75-2 0-.35.5-1.1 0-.8-.5Zm6.7 0c.95-1.5 2.65-1.5 3.6 0 .3.5-.45 1-.8.5-.5-.75-1.5-.75-2 0-.35.5-1.1 0-.8-.5Z"/>' },
  "😱": { name: "shocked", d: '<path fill-rule="evenodd" d="M12 2.3a9.7 9.7 0 1 0 0 19.4 9.7 9.7 0 0 0 0-19.4ZM8.6 7.9a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5Zm6.8 0a1.75 1.75 0 1 1 0 3.5 1.75 1.75 0 0 1 0-3.5ZM12 13.1c1.45 0 2.6 1.55 2.6 3.45S13.45 20 12 20s-2.6-1.55-2.6-3.45S10.55 13.1 12 13.1Z"/>' },
  "🔥": { name: "fire", d: '<path d="M12 22a6.9 6.9 0 0 0 6.9-6.9c0-4.8-4.3-6.6-4.3-11.1 0 0-3.3 2.1-3.3 5.9 0 1.7-1.1 2.6-2 1.9-.8-.6-.8-2.4-.8-2.4C6.8 11 5.1 12.8 5.1 15.1A6.9 6.9 0 0 0 12 22Z"/>' },
  "🤝": { name: "good game", d: '<g fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 9.5 6.3 6l3.5 3h4.4l3.5-3 3.9 3.5"/><path d="M2.4 9.5 5.7 14.1l2.3-1.7 3.1 2.7a2.1 2.1 0 0 0 2.8 0l3.1-2.7 2.3 1.7 3.3-4.6"/></g>' },
  "💀": { name: "oof", d: '<path fill-rule="evenodd" d="M12 2.2c-4.7 0-8.5 3.6-8.5 8.1 0 2.6 1.3 4.6 3 5.8.5.4.8 1 .8 1.6v1.1c0 .9.7 1.6 1.6 1.6h6.2c.9 0 1.6-.7 1.6-1.6v-1.1c0-.6.3-1.2.8-1.6 1.7-1.2 3-3.2 3-5.8 0-4.5-3.8-8.1-8.5-8.1Zm-3.4 6.9a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm6.8 0a2 2 0 1 1 0 4 2 2 0 0 1 0-4ZM12 13.9l1.1 2.2h-2.2Z"/><path d="M9.4 20.6v-2.2M12 20.6v-2.2M14.6 20.6v-2.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>' },
};
function reactionIcon(e) {
  const r = REACTIONS[e]; if (!r) return "";
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${r.d}</svg>`;
}
const reactionName = e => (REACTIONS[e] || { name: "reaction" }).name;
/* Wire icons declared in the markup, so the HTML stays free of path data. */
function paintIcons(root) {
  (root || document).querySelectorAll("[data-ic]").forEach(el => {
    if (el._ic) return;
    el._ic = true;
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.ic));
  });
}

export { ICONS, REACTIONS, FACES, icon, faceKey, faceIcon, reactionIcon, reactionName, paintIcons };
