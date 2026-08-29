// Water in the air.
//
// Above about Force 8 the sea stops being a surface. Crests break, and what
// comes off them is not one thing but three, and the eye reads all three
// differently:
//
//   Spume     — foam torn off the white water and carried bodily downwind,
//               hugging the surface it skims over. Thick, fine, everywhere.
//               This is the closest-range way of seeing what the air is doing,
//               and it is the class ported straight from the albatross game.
//   Droplets  — heavier water thrown clear of a hard-breaking crest, on a flat
//               ballistic arc: up a couple of metres, thirty downwind, then
//               back into the face of the next sea. Sparser, brighter, bigger.
//   Sheets    — above Force 9 whole veils of lace peel off the crests and sail
//               away as translucent rags before they shred. Photographs of
//               survival storms are mostly this, and nothing else looks like it.
//
// All three read the CPU sum and nothing else: `crestAt` decides where water is
// being torn off, `orbitalVelocityAt` gives it the velocity the water already
// had, and `roughHeightAt` is the surface it rides over and dies into. The
// identity is preserved by construction — this file never invents water, it
// only follows water the SeaState already describes. Height comes from
// `roughHeightAt` rather than `heightAt` for exactly the reason CONTRACT.md
// gives: spray is decorative, and it is never asked to touch the sea exactly.
//
// Two things are generalised out of the game's version. The spawn threshold is
// expressed in standard deviations of the sea's *own* crest pinch instead of
// the storm-tuned absolute the game shipped — that absolute is 1.8 sigma on the
// storm preset, and about four on a breeze, where it would never fire at all.
// And the population is frame-rate independent: the game tried one spawn per
// dead particle per frame, which quietly halved the spray on a thirty-hertz
// machine.
//
// A third generalisation came later, and it came from standing at the helm
// rather than flying over it. The spawn window is a disc a couple of hundred
// metres across, and a disc that size puts almost nothing in the handful of
// metres where a streak reads as *passing*: the spume lived politely out on the
// water and nothing ever reached the eye. So when the eye is at deck height and
// the wind is strong, a share of the same spawn budget is redirected into a
// narrow corridor dead upwind of the camera — the deck pass. The water still
// comes off breaking crests and off nothing else; it is simply *asked for*
// where it will be seen. Nothing is added: the pools, the attempt rate and the
// thresholds are untouched, and this is redistribution to the last particle.
// The corridor closes smoothly as the eye climbs, because the same library
// flies an albatross two hundred metres up, and it never opens at all on a sea
// with no wind in it — a calm draws not one extra random number.

import * as THREE from 'three';

/**
 * How much of this a machine gets. The desktop numbers are the ones the look
 * was judged on; a coarse pointer is a phone, and a phone gets half.
 *
 * These are pool sizes, not live counts. A pool is only as full as the sea
 * gives it cause to be: on `calm` almost nothing spawns and almost nothing is
 * drawn, at the cost of one crest query per dead particle per frame.
 */
// Sheets were first cut at 24 and measured from the helm: a veil in frame a
// fifth of the time, which reads as an anecdote. A survival-storm photograph
// is full of them, and the review that asked for them suggested 50–150.
const DESKTOP_BUDGET = { spume: 900, droplets: 500, sheets: 56 };

/** Wind speed below which no sheet ever peels off a crest. Force 9. */
const SHEET_WIND = 22;

/** The spawn attempt rate the game's numbers were tuned at. */
const ATTEMPT_HZ = 60;

/** Never more than this many attempts per dead particle in one long frame. */
const MAX_ATTEMPTS = 4;

/**
 * The share of a pool that may go looking for a crest in one frame.
 *
 * Without it the cheapest sea is the dearest: on `calm` nothing ever spawns, so
 * every slot in the pool is empty and every slot pays for a crest query, every
 * frame, to be told again that the water is not breaking.
 *
 * Three quarters, and not less, because the ceiling must sit above the emptiest
 * pool any sea can *fill*. A storm keeps nine tenths of its spume in the air and
 * never comes close; a gale, which is the awkward case, runs about half empty,
 * and capping below that would thin its streaks by a third — the sea state must
 * set the population, never an internal budget. Below a gale the cap binds hard
 * and costs nothing at all, because those seas were never going to fill the
 * pool anyway. The scan starts from a rotating cursor so no slot starves.
 */
const SEARCH_SHARE = 0.75;

/**
 * The deck pass: the corridor of air dead upwind of a low eye.
 *
 * `share` is the fraction of that class's spawn attempts redirected into it.
 * A fifth of the spume, because eight hundred streaks funnelled into one
 * corridor would be a wall rather than weather; near a third of the droplets,
 * because they are the sparse class and the only one that actually reaches the
 * eye. `spread` is the corridor's half-width in metres and `near` how close
 * upwind a particle may be born — far enough out that nothing is ever born
 * inside the near plane, close enough that it is past in a heartbeat.
 *
 * `flight` is not a distance but a fraction of one: the class's own speed over
 * the ground times the share of its life the corridor should cover. Most of it,
 * not all — a corridor as long as the whole flight delivers its first arrivals
 * and then goes quiet, and one much shorter fires a volley rather than a stream.
 */
const DECK = {
  spume: { share: 0.22, spread: 6, near: 5, flight: 1.15 * 1.8 },
  droplets: { share: 0.3, spread: 5, near: 4, flight: 1.05 * 1.15 },
};

/** Deck height, and the altitude by which the pass has faded out entirely. */
const DECK_EYE = { low: 10, high: 20 };

