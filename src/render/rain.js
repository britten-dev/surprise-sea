// Weather, in front of the eye and a mile off.
//
// Rain in an open sea is two entirely different sights and the eye reads them
// as one:
//
//   Streaks   — the water actually falling past you. Close, fast, sheared flat
//               by the wind, and short-lived: a drop is in frame for a fifth of
//               a second and dies the moment it touches the sea. A few hundred
//               of them, held in a box that travels with the camera, is enough,
//               because rain is a local phenomenon by definition — you cannot
//               see an individual drop at fifty metres.
//   Curtains  — the squall itself, a kilometre or two off: grey veils hanging
//               from a cloud base, dragging downwind across the water, dimming
//               everything behind them. This is the part that reads as
//               *weather* rather than as a particle effect, and it is what tells
//               a helmsman what is about to arrive.
//
// Both scale with one number, and at nought both cost nothing: no arithmetic,
// no draw call, no instances. That matters because rain is the one layer in the
// library that is off most of the time.
//
// The rain does not touch the sea. It never moves a vertex, never feeds the
// wave table, and never asks `heightAt` for the authoritative surface — drops
// die against `roughHeightAt`, which is what CONTRACT.md prescribes for
// anything decorative. What the rain *does* couple to, the demo does in one
// place and passes through `setLighting`: thicker fog and greyer colours. That
// coupling is arithmetic on a lighting object, not something hidden in here.
//
// Frame history, and so exempt from strict determinism by the amendment — but
// the seeded LCG is here anyway, because a bounded, repeatable pool is easier
// to test than a random one and costs nothing to keep.

import * as THREE from 'three';

/**
 * How much of this a machine gets. Streaks are the pool size, not the live
 * count: the live count is the pool scaled by the rain value, so a drizzle
 * draws a tenth of a squall's instances rather than a squall's instances at a
 * tenth opacity.
 */
const DESKTOP_BUDGET = { streaks: 460, curtains: 6 };

/**
 * The box the streaks live in, in metres. Half-width and half-height.
 *
 * Deliberately small. A few hundred drops spread over sixty metres of ground is
 * a drizzle wherever the eye is pointed; the same drops over twenty is a
 * downpour, and past twenty metres a drop is a pixel and reads as dust anyway.
 * The distance is the curtains' business.
 */
const VOLUME = { halfWidth: 21, halfHeight: 12 };

/** Terminal velocity of a raindrop, near enough, in metres a second. */
const FALL_SPEED = 8.2;

/**
 * How much of the wind a drop has picked up by the time you see it. Small water
 * reaches the speed of the air around it in about a second, which is why rain
 * in a gale arrives very nearly horizontally.
 */
const WIND_SHARE = 0.85;

/** Beyond this the shear stops steepening; a survival storm is flat enough. */
const MAX_SHEAR = 25;

/**
 * Where the curtains live: near enough to read, far enough to be weather.
 *
 * `near` is the floor and it has to be a high one. A veil three hundred metres
 * tall at five hundred metres range fills the upper half of the frame and stops
 * being a squall a mile off — which is the whole thing being drawn — and
 * becomes a grey sheet across the lens.
 */
const CURTAIN = { near: 900, far: 3400, spawnNear: 1900, spawnFar: 3200 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The library's LCG, the one `spectrum.js` and `spray.js` use. Each layer owns
 * its own stream, so changing the budget of one never reshuffles the other.
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** Direction the wind blows *toward*, as a unit vector on the xz plane. */
function downwind(windFromDeg, out = new THREE.Vector2()) {
  const rad = THREE.MathUtils.degToRad(windFromDeg);
  return out.set(-Math.sin(rad), Math.cos(rad)).normalize();
}

/** Hex numbers, CSS strings and THREE.Colors are all fair game for a palette. */
function readColour(out, value) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'number') out.setHex(value);
  else out.set(value);
  return out;
}

/**
 * Fold a coordinate back into a span centred on the camera, however far outside
 * it has got. A single `if` would do for a drop that has drifted one box width
 * in a frame; this also survives the demo walking the whole ship back to the
 * middle of the ocean between one frame and the next.
 */
