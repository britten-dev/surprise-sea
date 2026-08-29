# surprise-sea — review and upgrade roadmap

A senior graphics/simulation review of the library at this repo, against the
state of the art for real-time browser oceans in 2025–26. Every claim about
the code was checked against source; `npm test` passes 46/46.

The law this review is written under, from CONTRACT.md:

> The CPU and the GPU must describe the same water.

Every proposal below states what happens to that identity. Three outcomes are
allowed: **preserved** (both halves compute the same sum), **sub-30cm**
(degraded only where physics never looks), or **strategy** (an explicit plan
for keeping CPU truth).

---

## 1. Verdict

surprise-sea is a well-built 2020-era ocean with 2026-grade architecture. The
state of the art in the browser has moved to GPU spectral seas: three-cascade
inverse-FFT oceans running as WebGPU compute (Poseidon in three.js/TSL; WebTide
and Popov's OceanDemo in Babylon), with foam accumulated where the displacement
Jacobian folds, exact Fresnel against a real sky, Henyey–Greenstein subsurface
scattering, and spray particles culled by the foam field (GodotOceanWaves; the
commercial Tidewater kit even keeps a CPU mirror of its FFT for buoyancy).
Against that field: the look grades **C+** — the art direction (backlit crests,
damped fresnel, wind-streaked spindrift, sea-state-scaled foam) is B+ and reads
convincingly as a heavy sea, but the surface carries only 12 Gerstner
components plus a fake fbm ripple, foam has no memory so broken water heals the
instant the pinch passes, reflections are a two-colour ramp rather than any
sampled sky, and nothing is ever torn off a crest. The physics grades **A−** —
no browser ocean I can find ships anything like the Hull broach model, and the
Newton-inverted `heightAt` is more rigorous than most published buoyancy
samplers, which either skip inversion entirely or fixed-point iterate. The
architecture grades **A**: a deterministic, dependency-light, 46-test library
with an exact CPU/GPU contract is precisely the foundation the FFT crowd
lacks — their water looks better and answers no questions. The gap is
closable: everything the exemplars do visually can be layered onto this
identity rather than replacing it.

### What the best do that we do not

Surveyed exemplars (all verified live or from source in Aug 2026):

- **GPU FFT spectral seas / Tessendorf cascades.** [Poseidon](https://github.com/owenyuwono/poseidon)
  runs three inverse-FFT cascades (1024/144/24 m patches) as WebGPU compute in
  three.js/TSL, on a ~790k-vertex camera-centred radial grid out to 20 km.
  [WebTide](https://github.com/BarthPaleologue/WebTide) and
  [OceanDemo](https://popov72.github.io/OceanDemo/) do the same on Babylon.
  Result: continuous spectral content from 300 m swell down to centimetre
  ripple. Our sea carries 12 discrete components (`waveCount` default 12,
  `spectrum.js`), from the dominant train down to a `chopLength` of 1.6–16 m,
  and then *pretends* below that with a value-noise ripple normal
  (`ocean.js:131–138`) that fades by 900 m. From the helm it holds up; from
  the albatross's 10 m skim, the ~1–10 m band is visibly synthetic.
- **Jacobian foam accumulation.** The standard is: compute the Jacobian of the
  horizontal displacement, inject foam where it approaches folding, then
  *accumulate* it in a texture with decay and advection so broken water stays
  scarred ([jdupuy/whitecaps](https://github.com/jdupuy/whitecaps), Poseidon,
  [GodotOceanWaves](https://github.com/2Retr0/GodotOceanWaves); Sea of Thieves
  does the accumulation with a progressively blurred feedback buffer,
  [SIGGRAPH 2018 talk](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)).
  Our `vCrest` (Σ q·k·A·sinθ) is a first-order cousin of the Jacobian — a
  perfectly good breaking signal — but it is evaluated instantaneously:
  `smoothstep(uFoamLo, uFoamHi, vCrest + …)` at `ocean.js:177`. Foam appears
  on the pinch and vanishes with it. Real foam outlives its wave by half a
  minute.
- **Spray systems.** GodotOceanWaves spawns billboarded spray particles culled
  by the foam field; Poseidon streaks its whitecaps downwind. We ship nothing
  in the library. The albatross game has `spume.js` (147 lines, wind-carried
  points off breaking crests) and bow-spray in `ship.js`, and neither has been
  ported.
- **Reflections.** Poseidon uses exact dielectric Fresnel (n = 1.34) against a
  sky it actually evaluates. We mix two uniform colours by
  `smoothstep(-0.08, 0.45, reflDir.y)` (`ocean.js:160–162`) — a ramp that only
  approximately matches the sky dome the demo draws with a *different*
  two-smoothstep formula (`demo/main.js:630–632`). The seam is invisible in
  fog but the reflected sky carries no sun position, no haze anisotropy, no
  cloud.
- **Subsurface scattering.** The exemplars use a forward-scattering lobe
  (Henyey–Greenstein in Poseidon) driven by sun-behind-surface geometry. Our
  backlit crest glow (`ocean.js:153–156`) is a height-band × view-direction
  heuristic — art-directed, effective, but it does not respond to the actual
  thinness of a crest between the eye and the sun.
- **Breaking waves.** Nobody in the browser does true plunging breakers in a
  deep-water sea; the honest state of the art is foam + spray + crest
  deformation. (The research frontier is hybrid wave-particle/FFT coupling,
  e.g. [arXiv 2511.02852](https://arxiv.org/pdf/2511.02852), not shipped
  anywhere.) So our omission here is shared with everyone; the difference is
  the exemplars *disguise* the un-broken crest with accumulated foam and
  spray, and we do not.
- **WebGPU compute.** As of late 2025 WebGPU ships by default in Chrome, Edge,
  Safari 26 and Firefox 141+ ([web.dev](https://web.dev/blog/webgpu-supported-major-browsers)),
  and three.js `WebGPURenderer` (with WebGL2 fallback) is on a path to stable.
  We are a WebGL `ShaderMaterial` library. That is the right call today for
  phone reach, but the ceiling is visible.
- **Buoyancy approaches.** Most FFT demos have no physics at all, or read the
  displacement texture back asynchronously (a frame late, interpolated).
  [Tidewater](https://ilikekillnerds.com/2026/05/21/i-built-tidewater-threejs-ocean-kit/)
  — the closest commercial analogue to this library — keeps a CPU mirror of
  its FFT for buoyancy, which validates our architecture from the other
  direction. Our four-point sample with Newton inversion is *stronger* than
  any of these: exact, same-frame, deterministic.

### Grades

| Axis | Grade | One line |
| --- | --- | --- |
| Look | **C+** | B+ art direction on a D surface-detail budget; no foam memory, no sampled sky, no airborne water. |
| Physics | **A−** | Best-in-class sampling identity and the only seakeeping model in the field; phenomenological by design, and honest about it. |
| Architecture | **A** | Deterministic, tested, one dependency, clean seams (`SeaState` → `WaveField` → consumers), GLSL generated from the same table the CPU walks. |

---

## 2. What it does well

Worth defending, in order:

- **The identity itself.** The wave table is built once (`spectrum.js`), the
  CPU walks it (`seastate.js`), and the GLSL is *generated from it*
  (`oceanVertexChunk`, `seastate.js:296`). A test walks the shader sum by hand
  against `displacedPointAt`. No exemplar surveyed has this property; most
  cannot say where their water is.
- **Newton-inverted sampling.** `undisplacedAt` does three Newton steps on
  u + D(u) − x with the exact 2×2 Jacobian (`seastate.js:114–147`), landing
  the residual near a micron where naive fixed-point leaves half a metre at
  storm pinch. The comment explaining why is a model of engineering writing.
- **Determinism.** One seeded LCG, random draws in fixed order so adding a
  component never reshuffles the earlier ones (`spectrum.js:191–199`). Same
  options, same sea, every machine. This is what makes a two-ship pursuit game
  even possible without networking pain.
- **Set-structured swell.** The dominant train split three ways
  (±5–7°, slightly different speeds) so the sea arrives in sets with lulls.
  This is the single cheapest realism trick in the whole codebase and most
  big-budget oceans do not bother.
- **The seakeeping model.** `hull.js` gets the *feel* right: surge on the
  face, rudder authority collapsing exactly when surfing demands it
  (`hull.js:256–263`), quartering-sea yaw from athwartships slope
  differential, a broach latch with an honest three-term risk blend, pooping
  with hysteresis. Every constant is named, unit-ed and documented.
- **Cost profile.** One draw call, ~124k vertices (352² warped grid), 12-wave
  loop per vertex with per-wave distance attenuation, fragment shader that is
  all ALU and zero textures. It runs on a phone at 240² with antialias off
  (`demo/main.js:85–91`). The exemplars start at "requires WebGPU" and go up.
- **Sea-state-agnostic foam.** `foamProfile` (`ocean.js:222–258`) expresses
  thresholds in standard deviations of the sea's own pinch and height, so one
  shader serves millpond to greybeards untouched.

### Fine print on the identity (current, pre-existing)

Three places the halves already diverge, all deliberate, all worth knowing
before reading the roadmap:

1. **Normals.** CPU `normalAt` is a 22 m finite difference of `heightAt`;
   the GPU normal is the analytic per-vertex Gerstner normal. Height identity
   is exact; normal identity is approximate by design (physics *wants* the
   smoothed slope — `hull.js` says so).
2. **Distance attenuation.** The GPU fades each wave by
   `exp(-camDist / (L·45 + 600))` (`seastate.js:317`); the CPU never does. In
   the storm preset this is ~16 cm of missing dominant amplitude at 1 km —
   invisible. But note for the pursuit game: a second ship 1–2 km off rides
   CPU water very slightly taller and considerably choppier than the mesh
   under it. At that range it will not read, but if her heave is ever compared
   against far crests in-frame, evaluate the same attenuation CPU-side for
   her *visual* placement only.
3. **The ripple normal.** The fbm ripple (`ocean.js:131–138`) is already a
   visual-only detail layer the CPU never sees, at ~30 cm–3 m scale. The
   precedent for "degrade where physics never looks" exists in the shipped
   shader; the roadmap extends it, it does not invent it.

---

## 3. Roadmap

Ranked by visible-jump-per-effort, weighted toward the helmsman game (the next
title) and the specific request for crest spray. Costs: dev effort in days
(S ≤ 2, M ≤ 5, L ≤ 10, XL more), runtime on desktop (M1/RTX class) and phone
(mid-range Android).

### R1. Crest spray — particles torn off breaking crests

- **On screen:** white water ripped from a crest the moment it pinches past
  breaking, thrown downwind in a flat ballistic arc, dying into the back of
  the next sea. From the helm view, spray comes over the taffrail out of the
  overtaking crest; from the albatross, streaks whip beneath the wings.
- **Sketch:** new `src/render/spray.js`, generalising the game's `spume.js`
  (already proven, 147 lines). A fixed pool of GPU points (2–4k desktop,
  800 phone). Spawn test: `sea.crestAt(x, z, t) > kSpawn · crestSigma` — use
  the sea-relative sigma from `foamProfile` (export it from `ocean.js` or
  recompute; do *not* hard-code the game's `0.3`, which is storm-tuned).
  Initial velocity = `sea.orbitalVelocityAt(x, z, t)` + `air.wind × 1.15` +
  upward kick ∝ local pinch; gravity −9.81; life 0.8–2.5 s; two classes —
  short ballistic droplets (crest burst) and the existing surface-hugging
  spume streaks. Own seeded LCG, like spume's. Camera-radius spawn window
  (spume's `RANGE = 320`) scaled by view height. Update on CPU: ~3k ×
  (one `crestAt` on spawn + one `roughHeightAt` per frame) — trivial next to
  the hull's four `heightAt` samples.
- **Cost:** dev M (2–3 d). Runtime ~0.3 ms CPU + negligible GPU desktop;
  ~0.5 ms phone at reduced count.
- **Identity: preserved.** Spawns and rides *the CPU sum itself* via
  `crestAt` / `roughHeightAt` / `orbitalVelocityAt`. Decorative height via
  `roughHeightAt` exactly as CONTRACT.md prescribes.
- **Serves:** all three; the albatross most (it flies in it), helmsman a
  close second (the view aft is the game).

### R2. Persistent foam — a scar field the sea remembers

- **On screen:** broken water stays white behind the crest that broke it,
  stretching into wind-lanes and fading over ~30–60 s. The greybeards preset
  stops looking freshly laundered between sets. This is the single largest
  gap between us and every exemplar.
- **Sketch:** a camera-following ping-pong render target (`src/render/foamfield.js`),
  512² covering ~1.5 km (phone 256²). Each frame, a fullscreen pass:
  read previous, decay by `exp(-dt/τ)` (τ ≈ 45 s), advect one texel-ish
  downwind, add injection. Injection evaluates **the same crest sum** —
  reuse `oceanVertexChunk`'s uniforms in a tiny fragment shader computing
  Σ q·k·A·sinθ over the texel's world position, thresholded by the
  `foamProfile` numbers. Blur-on-feedback (Sea of Thieves style) softens it
  for free. World-anchored UVs; when the window recentres, offset-copy.
  `ocean.js` fragment gains one texture sample added into `foam` before the
  `mix` at line 195. **Stage 0 (pure ALU, no RT):** before building any of
  that, fake memory by evaluating the crest sum at `t − τ` for τ ∈ {2.5, 5} s
  in the vertex shader with decayed weights — two extra 12-wave loops per
  vertex, leaves trailing foam where crests were. Ships in an afternoon and
  tells you how much the full field is worth.
- **Cost:** Stage 0 dev S, runtime ~free. Full field dev M–L (4–6 d),
  runtime ~0.2–0.4 ms desktop, ~0.6 ms phone at 256².
- **Identity: preserved for the surface; strategy for the foam.** Geometry
  untouched. The foam *field* is GPU-state the CPU cannot see; if gameplay
  ever wants "am I in broken water" (spume spawning, drag), expose the same
  answer CPU-side as a decayed max of `crestAt` over the last N seconds — an
  approximation of the texture, documented as such in CONTRACT.md. Physics
  proper never reads foam.
- **Serves:** helmsman and pursuit equally; it is what makes a storm look
  survived-in.

### R3. Ship wake carved into the foam field

- **On screen:** ships plough a persistent white lane that spreads, drifts
  with the wind and heals — no more ribbon mesh floating 0.45 m proud of the
  water (`ship.js:866` in the game does exactly that, and it shows). Two
  ships in the pursuit game leave two crossing scars.
- **Sketch:** requires R2. Add a stamp pass: each hull writes a stern-anchored
  quad (width ∝ beam, intensity ∝ speed and `surfFactor`) into the foam RT
  each frame; the field's decay/advection does the rest. API:
  `foamField.stamp(x, z, radius, amount)` so games can also stamp broaches
  (a broach should leave an enormous scar — free drama). Bow-spray particles
  from the game's `_buildSpray` port into `spray.js` (R1) triggered by
  `hull.pitch` rate, replacing `Math.random` with the seeded LCG.
- **Cost:** dev S–M on top of R2 (1–2 d). Runtime negligible.
- **Identity: preserved.** Visual-only; the wake reads hull state, never
  feeds back into it.
- **Serves:** pursuit most (two ships, and reading the other ship's wake is
  gameplay), helmsman second.

### R4. Surface definition pass — per-pixel analytic normals + tone mapping

- **On screen:** the mid-distance (50–500 m) stops looking like lit
  triangles; crest edges resolve per-pixel; glints tighten. Filmic tone
  mapping stops the foam clipping to paper white and buys back the dusk
  preset's dynamic range.
- **Sketch:** the vertex normal is per-vertex on a warped grid — at 300 m the
  cells are metres wide and the interpolated normal is mush, which is why the
  ripple fbm carries so much weight. Move the *normal* evaluation into the
  fragment shader within ~400 m: same 12-wave loop, same uniforms (the
  vertex chunk's formula at `seastate.js:332–336`), evaluated at `vUndisp`,
  blended to the vertex normal beyond. Gate on `uRipple > 0`-style distance
  test; skip on phone (`IS_COARSE` quality flag already exists). Tone
  mapping: `renderer.toneMapping = THREE.AgXToneMapping` in the demo plus
  `#include <tonemapping_fragment>` before the colorspace include in both
  ocean and sky shaders; add `exposure` to the lighting preset object.
- **Cost:** dev S (1–2 d). Runtime: 12-wave loop on ≤ 25 % of fragments,
  ~0.5–1 ms desktop; skipped on phone.
- **Identity: preserved — strengthened.** The per-pixel normal is *the same
  analytic sum*, evaluated more densely. The fbm ripple's job shrinks, and
  the visible surface moves closer to CPU truth, not further.
- **Serves:** all three equally; pursuit most (you spend the game looking at
  the middle distance where the other ship is).

### R5. Sky-coherent reflections — prefiltered procedural-sky cubemap

- **On screen:** the sea reflects the sky that is actually overhead — sun
  glow in the right place, haze at the horizon, the dusk preset's orange in
  the wave backs. Rough-water blur keeps it honest (the shipped comment is
  right: storm seas are poor mirrors — keep the damped fresnel at
  `ocean.js:146`).
- **Sketch:** the sky is procedural and changes only on `setLighting`, so
  render it once per lighting change into a small cubemap (64–128²,
  `CubeCamera` over the demo's sky shader moved into the library as
  `src/render/sky.js` — the demo's dome at `demo/main.js:594` is already
  library-quality), then `PMREMGenerator` for roughness mips. Fragment:
  replace the two-colour ramp at `ocean.js:159–162` with
  `textureCube(uSky, reflDir, roughnessLod)`, roughness driven by foam +
  `uRipple`. Keep the analytic sun-glint lobes. SSR is **not recommended**:
  the only reflectable content is ships; a planar/SSR pass costs 2–4 ms and
  a following sea occludes most of it. Revisit only for the pursuit game's
  calm-preset scenes, if any.
- **Cost:** dev M (2–3 d). Runtime: cubemap rebuild ~0.5 ms *per lighting
  change only*; per-frame cost is one cube sample — free. Phone-safe.
- **Identity: preserved.** Fragment-only.
- **Serves:** all three; biggest in the sun-break and dusk moods.

### R6. Subsurface scattering upgrade

- **On screen:** thin crest shoulders glow green when the sun is behind them
  and stop glowing when it is not; the bottle-green reads as light *through*
  water instead of paint. Currently the glow band is height × backlit-view
  only (`ocean.js:153–156`) and ignores the surface's own orientation.
- **Sketch:** fragment-only. Transmission term ≈
  `pow(max(0, dot(viewDir, -sunDir)), k) · max(0, 1 - n.y)` shaped by a
  thinness proxy: high `vCrest` and high `vHeight` together mean a pinched
  crest between eye and sun. Multiply into `uCrestGlow` with a
  Henyey–Greenstein-ish forward lobe (one `pow`, no LUT). Keep the existing
  height-sigma band as the mask so it stays sea-state agnostic. ~10 lines in
  the water-body section.
- **Cost:** dev S (half a day of tuning against the three lighting presets).
  Runtime free.
- **Identity: preserved.** Shading only.
- **Serves:** albatross most (low sun, low flight, crests against the light
  constantly), then helmsman.

### R7. Spindrift sheets in high wind

- **On screen:** above ~force 9, whole sheets of lace peel off crests and
  sail downwind as translucent veils before shredding — distinct from both
  the surface streak texture (already shipped) and droplet spray (R1). This
  is the greybeards signature; photographs of survival storms are mostly
  this.
- **Sketch:** in `spray.js` (R1), a third particle class: camera-facing
  stretched quads (or `Points` with high `aSize` and a streak texture built
  procedurally), 50–150 alive, spawned only when `sea.windSpeed > 22` and
  local crest pinch is near the budget ceiling. Velocity ≈ wind × 1.3, weak
  gravity, alpha from an fbm mask scrolled along the quad so the sheet
  tatters. Spawn rate ∝ `(windSpeed − 22)`, so `storm` shows a little and
  `greybeards` is full of it.
- **Cost:** dev S–M (1–2 d on top of R1). Runtime negligible; halve counts
  on phone.
- **Identity: preserved.** Reads `crestAt`/`roughHeightAt`, touches nothing.
- **Serves:** helmsman (greybeards is its boss weather) and the albatross.

### R8. Rain and squall curtains

- **On screen:** grey curtains hanging from the cloud base, dragging across
  the sea a kilometre off, flattening contrast where they stand; when one
  crosses the ship, streaked rain and a visibility drop. O'Brian weather.
- **Sketch:** `src/render/squall.js`. Two parts. (1) Curtains: 4–8 large
  world-anchored billboards, vertical gradient alpha × fbm, positions
  drifting with `air.wind`, deterministic from the sea's seed. (2) Local
  rain: a small `Points` pool in camera space, streak-stretched along
  wind + fall velocity. Tie fog to it: `ocean.update()` already owns
  `uFogDensity`; add a `setWeather({ rainFactor })` that multiplies fog and
  desaturates `uSunColour`. Optionally let `AirOverSea` publish squall
  centres (a slow drifting lattice like its streets) so gusts and curtains
  agree — determinism preserved, and the helmsman game gets wind shifts that
  *announce themselves visually*, which is gameplay.
- **Cost:** dev M (2–3 d). Runtime ~0.2 ms desktop, similar phone (few
  big transparent quads — watch overdraw on mobile; cap curtain count at 3).
- **Identity: preserved** (air/visuals only; the surface is untouched). If
  squalls modulate `AirOverSea` wind, the sea *state* still does not change —
  document that rain does not alter the wave table (it wouldn't in reality on
  these timescales either).
- **Serves:** pursuit most (weather gage, losing sight of the chase),
  helmsman second.

### R9. Visual-only detail layer (the honest hybrid-FFT step)

- **On screen:** the 0.3–10 m band stops being noise-normal fakery: real
  travelling wavelets, glitter with structure, close-up water that survives
  the albatross's 5 m skim and the pursuit game's deck views.
- **Sketch:** two stages. **Stage 1 (GPU-only Gerstner extras):** extend
  `oceanVertexChunk` to accept `visualWaveCount` extra components generated
  by the same spectrum code with lengths 0.3–8 m, uploaded in the same
  uniform arrays but *flagged past `NW_PHYS`* — the CPU walks only the first
  `NW_PHYS`. Amplitudes capped so the summed extra height stays < 15 cm
  (the sub-30cm carve-out; cap enforced in `spectrum.js`, tested). 8–12 extra
  components ≈ doubling the vertex loop — fine. **Stage 2 (FFT cascade):**
  one 128² Tessendorf patch (16–32 m tile) evolved in a fragment-shader FFT
  (WebGL2, ping-pong; or a precomputed looping displacement/normal texture —
  64 frames baked at build time costs zero runtime compute and is perfectly
  deterministic), sampled as displacement+normal in the vertex/fragment
  stages, amplitude-capped identically. Stage 2 only if Stage 1's discrete
  components still read as discrete.
- **Cost:** Stage 1 dev M (2–3 d incl. tests). Runtime +0.3 ms vertex
  desktop, gate count on phone. Stage 2 dev L (5–8 d) or M with the baked
  loop; runtime 0.5–1 ms (live FFT) / ~0 (baked).
- **Identity: sub-30cm, by construction and by test.** Add a test asserting
  Σ amp of visual-only components < 0.15 m and that CPU queries ignore them.
  This turns the sacred constraint's escape clause into enforced code rather
  than convention. The existing fbm ripple should *shrink* as this lands,
  keeping total fakery constant.
- **Serves:** albatross and pursuit (close viewpoints); helmsman least (the
  helm view looks at 20–100 m water where the current sum is adequate).

### R10. Night and bioluminescence

- **On screen:** a moonless Southern Ocean night: near-black sea, foam and
  breaking crests picked out in pale blue-green fire, ship wakes as glowing
  scars (R2/R3's foam field *is* the bioluminescence mask, recoloured), a
  star dome. Cheap and unreasonably beautiful.
- **Sketch:** a fourth lighting preset (values only — `setLighting` already
  supports everything needed except one addition: an emissive foam term).
  Add `uFoamEmissive` (colour × strength) mixed where `foam > 0` *before*
  fog; drive it from the lighting object, zero in daytime presets. Stars:
  a hash-based point field in the demo sky shader gated on `skyTop`
  luminance. If R2 shipped, glow rides the persistent field automatically —
  a churned patch glows for half a minute, which is exactly what
  bioluminescence does.
- **Cost:** dev S (1 d, mostly art tuning). Runtime free.
- **Identity: preserved.** Shading only.
- **Serves:** pursuit (night chases are the genre's best chapters) and the
  albatross.

### R11. Breaking-wave geometry — the plunging lip (proceed with caution)

- **On screen:** when a greybeard's pinch hits the budget ceiling, the crest
  visibly topples: a lip thrown forward of the face, an overhang that
  collapses into R1 spray and R2 foam.
- **Sketch:** this is the one item where the identity bill is real. A
  GPU-only lip — extra forward displacement above a pinch threshold — makes
  the eye see water where `heightAt` says none is, exactly where the
  helmsman game's hull and the albatross's wingtips operate. Amplitude-capping
  it under 30 cm makes it invisible; making it visible (1–3 m of thrown lip
  on a 17 m sea) breaks the law at the worst location. The defensible
  version: (a) implement the lip displacement identically on both halves — a
  closed-form "curl" term added to the wave sum, `f(crest) · d̂ · lipGain`,
  in both `displacedPointAt`/`undisplacedAt` (its Jacobian is analytic too)
  and the GLSL chunk — the identity then *holds*, and the Newton inversion
  keeps working provided total pinch + lip stays under the fold; or (b) fake
  it entirely with R1 spray density + a crest-top darkening and never move a
  vertex. Recommend (b) now, (a) as a research branch behind a flag.
- **Cost:** (b) free with R1/R2. (a) dev XL (8–12 d incl. inversion-stability
  work and re-tuning the pinch budget), runtime small.
- **Identity:** (b) preserved; (a) preserved *only via the full strategy
  above* — never ship a GPU-only visible lip.
- **Serves:** helmsman (a broaching sea should be seen to break), but only
  after R1+R2 have proven insufficient drama.

### R12. WebGPU compute as the future path

- **On screen:** nothing, at first — it is headroom: 3-cascade FFT seas,
  512² foam simulation, particle counts ×10, all off the main thread.
- **Sketch:** WebGPU now ships by default in all four engines
  ([Chrome/Edge 113+, Safari 26, Firefox 141+](https://web.dev/blog/webgpu-supported-major-browsers));
  three.js `WebGPURenderer` falls back to WebGL2 and heads to stable. The
  migration that preserves this library's soul: keep `SeaState` as the CPU
  truth *and the low-frequency GPU base* (ported to TSL nodes, mechanical),
  and add FFT cascades as **high-pass-filtered detail only** — zero the
  cascade spectrum below a wavenumber cutoff so everything physics can feel
  stays analytic, everything above the cutoff is bounded by the sub-30cm
  budget (R9 Stage 2 generalised). Poseidon's Stockham-FFT-in-TSL shows the
  compute side is a solved problem. Do not port until a game needs what
  WebGL cannot give; the phone floor still matters more than the desktop
  ceiling for these games.
- **Cost:** dev XL (2–4 weeks). Runtime: compute is ~1–2 ms for three 256²
  cascades on desktop-class GPUs.
- **Identity: strategy, stated above** — analytic base spectrum stays CPU
  truth; FFT content is spectrally fenced out of physics' reach.
- **Serves:** the pursuit game, and the library's next three years.

---

## 4. Quick wins

The 3–5 items for the biggest visible jump per hour, in order:

1. **Spume + crest spray (R1).** The code is already written and shipped in
   the albatross game; this is a port and a generalisation. Concrete notes:
   spawn threshold = `foamProfile`'s `foamLo` (≈ 1.8 · crestSigma in storm —
   checked: the game's proven absolute `0.3` is 1.80 σ on the storm preset,
   so a sea-relative threshold reproduces it exactly there; the absolute
   value would be 4 σ on `breeze` and near-never fire);
   birth velocity `orbitalVelocityAt + wind·1.15 + (0, 2·pinch·ω·A, 0)`;
   gravity −9.81 on the droplet class only; keep spume's surface-hugging
   ease `min(1, dt·3)` for the streak class. One new file, no library
   surface changes beyond an optional export.
2. **Foam memory, Stage 0 (R2).** Two extra crest-sum evaluations in the
   vertex shader at `uTime − 2.5` and `uTime − 5.0`, weighted 0.55 / 0.3,
   `max`-ed into `vCrest` before the fragment's smoothstep. ~10 lines of
   generated GLSL in `oceanVertexChunk` (add a `uFoamLagWeights` uniform so
   `foamProfile` can scale it with coverage). Broken water trails behind the
   crest instead of vanishing — the single biggest per-line look change
   available.
3. **Tone mapping + exposure (R4, second half).** `AgXToneMapping` +
   `tonemapping_fragment` include in ocean and sky shaders, `exposure` in
   each lighting preset (storm 1.0, sun break 1.15, dusk 0.85 as starting
   points). Stops foam clipping and buys the dusk preset back. An hour.
4. **SSS transmission term (R6).** ~10 shader lines: forward-lobe
   `pow(dot(viewDir, -sun), 8.0)` × crest-thinness proxy
   `smoothstep(0.5, 1.0, vCrest / uFoamHi)` multiplied into the existing
   `uCrestGlow` term. Tune against the sun-break preset.
5. **Reflection/sky ramp unification (R5, cheap half).** Before any cubemap:
   make the ocean's reflected-sky ramp (`ocean.js:160–162`) evaluate the
   *same* two-smoothstep formula the sky dome uses (`demo/main.js:630–632`),
   moved into a shared GLSL snippet, and add the sun's analytic glow to the
   reflected colour using `reflDir` (it is already half-done via the `pow 60`
   term). Sea and sky stop disagreeing about what the sky looks like.

Items 1–5 together are roughly a week of work, no new dependencies, no
identity risk anywhere, and they close the most visible third of the gap to
the FFT exemplars.

---

## Sources

- [Poseidon — GPU-driven FFT ocean, three.js + WebGPU/TSL](https://github.com/owenyuwono/poseidon)
- [WebTide — Tessendorf ocean on WebGPU/Babylon](https://github.com/BarthPaleologue/WebTide) and the author's [write-up](https://barthpaleologue.github.io/Blog/posts/ocean-simulation-webgpu/)
- [Popov72 OceanDemo — WebGPU ocean in Babylon.js](https://popov72.github.io/OceanDemo/)
- [GodotOceanWaves — FFT ocean with foam-culled sea-spray particles](https://github.com/2Retr0/GodotOceanWaves)
- [jdupuy/whitecaps — Real-time Animation and Rendering of Ocean Whitecaps (Jacobian foam)](https://github.com/jdupuy/whitecaps)
- [The Technical Art of Sea of Thieves — SIGGRAPH 2018 talk (feedback-blurred foam buffer)](https://history.siggraph.org/wp-content/uploads/2022/09/2018-Talks-Ang_The-Technical-Art-of-Sea-of-Thieves.pdf)
- [Tidewater — commercial three.js ocean kit (cascaded FFT + CPU mirror for buoyancy)](https://ilikekillnerds.com/2026/05/21/i-built-tidewater-threejs-ocean-kit/)
- [Real-Time Interactive Hybrid Ocean: Spectrum-Consistent Wave Particle–FFT Coupling (arXiv 2511.02852)](https://arxiv.org/pdf/2511.02852)
- [WebGPU supported in all major browsers — web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
- [three.js WebGPURenderer docs](https://threejs.org/docs/pages/WebGPURenderer.html)
