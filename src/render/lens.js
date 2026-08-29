// Water on the glass.
//
// Every other layer in this library draws the sea. This one draws what the sea
// leaves *on the eye* — the handful of beads that a crest breaking over the
// taffrail puts across your face, and that you then spend two seconds looking
// through. It is the smallest layer here and the only one that lives in screen
// space, and both facts are the same fact: a droplet on a lens has no position
// in the world. It is not water any more. It is a smear between you and the
// water.
//
// The discipline is severity. A wet lens is a garnish that says *that one got
// you* and then gets out of the way; a wet lens that lingers, or that covers
// enough of the frame to be read as an image in its own right, is the oldest
// and cheapest trick in the medium and it makes a sea look like a video game
// rather than like weather. So: ten beads, none of them large, all of them
// gone inside two and a half seconds, and an opacity chosen so that the sea is
// legible straight through the middle of one. The HUD is DOM and sits over the
// canvas entirely, so nothing here can obscure it — but the sea can be
// obscured, and must not be.
//
// Three constraints shaped the implementation:
//
//   No framebuffer reads. A real bead refracts what is behind it, and reading
//   what is behind it means a copy of the frame — a whole extra target, bound
//   and sampled, for ten sprites. Instead each bead is drawn as its own
//   meniscus: dark in the middle where a lens gathers the scene down, bright
//   at the rim where it throws the sky at you. That is what the eye actually
//   picks a water droplet out by, and it costs one blend.
//
//   No knowledge of the viewport. The pool is held in normalised device
//   coordinates and the vertex stage recovers the aspect ratio from the
//   projection matrix it is handed, exactly as `rain.js` does for its streaks.
//   So the lens needs no resize handler, and a caller who forgets one is not
//   punished with oval droplets.
//
//   `enabled: false` builds nothing. No geometry, no material, no arrays: the
//   object3d is an empty group and every method returns. A game that wants no
//   wet lens on a low setting pays for a group and six closures.
//
// Attaching it: the vertex stage writes clip space directly and never reads a
// model matrix, so where the object sits in the graph is irrelevant to what is
// drawn — but it must be *in* the graph. Parent it to the camera and add the
// camera to the scene:
//
//     scene.add(camera);            // three.js only walks what is in the scene
//     camera.add(lens.object3d);
//
// which is the honest description of what it is: something stuck to the front
// of the camera. `scene.add(lens.object3d)` draws identically, and is there for
// a rig that would rather not put its camera in the graph.
//
// Frame history, and so exempt from strict determinism by the amendment — but
// the seeded LCG is here anyway, because ten beads that can be replayed are
// easier to test than ten that cannot, and it costs nothing to keep.

import * as THREE from 'three';

/** Beads. Ten is a face-full; the eye cannot count past about six anyway. */
const POOL = 10;

/** How long one lasts, in seconds, before the wind and the run of it win. */
const LIFE = { min: 1.5, max: 2.5 };

/**
 * Bead radius, as a fraction of half the screen *height* — so it is the same
 * size on any aspect ratio and on any pixel ratio. A tenth of that is about
 * fifteen pixels on a laptop: a real droplet on real glass, seen from the
 * distance a face sits from a screen.
 */
const SIZE = { min: 0.022, max: 0.055 };

/**
 * How long a bead clings before it breaks away and starts to run.
 *
 * This is the whole difference between water and confetti. A droplet that
 * begins sliding the instant it lands reads as a sprite with a velocity;
 * surface tension holds a real one still for a moment, and then it goes.
 */
const HOLD = { min: 0.12, max: 0.5 };

/** Downward acceleration once it lets go, in screen heights per second squared. */
const RUN = 0.34;

/** And how hard the wind drags it across, in the same units. */
const SHEAR = 0.42;

/**
 * A little drag, so a bead creeps rather than accelerating off the frame. Water
 * on glass is nearly all friction; this is the number that says so.
 */
const CREEP = 1.9;

/** Rain below this leaves nothing on the glass. Drizzle does not bead. */
const RAIN_ONSET = 0.4;

/** And a blinding squall puts this many beads a second on it. Not many. */
const RAIN_RATE = 1.1;

/**
 * The soonest two bursts may be told apart. The spray already rate-limits its
 * own callback, so this is a guard against a second caller and not a policy:
 * without it, anything that called `notifySpray` every frame would keep the
 * glass permanently streaming.
 */