/**
 * Force 6 to Force 8. Below that the sea may still be big — a dying swell is
 * enormous and perfectly quiet — but there is no wind in it to carry water past
 * anybody's face, and the corridor would only crowd the spume it already has.
 */
const DECK_WIND = { off: 12, full: 18 };

/** Arm's length. A droplet inside this has hit the man at the wheel. */
const HIT_RADIUS = 2.5;

/** And it may say so no more than once a second, however wet it gets. */
const HIT_COOLDOWN = 1;

/** Droplets inside arm's length in one frame that make a face-full. */
const HIT_FULL = 5;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The one source of randomness here, and it is the library's: the same LCG
 * `spectrum.js` uses, so a sea and the spray blowing off it come from the same
 * arithmetic. Each particle class owns its own stream, so changing the budget
 * of one class never reshuffles the others.
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TAU = Math.PI * 2;

/** Scratch for the spawn search. Nothing nests, so one is enough. */
const _spawn = { x: 0, z: 0 };

/**
 * Where to try for a new particle.
 *
 * The game scattered its candidates uniformly across a square six hundred
 * metres on a side and pushed the whole square three seconds *downwind*. Both
 * are right for a bird flying downwind through its own cloud, and wrong for
 * anything that holds station, which is what a ship does. Two corrections:
 *
 * `crowd` is the power the radius is raised to. A half is an even scatter over
 * the disc, and anything above it pulls the pool in toward the eye. It has to
 * be well above it, because the wind is doing the opposite: in a survival storm
 * spray covers a hundred metres of ground in its short life, so a birth
 * distribution that looks even arrives at the eye smeared over the whole spawn
 * radius, and what is left near enough to see is dust.
 *
 * `lead` is metres upwind: the window is offset by half the flight this class
 * of particle makes, so the stream it lays down runs *through* the viewer
 * instead of receding from him. Per class, because a droplet flies for a second
 * and a half and a veil for six, and per frame, because it is the gusting wind
 * that carries them.
 *
 * The radius that results is deliberately short — a couple of hundred metres,
 * not the horizon. Past that a sprite is a pixel and a half and reads as dust,
 * and the distance is the shader's business anyway: `ocean.js` streaks it with
 * spindrift out to two and a half kilometres. Particles do the near water.
 */
function spawnPoint(rand, cx, cz, range, windUnit, crowd, minR, lead, out = _spawn) {
  const ang = rand() * TAU;
  const rad = minR + (range - minR) * Math.pow(rand(), crowd);
  out.x = cx + Math.cos(ang) * rad - windUnit.x * lead;
  out.z = cz + Math.sin(ang) * rad - windUnit.z * lead;
  return out;
}

/**
 * A birth in the deck corridor: dead upwind of the eye, within a few metres of
 * the line the wind is about to carry it along.
 *
 * The lateral offset is squared about the middle rather than even, so most of
 * what is born here goes by close enough to streak across the view and only the
 * tail of the distribution passes out on the beam. Everything else about the
 * birth is unchanged — the crest test that follows is the same test — so this
 * asks for water where it will be seen and never invents any.
 */
function deckPoint(rand, cx, cz, windUnit, reach, spread, near, out = _spawn) {
  const up = near + rand() * Math.max(reach - near, 1);
  const u = rand() * 2 - 1;
  const side = u * Math.abs(u) * spread;
  // Upwind is minus the downwind unit; across it is that vector turned a quarter
  // turn in the xz plane.
  out.x = cx - windUnit.x * up - windUnit.z * side;
  out.z = cz - windUnit.z * up + windUnit.x * side;
  return out;
}

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
 * What a sea state is entitled to throw into the air.
 *
 * Every preset spends about the same Gerstner pinch budget — that is a
 * stability constraint, not a weather one — so the crest signal looks much the
 * same in a millpond as in a storm, and a fixed threshold would tear spray off
 * both alike. The honest signal for *weather* is how big the sea actually is:
 * significant height, four sigma of the surface. So the thresholds are set in
 * sigmas of pinch, and the number of sigmas slides down as the sea builds.
 *
 * The anchor is the game's proven constant. `crestAt > 0.3` is what shipped in
 * the albatross game, tuned by eye on the storm preset, and 0.3 is 1.80 sigma
 * of that preset's crest pinch. `3.9 − 2.6·coverage` lands on 1.79 sigma there,
 * so the storm sea gets back exactly the spume it had; a breeze gets 3.2 sigma
 * and shows the odd streak off the odd whitecap; greybeards get 1.33 sigma and
 * stream. Droplets want a harder break than spume, and sheets harder still.
 *
 * @param sea  a SeaState.
 */
