# Design integration — client module contract

Implements the `TRUMP.dc.html` design (claude.ai/design project `3589aae9`) over the existing
client. `app/index.html`, `app/solo.html` and all five files in `app/css/` are **already written**
and are the authority: read them before writing any renderer, and never invent a class or id that
is not in them.

A verbatim copy of the design source is at
`/tmp/claude-1000/-home-podip-projects-trump-multiplayer/60e5ffbd-5ccf-425c-85fb-c1964ea93013/scratchpad/TRUMP.dc.html`
(1636 lines; markup 61–611, logic 613–1634). Its `renderVals()` (1153–1631) is the reference for
every derived string, colour and layout number below.

## Non-negotiables

These are pinned by `test/pwa.test.js` / `test/client.test.js` and must survive verbatim:

* `deck.js` keeps the literal `createElement(asButton ? "button" : "div")`; `hand.js` keeps
  `cardEl(card, true)`, `wrap._sig`, `document.activeElement`, `.focus()`, `dataset.k`, and
  `setAttribute("aria-label", label)`.
* `log.js`/`chat.js` keep `syncWindow(` and must not contain `.innerHTML = ""` inside
  `renderLog`/`renderChat`.
* No `console.log(` and no `debugger` anywhere under `app/js/`.
* Every message type the client sends must still appear as `send({ type: "…" })` somewhere under
  `app/js/`: `bid trump call play chat emote ready start sit stand kick settings back newMatch`.
* Client must still test `m.type === "joined" | "state" | "emote" | "error"` and every
  `m.code === "…"` the room core defines.
* `DIFF_OPTS`/`DEAL_OPTS`/`TIMER_OPTS` stay exported from `screens/lobby.js` with the same values.
* `EMOTES` in `cards/icons.js` stays exactly `["👏","😂","😱","🔥","🤝","💀"]`.
* **No module may touch `document`/`window`/`navigator`/`localStorage` at top level** — only
  inside a function (`test/client-modules.test.js` imports every file under Node with no DOM).
* Imports are relative, never `/js/...`.

## New view fields

`app/js/core/engine/match.js` + `play.js` gain a public trick history. All of it is information
every seat already saw, so it carries no redaction risk:

```js
// G.tricks — pushed by resolveTrick(), reset by deal()/createMatch()
{ no: 1..13, winner: 0..3, pts: number, cards: [{ player, card }], winCard: {suit,rank} }
```

`publicView(G)` gains:

```js
tricks: G.tricks.map(t => ({ no, winner, pts, cards: t.cards.map(c => ({...})), winCard })),
calledCard: G.teamsRevealed ? G.calledCard : null,
```

`src/core/room/view.js` needs no change (it spreads `publicView`).

## Colour / string helpers (design parity)

| thing | rule |
|---|---|
| avatar hue | keep `nameHue(name)`; the disc is `oklch(.72 .13 var(--h))` — set `--h` only |
| bidding side | `--acc`; defenders are simply un-lit. There is no second team colour |
| contract bar | `--ok` once `dPts >= bid`, else `--acc` (class `ontrack` on the `<i>`) |
| trick pts ≥ 20 | felt flash + `big` sound + points chip |
| chips | 30 → `big` (28px, brass), else 10/5 (21px, stock); max 7, 105 ms apart |

## Module contract

Every renderer takes the view as its **first argument**. Nothing outside `screens/` and `main.js`
may import `session.js` or `net.js` — that is what let solo re-use the whole table this time.

### `app/js/cards/labels.js`
Unchanged exports, plus `suitClass(suit)` → `"s-h red"` style class string (`SUIT_KEY` + `red`
for ♥/♦).

### `app/js/cards/deck.js`
```js
cardFace(card, compact)   // inner HTML: <svg viewBox="0 0 240 336">…</svg> + .idx spans
cardEl(card, asButton)    // <div|button class="card s-x [red]"><span class="face">…</span><span class="back"></span></div>
miniCardEl(card, asButton)// <div|button class="mini-card s-x [red]"> + cardFace(card,true)
cardBackEl()              // <i class="card-back">
```
* Full face = pips/court as today (`PIP_LAYOUT`, `courtFigure`, ace = one big centred pip) plus a
  `<rect class="cfr" x="42" y="40" width="156" height="256" rx="9">` frame on courts only.
