// A sea state, and the two ways of asking it questions.
//
// The whole library turns on one promise: the CPU and the GPU describe the
// same water. So the wave table is defined once, as data, and both consumers
// walk it. `SeaState` is the CPU side — every analytic query a game can make
// of the surface. `waveUniforms` and `oceanVertexChunk` are the GPU twin,
// generated from the very same table, so a mesh vertex and a hull sample can
// never end up on different water.
//
// Gerstner waves, not plain sines. A storm sea is not sinusoidal: crests pinch
// sharp and troughs run long and flat, and that asymmetry is most of what
// makes water look heavy. The price is that a Gerstner surface moves material
// points sideways as well as up, so finding the surface in the column above a
// fixed (x, z) means inverting that horizontal displacement. That inversion is
// the only fiddly thing in this file, and it is why `heightAt` costs four
// passes over the table instead of one.

import { Vector3 } from 'three';

const GRAVITY = 9.81;

/**
 * Steps used to invert the Gerstner horizontal displacement.
 *
 * Three, and they have to be good ones. The obvious iteration — u ← x − D(u),
 * which is what the game shipped with — is a contraction whose modulus is
 * about the total pinch, so at storm steepness each pass only removes about a
 * quarter of the error and three of them leave half a metre. Half a metre is
 * the difference between a hull floating on the water and floating in it.
 *
 * So each pass here is a Newton step on u + D(u) − x instead. The Jacobian is
 * two-by-two and comes free from sines we are computing anyway, convergence is
 * quadratic, and three passes land the residual around a micron. The GLSL twin
 * never inverts at all — it displaces forward from the datum grid — so this is
 * the one place the two halves of the library can drift apart. Do not lower it.
 */
const INVERSION_STEPS = 3;

/** Below this the Jacobian is not worth trusting; fall back to a plain step. */
const MIN_JACOBIAN_DET = 1e-6;

// Scratch, so the hot queries allocate nothing. Each method owns its own, and
// none of them nest, which is the only rule that keeps this safe.
const _heightU = { x: 0, z: 0 };
const _orbitU = { x: 0, z: 0 };
const _pointU = { x: 0, z: 0 };

export class SeaState {
  /**
   * @param components  the spectrum, as plain description: each
   *                    { length, amp, off, pinch, phase } — wavelength in
   *                    metres, amplitude in metres, heading offset in degrees
   *                    from downwind, the fraction of full Gerstner sharpening
   *                    this component contributes, and its fixed phase.
   * @param meta        { preset, windFromDeg, windSpeed } — provenance the
   *                    consumers (air, renderer, HUD) want to read back.
   */
  constructor(components, meta = {}) {
    this.preset = meta.preset ?? null;
    this.windFromDeg = meta.windFromDeg ?? 285;

    // Not strictly part of the surface, but everything that flies over it
    // needs a wind, and the sea state is the only honest place to keep it.
    this.windSpeed = meta.windSpeed ?? 0;

    // Meteorological wind is where it comes *from*; the swell runs the other
    // way, downwind, as a wind sea does.
    const travelDeg = this.windFromDeg + 180;

    this.waves = components.map((c) => {
      const bearing = ((travelDeg + c.off) * Math.PI) / 180;
      const k = (2 * Math.PI) / c.length;
      return {
        // Unit vector of travel. Compass bearings: x = east, z = south.
        dx: Math.sin(bearing),
        dz: -Math.cos(bearing),
        k,
        // Deep water: nothing in these games happens over a bottom.
        omega: Math.sqrt(GRAVITY * k),
        amp: c.amp,
        // Gerstner steepness Q, read off the pinch budget. Q·k·A is the
        // fraction of horizontal sharpening this wave applies at its crest,
        // and it is the pinch that the spectrum was allowed to spend.
        q: c.amp > 0 ? c.pinch / (k * c.amp) : 0,
        length: c.length,
        phase: c.phase,
      };
    });

    // The furthest the surface can possibly reach, for anything that needs
    // bounds — camera clipping, spawn volumes, broad-phase culling.
    const sum = this.waves.reduce((a, w) => a + w.amp, 0);
    this.hMin = -sum;
    this.hMax = sum;

    // The train everything else rides on. Its phase speed sets the tempo of
    // the whole sea: a hull surfs at some fraction of it, and a rudder is
    // useless once the two are close.
    this.dominant = this.waves[0];
    this.dominantLength = this.dominant.length;
    this.dominantSpeed = this.dominant.omega / this.dominant.k;
  }