function wrap(v, centre, half) {
  const span = half * 2;
  let d = v - centre;
  d -= Math.floor((d + half) / span) * span;
  return centre + d;
}

// --- Shaders -----------------------------------------------------------------

// A streak is a real segment of the drop's own track, projected.
//
// The obvious way — take the fall direction into view space once and stretch
// every sprite along it — is wrong in the one view that matters. Running before
// a gale the helm looks very nearly straight up the wind, the rain comes bodily
// at the eye, and one shared screen axis foreshortens the whole pool into dots.
// Rain coming at you does not look like dots; it looks like streaks radiating
// out of the middle of the frame, and that radial splay is the entire reason
// the eye reads it as *approaching* rather than as weather in the distance.
//
// So both ends of each drop's segment are projected separately and the quad is
// laid out between them, in a screen space corrected for aspect so that a width
// is a width whichever way the streak has ended up lying. The cost is the
// hardware's own near clipping, which the divide by hand throws away — hence
// the guard, since the eye is *inside* this pool and drops do pass behind it.
const streakVert = /* glsl */ `
  attribute vec3 iPos;
  attribute float iFade;
  attribute float iLen;

  uniform vec3 uFall;      // unit vector; the way the rain is going
  uniform float uLength;   // metres of streak at iLen = 1
  uniform float uWidth;    // metres across

  varying vec2 vUv;
  varying float vFade;

  void main() {
    vUv = position.xy + 0.5;
    vFade = iFade;

    vec4 head = modelViewMatrix * vec4(iPos, 1.0);
    vec3 fallView = (viewMatrix * vec4(uFall, 0.0)).xyz;
    // The streak trails the drop: this is where it was a fortieth of a second
    // ago, not where it is going.
    vec4 tail = head - vec4(fallView * (iLen * uLength), 0.0);

    if (head.z > -0.05 || tail.z > -0.05) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec4 cH = projectionMatrix * head;
    vec4 cT = projectionMatrix * tail;
    float wH = max(cH.w, 1e-3);
    float wT = max(cT.w, 1e-3);

    float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];
    vec2 sH = vec2(cH.x / wH * aspect, cH.y / wH);
    vec2 sT = vec2(cT.x / wT * aspect, cT.y / wT);

    vec2 axis = (sH - sT) * 0.5;
    float al = length(axis);
    // Dead end-on a streak has no direction on screen; any will do, because it
    // is about to be a dot however it is turned.
    vec2 dir = al > 1e-6 ? axis / al : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);

    // A hair's breadth of water at thirty metres is a third of a pixel, and a
    // third of a pixel flickers as it crosses the sampling grid. The floor is
    // an angular one — about an eighth of a degree, a couple of pixels on any
    // screen this will run on — so it need know nothing about the camera.
    float width = max(uWidth, wH * 0.0022);
    float halfW = projectionMatrix[1][1] * width * 0.5 / wH;

    vec2 mid = (sH + sT) * 0.5;
    vec2 p = mid + axis * (position.y * 2.0) + perp * (halfW * position.x * 2.0);

    gl_Position = vec4(p.x / aspect, p.y, cH.z / wH, 1.0);
  }
`;

// Alpha-blended and pale, never additive: rain over a bright sky has to darken
// as readily as it brightens a dark sea, and additive water only ever brightens.
const streakFrag = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vFade;

  void main() {
    vec2 c = vUv - 0.5;
    // Soft across, tapered at both ends: a streak is a smear, not a stick.
    float across = smoothstep(0.5, 0.0, abs(c.x));
    float along = smoothstep(0.5, 0.28, abs(c.y));

    float alpha = across * along * vFade * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColour, alpha);

    #include <colorspace_fragment>
  }
