# Catch to Pick

A mobile-first **number-selection WebView** for The Lott. Picking numbers becomes
a game of catch:

> **Numbered 3D lotto balls fall from above → tap the ones you want → they fly
> into the tray → rare magnet balls pull in several at once → use the numbers.**

There is no score, no lives and no fail state. The reward is the interaction.
It is a *selection* experience only — it never purchases or submits a ticket, it
returns a structured selection to the host app.

The lotto balls are **not a re-implementation**. Catch to Pick reuses the shipped
BallPark visualiser renderer verbatim (`assets/ball-core.js`) — the exact `tetra4`
stamp treatment, matcap, geometry and the four approved product palettes — through
a single thin seam (`src/ballsystem.js`). The tray follows the shipped The Lott
tray reference (transparent slot row over the app background, `footer_bg.png`
control plate below).

---

## Quick start

```bash
# from this folder
npm run dev          # or: python3 -m http.server 8790
# open http://localhost:8790/index.html
```

Product and ticket size come from the URL (or from the host — see below):

```
index.html                                   Saturday Lotto, 6 numbers, 1 game
index.html?product=OzLotto                   7 numbers
index.html?product=Powerball                 7 + Powerball, two-stage
index.html?product=Powerball&games=20        Game 1/20 … Game 20/20
index.html?debug=1                           fps / pacing / row readout
index.html?reducedMotion=1                   force the reduced-motion presentation
index.html?muted=1                           start muted
index.html?seed=42                           DEV ONLY: reproducible run (see below)
```

`?seed=` is **gated**: it is honoured only on `localhost`/`127.0.0.1`/`*.local`,
over `file://`, or when the host sets `window.CATCH_TO_PICK_DEV = true`. On any
other origin it is ignored (and stripped from `?config=`), so a player cannot pin
the number stream from the URL bar.

Tests:

```bash
npm test              # game rules, magnet rules, pacing, simulated sessions (Node only)
npm run test:browser  # real Chromium + WebGL: rendering, capture, magnets, lifecycle
npm run test:all
```

---

## Architecture

Six decoupled layers. The rule that keeps the experience honest:

> **A captured ball's number is committed the instant the finger goes down —
> never when an animation finishes.** Animation is presentation catching up.

That single decision is what makes double taps, simultaneous captures,
backgrounding mid-magnet, WebGL context loss and rapid tapping all leave a valid
row behind.

| # | Layer | File | Responsibility |
|---|-------|------|----------------|
| 1 | Game rules | `src/config.js` | Product table, host-config resolution, validation. Pure, Node-safe. |
| 2 | Game state | `src/gamestate.js` | **The** authoritative state: rows, phase, capacity, uniqueness, commits, result. Pure, Node-safe. |
| 3 | Pacing | `src/director.js` | Issues guaranteed-unique numbers, decides density / velocity / cadence, schedules bursts. Pure, Node-safe. |
| 3 | Magnet rules | `src/magnet.js` | Tier eligibility, weighting, nearest-neighbour resolution. Pure, Node-safe. |
| 4 | Randomness | `src/rng.js` | `crypto.getRandomValues` with rejection sampling; seeded mulberry32 for dev/test only. |
| 5 | Presentation | `src/app.js`, `src/ballpool.js`, `src/particles.js`, `src/audio.js`, `src/tray.js` | Scene, simulation, input, FX, sound, tray DOM. |
| 6 | Host bridge | `src/bridge.js`, `src/analytics.js` | Config in; haptics / analytics / result / close out. Degrades with no host. |

```
        tap                    commit (synchronous, authoritative)
  pointerdown ──▶ hit test ──▶ GameState.capture(n) ──▶ slot index
                                      │
                        ┌─────────────┴──────────────┐
                        ▼                            ▼
              presentation: FLIGHT              phase / row bookkeeping
              (spring to slot, spin,            PRIMARY → BONUS → ROW_COMPLETE
               settle, idle wobble)                    → next row | TICKET_COMPLETE
```

**Coordinate system.** World units are CSS pixels, origin at screen centre, y up,
through an `OrthographicCamera` with a pixel-sized frustum. That is exactly how
the visualiser frames its own balls, so the matcap shading comes through
unchanged — and it makes a DOM-measured tray slot a one-line conversion to world
space.