export function sprayProfile(sea) {
  const waves = sea?.waves ?? [];

  let heightVar = 0;
  let pinchVar = 0;
  let orbital = 0;
  for (const w of waves) {
    heightVar += w.amp * w.amp * 0.5;
    const pinch = w.q * w.k * w.amp;
    pinchVar += pinch * pinch * 0.5;
    // Σ ω·A is the fastest the water can be moving vertically — every wave at
    // its crest at once. It is the natural speed scale for anything thrown off
    // one, and it is what the upward kick is quoted as a fraction of.
    orbital += w.omega * w.amp;
  }

  const heightSigma = Math.sqrt(heightVar) || 0.05;
  const crestSigma = Math.sqrt(pinchVar) || 0.02;
  const significant = 4 * heightSigma;

  // 0 at a glassy heave, 1 in a survival sea. The same curve `foamProfile` uses,
  // so what the shader paints white and what this file tears off it agree.
  const coverage = Math.pow(clamp((significant - 0.35) / 17, 0, 1), 0.55);

  const spumeSigma = 3.9 - 2.6 * coverage;

  return {
    heightSigma,
    crestSigma,
    coverage,
    // Everything is quoted in sigmas of pinch and then made absolute here, so
    // the update loop compares two plain numbers.
    spumeThreshold: crestSigma * spumeSigma,
    dropletThreshold: crestSigma * (spumeSigma + 0.55),
    sheetThreshold: crestSigma * (spumeSigma + 0.7),
    // A crest in a seventeen-metre sea throws bigger water further than one in
    // a two-metre sea. Everything with a length in metres scales by this.
    scale: clamp(heightSigma / 3, 0.55, 1.55),
    kickRef: orbital,
    windSpeed: sea?.windSpeed ?? 0,
    // Sheets start at Force 9 and are the whole sky by Force 11.
    sheetChance: clamp(((sea?.windSpeed ?? 0) - SHEET_WIND) / 12, 0, 1),
    // And the deck pass starts at Force 6. Nought here is the gate that keeps a
    // calm sea paying nothing at all for a corridor it would never fill.
    deckWind: smoothstep(DECK_WIND.off, DECK_WIND.full, sea?.windSpeed ?? 0),
  };
}

// --- Shaders -----------------------------------------------------------------

// Spume and droplets are both point sprites and share their vertex stage. The
// one thing the vertex stage does beyond placing them is work out which way the
// wind runs *on screen*, so the fragment stage can draw a streak lying along it
// rather than a dot — a point sprite is square, but nothing says what is drawn
// inside it has to be round, and a dot is the whole difference between spray
// and a swarm of gnats.
const pointVert = /* glsl */ `
  attribute float aFade;
  attribute float aSize;

  uniform float uPixelRatio;
  uniform float uSizeGain;
  uniform float uSizeMax;
  uniform vec2 uWindDir;

  varying float vFade;
  varying vec2 vAxis;

  void main() {
    vFade = aFade;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    vec3 windView = (viewMatrix * vec4(uWindDir.x, 0.0, uWindDir.y, 0.0)).xyz;
    float wl = length(windView.xy);
    // Looking straight up or down the wind it has no direction on screen, and a
    // streak seen end-on is a dot anyway.
    vAxis = wl > 1e-3 ? windView.xy / wl : vec2(1.0, 0.0);

    // Clamped at both ends. Below a pixel and a half a streak flickers as it
    // crosses the sampling grid; past the size ceiling a point sprite stops
    // being water and becomes a disc with a visible edge, which is the one
    // thing that gives a particle system away.
    gl_PointSize = clamp(aSize * uSizeGain * uPixelRatio * 260.0 / -mv.z, 1.5, uSizeMax);
  }
`;

/**
 * A soft streak. `uCore` is where the edge starts to bite — spume is all edge
 * and fades from the middle out, a droplet is a bead of water with something
 * like a rim — and `uStretch` is how many times narrower it is across the wind
 * than along it. One is a disc.
 */
const pointFrag = /* glsl */ `
  uniform vec3 uColour;
  uniform float uCore;
  uniform float uOpacity;
  uniform float uStretch;

  varying float vFade;
  varying vec2 vAxis;

  void main() {
    // Point coordinates run down the screen and everything else runs up it.
    vec2 d = gl_PointCoord - 0.5;
    d.y = -d.y;

    // Measured in the wind's own frame: full length along it, thin across.
    vec2 e = vec2(dot(d, vAxis), dot(d, vec2(-vAxis.y, vAxis.x)) * uStretch);
    float r = length(e) * 2.0;

    float alpha = smoothstep(1.0, uCore, r) * vFade * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColour, alpha);

    #include <colorspace_fragment>
  }
`;

// A sheet is a screen-aligned quad stretched along the wind *as the wind
// appears from here* — turn to look downwind and the veils foreshorten into
// blades, which is exactly what they do. The alternative, orienting them in
// world space, leaves them edge-on and invisible from half the compass.
const sheetVert = /* glsl */ `
  attribute vec3 iPos;
  attribute vec2 iSize;
  attribute float iFade;
  attribute float iSeed;
  attribute float iAge;

  uniform vec2 uWindDir;

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;
  varying float vAge;

  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);

    vec3 windView = (viewMatrix * vec4(uWindDir.x, 0.0, uWindDir.y, 0.0)).xyz;
    // Dead on the axis the wind vanishes from the screen; hold the last sane
    // orientation rather than normalising a zero.
    float wl = length(windView.xy);
    vec2 axis = wl > 1e-3 ? windView.xy / wl : vec2(1.0, 0.0);
    vec2 perp = vec2(-axis.y, axis.x);

    mv.xy += axis * position.x * iSize.x + perp * position.y * iSize.y;

    vUv = position.xy + 0.5;
    vFade = iFade;
    vSeed = iSeed;
    vAge = iAge;

    gl_Position = projectionMatrix * mv;
  }
`;

// Alpha-blended, not additive. Additive spray over a bright sea clips to paper
// white in the first lighting preset it meets; blending toward the foam colour
// brightens the same way and stops exactly where a sheet of foam stops, which
// is the point — a veil is thin water, not light.
const sheetFrag = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;

  varying vec2 vUv;
  varying float vFade;
  varying float vSeed;
  varying float vAge;

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
    return noise(p) * 0.62 + noise(p * 2.9) * 0.38;
  }

  void main() {
    vec2 c = vUv - 0.5;

    // Soft everywhere, softest across the wind: a veil is drawn out, never puffy.
    float body = smoothstep(0.5, 0.06, abs(c.y)) * smoothstep(0.5, 0.14, abs(c.x));

    // Torn into lace, and the tearing crawls downwind along the sheet as it
    // ages, so a veil shreds rather than simply dimming.
    float tat = fbm(vec2(vUv.x * 6.5 - vAge * 2.1 + vSeed * 37.0,
                         vUv.y * 2.4 + vSeed * 19.0));
    float lace = mix(0.28, 1.0, smoothstep(0.33, 0.74, tat));

    // The upwind edge is still attached to the crest; the downwind end is gone.
    float taper = mix(1.0, 0.22, vUv.x);

    float alpha = body * lace * taper * vFade * uOpacity;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColour, alpha);

    #include <colorspace_fragment>
  }