* The corner index is **HTML, not SVG text**: `<span class="idx tl">A<svg class="su">…</svg></span>`
  and the same with `class="idx br"`. Compact gets one `.idx` and one centred suit path
  (`translate(126 220) scale(1.12) translate(-50 -50)`), no frame, no second index.
* `.card` colour comes from the class (`s-h red` etc.), never an inline style.

### `app/js/cards/icons.js`
Add `sound`, `mute`, `flip`, `sort` to `ICONS` (24-grid, 1.7 stroke, same visual family).
`flip` = the design's box glyph `M4 8.5 12 4l8 4.5 / M20 8.5v7L12 20l-8-4.5v-7`.
`sort` = `M4 6h11 / M4 12h7 / M4 18h4 / M17 10v9 / M14 16l3 3 3-3`.
Leave `EMOTES` and `REACTIONS` alone.

### `app/js/util/prefs.js`
```js
setFourColor(on) · initPrefs() · getPref(key, dflt) · setPref(key, value)
```
`getPref`/`setPref` wrap `localStorage` in try/catch and are the only place that touches it here.

### `app/js/ui/sound.js` *(new)*
```js
initSound()            // read pref, paint #btn-sound, no AudioContext yet
toggleSound() -> bool  // flip + persist + repaint + a confirming "chip"
soundOn() -> bool
sfx(name)              // no-op when muted; lazily creates the AudioContext
```
Kit (design lines 775–809, copy the synthesis verbatim):
`deal flip play sweep big chip click bid pass trump reveal made set win tick`.
Persist under `trump_sound` ("1"/"0"), default on. `navigator.vibrate` guarded in try/catch.

### `app/js/ui/layout.js`
```js
fitTable() · setRingEl(el) · tickTimers() · startTicking() · initResize() · setTurnBar(pct, urgent)
```
`fitTable()` measures `#table` and `#action-tray` and writes onto `#table`:
```
--trickw/--trickh  --reach-x/--reach-y  --seat-scale  --tray-lift
```
using the design's formulas (lines 1196–1210, 1271–1275):
```
compact   = innerWidth < 900
shortFelt = tblH < 300
trkW      = round(max(40, min(compact?60:84, min(tblW*.19, tblH*(shortFelt?.19:.25)))))
trkH      = round(trkW*1.4)
reachX    = max(44, min(compact?78:134, tblW/2 - trkW/2 - (compact?88:230)))
reachY    = max(24, min(compact?62:104, tblH/2 - trkH/2 - (shortFelt?60:compact?54:74)))
seatScale = max(.7, min(compact?.88:1, tblW/470))
trayLift  = #action-tray.classList.contains("show") ? its offsetHeight : 0
```
It also toggles `#medallion.tight` (`tblH < 200`) and hides the medallion entirely when
`tblH - trayLift < 260` — the tray owns the bottom of a short felt, and the number it would
show is already in the rail and the prompt.
`tickTimers()` keeps the avatar ring (`--p`, `.urgent`) **and** now drives `setTurnBar()`.

### `app/js/ui/table.js` *(new — shared by both clients)*
```js
renderTable(v, o)
```
`o = { mySeat, posOf(seat), seatInfo(seat), activeSeat, role(seat), sideOf(seat), thinking }`
where `seatInfo` returns `{ name, isAI, connected, away }` and `role` returns `{c,t}|null`
(classes `bidder partner def passed`).

Renders, into the ids already in the markup:
* the four `.seat` blocks — plate classes `active`, `won`, `team-d`, `away-seat`, `thinking`;
  `.who`, `.meta` (`N pts · M tricks`), `.role`, `.dealer-btn`, `.bidchip`, avatar (+`ticking`),
  `.hand-backs` (one `.card-back` per `v.handCounts[seat]`, never for your own seat),
  `.pile` (one `<i style="--pr:Ndeg">` per trick that seat won, `title="Trick 4 · 20 pts"`).
* `#medallion` — the design's centre plaque (`centreLabel/centreMain/centreSub`, lines 1290–1299),
  shown only while `v.trick` is empty.