**Motion is force-based, not tweened.** A captured ball is pulled to its slot by
an under-damped spring, which produces the required shape for free: the fall is
interrupted, the ball accelerates toward the tray, overshoots slightly and
settles. Magnet attraction is a spring whose stiffness *ramps* with time, plus a
decaying tangential term — so a neighbour's fall eases for a beat, then it is
yanked inward along a curve, and the pull takes the same time regardless of how
far away it started.

### Pacing

The field is tuned to **always outrun the player**. A person manages roughly two
aimed taps a second; the calmest setting delivers about 3.7 balls a second and
the busiest about 8.5, so there is never a moment when everything on screen can
be taken. Choosing which ball to go for *is* the interaction.

| | |
|---|---|
| Balls in play | 6–11, hard ceiling 13 during a burst |
| Time to cross the play area | 1.3 s (busy) – 2.1 s (calm), accelerating as it falls |
| Spawn cadence | 0.10 – 0.28 s, faster than the field empties so it stays full |
| Measured miss rate | **71%** at 1.4 taps/s · **65%** at 2.2 taps/s · **41%** at 4 taps/s |
| Balls on screen while playing | ~6 average, 11 peak |

Adaptive pacing still exists, but it is deliberately lopsided: a catch moves the
dial six times as much as a miss, and the dial has a floor. Missing is the *cost
of choosing* here, not a mistake to be compensated for — a player who catches one
ball in four still drives the field busier, and a player who catches nothing
never drops below a real contest.

A dense field clumps, and two overlapping balls hide each other's numbers, so
spawns are placed by best-of-N candidate sampling and falling balls apply a gentle
**lateral** separation force to each other (horizontal only, so fall timing and
therefore the pacing above are untouched). Measured: a full 11-ball field holds at
zero merged pairs with peak sideways speed around 35 px/s — jostling you feel
rather than see.

### Ball lifecycle

`FALL → FLIGHT → SEAT`, or `FALL → PULL → FLIGHT → SEAT`, or `FALL → EXIT`.
Every transition has a failsafe timeout, so no ball can be stranded by a
backgrounded tab, a context loss or a second magnet.

---

## Game configurations

One configurable system, not three implementations.

| Product | Row | Pool | Bonus |
|---|---|---|---|
| Saturday Lotto (`TattsLotto`) | 6 | 1–45 | — |
| Weekday Windfall (`MondayWednesdayFridayLotto`) | 6 | 1–45 | — |
| Oz Lotto | 7 | 1–47 | — |
| Set for Life (`SetForLife744`) | 7 | 1–44 | — |
| Powerball | 7 | 1–35 | 1 × Powerball 1–20 |

Tray layouts are derived, not hard-coded: `● ● ● ● ● ●`, `● ● ● ● ● ● ●`, and
`● ● ● ● ● ● ●   PB` with a visible gap so the two pools never read as one run.

**Powerball is two-stage.** Catch seven blue primaries; the field then clears,
the PB label lights, a short banner and lift sound play, and the field becomes
white Powerballs from the separate 1–20 pool. The pools are never mixed and never
on screen together.

---

## Magnet balls

An `xN` badge means "pulls in **N** balls", so an x6 captures six numbers. The
magnet is a **device, not a number**: it carries nothing into the row, takes no
slot of its own, and is spent when it fires — it discharges on the spot while
the balls it pulled fly to the tray. It renders as a plasma orb rather than a
numbered ball for exactly this reason. The promise is always kept, which drives
two hard rules:

1. **Capacity.** A tier can only exist if `tier <= slotsRemaining`. As the row
   fills, tiers are capped and then the treatment is dropped entirely (one free
   slot cannot hold even an x2). A magnet can never overflow a row. A 6-number
   row is filled exactly by a single x6.
2. **Field.** A magnet arrives **with its own shoal**: the spawner adds however
   many ordinary balls the tier needs, plus one spare. Gating on balls that
   happened to already be falling made the ladder collapse — a player who catches
   well keeps the live field near empty, so x4–x6 were unreachable and a quick
   player saw no magnets at all.
3. **The badge is the promise.** A falling magnet is re-tuned once a frame
   against the settled field, with one spare neighbour of headroom, and again
   **synchronously at the instant of the tap**. If the field genuinely cannot
   supply the advertised tier — two magnets caught in one touch event, say — the
   badge steps down to what is real *before* the animation starts. `xN` delivers
   exactly N numbers, or the badge is no longer showing N. It never lies.