  /**
   * The datum point whose Gerstner displacement lands in the column above
   * (x, z) at time t. The renderer works forward from the datum grid; the
   * physics has to work backward, and this is that step, exposed because
   * anything wanting to place a mesh *on* the surface needs it too.
   */
  undisplacedAt(x, z, t, out = { x: 0, z: 0 }) {
    let ux = x;
    let uz = z;

    for (let iter = 0; iter < INVERSION_STEPS; iter++) {
      // Residual, and the Jacobian of the forward map, in one sweep.
      let dx = 0;
      let dz = 0;
      let jxx = 1;
      let jxz = 0;
      let jzz = 1;
      for (const w of this.waves) {
        const theta = w.k * (w.dx * ux + w.dz * uz) - w.omega * t + w.phase;
        const qa = w.q * w.amp;
        const c = Math.cos(theta) * qa;
        dx += w.dx * c;
        dz += w.dz * c;

        // ∂(d·q·A·cosθ)/∂u = −q·A·k·sinθ · (d ⊗ d): symmetric, so three terms.
        const s = qa * w.k * Math.sin(theta);
        jxx -= s * w.dx * w.dx;
        jxz -= s * w.dx * w.dz;
        jzz -= s * w.dz * w.dz;
      }

      const rx = ux + dx - x;
      const rz = uz + dz - z;
      const det = jxx * jzz - jxz * jxz;
      if (Math.abs(det) > MIN_JACOBIAN_DET) {
        ux -= (jzz * rx - jxz * rz) / det;
        uz -= (jxx * rz - jxz * rx) / det;
      } else {
        // Degenerate only if the pinch budget has been overspent, which the
        // spectrum will not do. Take the plain step and keep going.
        ux = x - dx;
        uz = z - dz;
      }
    }

    out.x = ux;
    out.z = uz;
    return out;
  }

  /**
   * Forward Gerstner displacement of a datum point — the exact CPU twin of the
   * GLSL `gerstner()` with no distance attenuation. `undisplacedAt` is its
   * inverse, and the pair of them is what the identity test checks.
   */
  displacedPointAt(ux, uz, t, out = new Vector3()) {
    let px = ux;
    let py = 0;
    let pz = uz;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * ux + w.dz * uz) - w.omega * t + w.phase;
      const qa = w.q * w.amp;
      px += w.dx * qa * Math.cos(theta);
      pz += w.dz * qa * Math.cos(theta);
      py += w.amp * Math.sin(theta);
    }
    return out.set(px, py, pz);
  }

  /**
   * Height of the water surface in the column above (x, z) at time t. This is
   * the authoritative surface: what a hull floats on, what a wingtip touches,
   * and what the eye is looking at.
   */
  heightAt(x, z, t) {
    const u = this.undisplacedAt(x, z, t, _heightU);
    return this.roughHeightAt(u.x, u.z, t);
  }

  /**
   * Cheap height: the vertical sum only, no inversion. Wrong by up to the
   * pinch near a sharp crest, which is fine for spray, birds and anything else
   * decorative that is never asked to touch the water exactly.
   */
  roughHeightAt(x, z, t) {
    let h = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
      h += w.amp * Math.sin(theta);
    }
    return h;
  }

  /**
   * Surface gradient by central difference. The default stencil is wide on
   * purpose: the shapes that steer a ship are wave faces a hundred metres
   * long, and a narrower stencil just feeds her the chop.
   */
  gradientAt(x, z, t, spread = 22) {
    const hL = this.heightAt(x - spread, z, t);
    const hR = this.heightAt(x + spread, z, t);
    const hU = this.heightAt(x, z - spread, t);
    const hD = this.heightAt(x, z + spread, t);
    return {
      dx: (hR - hL) / (2 * spread),
      dz: (hD - hU) / (2 * spread),
    };
  }

  normalAt(x, z, t, spread = 22, out = new Vector3()) {
    const g = this.gradientAt(x, z, t, spread);
    return out.set(-g.dx, 1, -g.dz).normalize();
  }

  /**
   * How pinched the surface is at a point, 0..~0.8 at the budget ceiling. High
   * values are breaking crests — where the foam is and where spume gets torn
   * off. Deliberately un-inverted: foam wants the cheap answer, and the
   * shader computes exactly this same sum from the datum grid.
   */
  crestAt(x, z, t) {
    let c = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * x + w.dz * z) - w.omega * t + w.phase;
      c += w.q * w.k * w.amp * Math.sin(theta);
    }
    return c;
  }

  /**
   * Velocity of the water particle at the surface above (x, z): the deep-water
   * orbit, horizontal u = Σ ω·A·cosθ along each wave's heading, vertical
   * w = Σ ω·A·sinθ. Hulls make leeway with it and wakes are laid down in it.
   *
   * Sampled at the inverted coordinates rather than the raw ones, so it is the
   * velocity of the particle `heightAt` just reported the height of.
   */
  orbitalVelocityAt(x, z, t, out = new Vector3()) {
    const u = this.undisplacedAt(x, z, t, _orbitU);
    let vx = 0;
    let vy = 0;
    let vz = 0;
    for (const w of this.waves) {
      const theta = w.k * (w.dx * u.x + w.dz * u.z) - w.omega * t + w.phase;
      const oa = w.omega * w.amp;
      const c = Math.cos(theta) * oa;
      vx += w.dx * c;
      vz += w.dz * c;
      vy += Math.sin(theta) * oa;
    }
    return out.set(vx, vy, vz);
  }

  /** The point on the surface above (x, z) — inverted, then displaced back. */
  surfacePointAt(x, z, t, out = new Vector3()) {
    const u = this.undisplacedAt(x, z, t, _pointU);
    return this.displacedPointAt(u.x, u.z, t, out);
  }

  /** Compass bearing the dominant train is travelling towards, in radians. */
  get dominantTravelRad() {
    return Math.atan2(this.dominant.dx, -this.dominant.dz);
  }
}

