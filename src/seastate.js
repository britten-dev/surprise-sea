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
//
// On top of the table a sea can carry up to MAX_PACKETS wave packets: a group
// of two or three very large seas under one travelling envelope, which grows,
// comes on at the group speed and dies away. A rogue sea, in short. Packets are
// added to every sum below, CPU and GPU alike, so a hull rides the rogue the
// eye is watching.

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

/** How many packets a sea can carry at once. Compiled into the shaders as NP. */
export const MAX_PACKETS = 2;

/**
 * The summed pinch, sea and packet together, that a packet may take a crest
 * up to. The surface folds over at one; the spectrum stops at 0.8. A packet is
 * allowed what is left under this, and no more, so a rogue sea sharpens the
 * crest it rides on without ever turning it inside out.
 */
const PACKET_PINCH_CEILING = 0.95;

const GRAVITY_PACKET = 9.81;

/**
 * A packet, described: where its envelope is centred when it is born, which
 * way it runs, its carrier wavelength, its height at its peak, and its life.
 *
 *   x, z        metres: the centre of the envelope at `born`
 *   bearingDeg  compass bearing it travels toward; default the dominant train's
 *   length      carrier wavelength, metres; default 1.15 × the dominant
 *   height      amplitude at the peak of its life and the centre of its envelope
 *   pinch       Q·k·A at that peak; default, and at most, what the ceiling leaves
 *   born, life  seconds on the sea's clock; it is nothing outside [born, born+life]
 *   along       envelope standard deviation along its track, metres; default one
 *               wavelength, which is two or three big crests
 *   across      the same across its track; default two and a half wavelengths
 *   phase       radians
 *
 * The envelope is centred at (x, z) + d·cg·(t − born), where cg = ω / 2k is the
 * deep-water group speed: half the speed of its own crests, so each crest
 * rises through the back of the group, peaks in the middle and fades out of its
 * front, as a real group's do. Its height over its life is sin²(π·τ), τ the
 * fraction of its life gone: nothing, a peak half way, nothing again.
 */
function describePacket(p, sea) {
  const bearingDeg = p.bearingDeg ?? (Math.atan2(sea.dominant?.dx ?? 0, -(sea.dominant?.dz ?? -1)) * 180) / Math.PI;
  const bearing = (bearingDeg * Math.PI) / 180;
  const length = Math.max(1, p.length ?? (sea.dominantLength || 200) * 1.15);
  const k = (2 * Math.PI) / length;
  const omega = Math.sqrt(GRAVITY_PACKET * k);
  const height = Math.max(0, p.height ?? 0);
  const room = Math.max(0, PACKET_PINCH_CEILING - sea.pinch);
  const pinch = Math.max(0, Math.min(room, p.pinch ?? room));
  return {
    x: p.x ?? 0,
    z: p.z ?? 0,
    bearingDeg,
    dx: Math.sin(bearing),
    dz: -Math.cos(bearing),
    length,
    k,
    omega,
    groupSpeed: omega / (2 * k),
    phaseSpeed: omega / k,
    height,
    pinch,
    q: height > 0 ? pinch / (k * height) : 0,
    born: p.born ?? 0,
    life: Math.max(0, p.life ?? 0),
    along: Math.max(1, p.along ?? length),
    across: Math.max(1, p.across ?? length * 2.5),
    phase: p.phase ?? 0,
  };
}

/**
 * How big packet `p` is at (x, z) and t — its height under the envelope, or
 * nought outside its life — with the envelope's gradient in `grad` when asked.
 * The GLSL `packetEnvelope` is this, term for term.
 */
function packetEnvelope(p, x, z, t, grad = null) {
  if (p.life <= 0 || p.height <= 0) return 0;
  const tau = (t - p.born) / p.life;
  if (tau <= 0 || tau >= 1) return 0;
  const g = Math.sin(Math.PI * tau);
  const run = p.groupSpeed * (t - p.born);
  const rx = x - (p.x + p.dx * run);
  const rz = z - (p.z + p.dz * run);
  const s = p.dx * rx + p.dz * rz;
  const n = -p.dz * rx + p.dx * rz;
  const sa = s / p.along;
  const nc = n / p.across;
  const e = p.height * g * g * Math.exp(-0.5 * (sa * sa + nc * nc));
  if (grad) {
    // ∇E = E·(−s/σa²·d − n/σc²·d⊥), with d⊥ = (−dz, dx).
    const a = -s / (p.along * p.along);
    const c = -n / (p.across * p.across);
    grad.x = e * (a * p.dx - c * p.dz);
    grad.z = e * (a * p.dz + c * p.dx);
  }
  return e;
}