const BURST_GAP = 0.25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The library's LCG, the one `spectrum.js`, `spray.js` and `rain.js` use. */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Hex numbers, CSS strings and THREE.Colors are all fair game for a palette. */
function readColour(out, value) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'number') out.setHex(value);
  else out.set(value);
  return out;
}

// --- Shaders -----------------------------------------------------------------

// The bead is placed in clip space by hand. Nothing here reads the model or the
// view matrix: the pool already knows where it is on the screen, and asking a
// transform about it could only get it wrong.
//
// The projection matrix is read for one number. For any perspective camera
// P[1][1]/P[0][0] is the aspect ratio, which is what turns a circle in NDC into
// an oval and back — so the quad is laid out in a square space where a width is
// a height, and only the last step divides x by it. That is also why there is
// no resize handler in this file: the aspect arrives with the frame.
const vertexShader = /* glsl */ `
  attribute vec2 iPos;     // centre, in normalised device coordinates
  attribute vec2 iVel;     // NDC a second; the bead is drawn out along it
  attribute float iSize;   // radius, in half-screen-heights
  attribute float iFade;
  attribute float iSeed;

  uniform float uStretch;  // seconds of run drawn as length

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;

  void main() {
    vUv = position.xy + 0.5;
    vFade = iFade;
    vSeed = iSeed;

    float aspect = projectionMatrix[1][1] / projectionMatrix[0][0];

    // The run, in the square space, so a bead sliding down a wide screen is not
    // told it is sliding sideways.
    vec2 run = vec2(iVel.x * aspect, iVel.y);
    float speed = length(run);
    // Still, or as near as makes no difference: a bead that has not let go yet
    // has no direction to be drawn out along, and any will do because it is
    // about to be round.
    vec2 axis = speed > 1e-4 ? run / speed : vec2(0.0, -1.0);
    vec2 perp = vec2(-axis.y, axis.x);

    // Round while it clings, drawn out once it runs. Only a little: a bead that
    // stretches with its speed becomes a scratch, and a scratch on the lens is
    // a different and much less welcome effect.
    float len = iSize * (1.0 + min(speed * uStretch, 1.3));

    vec2 off = perp * (position.x * iSize * 2.0) + axis * (position.y * len * 2.0);
    gl_Position = vec4(iPos + vec2(off.x / aspect, off.y), 0.0, 1.0);
  }
`;

// A meniscus, and nothing else.
//
// Alpha-blended in two passes at once: a dark core that takes the scene down a
// little, and a bright rim laid over it. That is a lens seen from the wrong
// side — it gathers what is behind it into the middle, which reads as darker
// and busier, and it throws the sky at you off the curve of the edge. Additive
// would give the rim and lose the core, and a droplet with no core is a spark.
const fragmentShader = /* glsl */ `
  uniform vec3 uColour;    // the rim: the sky, on the curve of the water
  uniform vec3 uCore;      // the middle: the scene, gathered and dimmed
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;

  void main() {
    vec2 c = vUv - 0.5;

    // The trailing half of a running bead is narrower than the head: the water
    // is being left behind rather than carried, and that taper is most of what
    // says which way it is going.
    float along = vUv.y;
    float narrow = mix(0.5, 1.0, smoothstep(0.0, 0.62, along));
    float r = length(vec2(c.x / narrow, c.y)) * 2.0;

    // The bead's own extent, soft at the edge because water has no edge.
    float body = 1.0 - smoothstep(0.74, 1.0, r);
    // And the meniscus, which is where it is: a ring, thrown out toward the rim
    // and a touch wider on one bead than the next.
    float rim = smoothstep(mix(0.24, 0.38, vSeed), 0.9, r) * body;

    // The tail is thinner water and lets more through.
    float weight = mix(0.4, 1.0, smoothstep(0.0, 0.55, along));

    float alpha = (0.30 * body + 0.70 * rim) * weight * vFade * uOpacity;
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(mix(uCore, uColour, rim), alpha);

    #include <colorspace_fragment>
  }
`;

// --- The system ---------------------------------------------------------------