/** Uniform values for the shaders, in the layout `oceanVertexChunk` expects. */
export function waveUniforms(seaState) {
  return {
    uWaveDir: { value: seaState.waves.flatMap((w) => [w.dx, w.dz]) },
    uWaveK: { value: seaState.waves.map((w) => w.k) },
    uWaveOmega: { value: seaState.waves.map((w) => w.omega) },
    uWaveAmp: { value: seaState.waves.map((w) => w.amp) },
    uWaveQ: { value: seaState.waves.map((w) => w.q) },
    uWaveLen: { value: seaState.waves.map((w) => w.length) },
    uWavePhase: { value: seaState.waves.map((w) => w.phase) },
  };
}

/**
 * How long foam outlives the crest that made it.
 *
 * A Gerstner pinch heals the instant the wave moves on, so foam keyed straight
 * off `crestAt` appears and vanishes with the crest — which is why the sea has
 * always looked freshly laundered between sets. Real broken water stays white
 * for half a minute and streams away downwind. Short of a feedback texture,
 * the cheapest honest memory is to ask the *same* crest sum what it was doing a
 * few seconds ago and keep whichever answer is whitest: foam is then left
 * behind along the track the crest came down, and fades as the weights decay.
 *
 * Two lags is enough to read as a trail rather than as two ghosts. The table
 * is exported because it is the rule, not a shader detail: a game wanting to
 * ask "is this water broken?" on the CPU should take the same decayed max of
 * `crestAt` over the same lags and get the same answer the eye is being given.
 */
export const FOAM_LAGS = [
  { lag: 2.5, weight: 0.55 },
  { lag: 5.0, weight: 0.3 },
];

/** GLSL has no integer/float coercion: 5 must be written 5.0 or it will not compile. */
const glslFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/**
 * The wave table as it appears to a shader stage. Both chunks below open with
 * this; they are meant for *different* stages, so the repeated declarations
 * never collide, and the uniforms are shared across the linked program.
 */
function waveArrayDeclarations(waveCount) {
  return /* glsl */ `
  #define NW ${waveCount}

  uniform vec2 uWaveDir[NW];
  uniform float uWaveK[NW];
  uniform float uWaveOmega[NW];
  uniform float uWaveAmp[NW];
  uniform float uWaveQ[NW];
  uniform float uWaveLen[NW];
  uniform float uWavePhase[NW];
`;
}

/**
 * The GLSL twin of `displacedPointAt` — forward Gerstner displacement of a
 * grid vertex, with the analytic normal and the crest pinch the foam keys off.
 *
 * The one thing it does that the CPU does not is attenuate. A vertex two
 * kilometres out sits in a cell tens of metres wide and physically cannot
 * carry a seventeen-metre wave; left in, that wave becomes horizon shimmer.
 * `exp(-camDist / (L·45 + 600))` fades each component out at a range
 * proportional to its own wavelength, so the mesh only ever carries the waves
 * it can resolve. Near the camera — where a hull actually is — the attenuation
 * is one and the two halves agree exactly.
 *
 * The crest it reports carries `FOAM_LAGS` worth of memory. Geometry does not:
 * position and normal are the instantaneous surface, exactly as before, so the
 * water a hull floats on is untouched by any of this.
 *
 * @param waveCount  must match `seaState.waves.length`.
 */