const _packetGrad = { x: 0, z: 0 };

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
    this.dominantLength = this.dominant?.length ?? 0;
    this.dominantSpeed = this.dominant ? this.dominant.omega / this.dominant.k : 0;

    // The pinch the spectrum has already spent, which is what a packet's own
    // is measured against (PACKET_PINCH_CEILING).
    this.pinch = this.waves.reduce((a, w) => a + w.q * w.k * w.amp, 0);
    this._hMin = this.hMin;
    this._hMax = this.hMax;

    // The packets, and their table in the shader layout. The arrays are the
    // uniforms' own values (see waveUniforms), filled in place, so a packet
    // added to a running sea reaches the shader without anything re-uploaded.
    this.packets = [];
    this.packetTable = {
      a: new Array(MAX_PACKETS * 4).fill(0),
      b: new Array(MAX_PACKETS * 4).fill(0),
      c: new Array(MAX_PACKETS * 4).fill(0),
      phase: new Array(MAX_PACKETS).fill(0),
    };
    if (meta.packets) this.setPackets(meta.packets);
  }

  /**
   * Put packets on this sea, replacing any it had: at most MAX_PACKETS, each
   * described as `describePacket` says. An empty list clears them. The bounds
   * grow to take their peaks. Returns the packets as described.
   */
  setPackets(list = []) {
    if (list.length > MAX_PACKETS) throw new RangeError(`A sea carries at most ${MAX_PACKETS} packets`);
    this.packets = list.map((p) => describePacket(p, this));
    const { a, b, c, phase } = this.packetTable;
    a.fill(0); b.fill(0); c.fill(0); phase.fill(0);
    this.packets.forEach((p, i) => {
      a.splice(i * 4, 4, p.dx, p.dz, p.k, p.omega);
      b.splice(i * 4, 4, p.height, p.q, p.along, p.across);
      c.splice(i * 4, 4, p.x, p.z, p.born, p.life);
      phase[i] = p.phase;
    });
    const reach = this.packets.reduce((sum, p) => sum + p.height, 0);
    this.hMin = this._hMin - reach;
    this.hMax = this._hMax + reach;
    return this.packets;
  }

  /**
   * Where packet `i` is at time t: the centre of its envelope, its height
   * there now, and whether it is alive. For a game that wants to know how far
   * off a rogue sea is and when it will arrive.
   */
  packetAt(i, t) {
    const p = this.packets[i];
    if (!p) return null;
    const run = p.groupSpeed * (t - p.born);
    const x = p.x + p.dx * run;
    const z = p.z + p.dz * run;
    return { x, z, height: packetEnvelope(p, x, z, t), alive: t > p.born && t < p.born + p.life,
      groupSpeed: p.groupSpeed, phaseSpeed: p.phaseSpeed, bearingDeg: p.bearingDeg, length: p.length };
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

    // A packet alive at t pinches the crests it rides on harder still, and its
    // envelope moves with the point; one more step lands it as well as the
    // plain sea lands.
    let steps = INVERSION_STEPS;
    for (const p of this.packets) if (t > p.born && t < p.born + p.life) { steps++; break; }

    for (let iter = 0; iter < steps; iter++) {
      // Residual, and the Jacobian of the forward map, in one sweep.
      let dx = 0;
      let dz = 0;
      let jxx = 1;
      let jxz = 0;
      let jzx = 0;
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
        jzx -= s * w.dx * w.dz;
        jzz -= s * w.dz * w.dz;
      }
      // A packet's displacement is d·q·E(u)·cosθ, and E moves with u, so its
      // share of the Jacobian is not symmetric: d ⊗ q·(∇E·cosθ − E·k·sinθ·d).
      for (const p of this.packets) {
        const e = packetEnvelope(p, ux, uz, t, _packetGrad);
        if (e === 0) continue;
        const theta = p.k * (p.dx * ux + p.dz * uz) - p.omega * t + p.phase;
        const c = Math.cos(theta);
        const s = Math.sin(theta);
        dx += p.dx * p.q * e * c;
        dz += p.dz * p.q * e * c;
        const gx = p.q * (_packetGrad.x * c - e * p.k * s * p.dx);
        const gz = p.q * (_packetGrad.z * c - e * p.k * s * p.dz);
        jxx += p.dx * gx;
        jxz += p.dx * gz;
        jzx += p.dz * gx;
        jzz += p.dz * gz;
      }

      const rx = ux + dx - x;
      const rz = uz + dz - z;
      const det = jxx * jzz - jxz * jzx;
      if (Math.abs(det) > MIN_JACOBIAN_DET) {
        ux -= (jzz * rx - jxz * rz) / det;
        uz -= (jxx * rz - jzx * rx) / det;
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
    for (const p of this.packets) {
      const e = packetEnvelope(p, ux, uz, t);
      if (e === 0) continue;
      const theta = p.k * (p.dx * ux + p.dz * uz) - p.omega * t + p.phase;
      const qa = p.q * e;
      px += p.dx * qa * Math.cos(theta);
      pz += p.dz * qa * Math.cos(theta);
      py += e * Math.sin(theta);
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
    for (const p of this.packets) {
      const e = packetEnvelope(p, x, z, t);
      if (e !== 0) h += e * Math.sin(p.k * (p.dx * x + p.dz * z) - p.omega * t + p.phase);
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
    for (const p of this.packets) {
      const e = packetEnvelope(p, x, z, t);
      if (e !== 0) c += p.q * p.k * e * Math.sin(p.k * (p.dx * x + p.dz * z) - p.omega * t + p.phase);
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
    for (const p of this.packets) {
      const e = packetEnvelope(p, u.x, u.z, t);
      if (e === 0) continue;
      const theta = p.k * (p.dx * u.x + p.dz * u.z) - p.omega * t + p.phase;
      const oa = p.omega * e;
      const c = Math.cos(theta) * oa;
      vx += p.dx * c;
      vz += p.dz * c;
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

/**
 * Uniform values for the shaders, in the layout `oceanVertexChunk` expects:
 * two vec4s a wave, as flat arrays.
 *
 *   uWaveA[i] = (dx, dz, k, omega)
 *   uWaveB[i] = (amp, q, length, phase)
 *
 * Every term of a wave is read together, so packed it is two uniform loads a
 * wave rather than seven, and the sea draws a few per cent cheaper for it. The
 * numbers are the table's, untouched; only where they sit has moved.
 */
export function waveUniforms(seaState) {
  return {
    uWaveA: { value: seaState.waves.flatMap((w) => [w.dx, w.dz, w.k, w.omega]) },
    uWaveB: { value: seaState.waves.flatMap((w) => [w.amp, w.q, w.length, w.phase]) },
    // The packets, three vec4s and a phase each (see SeaState.setPackets). These
    // are the sea state's own arrays, not copies, so setPackets reaches them.
    //   uPacketA[i] = (dx, dz, k, omega)
    //   uPacketB[i] = (height, q, along, across)
    //   uPacketC[i] = (x, z, born, life)
    uPacketA: { value: seaState.packetTable.a },
    uPacketB: { value: seaState.packetTable.b },
    uPacketC: { value: seaState.packetTable.c },
    uPacketPhase: { value: seaState.packetTable.phase },
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

/**
 * How far ahead the spill looks, in seconds. A crest that is breaking throws
 * its white water down the face in front of it, and the water it will reach in
 * the next moment is the water it is tumbling onto. Two looks, near and far,
 * so the white runs on from the crest down the face rather than landing as a
 * separate band: on the dominant swell of a storm, about twenty metres of
 * face. The far look counts for a little less, so the white thins as it runs
 * down. Shading only — nothing moves for it.
 */
export const SPILL_LEAD = [
  { lead: 0.4, weight: 1.0 },
  { lead: 0.9, weight: 0.85 },
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

  // Two vec4s a wave. See waveUniforms.
  uniform vec4 uWaveA[NW];  // dx, dz, k, omega
  uniform vec4 uWaveB[NW];  // amp, q, length, phase

  // The wave packets: rogue seas. See SeaState.setPackets.
  #define NP ${MAX_PACKETS}
  uniform vec4 uPacketA[NP];  // dx, dz, k, omega
  uniform vec4 uPacketB[NP];  // height, q, along, across
  uniform vec4 uPacketC[NP];  // x, z when born, born, life
  uniform float uPacketPhase[NP];

  // Packet i's height under its envelope at p and t, nought outside its life.
  // The CPU packetEnvelope, term for term.
  float packetEnvelope(int i, vec2 p, float t) {
    vec4 a = uPacketA[i];
    vec4 b = uPacketB[i];
    vec4 c = uPacketC[i];
    if (c.w <= 0.0 || b.x <= 0.0) return 0.0;
    float tau = (t - c.z) / c.w;
    if (tau <= 0.0 || tau >= 1.0) return 0.0;
    float g = sin(3.14159265358979 * tau);
    float run = a.w / (2.0 * a.z) * (t - c.z);
    vec2 r = p - (c.xy + a.xy * run);
    float sa = dot(r, a.xy) / b.z;
    float nc = dot(r, vec2(-a.y, a.x)) / b.w;
    return b.x * g * g * exp(-0.5 * (sa * sa + nc * nc));
  }
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
function crestLagChunks(omega = 'uWaveA[i].w') {
  const lagDecl = FOAM_LAGS.map((_, i) => `    float crestLag${i} = 0.0;`).join('\n');

  // θ(t − τ) = k·d·p − ω(t − τ) + φ = θ(t) + ω·τ. So a lagged crest sum costs
  // one extra sine per wave, not another pass over the table.
  const lagSums = FOAM_LAGS.map(
    ({ lag }, i) =>
      `      crestLag${i} += qka * sin(theta + ${omega} * ${glslFloat(lag)});  // ${glslFloat(lag)} s ago`
  ).join('\n');

  // Nested, because GLSL's max takes two arguments however many lags there are.
  const lagFold = FOAM_LAGS.reduce(
    (acc, { weight }, i) => `max(${acc}, crestLag${i} * ${glslFloat(weight)})`,
    'crest'
  );
  return { lagDecl, lagSums, lagFold };
}

/**
 * The opening of a packet's term inside a shader loop over NP: the same locals
 * the wave loop has to hand (d, theta, amp, ka, qka) for packet i at time t.
 * Its height is the envelope's, attenuated with distance as a wave of its
 * length would be; a packet that is not alive at this point is skipped.
 *
 * Its crest memory and its spill (FOAM_LAGS, SPILL_LEAD) move the phase but
 * keep the envelope it has now: in five seconds the envelope runs a few tens of
 * metres of a group several hundred long, and the foam cannot tell.
 */
function packetTermOpening(t) {
  return `
      float amp = packetEnvelope(i, p, ${t});
      if (amp <= 0.0) continue;
      amp *= exp(-camDist / ((6.28318530718 / uPacketA[i].z) * 45.0 + 600.0));
      if (amp < 0.001) continue;

      vec2 d = uPacketA[i].xy;
      float theta = uPacketA[i].z * dot(d, p) - uPacketA[i].w * ${t} + uPacketPhase[i];
      float ka = uPacketA[i].z * amp;
      float qka = uPacketB[i].y * ka;`;
}

export function oceanVertexChunk(waveCount = 12) {
  const { lagDecl, lagSums, lagFold } = crestLagChunks();
  const packetLags = crestLagChunks('uPacketA[i].w').lagSums;

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
      float att = exp(-camDist / (uWaveB[i].z * 45.0 + 600.0));
      float amp = uWaveB[i].x * att;
      if (amp < 0.001) continue;

      vec2 d = uWaveA[i].xy;
      float theta = uWaveA[i].z * dot(d, p) - uWaveA[i].w * uTime + uWaveB[i].w;
      float s = sin(theta);
      float c = cos(theta);
      float qa = uWaveB[i].y * amp;
      float ka = uWaveA[i].z * amp;
      float qka = uWaveB[i].y * ka;

      pos.x += d.x * qa * c;
      pos.z += d.y * qa * c;
      pos.y += amp * s;

      normal.x -= d.x * ka * c;
      normal.z -= d.y * ka * c;
      normal.y -= qka * s;

      crest += qka * s;
${lagSums}
    }

    // The packets, term for term the same, with the envelope's height for amp.
    for (int i = 0; i < NP; i++) {${packetTermOpening('uTime')}
      float s = sin(theta);
      float c = cos(theta);
      float qa = uPacketB[i].y * amp;

      pos.x += d.x * qa * c;
      pos.z += d.y * qa * c;
      pos.y += amp * s;

      normal.x -= d.x * ka * c;
      normal.z -= d.y * ka * c;
      normal.y -= qka * s;

      crest += qka * s;
${packetLags}
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
      float att = exp(-camDist / (uWaveB[i].z * 45.0 + 600.0));
      float amp = uWaveB[i].x * att;
      if (amp < 0.001) continue;

      vec2 d = uWaveA[i].xy;
      float theta = uWaveA[i].z * dot(d, p) - uWaveA[i].w * t + uWaveB[i].w;
      float ka = uWaveA[i].z * amp;

      normal.x -= d.x * ka * cos(theta);
      normal.z -= d.y * ka * cos(theta);
      normal.y -= uWaveB[i].y * ka * sin(theta);
    }

    for (int i = 0; i < NP; i++) {${packetTermOpening('t')}

      normal.x -= d.x * ka * cos(theta);
      normal.z -= d.y * ka * cos(theta);
      normal.y -= qka * sin(theta);
    }

    return normalize(normal);
  }
`;
}

/**
 * The fragment-stage twin of the crest half of `gerstner`, memory and all,
 * computed alongside the per-pixel normal.
 *
 * The vertex crest is exact where it is computed and mush in between, exactly
 * as the normal was: a whitecap is cut by a threshold on this number, and a
 * threshold on a value interpolated across a cell six metres wide draws a soft
 * smear the shape of the triangle rather than a crest. Evaluated per pixel, the
 * white stops where the surface really stops pinching, which is what makes a
 * breaking top read as a hard white edge on grey water and not as fog sitting
 * on it.
 *
 * It declares nothing. It joins a stage that has already included
 * `oceanNormalChunk`, which owns the wave table, and it takes the clock as a
 * parameter for the same reason that one does. Like it, it is shading only:
 * no position comes out of it, so the surface a hull floats on is untouched.
 */
export function oceanCrestChunk() {
  const { lagDecl, lagSums, lagFold } = crestLagChunks();
  const packetLags = crestLagChunks('uPacketA[i].w').lagSums;
  // θ(t + τ) = θ(t) − ω·τ: the lead is the lag run the other way.
  const leadDecl = SPILL_LEAD.map((_, i) => `    float lead${i} = 0.0;`).join('\n');
  const leadSumsFor = (omega) => SPILL_LEAD.map(
    ({ lead }, i) =>
      `      lead${i} += qka * sin(theta - ${omega} * ${glslFloat(lead)});  // ${glslFloat(lead)} s ahead`
  ).join('\n');
  const leadSums = leadSumsFor('uWaveA[i].w');
  const packetLeads = leadSumsFor('uPacketA[i].w');
  const leadFold = SPILL_LEAD.reduce(
    (acc, { weight }, i) =>
      i === 0 ? `lead0 * ${glslFloat(weight)}` : `max(${acc}, lead${i} * ${glslFloat(weight)})`,
    ''
  );
  return /* glsl */ `
  // gerstnerNormal and the crest in one pass over the table: the attenuation
  // and the phase are the expensive part of either, and they are the same
  // numbers. The normal is the sum gerstnerNormal returns, term for term.
  //
  // leadOut is the crest pinch this point is about to have (SPILL_LEAD): high
  // on the face just ahead of a breaking crest, which is the water that crest
  // is about to tumble down. See the spill in ocean.js.
  //
  // px is how many metres of sea one pixel covers here. A wave shorter than a
  // couple of pixels cannot be drawn, only aliased: its normal flips facet to
  // facet between neighbouring pixels and the sky it reflects breaks into a
  // speckle that, on a screen drawn at reduced resolution and scaled up, reads
  // as a field of little bricks. So each wave's share of the normal fades out
  // as it shrinks from four pixels to two. Its share of the crest does not:
  // that is a coverage, cut softly, and the foam needs the pinch it adds.
  vec3 gerstnerNormalCrest(vec2 p, float camDist, float t, float px, out float crestOut, out float leadOut) {
    vec3 normal = vec3(0.0, 1.0, 0.0);
    float crest = 0.0;
${leadDecl}
${lagDecl}

    for (int i = 0; i < NW; i++) {
      float att = exp(-camDist / (uWaveB[i].z * 45.0 + 600.0));
      float amp = uWaveB[i].x * att;
      if (amp < 0.001) continue;

      vec2 d = uWaveA[i].xy;
      float theta = uWaveA[i].z * dot(d, p) - uWaveA[i].w * t + uWaveB[i].w;
      float s = sin(theta);
      float c = cos(theta);
      float ka = uWaveA[i].z * amp;
      float qka = uWaveB[i].y * ka;
      float drawn = 1.0 - smoothstep(0.25, 0.5, px / uWaveB[i].z);

      normal.x -= d.x * ka * c * drawn;
      normal.z -= d.y * ka * c * drawn;
      normal.y -= qka * s * drawn;

      crest += qka * s;
${leadSums}
${lagSums}
    }

    for (int i = 0; i < NP; i++) {${packetTermOpening('t')}
      float s = sin(theta);
      float c = cos(theta);
      float drawn = 1.0 - smoothstep(0.25, 0.5, px * uPacketA[i].z / 6.28318530718);

      normal.x -= d.x * ka * c * drawn;
      normal.z -= d.y * ka * c * drawn;
      normal.y -= qka * s * drawn;

      crest += qka * s;
${packetLeads}
${packetLags}
    }

    crestOut = ${lagFold};
    leadOut = ${leadFold};
    return normalize(normal);
  }
`;
}
