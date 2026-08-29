# surprise-sea — the contract

A reusable sea for three games: the albatross game (`hms-surprise`), The
Helmsman's Watch, and The Pursuit. Two halves, one law:

> **The CPU and the GPU must describe the same water.** Physics samples the
> surface analytically; the renderer displaces a mesh with the same wave sum.
> A ship or a bird touching the water must touch what the eye sees.

Everything is deterministic: same options → same sea, every run. No
`Date.now`, no `Math.random` in simulation code — seeded LCGs only. Plain
JavaScript ES modules, three.js ^0.180 as the only dependency. Comment in the
voice of the reference code: explain *why*, literately, not what.

Reference implementations to read before writing anything (working code from
the albatross game — port, generalise, improve; do not import from there):

- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/world/ocean/waves.js`
- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/world/ocean/wavefield.js`
- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/world/ocean/ocean.js`
- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/world/ocean/oceanAir.js`
- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/world/ocean/ship.js` (the `update()` motion section)
- `/Users/matthewjamesbates/Documents/Dev/hms-surprise/src/main.js` (how a game consumes all of it)

## File layout

```
src/
  index.js        re-exports the whole public API below
  spectrum.js     createSeaState(options) → SeaState; the presets live here
  seastate.js     SeaState class: every CPU query + the GLSL twin
  wavefield.js    WaveField: the game-facing adapter with time
  hull.js         Hull: seakeeping, rudder, broach and pooping
  airoversea.js   AirOverSea: wind, wave lift, streets (for flying things)
  render/
    grid.js       warpedGrid(n, halfSpan, exponent) → BufferGeometry
    ocean.js      createOcean(waveField, options) → { mesh, update, setLighting, setSeaState }
demo/
  index.html      the workbench page
  main.js         scene, test hull, cameras, HUD, input
test/
  seastate.test.js
  hull.test.js