export function oceanVertexChunk(waveCount = 12) {
  const lagDecl = FOAM_LAGS.map((_, i) => `    float crestLag${i} = 0.0;`).join('\n');

  // θ(t − τ) = k·d·p − ω(t − τ) + φ = θ(t) + ω·τ. So a lagged crest sum costs
  // one extra sine per wave, not another pass over the table.
  const lagSums = FOAM_LAGS.map(
    ({ lag }, i) =>
      `      crestLag${i} += qka * sin(theta + uWaveOmega[i] * ${glslFloat(lag)});  // uTime - ${glslFloat(lag)}`
  ).join('\n');

  // Nested, because GLSL's max takes two arguments however many lags there are.
  const lagFold = FOAM_LAGS.reduce(
    (acc, { weight }, i) => `max(${acc}, crestLag${i} * ${glslFloat(weight)})`,
    'crest'
  );

  return /* glsl */ `
  ${waveArrayDeclarations(waveCount)}
  uniform float uTime;

  // Displace a point on the datum plane; returns position, writes normal and
  // crest pinch. camDist is used to attenuate what this vertex cannot resolve.
  vec3 gerstner(vec2 p, float camDist, out vec3 normal, out float crest) {
    vec3 pos = vec3(p.x, 0.0, p.y);
    normal = vec3(0.0, 1.0, 0.0);
    crest = 0.0;

    // Where the crest was, a few seconds back. See FOAM_LAGS.
${lagDecl}

    for (int i = 0; i < NW; i++) {
      float att = exp(-camDist / (uWaveLen[i] * 45.0 + 600.0));
      float amp = uWaveAmp[i] * att;
      if (amp < 0.001) continue;

      vec2 d = uWaveDir[i];
      float theta = uWaveK[i] * dot(d, p) - uWaveOmega[i] * uTime + uWavePhase[i];
      float s = sin(theta);
      float c = cos(theta);
      float qa = uWaveQ[i] * amp;
      float ka = uWaveK[i] * amp;
      float qka = uWaveQ[i] * ka;

      pos.x += d.x * qa * c;
      pos.z += d.y * qa * c;
      pos.y += amp * s;

      normal.x -= d.x * ka * c;
      normal.z -= d.y * ka * c;
      normal.y -= qka * s;

      crest += qka * s;
${lagSums}
    }

    normal = normalize(normal);

    // Whitest wins. The weights are below one, so a crest always outshines its
    // own wake and the trail decays behind it instead of smearing everything.
    crest = ${lagFold};

    return pos;
  }
`;
}

/**
 * The fragment-stage twin of the normal half of `gerstner`.
 *
 * The vertex normal is exact where it is computed and mush in between: on the
 * warped grid a cell is metres across by fifty metres out, and interpolating a
 * normal over one loses every crest edge inside it. That is the hole the fbm
 * ripple has been papering over. Evaluating this per pixel over the near field
 * does not invent a surface — it is the same analytic sum, sampled where the
 * eye can actually resolve it, so the visible water moves *closer* to what the
 * CPU believes rather than further away.
 *
 * Time is a parameter rather than a uniform read so this can drop into a stage
 * that already declares its own clock. Waves whose attenuated amplitude has
 * fallen below a millimetre are skipped, which is most of the table by the far
 * edge of the near field.
 *
 * @param waveCount  must match `seaState.waves.length`.
 */
export function oceanNormalChunk(waveCount = 12) {
  return /* glsl */ `
  ${waveArrayDeclarations(waveCount)}

  vec3 gerstnerNormal(vec2 p, float camDist, float t) {
    vec3 normal = vec3(0.0, 1.0, 0.0);

    for (int i = 0; i < NW; i++) {
      float att = exp(-camDist / (uWaveLen[i] * 45.0 + 600.0));
      float amp = uWaveAmp[i] * att;
      if (amp < 0.001) continue;

      vec2 d = uWaveDir[i];
      float theta = uWaveK[i] * dot(d, p) - uWaveOmega[i] * t + uWavePhase[i];
      float ka = uWaveK[i] * amp;

      normal.x -= d.x * ka * cos(theta);
      normal.z -= d.y * ka * cos(theta);
      normal.y -= uWaveQ[i] * ka * sin(theta);
    }

    return normalize(normal);
  }
`;
}