`;

// A curtain stands upright in the world and turns about its own vertical axis
// to face the eye. Screen-aligning it instead would tip it as the camera
// pitched, and a squall that leans when you look up at it stops being a squall.
const curtainVert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec2 iSize;    // half-width and full height, metres
  attribute float iFade;
  attribute float iSeed;

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;

  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);

    vec3 upView = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    vec3 ray = normalize(mv.xyz);
    vec3 right = cross(upView, ray);
    float rl = length(right);
    // Straight up the axis of a curtain there is no facing to choose; anything
    // will do, because it is edge-on and about to be invisible anyway.
    right = rl > 1e-4 ? right / rl : vec3(1.0, 0.0, 0.0);

    // The quad's foot sits at iPos, on the water, and it hangs upward from
    // there — so a curtain always meets the sea and never floats above it.
    mv.xyz += right * position.x * iSize.x + upView * (position.y + 0.5) * iSize.y;

    vUv = position.xy + vec2(0.5);
    vFade = iFade;
    vSeed = iSeed;
    gl_Position = projectionMatrix * mv;
  }
`;

const curtainFrag = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;
  uniform float uTime;

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    return noise(p) * 0.64 + noise(p * 2.7) * 0.36;
  }

  void main() {
    // Soft at both sides, or a curtain reads as a poster of a curtain.
    float across = smoothstep(0.0, 0.26, vUv.x) * smoothstep(1.0, 0.74, vUv.x);

    // Rooted at the water and thinning upward. The contact with the sea is the
    // whole sight — a squall is a thing you watch *arrive* across the water —
    // so the density is greatest low down, with the first few metres feathered
    // into spray, and it never quite goes out at the top because there is no
    // cloud drawn up there for it to disappear into.
    float hang = smoothstep(0.0, 0.08, vUv.y)
               * (0.35 + 0.65 * smoothstep(1.0, 0.15, vUv.y));

    // Rain falls in columns. They are drawn out vertically, they differ from
    // curtain to curtain, and they crawl, so a squall is never a still shape.
    float col = fbm(vec2(vUv.x * 7.5 + vSeed * 41.0,
                         vUv.y * 1.7 - vSeed * 13.0 - uTime * 0.06));
    float veil = mix(0.4, 1.0, smoothstep(0.28, 0.76, col));

    float alpha = across * hang * veil * vFade * uOpacity;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColour, alpha);

    #include <colorspace_fragment>
  }