```

## Physics half (owner: physics agent)

### `createSeaState(options) → SeaState`  (spectrum.js)

```js
createSeaState({
  preset,        // 'calm' | 'breeze' | 'gale' | 'storm' | 'greybeards'
  windFromDeg,   // meteorological; the swell runs downwind. Default 285.
  seed,          // integer; default 1796. Same seed, same sea.
  scale,         // overall amplitude multiplier, default 1
  waveCount,     // default 12
})
```

Presets are rough Beaufort anchors — dominant wavelength, significant height,
directional spread, chop energy:

| preset      | feel                         | Hs (m) | dominant L (m) |
|-------------|------------------------------|--------|----------------|
| calm        | glassy heave                 | ~0.4   | ~60            |
| breeze      | whitecaps starting           | ~2     | ~90            |
| gale        | heavy, streaked              | ~7     | ~160           |
| storm       | the albatross game today     | ~12    | ~230           |
| greybeards  | survival storm, towering     | ~17    | ~320           |

Synthesis rules (learned the hard way in the game):

- **Split the primary train into three near-parallel components** — same
  neighbourhood of wavelength, ±5–7° heading, slightly different speeds — so
  the sea arrives in *sets* with lulls between. One clean dominant wave reads
  as corduroy from any height.
- Remaining components log-spaced down from the dominant to short chop, with
  alternating heading offsets widening to ±30°.
- Deep-water dispersion: ω = √(g·k). Phase, heading jitter, amplitude jitter
  from the seeded LCG.
- Gerstner pinch per wave (`q·k·A`) budgeted so the total stays ≤ ~0.8; the
  pinch is what makes crests sharp and troughs long.

### `SeaState`  (seastate.js)

State: `waves[]` ({dx,dz,k,omega,amp,q,length,phase}), `hMin`, `hMax`,
`dominant`, `dominantSpeed`, `windFromDeg`, `preset`.

Queries (all take explicit `t` seconds):

- `heightAt(x, z, t)` — exact surface height in the column above (x,z):
  3 fixed-point iterations inverting the Gerstner horizontal displacement,
  then the vertical sum. This is the authoritative surface.
- `roughHeightAt(x, z, t)` — vertical terms only, no inversion. For spray,
  birds, anything decorative.
- `gradientAt(x, z, t, spread = 22)` — finite differences of `heightAt`.
- `normalAt(x, z, t, spread, out?)` — from the gradient, THREE.Vector3.
- `crestAt(x, z, t)` — Σ q·k·A·sin(θ): how pinched the surface is; foam and
  spume key off it.
- `orbitalVelocityAt(x, z, t, out?)` — water particle velocity at the surface
  (deep-water orbits: u = Σ ω·A·cosθ·d̂ horizontally, w = Σ ω·A·sinθ
  vertically). Hulls and wakes drift with this.

GPU twin:

- `waveUniforms(seaState)` — uniform arrays uWaveDir/K/Omega/Amp/Q/Len/Phase.
- `oceanVertexChunk(waveCount)` — the GLSL `gerstner(p, camDist, out normal,
  out crest)` function, generated for NW = waveCount, with per-wave distance
  attenuation `exp(-camDist / (L·45 + 600))` so coarse far mesh never aliases.

### `WaveField`  (wavefield.js)

The adapter games hand to everything else. Owns the clock so one frame sees
one sea.

```js
const field = new WaveField(seaState, extent /* metres, square */);
field.advance(dt); field.time;
field.heightAt(x, z); field.gradientAt(x, z, spread?);
field.normalAt(x, z, spread?, out?); field.contains(x, z, margin?);
field.extent; field.half; field.hMin; field.hMax; field.sea;
field.setSeaState(newSeaState);   // live swap, clock keeps running
```

### `Hull`  (hull.js) — the seakeeping heart of The Helmsman's Watch

Phenomenological, tunable, honest about being a game model. Weather-ship
behaviour first, naval architecture second.

```js
const hull = new Hull({
  length: 39, beam: 9.9, draught: 4.3,       // metres
  mass: 500e3,                               // suggests the response taus
  heaveTau: 1.5, pitchTau: 1.9, rollTau: 2.1,
  maxSpeed: 6,                                // m/s under current canvas
  rudderPower: 0.25,                          // rad/s² of yaw at full helm, full flow
  yawDamping: 0.8,
  x: 0, z: 0, headingDeg: 105,
});