`;

// --- The three classes -------------------------------------------------------

/**
 * Spume: near-surface streaks, carried on the wind, hugging the water.
 *
 * The port of the game's system, near enough constant for constant. A particle
 * is born on a breaking crest upwind of the viewer, rides the wind a touch
 * faster than the wind itself, and is held down onto whatever surface is under
 * it by an exponential ease — that ease is why it reads as skimming the water
 * rather than flying over it, and it is the whole trick of the class. It is
 * drawn as a streak lying along the wind rather than the game's round point:
 * that is the difference between spray and a swarm of gnats when the eye is six
 * feet above the water and there are eight hundred of them.
 */
function createSpume(count, seed) {
  const positions = new Float32Array(count * 3);
  const fades = new Float32Array(count);
  const sizes = new Float32Array(count);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const rand = makeRandom(seed);
  const maxSearch = Math.max(1, Math.ceil(count * SEARCH_SHARE));
  let cursor = 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  // The pool spans the horizon and every point moves on the CPU: there is
  // nothing useful a frustum test could say about it.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const uniforms = {
    uColour: { value: new THREE.Color(0xdfe4e4) },
    uPixelRatio: { value: 1 },
    uWindDir: { value: new THREE.Vector2(0, 1) },
    // Longer than the game's round point, and much thinner, for the same ink:
    // spume is torn foam being dragged, and it lies down along the drag.
    uSizeGain: { value: 1.4 },
    uStretch: { value: 2.6 },
    uSizeMax: { value: 18 },
    uCore: { value: 0.1 },
    uOpacity: { value: 0.62 },
  };

  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
    })
  );
  points.frustumCulled = false;
  points.renderOrder = 25;
  points.name = 'spray-spume';

  function update(c) {
    const { dt, sea, t, wind, profile } = c;
    // Only worth having when the eye is low enough to resolve a streak. Soft,
    // because a bird climbing out of the troughs should watch it thin, not
    // watch it switch off.
    const gate = 1 - smoothstep(70, 110, c.altitude);
    // Mean life is two and a bit seconds, and a streak makes good rather more
    // than the wind's own speed over it.
    const travel = c.windSpeed * 1.15 * 2.7;
    const range = c.range * 220;
    const scale = profile.scale;
    // The share of this frame's attempts that go into the corridor instead of
    // out on to the water, and how far up it they may be born. The floor on the
    // reach is for a wind that has dropped away under a sea still running: the
    // corridor must not collapse into a single point on the taffrail.
    const deck = c.deck * DECK.spume.share;
    const reach = Math.max(DECK.spume.near + 8, c.windSpeed * DECK.spume.flight);
    let alive = 0;
    let searches = 0;

    for (let n = 0; n < count; n++) {
      const i = (cursor + n) % count;
      const o = i * 3;

      if (life[i] <= 0) {
        fades[i] = 0;
        if (gate <= 0.001 || searches >= maxSearch) continue;
        searches++;

        // Spawn only where a crest is genuinely breaking, so the spume comes
        // off white water and off nothing else.
        for (let a = 0; a < c.attempts; a++) {
          if (gate < 1 && rand() > gate) continue;
          // The draw is only made when the corridor is open — short-circuited,
          // and deliberately so. A calm sea, or a camera at altitude, takes the
          // same arithmetic and the very same stream of random numbers it took
          // before any of this was written.
          const { x, z } =
            deck > 0 && rand() < deck
              ? deckPoint(rand, c.cx, c.cz, c.windUnit, reach,
                          DECK.spume.spread, DECK.spume.near)
              : spawnPoint(rand, c.cx, c.cz, range, c.windUnit, 1.2, 4, travel * 0.5);
          if (sea.crestAt(x, z, t) < profile.spumeThreshold) continue;

          positions[o] = x;
          positions[o + 1] = sea.roughHeightAt(x, z, t) + (0.3 + rand() * 1.3) * scale;
          positions[o + 2] = z;
          maxLife[i] = 1.6 + rand() * 2.2;
          life[i] = maxLife[i];
          sizes[i] = (0.4 + rand() * 0.9) * scale;
          break;
        }
        continue;
      }

      life[i] -= dt;
      alive++;

      positions[o] += wind.x * 1.15 * dt;
      positions[o + 2] += wind.z * 1.15 * dt;
      const surface = sea.roughHeightAt(positions[o], positions[o + 2], t);
      // The game's metre of clearance, plus the streak's own size — which is
      // already in the sea's units, so it must not be scaled twice. Spume that
      // rides three metres up stops reading as foam being dragged over water
      // and starts reading as flies.
      const want = surface + scale + sizes[i];
      positions[o + 1] += (want - positions[o + 1]) * Math.min(1, dt * 3);

      const lifeT = 1 - life[i] / maxLife[i];
      fades[i] = Math.min(1, lifeT * 6) * Math.min(1, (1 - lifeT) * 3);
    }

    cursor = (cursor + maxSearch) % count;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFade.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    return alive;
  }

  return { object3d: points, uniforms, update, geometry };
}

/**
 * Droplets: water thrown clear of a hard-breaking crest, and then simply
 * falling.
 *
 * The only class in the file with a velocity of its own. It is born with the
 * velocity the water already had — the orbital motion at that point on the
 * surface, which at a pinching crest is several metres a second upward — plus
 * the wind that is tearing it away, plus a kick out of the break itself scaled
 * by how far past breaking the crest has gone. After that it is gravity and
 * air: nine point eight one down, and a drag that pulls it toward the speed of
 * the wind carrying it. It dies when it falls back into the sea.
 */
function createDroplets(count, seed) {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const fades = new Float32Array(count);
  const sizes = new Float32Array(count);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const rand = makeRandom(seed);
  const birth = new THREE.Vector3();
  const maxSearch = Math.max(1, Math.ceil(count * SEARCH_SHARE));
  let cursor = 0;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const uniforms = {
    uColour: { value: new THREE.Color(0xdfe4e4) },
    uPixelRatio: { value: 1 },
    uWindDir: { value: new THREE.Vector2(0, 1) },
    uSizeGain: { value: 1.15 },
    // Barely stretched: a thrown droplet is a bead, and what says it is moving
    // is that it is moving.
    uStretch: { value: 1.2 },
    // A bead of water has a rim; spume does not. Only a little of one, though —
    // a hard rim on a big near sprite reads as confetti, and these are the
    // sprites that get closest to the eye.
    uCore: { value: 0.3 },
    // Brighter than spume, but not opaque: what makes a droplet read as thrown
    // water rather than as a dot is that it is bigger and it moves on its own.
    // 0.82 read as confetti against a bright sky from the helm; 0.7 does not.
    uOpacity: { value: 0.7 },
    uSizeMax: { value: 13 },
  };

  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
    })
  );
  points.frustumCulled = false;
  points.renderOrder = 26;
  points.name = 'spray-droplets';

  function update(c) {
    const { dt, sea, t, wind, profile } = c;
    // Thrown water is bigger and brighter than spume and carries much further
    // up: the albatross still sees it from a couple of hundred metres.
    const gate = 1 - smoothstep(200, 300, c.altitude);
    // Shorter-lived than spume, and slower over the ground for the first half
    // of it while the drag is still hauling it up to the wind's speed.
    const travel = c.windSpeed * 1.05 * 1.65;
    const range = c.range * 200;
    const scale = profile.scale;
    const deck = c.deck * DECK.droplets.share;
    const reach = Math.max(DECK.droplets.near + 6, c.windSpeed * DECK.droplets.flight);
    // Arm's length, squared, so the hot loop compares two squares. Only counted
    // when somebody is listening and the last face-full is a second behind us.
    const hitR2 = c.wantHits ? HIT_RADIUS * HIT_RADIUS : -1;
    let alive = 0;
    let searches = 0;

    for (let n = 0; n < count; n++) {
      const i = (cursor + n) % count;
      const o = i * 3;

      if (life[i] <= 0) {
        fades[i] = 0;
        if (gate <= 0.001 || searches >= maxSearch) continue;
        searches++;

        for (let a = 0; a < c.attempts; a++) {
          if (gate < 1 && rand() > gate) continue;
          const { x, z } =
            deck > 0 && rand() < deck
              ? deckPoint(rand, c.cx, c.cz, c.windUnit, reach,
                          DECK.droplets.spread, DECK.droplets.near)
              : spawnPoint(rand, c.cx, c.cz, range, c.windUnit, 1.4, 6, travel * 0.5);
          const pinch = sea.crestAt(x, z, t);
          if (pinch < profile.dropletThreshold) continue;

          // How far past breaking, in sigmas of pinch. Nought at the threshold,
          // and a hard break is one or two.
          const over = (pinch - profile.dropletThreshold) / profile.crestSigma;

          sea.orbitalVelocityAt(x, z, t, birth);
          const kick = profile.kickRef * (0.22 + 0.26 * over) * (0.6 + rand() * 0.9);

          positions[o] = x;
          positions[o + 1] = sea.roughHeightAt(x, z, t) + (0.3 + rand() * 0.9) * scale;
          positions[o + 2] = z;
          velocities[o] = birth.x + wind.x * 1.15;
          velocities[o + 1] = birth.y + kick;
          velocities[o + 2] = birth.z + wind.z * 1.15;

          maxLife[i] = 0.8 + rand() * 1.7;
          life[i] = maxLife[i];
          sizes[i] = (0.7 + rand() * 1.3) * scale;
          break;
        }
        continue;
      }

      life[i] -= dt;
      alive++;

      // Gravity, and a drag that hauls the droplet toward the speed of the air
      // around it. Small water loses its own velocity in a second or two, which
      // is why spray ends up going wherever the wind is going.
      const drag = Math.min(1, dt * 0.32);
      velocities[o] += (wind.x - velocities[o]) * drag;
      velocities[o + 1] += (0 - velocities[o + 1]) * drag - 9.81 * dt;
      velocities[o + 2] += (wind.z - velocities[o + 2]) * drag;

      positions[o] += velocities[o] * dt;
      positions[o + 1] += velocities[o + 1] * dt;
      positions[o + 2] += velocities[o + 2] * dt;

      // Did it hit him? Measured against the eye position this very update was
      // handed, so the answer is about where the camera *is* and not where it
      // was last frame. The count and the nearest miss both go back to the
      // caller, because one fleck at arm's length and five across the face are
      // not the same event.
      if (hitR2 > 0) {
        const hx = positions[o] - c.cx;
        const hy = positions[o + 1] - c.cy;
        const hz = positions[o + 2] - c.cz;
        const d2 = hx * hx + hy * hy + hz * hz;
        if (d2 < hitR2) {
          c.hits++;
          if (d2 < c.hitNearest) c.hitNearest = d2;
        }
      }

      // Back into the sea. Given a moment first, so a droplet born a hand's
      // breadth above a crest is not killed by the crest it came off.
      const age = maxLife[i] - life[i];
      if (age > 0.15 &&
          positions[o + 1] < sea.roughHeightAt(positions[o], positions[o + 2], t)) {
        life[i] = 0;
        fades[i] = 0;
        alive--;
        continue;
      }

      const lifeT = 1 - life[i] / maxLife[i];
      fades[i] = Math.min(1, lifeT * 10) * Math.min(1, (1 - lifeT) * 2.5);
    }

    cursor = (cursor + maxSearch) % count;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFade.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    return alive;
  }

  return { object3d: points, uniforms, update, geometry };
}

/**
 * Spindrift sheets: veils of lace peeling off the crests in a survival wind.
 *
 * A handful of very large, very faint, very slow quads. They spawn only above
 * Force 9 and only on the hardest-breaking crests, they sail downwind faster
 * than the water under them, and they sink gently as they shred. There are
 * never many alive — two dozen is the whole budget — because each one is tens
 * of metres long and a sky full of them is a sky you cannot see through.
 */
function createSheets(count, seed) {
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  const sizes = new Float32Array(count * 2);
  const fades = new Float32Array(count);
  const seeds = new Float32Array(count);
  const ages = new Float32Array(count);
  const life = new Float32Array(count);
  const maxLife = new Float32Array(count);
  const rand = makeRandom(seed);
  const maxSearch = Math.max(1, Math.ceil(count * SEARCH_SHARE));
  let cursor = 0;

  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      // A unit quad about its own centre; the vertex stage does the rest.
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  geometry.setAttribute('iPos', new THREE.InstancedBufferAttribute(positions, 3));
  geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(sizes, 2));
  geometry.setAttribute('iFade', new THREE.InstancedBufferAttribute(fades, 1));
  geometry.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('iAge', new THREE.InstancedBufferAttribute(ages, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

  const uniforms = {
    uColour: { value: new THREE.Color(0xdfe4e4) },
    uWindDir: { value: new THREE.Vector2(0, 1) },
    // Very low, and it has to be: two dozen veils forty metres long can cover
    // most of the sky between them, and a veil you can read the shape of is a
    // sheet of paper. This is about as faint as it can be and still be seen.
    uOpacity: { value: 0.22 },
  };

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: sheetVert,
      fragmentShader: sheetFrag,
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  mesh.frustumCulled = false;
  // Under the points: a droplet in front of a veil should be a droplet in front
  // of a veil.
  mesh.renderOrder = 24;
  mesh.name = 'spray-sheets';

  function update(c) {
    const { dt, sea, t, wind, profile } = c;
    // Big and slow, so they hold up much further out than the points do.
    const gate = (1 - smoothstep(350, 700, c.altitude)) * profile.sheetChance;
    // A veil sails for five seconds and faster than the wind — two hundred
    // metres of ground in a survival storm — so it is born a long way up it,
    // and the window is centred on the *middle* of that flight. Half of two
    // dozen veils is in front of the eye whichever way the eye is turned, which
    // is the best a budget this small can do; the alternative, biasing them
    // upwind for the helm view, empties the frame for every other camera.
    const travel = c.windSpeed * 1.3 * 5.0;
    const range = c.range * 220;
    const scale = profile.scale;
    let alive = 0;
    let searches = 0;

    for (let n = 0; n < count; n++) {
      const i = (cursor + n) % count;
      const o = i * 3;

      if (life[i] <= 0) {
        fades[i] = 0;
        if (gate <= 0.001 || searches >= maxSearch) continue;
        searches++;

        for (let a = 0; a < c.attempts; a++) {
          if (rand() > gate) continue;
          // An even scatter, and never close: a veil forty metres long that
          // spawns on top of the camera is a grey wash across the whole frame.
          const { x, z } = spawnPoint(rand, c.cx, c.cz, range, c.windUnit, 0.9, 50, travel * 0.5);
          if (sea.crestAt(x, z, t) < profile.sheetThreshold) continue;

          positions[o] = x;
          positions[o + 1] = sea.roughHeightAt(x, z, t) + (1.5 + rand() * 4.5) * scale;
          positions[o + 2] = z;
          // Faster than the wind at birth: the crest flings it away.
          velocities[o] = wind.x * 1.3;
          velocities[o + 1] = 0.4 + rand() * 0.8;
          velocities[o + 2] = wind.z * 1.3;

          sizes[i * 2] = (24 + rand() * 46) * scale;
          sizes[i * 2 + 1] = (7 + rand() * 11) * scale;
          seeds[i] = rand();
          maxLife[i] = 3.0 + rand() * 4.0;
          life[i] = maxLife[i];
          ages[i] = 0;
          break;
        }
        continue;
      }

      life[i] -= dt;
      alive++;

      // Weak gravity: a sheet of lace is mostly air, and it settles rather than
      // falls. The drag is strong for the same reason.
      const drag = Math.min(1, dt * 0.7);
      velocities[o] += (wind.x * 1.3 - velocities[o]) * drag;
      velocities[o + 1] += (0 - velocities[o + 1]) * drag - 0.9 * dt;
      velocities[o + 2] += (wind.z * 1.3 - velocities[o + 2]) * drag;

      positions[o] += velocities[o] * dt;
      positions[o + 1] += velocities[o + 1] * dt;
      positions[o + 2] += velocities[o + 2] * dt;

      const lifeT = 1 - life[i] / maxLife[i];
      ages[i] = lifeT;

      // Into the back of the next sea, which is where a veil ends.
      if (positions[o + 1] < sea.roughHeightAt(positions[o], positions[o + 2], t)) {
        life[i] = 0;
        fades[i] = 0;
        alive--;
        continue;
      }

      // Slow in, slow out. Anything quicker and a veil pops.
      fades[i] = Math.min(1, lifeT * 3.5) * Math.min(1, (1 - lifeT) * 2.2);
    }

    cursor = (cursor + maxSearch) % count;
    geometry.attributes.iPos.needsUpdate = true;
    geometry.attributes.iSize.needsUpdate = true;
    geometry.attributes.iFade.needsUpdate = true;
    geometry.attributes.iSeed.needsUpdate = true;
    geometry.attributes.iAge.needsUpdate = true;
    return alive;
  }

  return { object3d: mesh, uniforms, update, geometry };
}

// --- The system ---------------------------------------------------------------

const DEFAULT_LIGHTING = {
  sunColour: 0xdfe2de,
  skyHaze: 0xa6abab,
  glare: 0.3,
  water: { foam: 0xdfe4e4 },
};

/**
 * Everything the sea throws into the air.
 *
 * @param waveField  a WaveField; its `sea` supplies the spectrum and the
 *                   thresholds, and its `time` the clock — so the spray can
 *                   never drift out of step with the surface it comes off.
 * @param options
 *   `air`        an AirOverSea (or a function returning one, for a demo that
 *                rebuilds it on a weather change). Gives the spray the gusting
 *                wind rather than the sea state's steady one. Optional: without
 *                it the wind comes straight off the sea state.
 *   `budget`     `{ spume, droplets, sheets }` pool sizes. Halved automatically
 *                on a coarse pointer.
 *   `seed`       integer; same seed, same spray. Default 97531, the game's.
 *   `lighting`   the same object `createOcean` takes; only `water.foam`,
 *                `sunColour`, `skyHaze` and `glare` are read.
 *   `pixelRatio` defaults to the device's, capped at two.
 *   `onCameraHit` called with a strength 0..1 when thrown water passes within
 *                arm's length of the eye. At most once a second, and only where
 *                the deck pass is live — from altitude, or in a wind that
 *                carries nothing, no droplet was ever going to arrive. Also
 *                settable afterwards, the way `Hull` takes its events.
 *
 * @returns `{ object3d, update(dt, cameraPos), setSeaState, setLighting,
 *            onCameraHit, dispose, stats }`
 */
export function createSpray(waveField, options = {}) {
  // A coarse pointer is a phone. Guarded, because this module is imported by
  // the tests, which have no window to ask.
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const half = (n) => Math.max(1, Math.round(n / 2));

  const asked = { ...DESKTOP_BUDGET, ...(options.budget ?? {}) };
  const budget = coarse
    ? { spume: half(asked.spume), droplets: half(asked.droplets), sheets: half(asked.sheets) }
    : asked;

  const seed = options.seed ?? 97531;
  const pixelRatio =
    options.pixelRatio ??
    (typeof devicePixelRatio === 'number' ? Math.min(devicePixelRatio, 2) : 1);

  // Three streams, three offsets: the classes never draw from each other's.
  const classes = [
    createSpume(budget.spume, seed),
    createDroplets(budget.droplets, seed + 7717),
    createSheets(budget.sheets, seed + 15443),
  ];
  const [spume, droplets, sheets] = classes;

  const object3d = new THREE.Group();
  object3d.name = 'spray';
  for (const c of classes) {
    if (c.uniforms.uPixelRatio) c.uniforms.uPixelRatio.value = pixelRatio;
    object3d.add(c.object3d);
  }

  let sea = waveField.sea;
  let profile = sprayProfile(sea);

  // The wind the spray actually rides. An AirOverSea gusts; a sea state does
  // not, so without one this is the steady wind and never changes.
  const wind = new THREE.Vector3();
  const steadyWind = new THREE.Vector3();
  const windDir = new THREE.Vector2(0, 1);
  // The same direction in the xz naming the spawn search uses. Kept as a plain
  // object so nothing in the hot loop has to remember that a Vector2's second
  // component is called y and means z.
  const windUnit = { x: 0, z: 1 };
  const airOption = options.air ?? null;

  // One direction object, shared by all three materials: the streaks, the beads
  // and the veils all lie along the same wind, and nothing should be able to
  // update one of them and forget the others.
  for (const c of classes) c.uniforms.uWindDir.value = windDir;

  function readSeaWind() {
    downwind(sea.windFromDeg ?? 285, windDir);
    steadyWind.set(windDir.x, 0, windDir.y).multiplyScalar(sea.windSpeed ?? 0);
  }

  const stats = { spume: 0, droplets: 0, sheets: 0 };

  // The lighting actually in force, so a caller may hand over half an object
  // without the rest of it going black — the same courtesy `createOcean` does.
  let lighting = { ...DEFAULT_LIGHTING, water: { ...DEFAULT_LIGHTING.water } };
  const foamCol = new THREE.Color();
  const sunCol = new THREE.Color();
  const hazeCol = new THREE.Color();

  function applyColour() {
    readColour(foamCol, lighting.water?.foam ?? DEFAULT_LIGHTING.water.foam);
    readColour(sunCol, lighting.sunColour ?? DEFAULT_LIGHTING.sunColour);
    readColour(hazeCol, lighting.skyHaze ?? DEFAULT_LIGHTING.skyHaze);
    const glare = clamp(lighting.glare ?? 0.3, 0, 1);

    // Spray is the sea's own foam, in the air, warmed by whatever sun there is:
    // a droplet is lit from every side at once and takes the light's colour more
    // readily than the surface does.
    spume.uniforms.uColour.value.copy(foamCol).lerp(sunCol, 0.18 * glare);
    droplets.uniforms.uColour.value.copy(spume.uniforms.uColour.value);
    // A veil is thin enough to be mostly the sky behind it.
    sheets.uniforms.uColour.value.copy(spume.uniforms.uColour.value).lerp(hazeCol, 0.28);
  }

  function setLighting(next = {}) {
    lighting = {
      ...lighting,
      ...next,
      water: { ...lighting.water, ...(next.water ?? {}) },
    };
    applyColour();
  }

  function setSeaState(nextSea) {
    sea = nextSea ?? waveField.sea;
    profile = sprayProfile(sea);
    readSeaWind();
  }

  readSeaWind();
  setLighting(options.lighting ?? {});

  // Fractional spawn attempts, carried between frames so nothing is lost to
  // rounding: the population must not depend on how fast the machine is.
  let attemptCarry = 0;

  // Who to tell when the sea comes aboard, and how long until it may be said
  // again. A gale throws water past the eye continuously; an event reported
  // continuously is not an event, so it is reported at most once a second.
  let onCameraHit = typeof options.onCameraHit === 'function' ? options.onCameraHit : null;
  let hitCooldown = 0;

  return {
    object3d,
    stats,

    get onCameraHit() {
      return onCameraHit;
    },
    set onCameraHit(fn) {
      onCameraHit = typeof fn === 'function' ? fn : null;
    },
    uniforms: {
      spume: spume.uniforms,
      droplets: droplets.uniforms,
      sheets: sheets.uniforms,
    },

    /**
     * One frame. Call it inside the same step the wave field is advanced in —
     * the clock read here is the field's, so a frame the field has not been
     * advanced for simply draws the same instant again.
     */
    update(dt, cameraPos) {
      if (!(dt > 0)) return stats;

      const t = waveField.time;
      const air = typeof airOption === 'function' ? airOption() : airOption;
      if (air?.wind) wind.copy(air.wind);
      else wind.copy(steadyWind);

      // A gusting wind swings; the sheets are oriented by it, so follow it.
      const windSpeed = Math.hypot(wind.x, wind.z);
      if (windSpeed > 1e-3) windDir.set(wind.x / windSpeed, wind.z / windSpeed);
      windUnit.x = windDir.x;
      windUnit.z = windDir.y;

      const cx = cameraPos?.x ?? 0;
      const cz = cameraPos?.z ?? 0;
      const cy = cameraPos?.y ?? 0;
      const altitude = cy - sea.roughHeightAt(cx, cz, t);

      // From high up the spawn window has to open, or the whole cloud sits in
      // a patch under the camera and travels with it like a swarm.
      const range = clamp(1 + altitude / 90, 1, 2.4);

      // Attempts per dead particle this frame: exactly one at sixty hertz, two
      // at thirty, every other frame at a hundred and twenty. The fraction is
      // carried rather than rounded, so the population a sea supports is the
      // same on every machine — the game's version quietly halved its spray on
      // a slow one. A single very long frame is capped rather than paid back.
      attemptCarry = Math.min(attemptCarry + dt * ATTEMPT_HZ, MAX_ATTEMPTS);
      const attempts = Math.floor(attemptCarry);
      attemptCarry -= attempts;

      // The deck pass. Full at the height of a man on a quarterdeck, gone by
      // the time a bird has climbed clear of the troughs, and shut outright on
      // any sea without the wind to carry water. The two gates multiply, so it
      // opens and closes smoothly on both.
      const deck =
        profile.deckWind > 0
          ? (1 - smoothstep(DECK_EYE.low, DECK_EYE.high, altitude)) * profile.deckWind
          : 0;

      // Nobody listening, or the last face-full is less than a second behind
      // us, or there is no pass to be hit by: the distance test is not worth
      // the cycles.
      hitCooldown = Math.max(0, hitCooldown - dt);
      const wantHits = !!onCameraHit && hitCooldown <= 0 && deck > 0;

      const ctx = {
        dt, sea, t, wind, profile, cx, cy, cz, altitude, range, attempts,
        windSpeed, windUnit, deck,
        wantHits, hits: 0, hitNearest: Infinity,
      };

      stats.spume = spume.update(ctx);
      stats.droplets = droplets.update(ctx);
      stats.sheets = sheets.update(ctx);

      if (wantHits && ctx.hits > 0) {
        // How wet, in one number: how close the nearest of them came, and how
        // many came with it. A single fleck out at arm's length is a quarter of
        // what a crest breaking over the taffrail throws at a man.
        const closeness = 1 - Math.sqrt(ctx.hitNearest) / HIT_RADIUS;
        const weight = clamp(ctx.hits / HIT_FULL, 0, 1);
        hitCooldown = HIT_COOLDOWN;
        onCameraHit(clamp(0.25 + 0.45 * closeness + 0.5 * weight, 0, 1));
      }

      return stats;
    },

    setLighting,

    /**
     * Swap the spectrum under a running sky. Nothing already in the air is
     * killed — a change of weather does not un-throw the water that is already
     * up — but every threshold from here on is the new sea's.
     */
    setSeaState,

    dispose() {
      for (const c of classes) {
        c.geometry.dispose();
        c.object3d.material.dispose();
      }
      object3d.clear();
    },
  };
}