/**
 * Water on the glass.
 *
 * @param options
 *   `enabled`  false builds nothing at all — no arrays, no geometry, no
 *              material — and every method becomes a no-op. Default true.
 *   `pool`     how many beads at once; ten by default, and ten is already a
 *              great deal of water.
 *   `seed`     integer; same seed, same beads. Default 51423.
 *   `colour`   the rim: what the sky looks like on the curve of a droplet.
 *   `core`     the middle: the scene, gathered down.
 *   `opacity`  the ceiling on the whole layer. Raise it and this stops being a
 *              garnish; the default is where it was judged from the helm.
 *   `rain`     the weather to start at, if the lens should already be wet.
 *
 * @returns `{ object3d, notifySpray(strength), update(dt, windScreenVec?),
 *            setWeather({ rain }), enabled, stats, dispose }`
 */
export function createLens(options = {}) {
  const enabled = options.enabled !== false;

  const object3d = new THREE.Group();
  object3d.name = 'lens';

  const stats = { alive: 0, rain: 0 };

  // Nothing below this line is built when the lens is off. The group is real,
  // so a caller may add it to the graph unconditionally and never test.
  if (!enabled) {
    return {
      object3d,
      stats,
      get enabled() { return false; },
      notifySpray() {},
      update() { return stats; },
      setWeather() {},
      dispose() {},
    };
  }

  const count = Math.max(1, Math.round(options.pool ?? POOL));
  const rand = makeRandom(options.seed ?? 51423);

  const pos = new Float32Array(count * 2);
  const vel = new Float32Array(count * 2);
  const sizes = new Float32Array(count);
  const fades = new Float32Array(count);
  const seeds = new Float32Array(count);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const hold = new Float32Array(count);

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 2));
  geometry.setAttribute('iVel', new THREE.InstancedBufferAttribute(vel, 2));
  geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(sizes, 1));
  geometry.setAttribute('iFade', new THREE.InstancedBufferAttribute(fades, 1));
  geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.instanceCount = count;
  // It is drawn in clip space and has no place in the world; a frustum test
  // could only ever throw it away.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const uniforms = {
    // A droplet takes the sky's colour on its rim, whatever the sky is doing.
    // Pale rather than white: white beads read as dust on the sensor.
    uColour: { value: readColour(new THREE.Color(), options.colour ?? 0xeef2f3) },
    uCore: { value: readColour(new THREE.Color(), options.core ?? 0x2b3439) },
    uOpacity: { value: clamp(options.opacity ?? 0.5, 0, 1) },
    uStretch: { value: 1.6 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
    depthWrite: false,
    // It is on the front of the lens: nothing in the world is in front of it,
    // and the depth it would be tested against is meaningless anyway.
    depthTest: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  // Last of everything, including the rain — a bead on the glass is in front of
  // the drop that made it.
  mesh.renderOrder = 4000;
  mesh.name = 'lens-beads';
  object3d.add(mesh);

  let rain = clamp(options.rain ?? 0, 0, 1);
  stats.rain = rain;
  let rainCarry = 0;
  let sinceBurst = BURST_GAP;
  let cursor = 0;

  /** Put one bead on the glass. Silently does nothing if the pool is full. */
  function place(strength) {
    // Round robin from a rotating cursor, so a burst spreads over the pool
    // instead of refilling one slot. A full pool simply refuses: nothing alive
    // is ever evicted, because a bead that vanished mid-run to make room for
    // another would be the one thing the eye is certain to catch.
    let slot = -1;
    for (let n = 0; n < count; n++) {
      const i = (cursor + n) % count;
      if (life[i] <= 0) { slot = i; break; }
    }
    if (slot < 0) return false;
    cursor = (slot + 1) % count;

    const o = slot * 2;
    // Anywhere but the very edges, and a little above the middle by preference:
    // a bead has to have somewhere to run to, and one born on the bottom rail
    // is gone before it has been seen.
    pos[o] = (rand() * 2 - 1) * 0.82;
    pos[o + 1] = -0.35 + rand() * 1.15;
    vel[o] = 0;
    vel[o + 1] = 0;
    // A hard face-full throws bigger water than a fleck off a crest.
    sizes[slot] = (SIZE.min + rand() * (SIZE.max - SIZE.min)) * (0.7 + 0.45 * strength);
    seeds[slot] = rand();
    hold[slot] = HOLD.min + rand() * (HOLD.max - HOLD.min);
    maxLife[slot] = LIFE.min + rand() * (LIFE.max - LIFE.min);
    life[slot] = maxLife[slot];
    fades[slot] = 0;
    return true;
  }

  return {
    object3d,
    stats,
    uniforms,

    get enabled() {
      return true;
    },

    /**
     * The sea just got you.
     *
     * @param strength 0..1, as `spray.js` reports it: a fleck at arm's length
     *                 against a crest over the taffrail. It decides how many
     *                 beads land and how big they are, and nothing else — the
     *                 opacity is fixed, because a wetter lens must be more
     *                 water and never a heavier filter.
     */
    notifySpray(strength = 0.5) {
      if (sinceBurst < BURST_GAP) return 0;
      sinceBurst = 0;

      const s = clamp(Number.isFinite(strength) ? strength : 0.5, 0, 1);
      // One to five. Five beads is already most of the pool, and the pool is
      // the ceiling that keeps the worst case honest.
      const want = 1 + Math.round(s * 4);
      let put = 0;
      for (let n = 0; n < want; n++) if (place(s)) put++;
      return put;
    },

    /**
     * One frame.
     *
     * @param windScreenVec  the wind's direction as it lies on the screen —
     *                       view-space x right, y up, any length. The beads
     *                       shear along it, which is what ties the glass to the
     *                       weather rather than to gravity alone. Optional:
     *                       without it they simply run down.
     */
    update(dt, windScreenVec) {
      if (!(dt > 0)) return stats;

      sinceBurst += dt;

      // Rain, if there is enough of it to bead at all. A drizzle wets glass
      // evenly and leaves nothing to look at; it takes a real fall before
      // separate drops start standing on it.
      if (rain > RAIN_ONSET) {
        rainCarry += smoothstep(RAIN_ONSET, 1, rain) * RAIN_RATE * dt;
        while (rainCarry >= 1) {
          rainCarry -= 1;
          // Small ones. Rain beads are not thrown, they land.
          place(0.25 * rain);
        }
      } else {
        rainCarry = 0;
      }

      let wx = 0;
      let wy = 0;
      if (windScreenVec) {
        const x = windScreenVec.x ?? 0;
        const y = windScreenVec.y ?? 0;
        const l = Math.hypot(x, y);
        if (l > 1e-4) { wx = x / l; wy = y / l; }
      }

      let alive = 0;

      for (let i = 0; i < count; i++) {
        if (life[i] <= 0) {
          fades[i] = 0;
          continue;
        }

        life[i] -= dt;
        if (life[i] <= 0) { fades[i] = 0; continue; }

        const o = i * 2;
        const age = maxLife[i] - life[i];

        if (age > hold[i]) {
          // It has let go. Gravity down the glass, the wind across it, and a
          // friction that keeps the whole thing a creep rather than a fall.
          vel[o] += (wx * SHEAR - vel[o] * CREEP) * dt;
          vel[o + 1] += (wy * SHEAR - RUN - vel[o + 1] * CREEP) * dt;
          pos[o] += vel[o] * dt;
          pos[o + 1] += vel[o + 1] * dt;
        }

        // Off the glass: gone, and the slot is free again this instant.
        if (pos[o] < -1.3 || pos[o] > 1.3 || pos[o + 1] < -1.3 || pos[o + 1] > 1.3) {
          life[i] = 0;
          fades[i] = 0;
          continue;
        }

        const lifeT = 1 - life[i] / maxLife[i];
        // On fast — it *arrived*, it did not appear — and off slowly, because
        // what actually happens is that it thins and runs out rather than
        // vanishing.
        fades[i] = Math.min(1, lifeT * 14) * Math.min(1, (1 - lifeT) * 2.4);
        alive++;
      }

      geometry.attributes.iPos.needsUpdate = true;
      geometry.attributes.iVel.needsUpdate = true;
      geometry.attributes.iSize.needsUpdate = true;
      geometry.attributes.iFade.needsUpdate = true;
      geometry.attributes.iSeed.needsUpdate = true;

      // Nothing on the glass is nothing to draw.
      mesh.visible = alive > 0;
      stats.alive = alive;
      return stats;
    },

    /**
     * How hard it is raining. Only heavy rain reaches the glass at all, and it
     * arrives as a slow trickle rather than a burst — the spray is what bursts.
     */
    setWeather(next = {}) {
      if (next.rain !== undefined) {
        rain = clamp(Number.isFinite(next.rain) ? next.rain : 0, 0, 1);
        stats.rain = rain;
      }
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      object3d.clear();
    },
  };
}