hull.update(dt, waveField, {
  rudder,      // -1..1, port..starboard
  thrust,      // 0..1 fraction of maxSpeed the canvas is driving her at
});
```

Model, per update:

1. Sample `heightAt` at bow, stern, port beam, starboard beam (at ±length·0.35
   and ±beam·0.45). Targets: heave = mean; pitch = atan(bow−stern / span)·0.85;
   roll = atan(port−starboard / span)·0.6. Ease each toward its target with
   its tau (`1 − exp(−dt/τ)`).
2. **Surge/surf**: fore-aft slope under her; stern-up adds speed (surf),
   bow-up subtracts. `surfFactor` 0..1 = how hard she is surfing.
3. **Rudder authority**: proportional to relative flow past the rudder —
   `authority = clamp(speed / (dominantSpeed·0.5), 0, 1) · (1 − 0.8·surfFactor)`.
   Surfing at wave speed, the rudder is in water moving with her: near-useless.
   This is the core feel of the helmsman game.
4. **Wave yaw**: quartering seas slew the stern — yaw torque from the
   *athwartships* slope sampled at the stern minus at the bow, multiplied by
   (1 + 2·surfFactor). Integrate yawRate with damping; heading integrates
   yawRate.
5. **Broach**: `broachRisk` 0..1 blends surfFactor, |wave yaw torque| and how
   far heading is off the wave-travel direction. Risk ≥ 1 latches
   `broached = true`: yaw kicks hard toward beam-on, roll target gains
   +0.35 rad, speed decays; recovery (risk fallen and roll settling) clears
   the latch. Fire `onBroach` callback once per event.
6. **Pooped**: overtaking crest at the stern above deck height
   (heave + freeboard) while `surfFactor < 0.3` → `onPooped` once per crest;
   briefly multiply rudder authority by 0.3.
7. Expose: `position` (Vector3, y = heave), `quaternion` (yaw·pitch·roll,
   'YXZ'), `headingDeg`, `speed`, `yawRate`, `surfFactor`, `broachRisk`,
   `broached`, `rudderAuthority`, plus `onBroach`/`onPooped` callbacks.

### `AirOverSea`  (airoversea.js)

Port of the game's `OceanAir`, parameterised by the sea state (wind speed and
direction come from it; wave lift reads the field's gradient; streets
configurable). Same public surface: `update(dt)`, `velocityAt(x,y,z,out)`,
`wind`, `windSpeed`, `nearbyThermals()` → [], `thermals` → [].

### Tests (node --test, no browser, no new deps)

- Inversion: for `storm` and `greybeards`, |forward(invert(x,z)) − (x,z)| <
  0.01 m across a grid of points and times; `heightAt` within hMin..hMax.
- Determinism: two `createSeaState` with the same options produce identical
  wave tables; different seeds differ.
- Presets: significant height (4·σ of sampled heights) within ±30% of the
  table above.
- Hull: on `calm`, holds heading within 2° over 60 s with rudder 0; full
  starboard rudder turns her clockwise; in `greybeards` running dead downwind
  at full thrust, `broachRisk` exceeds 0.5 within 5 minutes but heading
  recovers after a broach clears; no NaNs anywhere after 10 minutes at dt
  = 1/60.

## Rendering half (owner: render agent)

### `createOcean(waveField, options)`  (render/ocean.js)

Port of the game's renderer, decoupled from its mood system:

```js
const ocean = createOcean(waveField, {
  quality: { gridN: 352, halfSpan: 16000, exponent: 2.2 },
  windFromDeg: 285,               // streak direction (default from seaState)
  fogDensity: 1.05e-4,
  lighting: {                     // everything setLighting() can change later
    sunDir: [0.35, 0.3, 0.65], sunColour: 0xdfe2de,
    skyTop: 0x67737f, skyHaze: 0xa6abab, glare: 0.3,
    fogDensity: 1.15,             // multiplier on the base
    water: { deep: 0x25383c, crest: 0x3d6a5c, foam: 0xdfe4e4 },
  },
});
ocean.mesh; ocean.update(cameraPos); ocean.setLighting(lighting);
ocean.setSeaState(seaState);      // re-upload wave uniforms on live swap
```

Keep every visual lesson already in the reference shader: warped
camera-following grid; damped fresnel (rough seas are poor mirrors); backlit
bottle-green crests; crest foam with distance fade so far crests never become
solid bars; spindrift streaked long and lacy along the wind; ripple detail
normal fading by ~900 m; fog to the haze colour. Foam coverage should scale
with the sea state (crest threshold from mean pinch) so `calm` shows almost
none and `greybeards` is streaked white.

### Demo workbench  (demo/)

A page that proves the whole library and doubles as the tuning rig for the
future games. Vite root is `demo/` (config exists at repo root). Import from
`../src/index.js`.

- Scene: gradient sky dome (small inline shader is fine), the ocean, and a
  **placeholder hull** — a simple grey block hull with deck, a stub mast and
  a flag so heading/roll read clearly. No detailed ship; that arrives from
  another project.
- The hull is driven by `Hull` + arrow keys / A-D for rudder, W/S for thrust.
- Number keys 1–5 switch presets live (`setSeaState` on field + ocean;
  `AirOverSea` refreshed). On-screen HUD (plain DOM): preset name, wind,
  hull speed/heading, rudder-authority bar, broach-risk bar that flashes on
  a broach or pooping, event log line.
- `C` cycles cameras: orbit (drag to rotate, wheel to zoom), chase (astern),
  and **helm** — eye-height on the quarterdeck looking aft over the stern at
  the following sea. The helm view is the point of the whole exercise.
- Three lighting presets on `L`: storm grey, sun break, dusk (values from the
  reference game's moods are fine).
- Runs with `npm run dev`. Keep it dependency-free beyond three.

## Boundary

Physics agent owns `src/*.js` and `test/`. Render agent owns `src/render/`
and `demo/`. Neither edits the other's files; both read this contract. The
render agent codes against the signatures above even if the physics files are
not present yet.

---

# Amendment II — the scarred sea, the real sky, and the weather

Four additions from docs/REVIEW.md (R2-full, R3, R5, R8) plus a live
environment panel. The law stands: nothing here may move the displaced
geometry the physics samples. These layers are shading and air. Frame-history
effects (the foam field, rain) are exempt from strict determinism — they are
visual memory, not simulation truth — but must be stable, bounded, and free
of NaNs forever. `npm test` stays green throughout; new GLSL gets
string-level tests where a browser is not available.

## FoamField — R2-full + R3  (src/render/foamfield.js, NEW)

A camera-following accumulation texture: where the sea has broken or a ship
has passed, the water stays scarred until it fades.

```js
const foam = createFoamField(waveField, {
  size: 1024,            // texels; 512 on coarse pointers
  extent: 2400,          // metres covered, centred on the camera
  halfLife: 22,          // seconds for a scar to fade by half
  windFromDeg,           // advection direction (foam drifts downwind)
});
foam.update(renderer, dt, cameraPos);  // MUST be callable from the demo tick,
                                       // so it works under window.sea.step()
foam.stamp(x, z, radius, strength);    // queue a splat (wakes, broaches);
                                       // cheap, many per frame is fine
foam.texture; foam.uniforms;           // whatever ocean.js needs to sample it
foam.dispose();
```

Implementation intent: half-float ping-pong RTs; each update decays by the
half-life, advects by the wind (sample offset upwind), injects the analytic
crest sum evaluated in the RT's own pass (same wave uniforms — this is the
Jacobian-fold analogue), and applies queued stamps as soft discs. The
footprint follows the camera quantised to whole texels so the history never
smears from re-centring; texels that scroll in start clean.

Ocean sampling (src/render/ocean.js, same agent): inside the footprint the
fragment foam term becomes `max(analytic Stage-0 foam, field sample)`, with a
soft edge fade to the analytic fallback outside. New createOcean option
`foamField`, new method `ocean.setFoamField(foamOrNull)`.

Wakes (R3): the *library* provides `wakeStamper(hull, foam, options)` in
foamfield.js — reads the hull's public state each call, stamps a trail at the
stern scaled by speed (nothing below ~1 m/s), doubles width while `broached`,
and dumps one broad splat on the broach event. The demo wires it; The
Pursuit will reuse it.

## Reflections — R5  (src/render/sky.js NEW + a hook in ocean.js)

The sky dome moves from the demo into the library, so the water can reflect
the sky that is actually overhead.

```js
const sky = createSky({ lighting });     // the dome the demo already draws
sky.mesh; sky.setLighting(lighting);     // same fields as the ocean's
sky.reflection;                          // mipmapped cube texture, re-rendered
                                         // only when lighting changes (a
                                         // CubeCamera into a small mipped
                                         // WebGLCubeRenderTarget, ~128px)
sky.updateReflection(renderer);          // called after setLighting; cheap
sky.dispose();
```

Ocean hook (owned by the FoamField agent, interface fixed here so both sides
can build against it): `ocean.setReflection(cubeTexture, amount = 1)` adds
uniforms `uSkyRefl` (samplerCube), `uSkyReflAmount` (0 = pure procedural
ramp, the current look). The fragment mixes the procedural ramp toward a
roughness-blurred cube sample (mip bias by an existing roughness proxy; exact
LOD calls are a bonus, a bias is acceptable). Foam and glints unchanged.

## Rain — R8  (src/render/rain.js, NEW)

```js
const rain = createRain(waveField, { windFromDeg, lighting });
rain.object3d;
rain.update(dt, cameraPos);              // under the same tick as everything
rain.setWeather({ rain });               // 0 none .. 1 blinding squall
rain.setLighting(lighting); rain.dispose();
```

Two layers: near-camera rain streaks (a few hundred stretched sprites, wind-
sheared, dying on the surface), and 3-6 big translucent squall-curtain
billboards drifting downwind in the middle distance. Both scale with the
`rain` value; 0 must cost nothing.

## Weather + the panel  (demo)

The demo gains one weather object and a control panel (toggle with `E`):

- Sliders: sun azimuth (deg), sun elevation (deg), glare, exposure,
  visibility (km, 1–40, mapped `fogDensity = 3 / (visibility_m)` — label it
  visibility, store it as fog), rain (0–1).
- Colour pickers: sky top, sky haze, sun colour, water deep, water crest,
  foam.
- Every control applies live to sky, ocean, spray, rain, and the scene
  lights through the existing setLighting path plus `rain.setWeather`.
- Rain couples: at rain r, effective fogDensity ×(1 + 1.2r) and sky/water
  colours desaturate toward grey by up to 25% — computed in ONE place in the
  demo and passed through setLighting, not hidden in shaders.
- `L` still cycles the three presets (they now also carry `rain: 0`);
  touching any slider switches to a `Custom` state; a `Copy JSON` button
  puts the full lighting+weather object on the clipboard; the custom state
  persists in localStorage (guarded try/catch) and survives reload.
- Panel is plain DOM in demo/index.html + main.js, styled like the HUD.

## Ownership

- Agent F: src/render/foamfield.js, src/render/ocean.js (foam sampling +
  setReflection hook), src/index.js exports, tests.
- Agent S: src/render/sky.js, src/render/rain.js, demo/index.html,
  demo/main.js (library sky replaces the inline one; panel; wiring foam via
  documented API with `ocean.setFoamField?.()`-style guards so agent order
  never matters), tests for what is testable headlessly.
- Neither touches src/seastate.js, src/spectrum.js, src/hull.js,
  src/wavefield.js, src/airoversea.js, or src/render/spray.js this round.

---

# Amendment III — the sea comes aboard

`shipSeas(hull, waveField, options)` — src/shipseas.js. The generic half of
ship–sea interaction: WHERE, WHEN and HOW HARD water comes aboard, as
numbers and events. No rendering, no GL, no geometry beyond points — the
game binds the dressing (sheeting decks, smashed glass) to its own mesh.

```js
const seas = shipSeas(hull, waveField, {
  freeboard: 3.2,          // deck above waterline amidships
  sheer: 1.2,              // extra height of deck at bow and stern
  regions: null,           // default: foredeck / waist / quarterdeck from hull.length
});
seas.update(dt);           // after hull.update, same tick
```

Per update, transform a fixed set of hull-local sample points (bow, stern,
port and starboard rail rows, one centre point per deck region) through the
hull's position/quaternion, and compare against `heightAt` there:

- `onBowPlunge({ energy, x, z })` — the bow's downward velocity relative to
  the local water surface exceeds a threshold while the bow point is
  immersed. `energy` 0..1 from relative velocity². Rate-limit ~1/s.
- `onGreenWater({ region, depth })` — water level above a region's deck
  point; fires on the rising edge per shipped sea. Continuous state in
  `seas.water[region]` (0..1): fed by immersion depth, drained at
  `drainRate` (~0.4/s). This is the scalar a game sheets water with.
- `onSternSea({ force })` — overtaking crest buries the stern point while
  the wave travels faster than the ship: the pooping event with a force
  behind it (relative closing velocity²). The stern-window smasher.
- `onRailDip({ side })` — roll+heave puts a rail row under; fires per
  immersion episode per side.

All thresholds named options with documented defaults, tuned so: calm fires
nothing, storm running downwind at 60% thrust takes occasional bow plunges
and rare stern seas, greybeards at full thrust is regularly wet and a broach
dips the rail. Deterministic, NaN-free forever, hull never written to.
`seas.stats` counts every event kind. Tests drive a real Hull through real
presets and assert those behaviours, plus decay, rate limits, and that
region defaults span the hull. Export from index.js.