Higher tiers are progressively rarer (`TIER_WEIGHTS` in `src/magnet.js`).
Magnets are disabled during the Powerball stage, which has a single slot. A
magnet caught near a screen edge eases itself inward so the whole gathered group
frames on screen — a captured number is never assembled out of sight.

On capture: pulse ring → neighbours bend inward along curves with energy
filaments → they settle into a rosette around the magnet → the group collapses →
the device discharges and the numbers it pulled cascade to the tray on a
rhythmic stagger. Sound and haptics escalate
with the tier, pinned to one pentatonic scale so what stacks always consonates,
resolving onto a chord at x4 and above.

---

## Host-app integration

### Launch / configure (host → WebView)

Any of these; a global wins over the query string:

```js
window.CATCH_TO_PICK_CONFIG = { product: 'Powerball', totalGames: 5 };
```
```
index.html?product=Powerball&games=5&reducedMotion=1&muted=1
index.html?config=%7B%22productId%22%3A%22OzLotto%22%7D    // uri-encoded JSON
```
```js
window.CatchToPick.configure({ product: 'OzLotto', totalGames: 3 });  // after load
```

| field | meaning |
|-------|---------|
| `product` / `productId` | product key (`Powerball`) or host id (`TattsLotto`, …) |
| `totalGames` | rows on the ticket, 1–20 (drives `Game N/M`) |
| `primaryCount`, `primaryPool` | override the row size / range |
| `bonus` | `{ name, short, count, min, max }` or `null` |
| `reducedMotion`, `muted` | presentation preferences |

Host input is treated as untrusted but well-meant:

- **Numbers may be strings.** `totalGames: "5"` is accepted — native bridges
  routinely stringify, and a whole config used to be discarded over one quote.
- **Out-of-range values clamp** rather than reject: `totalGames: 25` becomes 20.
- **An unknown product falls back and says so.** The unresolvable id is *not*
  carried into `productId`, because emitting Saturday Lotto numbers labelled with
  a host's typo is worse than falling back loudly.
- **Product-specific overrides do not survive a product change.** Naming a
  different product resets `primaryCount` / `primaryPool` / `bonus` and keeps only
  ticket- and presentation-level preferences.
- **Nothing is swallowed.** `configure()` returns `true`/`false`, and every
  coercion, clamp, fallback or rejection is emitted as a `problem` message to the
  host and as a `catchtopick:problem` DOM event.

### Result (WebView → host)

Auto-detected: iOS `window.webkit.messageHandlers.catchToPick`, Android
`window.CatchToPickNative.postMessage(json)`, plus `window.parent.postMessage`
when embedded. Envelope: `{ type, payload, source: 'catch-to-pick' }` with
`type ∈ {ready, haptic, analytics, problem, result, close}`.

On **Use numbers**:

```json
{
  "productId": "Powerball",
  "games": [
    { "primaryNumbers": [3, 10, 11, 14, 16, 33, 35], "bonusNumbers": [8] }
  ],
  "complete": true,
  "source": "catch-to-pick"
}
```

Numbers are sorted ascending; `bonusNumbers` is `[]` for non-Powerball products.
A `close` message follows so the host can populate the game rows and dismiss the
WebView. With no native bridge the result is logged and dispatched as a DOM event:

```js
window.addEventListener('catchtopick:result', (e) => console.log(e.detail));
```

See `integration-example.html` for a minimal web host harness.

### Analytics

Every event goes to the host bridge, to any sink registered with
`analytics.addSink(fn)`, and to a `catchtopick:analytics` DOM event. No PII —
product ids, drawn numbers, counts, tiers and slot indices only.

`catch_game_started` · `ball_caught` · `ball_caught_via_magnet` ·
`magnet_ball_caught` · `magnet_tier` · `ball_missed` · `row_completed` ·
`powerball_phase_started` · `catch_game_completed` · `use_numbers_selected` ·
`game_restarted`

### Haptics

`light` on an ordinary catch · `medium` on x3–x4 and the phase change · `heavy`
on x5–x6 · `success` on row completion and Use numbers. Falls back to
`navigator.vibrate`; silent if neither is available.