`;

/** The unit quad every instanced layer here is built on. */
function unitQuad() {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  // Every instance moves on the CPU and the pool spans the horizon: there is
  // nothing useful a frustum test could say about it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return geometry;
}

// --- The two layers -----------------------------------------------------------

/**
 * Falling water, in a box that travels with the eye.
 *
 * There is no birth and no death here in the usual sense: the population is
 * fixed, and a drop that leaves the box through one wall comes back through the
 * opposite one. That is right for rain and wrong for spray — spray is thrown
 * off particular crests and has to be born on them, rain is everywhere at once
 * and only ever needs to be *present*. It buys a pool that can never run dry
 * and never has to search for a spawn site.
 *
 * The one real death is the sea. A drop below the surface is respawned at the
 * top of the box, and the last metre and a half of its fall is faded out, so it
 * dies *into* the water rather than switching off above it.
 */
function createStreaks(count, seed) {
  const positions = new Float32Array(count * 3);
  const fades = new Float32Array(count);
  const lengths = new Float32Array(count);
  const rand = makeRandom(seed);
  let placed = false;

  const geometry = unitQuad();
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(positions, 3));
  geometry.setAttribute('iFade', new THREE.InstancedBufferAttribute(fades, 1));
  geometry.setAttribute('iLen', new THREE.InstancedBufferAttribute(lengths, 1));
  geometry.instanceCount = 0;

  const uniforms = {
    uColour: { value: new THREE.Color(0xd6dcde) },
    uOpacity: { value: 0 },
    uFall: { value: new THREE.Vector3(0, -1, 0) },
    uLength: { value: 0.3 },
    uWidth: { value: 0.018 },
  };

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: streakVert,
      fragmentShader: streakFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  mesh.frustumCulled = false;
  // In front of everything the sea throws up: these are the drops between the
  // eye and the first metre of air.
  mesh.renderOrder = 30;
  mesh.name = 'rain-streaks';

  /** Put one drop somewhere in the box, at a height that is over the water. */
  function place(i, cx, cy, cz, sea, t, top) {
    const o = i * 3;
    const x = cx + (rand() * 2 - 1) * VOLUME.halfWidth;
    const z = cz + (rand() * 2 - 1) * VOLUME.halfWidth;
    positions[o] = x;
    positions[o + 2] = z;
    // Almost always the lid of the box. In a survival sea the eye can be deep
    // in a trough with a crest standing over it, and a drop born under the
    // water would only be killed again next frame — so it is lifted clear of
    // whatever is actually there, and then held under the ceiling the update
    // recycles at, so the two can never argue.
    positions[o + 1] = top
      ? Math.min(
          Math.max(cy + VOLUME.halfHeight, sea.roughHeightAt(x, z, t) + 3),
          cy + VOLUME.halfHeight * 1.5
        )
      : cy - VOLUME.halfHeight + rand() * VOLUME.halfHeight * 2;
    lengths[i] = 0.6 + rand() * 0.9;
    fades[i] = 0;
  }

  function update(c) {
    const { dt, sea, t, cx, cy, cz, live } = c;

    if (!placed) {
      // The first frame is the only one that scatters the whole box; after that
      // the wrap keeps it full for ever.
      for (let i = 0; i < count; i++) place(i, cx, cy, cz, sea, t, false);
      placed = true;
    }

    const vx = c.fall.x * dt;
    const vy = c.fall.y * dt;
    const vz = c.fall.z * dt;

    let alive = 0;

    for (let i = 0; i < live; i++) {
      const o = i * 3;

      positions[o] += vx;
      positions[o + 1] += vy;
      positions[o + 2] += vz;

      // Sideways the box is a torus: a drop blown out of one wall is the same
      // drop as one blowing in through the other, and rain has no identity.
      positions[o] = wrap(positions[o], cx, VOLUME.halfWidth);
      positions[o + 2] = wrap(positions[o + 2], cz, VOLUME.halfWidth);

      const x = positions[o];
      const y = positions[o + 1];
      const z = positions[o + 2];

      // Three ways out of the pool, and all of them come back through the lid:
      // into the water, out of the floor, or — after the eye has been picked up
      // and put down somewhere else, or a slot has sat idle while the rain was
      // lighter — stranded far above it. Nothing here can loop, because the lid
      // itself is held under this same ceiling.
      const surface = sea.roughHeightAt(x, z, t);
      if (y < surface ||
          y < cy - VOLUME.halfHeight ||
          y > cy + VOLUME.halfHeight * 1.6) {
        place(i, cx, cy, cz, sea, t, true);
        continue;
      }

      const dx = x - cx;
      const dy = y - cy;
      const dz = z - cz;
      const radial = Math.sqrt(dx * dx + dz * dz);

      // Three fades, and each of them hides a seam: the rim of the box, the lid
      // it falls in through, and the surface it dies on. The fourth is the eye
      // itself — a drop half a metre from the lens is a grey bar across the
      // frame.
      let fade = 1 - smoothstep(VOLUME.halfWidth * 0.7, VOLUME.halfWidth, radial);
      fade *= 1 - smoothstep(VOLUME.halfHeight * 0.75, VOLUME.halfHeight, dy);
      fade *= smoothstep(0, 1.5, y - surface);
      fade *= smoothstep(0.7, 2.6, Math.sqrt(dx * dx + dy * dy + dz * dz));

      fades[i] = fade;
      if (fade > 0.01) alive++;
    }

    geometry.instanceCount = live;
    geometry.attributes.iPos.needsUpdate = true;
    geometry.attributes.iFade.needsUpdate = true;
    geometry.attributes.iLen.needsUpdate = true;
    return alive;
  }

  return { object3d: mesh, uniforms, update, geometry, setCount(n) { geometry.instanceCount = n; } };
}

/**
 * The squall itself: a handful of veils, upright in the world, sailing downwind
 * across the middle distance.
 *
 * They are anchored to the sea rather than to the camera, so they pass — which
 * is the whole point. One comes up from upwind, crosses, and goes away astern,
 * and while it is across the ship the demo has thickened the fog. Recycled at
 * both ends: too far off to see, or close enough to fill the frame with grey.
 */
function createCurtains(count, seed) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count * 2);
  const fades = new Float32Array(count);
  const seeds = new Float32Array(count);
  const rand = makeRandom(seed);
  let placed = false;

  const geometry = unitQuad();
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(positions, 3));
  geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(sizes, 2));
  geometry.setAttribute('iFade', new THREE.InstancedBufferAttribute(fades, 1));
  geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.instanceCount = 0;

  const uniforms = {
    uColour: { value: new THREE.Color(0x9aa2a4) },
    uOpacity: { value: 0 },
    uTime: { value: 0 },
  };

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: curtainVert,
      fragmentShader: curtainFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  mesh.frustumCulled = false;
  // Behind the spray and well behind the streaks: a curtain is a kilometre off
  // and everything the sea throws up is in front of it.
  mesh.renderOrder = 20;
  mesh.name = 'rain-curtains';

  /**
   * @param upwind  the bearing to place it on, in radians, or null to scatter
   *                it anywhere — which is only wanted for the first fill, so
   *                the sea does not start empty and fill from one side.
   */
  function place(i, cx, cz, upwindAng) {
    const o = i * 3;
    const ang =
      upwindAng === null
        ? rand() * TAU
        // A wedge either side of dead upwind, so they arrive from where the
        // weather is coming from without marching in single file.
        : upwindAng + (rand() - 0.5) * 2.4;
    const range =
      upwindAng === null
        ? CURTAIN.near + rand() * (CURTAIN.far - CURTAIN.near)
        : CURTAIN.spawnNear + rand() * (CURTAIN.spawnFar - CURTAIN.spawnNear);

    positions[o] = cx + Math.sin(ang) * range;
    // Mean sea level. A curtain is hundreds of metres across and a point sample
    // of the surface under one corner of it would be an arbitrary number; the
    // soft foot in the fragment stage does the rest.
    positions[o + 1] = 0;
    positions[o + 2] = cz + Math.cos(ang) * range;

    sizes[i * 2] = 260 + rand() * 320;      // half-width
    sizes[i * 2 + 1] = 170 + rand() * 220;  // height
    seeds[i] = rand();
    fades[i] = 0;
  }

  function update(c) {
    const { dt, cx, cz, live, windUnit, windSpeed } = c;

    if (!placed) {
      for (let i = 0; i < count; i++) place(i, cx, cz, null);
      placed = true;
    }

    // A squall travels with the air that made it, a little slower than the
    // gusts inside it.
    const dx = windUnit.x * windSpeed * 0.85 * dt;
    const dz = windUnit.z * windSpeed * 0.85 * dt;
    // Dead upwind, as a bearing in the same frame `place` builds one from.
    const upwindAng = Math.atan2(-windUnit.x, -windUnit.z);

    let alive = 0;

    for (let i = 0; i < live; i++) {
      const o = i * 3;
      positions[o] += dx;
      positions[o + 2] += dz;

      const rx = positions[o] - cx;
      const rz = positions[o + 2] - cz;
      const range = Math.sqrt(rx * rx + rz * rz);

      if (range > CURTAIN.far || range < CURTAIN.near * 0.55) {
        place(i, cx, cz, upwindAng);
        continue;
      }

      // In as it comes over the horizon, out as it gets close enough to stop
      // being weather and start being a grey wall across the lens.
      const fade =
        smoothstep(CURTAIN.far, CURTAIN.far * 0.86, range) *
        smoothstep(CURTAIN.near * 0.55, CURTAIN.near, range);

      fades[i] = fade;
      if (fade > 0.01) alive++;
    }

    geometry.instanceCount = live;
    geometry.attributes.iPos.needsUpdate = true;
    geometry.attributes.iSize.needsUpdate = true;
    geometry.attributes.iFade.needsUpdate = true;
    geometry.attributes.iSeed.needsUpdate = true;
    return alive;
  }

  return { object3d: mesh, uniforms, update, geometry, setCount(n) { geometry.instanceCount = n; } };
}

// --- The system ---------------------------------------------------------------

const DEFAULT_LIGHTING = {
  skyHaze: 0xa6abab,
  sunColour: 0xdfe2de,
  glare: 0.3,
  water: { foam: 0xdfe4e4 },
};

/**
 * Rain.
 *
 * @param waveField  a WaveField; its `sea` gives the wind and the surface the
 *                   drops die on, and its `time` the clock — read fresh every
 *                   frame, so a live change of sea state needs no call here.
 * @param options
 *   `windFromDeg` meteorological; defaults to the sea state's own.
 *   `lighting`    the same object `createOcean` takes. Only `skyHaze`,
 *                 `sunColour`, `glare` and `water.foam` are read.
 *   `budget`      `{ streaks, curtains }` pool sizes. Halved on a coarse
 *                 pointer, where transparent overdraw is the thing that hurts.
 *   `seed`        integer; default 60413.
 *   `rain`        the weather to start at; default 0, which is free.
 *
 * @returns `{ object3d, update(dt, cameraPos), setWeather({ rain }),
 *            setLighting, setSeaState, dispose, stats }`
 */
export function createRain(waveField, options = {}) {
  // A coarse pointer is a phone. Guarded, because the tests have no window to
  // ask — and because a curtain is the most expensive transparent quad in the
  // library, so a phone gets half of them.
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const half = (n) => Math.max(1, Math.round(n / 2));

  const asked = { ...DESKTOP_BUDGET, ...(options.budget ?? {}) };
  const budget = coarse
    ? { streaks: half(asked.streaks), curtains: half(asked.curtains) }
    : asked;

  const seed = options.seed ?? 60413;

  const streaks = createStreaks(budget.streaks, seed);
  const curtains = createCurtains(budget.curtains, seed + 4409);
  const layers = [curtains, streaks];

  const object3d = new THREE.Group();
  object3d.name = 'rain';
  for (const layer of layers) object3d.add(layer.object3d);

  // A wind direction given here is a deliberate choice and survives sea-state
  // swaps; left out, the rain leans with whatever wind the sea state carries.
  const pinnedWind = options.windFromDeg ?? null;

  const windDir = new THREE.Vector2(0, 1);
  const windUnit = { x: 0, z: 1 };
  const fall = new THREE.Vector3(0, -FALL_SPEED, 0);

  let rain = clamp(options.rain ?? 0, 0, 1);

  const stats = { rain, streaks: 0, curtains: 0 };

  // The lighting in force, so a caller may hand over half an object without the
  // rest of it going black — the same courtesy the ocean and the spray do.
  let lighting = { ...DEFAULT_LIGHTING, water: { ...DEFAULT_LIGHTING.water } };
  const hazeCol = new THREE.Color();
  const foamCol = new THREE.Color();
  const sunCol = new THREE.Color();

  function applyColour() {
    readColour(hazeCol, lighting.skyHaze ?? DEFAULT_LIGHTING.skyHaze);
    readColour(foamCol, lighting.water?.foam ?? DEFAULT_LIGHTING.water.foam);
    readColour(sunCol, lighting.sunColour ?? DEFAULT_LIGHTING.sunColour);
    const glare = clamp(lighting.glare ?? 0.3, 0, 1);

    // Falling water is lit from every side at once and takes the light's colour
    // readily: mostly the sky's own haze, lifted toward foam white and warmed
    // by whatever sun is getting through.
    streaks.uniforms.uColour.value
      .copy(hazeCol)
      .lerp(foamCol, 0.55)
      .lerp(sunCol, 0.12 * glare);

    // A curtain is a shadow as much as it is water: the haze colour, taken
    // down, so it reads as a thickening of the air rather than a white sheet.
    curtains.uniforms.uColour.value.copy(hazeCol).multiplyScalar(0.86);
  }

  function setLighting(next = {}) {
    lighting = {
      ...lighting,
      ...next,
      water: { ...lighting.water, ...(next.water ?? {}) },
    };
    applyColour();
  }

  /**
   * How hard it is raining, nought to one.
   *
   * Both layers scale, and they scale differently: the streaks scale in
   * *population*, because a drizzle is fewer drops and not fainter ones, and
   * the curtains scale in both count and opacity, because a squall that is
   * barely there is barely there. Nought switches the group off outright — no
   * arithmetic, no instances, no draw call.
   */
  function setWeather(next = {}) {
    if (next.rain !== undefined) rain = clamp(next.rain, 0, 1);
    stats.rain = rain;

    object3d.visible = rain > 0;
    if (rain <= 0) {
      for (const layer of layers) layer.setCount(0);
      stats.streaks = 0;
      stats.curtains = 0;
      return;
    }

    // A whisper of rain must look like a whisper: the first tenth of the slider
    // brings the opacity up from nothing rather than dropping a fifth of a
    // squall's worth of drops straight in.
    const onset = smoothstep(0, 0.14, rain);
    streaks.uniforms.uOpacity.value = 0.5 * onset;
    curtains.uniforms.uOpacity.value = 0.42 * onset * (0.45 + 0.55 * rain);
  }

  function setSeaState() {
    readWind();
  }

  function readWind() {
    const sea = waveField?.sea;
    downwind(pinnedWind ?? sea?.windFromDeg ?? 285, windDir);
    windUnit.x = windDir.x;
    windUnit.z = windDir.y;
  }

  readWind();
  setLighting(options.lighting ?? {});
  setWeather({ rain });

  return {
    object3d,
    stats,
    uniforms: { streaks: streaks.uniforms, curtains: curtains.uniforms },

    /**
     * One frame. Call it inside the same step the wave field is advanced in —
     * the clock read here is the field's, so a frame the field has not been
     * advanced for simply draws the same instant again.
     */
    update(dt, cameraPos) {
      if (rain <= 0 || !(dt > 0)) return stats;

      const sea = waveField.sea;
      const t = waveField.time;

      readWind();

      // The lean. A drop has picked up most of the wind by the time it reaches
      // the eye, so rain in a gale arrives very nearly flat — and that lean is
      // the single most legible statement the weather makes about the wind.
      const shear = Math.min((sea?.windSpeed ?? 0) * WIND_SHARE, MAX_SHEAR);
      fall.set(windUnit.x * shear, -FALL_SPEED, windUnit.z * shear);
      const speed = fall.length() || FALL_SPEED;
      streaks.uniforms.uFall.value.copy(fall).multiplyScalar(1 / speed);
      // Streak length is the distance a drop covers in about a thirtieth of a
      // second — the eye's own exposure. Faster rain draws longer lines, which
      // is why a squall looks like it is being poured rather than falling. The
      // floor is there so that rain in a flat calm still reads as rain.
      streaks.uniforms.uLength.value = Math.max(speed * 0.032, 0.28);

      curtains.uniforms.uTime.value = t;

      const cx = cameraPos?.x ?? 0;
      const cy = cameraPos?.y ?? 0;
      const cz = cameraPos?.z ?? 0;

      const ctx = {
        dt, sea, t, cx, cy, cz, fall, windUnit,
        windSpeed: sea?.windSpeed ?? 0,
        live: 0,
      };

      // Population, not opacity: rain is a number of drops.
      ctx.live = Math.max(1, Math.round(budget.streaks * rain));
      stats.streaks = streaks.update(ctx);

      // Three curtains at a drizzle, six in a squall — the band the amendment
      // asks for, and about as many as a sky can hold without becoming one
      // continuous grey sheet.
      ctx.live = clamp(Math.round(2 + 4 * rain), 1, budget.curtains);
      stats.curtains = curtains.update(ctx);

      return stats;
    },

    setWeather,
    setLighting,

    /** Nothing to re-derive but the wind; the surface is read fresh each frame. */
    setSeaState,

    dispose() {
      for (const layer of layers) {
        layer.geometry.dispose();
        layer.object3d.material.dispose();
      }
      object3d.clear();
    },
  };
}