* `#trick` — reuse existing nodes so only a newly played card animates (keep today's `dataset.k`
  prefix check). `.trick-card.pos-N` where N = `posOf(play.player)`; `.winner` on the winning slot
  at `trickEnd`.
* the trick-end beat, driven by a module-local memo of the last resolved trick key:
  `#points-chip` (`+pts`), `#flash.on` and chips when `pts >= 20`, then `.sweeping` on every
  trick card (with `--sx/--sy` pointing at the winner's position) after ~780 ms.
* `#turn-glow` `.on`/`.urgent`.

Sound is called from here for `play`/`big`/`sweep`/`chip` only.

### `app/js/ui/rails.js` *(new — shared)*
```js
renderContract(v, o) · renderScoreboard(v, o) · renderTricks(v, o)
```
`o = { mySeat, sideOf(seat), target, settingsHtml? }`.
* `renderContract` fills `#contract-suit/-bid/-side/-fill/-captured/-remain`, the
  `#called-card-row`/`#bonus-card-row` pairs (`.show` when applicable, `#bonus-card` gets `dim`
  once someone has taken it) **and** the phone `#contract-strip` (suit · bid · bar · captured ·
  bonus/called thumbs).
* `renderScoreboard` builds `#scoreboard` as today's `<table class="score">` but with
  `td.name / td.pts / td.deals`, row classes `you side-d side-o`, tally pips when
  `target <= 5`, plus `#contract-line` and (if present) `#settings-line`.
* `renderTricks` fills `#sec-tricks` (`.show` once teams are revealed), `#my-tricks-count`
  (`"3 · 45 pts"`), `#last-trick-note`, and one `.trickrow` per trick you won, newest first,
  each with four `miniCardEl(card)` (the winning card gets `.win`).

### `app/js/ui/hand.js`
```js
renderHand(view, onPlay) · fitHand(wrap) · initHandTools(onChange) · resetHandFor(roundNumber)
```
* Module state: `faceUp` (a `Set` of `suit+rank`), `sorted` (persisted `trump_sort`), and the
  round number the `faceUp` set belongs to — a new deal clears it.
* Cards deal **face-down**: `.card.down` until tapped. A tap on a face-down card turns it over
  (`sfx("flip")`); a tap on a face-up legal card plays it. `.playable` / `.illegal` /
  `.legal-hint` (only when `legal.length < hand.length`) / `.trumpcard` / `.bonuscard` /
  `.suit-start`. The trump run gets one `.tag` ("TRUMP") on its middle card; the bonus 3 gets
  `.tag.bonus` ("+30").
* `--rot`/`--dy` fan as today (`t*6deg`, `t*t*8px`); `--dfx/--dfy/--dfr` per card for the deal-in,
  with `animation-delay` staggered `i * 46ms`; `fitHand` keeps today's measured `--ml` logic but
  against `#my-hand`'s own width.
* aria: face-down cards read `"Turn over card 3 of 13"`, face-up ones keep `cardName` +
  `(trump, bonus 30)` and gain `"Play "` when legal.
* `initHandTools` wires `#btn-flip` (turn all over / all back) and `#btn-sort`, toggling the
  buttons' `.on` and `aria-pressed`, and calls `onChange()` to force a repaint.
* `#hand-tools.show` whenever the hand is non-empty.

### `app/js/ui/actionbar.js`
```js
renderActionBar(v, h) · phaseLabel(phase)
```
`h = { bid(value), pass(), trump(suit), call(card), ready(), nextDeal() }` — any may be absent.
Fills `#action-bar` (one `.prompt` span, `data-turn="you"|"other"`), `#action-tray`
(`.show` only when there is something to decide), `#action-buttons`, `#call-grid`, `#hand-hint`.
Copy the design's prompts and hints verbatim (lines 1302–1362). Bid stepper state is module-local
and keyed on `roundNumber + "|" + (highBid||0)`, exactly as `S.humanBidValue`/`S.bidCtxKey` were.
Buttons: `Pass` `−5` `<bidval>` `+5` `Bid N`(`.primary`); four `.act-btn.suit` for trump; the call
grid is `.call-row` per suit with `miniCardEl(card, true)` (`.bonus` outline on the bonus 3).

### `app/js/ui/log.js`
Keep `syncWindow` byte-for-byte. `renderLog(view)` builds
`<div class="entry CLS"><span class="t">HH:MM</span><span>…</span></div>`, where the clock is the
time the client **first saw** that entry (a module-local `Map` from window key → time), because
the wire carries no timestamps. Card names inside the text keep `textWithCards`.

### `app/js/ui/chat.js`
Same exports. `openSheet(tab)` now targets `#rail-left` for `score` and `#rail-right` for
`log`/`chat` (setting `#rail-right`'s `data-tab`); `closeSheet()` closes both. Chat rows become
`<div class="msg [you]"><span class="from">Name:</span> text</div>`. Emote buttons keep
`send({ type: "emote", e })`.

### `app/js/ui/modals.js`
```js
setModal(kind, html) · hideOverlay() · showHelp(view) · showSettingsModal() ·
showMatchOver(view, onRematch) · showRoundResult(v, o, h) · maybeShowReveal(v, o) ·
hideReveal() · setRenderHandler(fn)
```
* `showHelp` renders the design's five numbered steps (lines 680–686) into `.modal.wide` with a
  `.how` list, substituting `view.consts`.
* `showRoundResult` is the design's deal-result panel: kicker, `MADE`/`SET` head, sub, progress
  bar, the `.review` block ("Where the 250 went" split bar over `v.capturedPoints`, plus the four
  review rows from lines 1528–1535), `.standings`, and one button — `h.ready()` in multiplayer
  (label mirrors today's `Ready ✓ — waiting 2/3`) or `h.nextDeal()` in solo.
* `maybeShowReveal(v, o)` shows `#reveal` the first time `v.teamsRevealed` flips true in a deal:
  kicker (`THE CALLED CARD`, or `NOBODY HOLDS IT` when declarer === partner), the called card via
  `cardEl`, the two names, then the tail line, staged ~820/1680 ms apart and auto-hidden after
  3.4 s or on tap. `sfx("reveal")`.

### `app/js/screens/join.js` · `lobby.js`
Same exports and the same `send()` calls; only the produced markup changes to the classes in
`app/index.html` (`.seatrow`/`.pill`/`.dot`, `.setrow > .lbl` + `.opts`, `.btn`).
`lobby.js` also wires `#btn-lobby-leave` → `leaveRoom("")`.

### `app/js/screens/game.js`
Orchestrates: `render()` picks the screen, `renderGame()` calls
`renderTable → renderContract → renderScoreboard → renderTricks → renderHand → renderActionBar →
fitTable → renderLog → renderChat → tickTimers → maybeShowReveal`, and owns the multiplayer
handler object passed to `renderActionBar`/`showRoundResult` (each one a `send({type:…})`).
Keeps `orient/seatAtPos/posOfSeat/sideOf/activeSeat/roleOf` exported.
`fitTable()` still runs **after** the action bar — the tray's height is what `--tray-lift` needs.

### `app/js/solo.js`
Unchanged game loop (`step`/`apply`/`paint`/`toStart`/`gen`/`paused`). `render(v)` now calls the
same shared renderers with a solo `o`/`h` (`posOf: s => s`, `isAI: s => s !== 0`,
`nextDeal: () => { E.nextDeal(G); paint(); step(); }`). Delete solo's private
`renderSeats/renderTrick/renderMedallion/renderScoreboard/renderActionBar/bannerForPlay` — they
are the shared modules now. It must still define none of the engine functions
`test/solo.test.js` bans.

### `app/js/main.js`
Wires `#btn-sound` → `toggleSound()`, `#btn-flip`/`#btn-sort` via `initHandTools(render)`,
`#btn-lobby-leave`, the colophon (`<i class="bar"></i><span>250 points · bid &amp; capture</span>`),
the hero fan (`♠A ♥K ♦10`, rotations `-7/0/7deg`, delays `.10/.21/.32s`), `initSound()`, and the
existing PWA/share/keyboard/tab wiring.

## Finishing

`npm run build:assets` then `npm test` — both must be clean. Update `docs/STRUCTURE.md` for the
three new modules (`ui/table.js`, `ui/rails.js`, `ui/sound.js`) and add a `ROADMAP.md` decision
entry for the redesign.