---

## Performance

- **One scene, one loop.** Every ball — falling, in flight and seated in the
  tray — is in a single WebGL scene, so a capture is one continuous motion with
  no handoff between renderers.
- **Shared everything.** The shipped factory already shares one `SphereGeometry`
  and caches a matcap material + number texture per (number, colour);
  `src/ballpool.js` adds Mesh recycling, so spawning a ball during play allocates
  nothing. The active pool's textures are warmed during idle time after first
  paint, so no number costs a texture build mid-play.
- **Fixed-size FX pools.** 320 particles, 24 rings, pre-rendered glow sprites per
  colour, and per-frame link/halo/label lists that are reused arrays truncated by
  a count. No allocation in the animation loop.
- **Adaptive quality governor.** A frame-time EMA steps quality down (and back
  up) in the brief's order: particle quantity → halo/bloom strength → filaments →
  rendering resolution (DPR 2.5 → 1.25). **Tap responsiveness is never
  degraded** — hit testing and the synchronous commit are outside the governor.
- **Lifecycle.** `visibilitychange`, `pagehide`/`pageshow` pause the loop and
  suspend the audio context; `dt` is clamped to 1/24 s so a long background gap
  cannot teleport the simulation. `webglcontextlost` / `restored` rebuilds the
  renderer and re-seats the tray from authoritative state. `dispose()` removes
  every listener and closes the audio context.

Measured (Chromium/SwiftShader, far slower than a real GPU), 8 balls in play:

| | |
|---|---|
| Draw calls / frame | **8** — one per ball; 1 geometry, 1 shader program |
| Frame time | median **8.3 ms**, p95 **9.1 ms**, worst **9.5 ms** *including a forced x6* |
| JS heap | **10.7 MB**, unchanged across 4 full Powerball rounds |
| Mesh pool | plateaus at **9** meshes; balls tracked plateaus at 8 |
| DOM nodes | **65**, stable across repeated rows |
| Capture → tray contact | **216 ms**, overshoot **6.3 px** (inside the ring) |
| Magnet held beat | **208 ms** at x2 → **425 ms** at x6 |
| Magnet rate / tier spread | ~4% of spawns, ~0.8 per row, max 2 on screen; x2–x6 all reachable |

Interaction timings worth knowing: the state commit, the squash, the particle
burst and the haptic all run synchronously in the `pointerdown` handler before
anything else, including audio. Creating an `AudioContext` is a one-off platform
cost that can reach 100 ms+ on a cold audio stack, so `unlock()` is deliberately
the **last** thing the first tap does — the reverb impulse and noise buffer are
then built two frames later, off the gesture entirely.

---

## Accessibility

- `prefers-reduced-motion` (or a host flag) keeps the whole mechanic and outcome:
  particles drop to minimum, halos and bloom are cut, capture and magnet paths
  lose their swirl, the field is calmer and slower, bursts are disabled and the
  tray wobble drops to about ±1°. Nothing is removed from the game.
- **The committed row is real text.** Each tray slot carries its number in an
  `aria-label` and in visually-hidden text, and a `role="status"` live region
  reads back "Game 1 of 3. 3 of 8 caught: 6, 17, 14". The balls are WebGL and the
  rings are empty holders, so without this the selection would exist nowhere a
  screen reader — or anyone wanting to check the pick before the irreversible
  **Use numbers** — could reach it.
- Numbers are rendered on the ball at a size that stays legible at the narrowest
  supported portrait width, and repeated as text in the ghost rows — no
  information is carried by colour alone. Falling balls sway about the vertical
  and horizontal axes but **never roll about the view axis**, so a number is never
  upside down; a captured ball's spin resolves onto the upright stamp as it
  seats.
- The tray slot row is a `role="list"`. The audio control is a real toggle button
  whose accessible **name stays constant** while `aria-pressed` carries the state
  — "Unmute sound, pressed" would assert two contradictory things at once. The
  phase banner and hint are `aria-live="polite"`.
- Audio respects a host preference (`window.LOTT_AUDIO_MUTED`), persists the
  user's own choice, and if the audio context fails to initialise every sound
  method degrades to a no-op — sound can never block gameplay.

---

## Mobile hardening

`viewport-fit=cover`, safe-area insets, `100dvh`, `visualViewport` resize
tracking, `touch-action: none`, `overscroll-behavior: none`, no user-select or
callout, `maximum-scale=1`, DPR clamped, orientation recovery that re-measures
the tray and pulls balls back inside a narrower frame, and multi-touch handled
per pointer id so two simultaneous taps both land.

The playfield's floor is the top of the **label** row, and a missed ball fades
where it left the field rather than continuing at full speed, so falling balls
never share pixels with "YOUR NUMBERS / Game N/M / PB", the slot rings or the
controls. Captured balls still fly through that band into their slots — that
motion is purposeful and brief.

Taps are collected by `#ctp-input`, which sits *beneath* the tray chrome (so tray
buttons keep their input) and *beneath* the pointer-transparent canvases (so the
balls can paint over the tray rings). The tray's own box is
`pointer-events: none` except for the control plate: while it was pointer-opaque,
its 52px of top padding sat over live playfield and silently swallowed every real
touch aimed at a low ball.

Slot rings are size-capped and the ball radius is derived from **both** viewport
dimensions, so a wide (landscape) viewport cannot inflate the tray vertically and
squeeze the playfield out. Verified at 320×568, 390×844, 430×932 and 844×390.

---

## Files

```
Catch/
├── index.html                 entry — viewport hardening, canvases, input surface, boot
├── styles.css                 tray reference, tokens, safe areas, reduced motion
├── src/
│   ├── ballsystem.js          the ONLY seam onto the shipped ball renderer
│   ├── config.js              (1) product rules
│   ├── gamestate.js           (2) THE authoritative game state
│   ├── director.js            (3) spawn pacing + unique number issuing
│   ├── magnet.js              (3) magnet tier rules
│   ├── rng.js                 (4) CSPRNG + seeded dev generator
│   ├── ballpool.js            (5) Mesh pooling over the shipped factory
│   ├── particles.js           (5) pooled 2D FX overlay
│   ├── audio.js               (5) original Web Audio synthesis
│   ├── tray.js                (5) tray DOM + slot geometry
│   ├── app.js                 (5) scene, simulation, input, orchestration
│   ├── analytics.js           (6) event hooks
│   └── bridge.js              (6) native WebView bridge
├── assets/
│   ├── ball-core.js           shipped visualiser core (Three.js + the ball renderer)
│   ├── SharpGroteskMedium22.woff2
│   └── footer_bg.png          tray control plate, from the UI reference
├── test/
│   ├── harness.mjs
│   ├── logic.test.mjs         rules, magnets, pacing, simulated sessions
│   └── browser.test.mjs       Playwright + real WebGL
└── integration-example.html   minimal web host harness
```

---

## Known limitations

- **Ball-core coupling.** Visual fidelity comes from importing the shipped
  `ball-core.js` bundle (~2.2 MB, includes Three.js and RAPIER). If that bundle's
  single-letter export map changes, `src/ballsystem.js` is the one file to fix.
  RAPIER is bundled but unused here — the field simulation is our own lightweight
  integrator.
- **x6 needs a 7-slot row.** On a 6-number game the largest keepable promise is
  x5. This is a consequence of never overflowing a row, not a bug; the badge
  downgrades rather than over-promising.
- **Landscape is a fallback, not a target.** It stays playable — the tray
  collapses and the balls shrink — but the play band fits about four ball heights
  against twelve in portrait. The experience is designed for portrait.
- **PowerHit / system entries** are out of scope — one primary row per game.
- **Playwright is borrowed.** The browser suite resolves Playwright from a
  sibling repo's install via `NODE_PATH` rather than adding a test framework to
  this project. Adjust the path in `package.json` if that sibling moves.
- **Supplementary numbers** are not customer-selected and are intentionally
  excluded.
- **`getImageData` console warnings.** `ball-core.js` builds its number and
  matcap textures with canvas readbacks, so Chromium logs a
  `willReadFrequently` hint once per texture while the pool warms. It comes from
  the shipped bundle, not from this code, and silencing it would mean patching
  the bundle we were asked to reuse verbatim.
- **First-tap audio.** On a cold audio stack the very first catch can be silent
  for a few milliseconds while the context comes up; the commit, the squash and
  the haptic are never delayed by it, and the sound is replayed as soon as the
  graph exists.
