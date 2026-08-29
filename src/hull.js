// A hull in a following sea.
//
// This is the seakeeping heart of The Helmsman's Watch, and it is honest about
// being a game model: phenomenological, every constant a tunable, weather-ship
// behaviour first and naval architecture a distant second. What it has to get
// right is not the added-mass coefficients — it is the *feel* of running
// before a big sea, which is a very particular and very unpleasant thing:
//
//   She is fast on the faces and slow in the troughs, so the ride comes in
//   surges rather than at a speed.
//
//   The faster she surfs the less the rudder can do, because a rudder works on
//   the water flowing past it and while she is running with a crest that water
//   is going her way. At the exact moment you most need steerage you have
//   least, which is the entire game.
//
//   Meanwhile the sea itself is trying to turn her. A crest lifting one
//   quarter and not the other slews the stern, and a slewed stern in a
//   following sea is the first half of a broach: she comes beam-on, goes over,
//   and there is nothing the helm can do about it until she slows.
//
// The four-point sample does most of the work. Bow, stern and both beams read
// the wave field every step; heave, pitch and roll ease toward what those four
// numbers say with the reluctance of five hundred tons, and surfing falls out
// of the fore-and-aft slope for free.
//
// Frames: headings are compass bearings (x east, z south, north is −z), which
// is what the wave table uses. The quaternion is for a mesh whose bow points
// down its own −Z, three.js's default forward.

import { Vector3, Quaternion, Euler, MathUtils } from 'three';

const { clamp } = MathUtils;

const _euler = new Euler();
const _orbit = new Vector3();

/**
 * Every number the model uses, in one place, each one meaning something.
 * Anything not passed to the constructor comes from here.
 */
export const HULL_DEFAULTS = {
  // --- The ship -------------------------------------------------------------
  length: 39, // stem to sternpost, metres
  beam: 9.9, // extreme breadth, metres
  draught: 4.3, // metres. Carried for whoever draws her; nothing here reads it.
  freeboard: 2.4, // quarterdeck above the waterline — what a sea has to top
  mass: 500e3, // kg. Only suggests the response taus, if those are omitted.

  // --- Response ------------------------------------------------------------
  // Time constants for the exponential ease toward the sampled attitude. A
  // heavy ship does not sit on the water, she argues with it.
  heaveTau: 1.5,
  pitchTau: 1.9,
  rollTau: 2.1,

  // --- Sampling ------------------------------------------------------------
  sampleFore: 0.35, // fore/aft sample arms, as a fraction of length
  sampleBeam: 0.45, // beam sample arms, as a fraction of beam
  pitchGain: 0.85, // she does not follow the slope all the way — inertia
  rollGain: 0.6, // nor the athwartships one; a deep hull resists more
  slopeStencil: 26, // metres, the central difference used for wave yaw

  // --- Way through the water -----------------------------------------------
  maxSpeed: 6, // m/s at full canvas in flat water
  maxSurgeFactor: 1.9, // ceiling as a multiple of maxSpeed, running down a face
  surgeGain: 26, // m/s of surge per unit of fore-and-aft slope
  surgeTau: 2.2, // she gathers and loses way slowly
  orbitalDrift: 0.15, // fraction of the surface orbital velocity she is carried by

  // --- Surfing -------------------------------------------------------------
  // surfFactor is "how much of her speed is the sea's doing", measured against
  // what her own canvas could give her.
  surfSurgeFraction: 0.6,
  surfTau: 0.6, // short: surfing starts and stops within a wave

  // --- Steering ------------------------------------------------------------
  rudderPower: 0.25, // rad/s² of yaw at full helm and full flow
  yawDamping: 0.8, // 1/s; a hull is directionally stable, up to a point
  maxYawRate: 0.6, // rad/s. Nothing this size turns faster, broached or not.
  rudderFlowFraction: 0.5, // authority is full at half the dominant wave speed
  surfAuthorityLoss: 0.8, // fraction of authority lost at surfFactor = 1

  // --- The sea slewing her -------------------------------------------------
  // Set so a glassy heave slews her by well under a degree a minute while a
  // greybeard sea has her broaching inside five, which is the whole dynamic
  // range the model has to cover.
  waveYawGain: 0.7, // rad/s² per unit of stern-minus-bow athwartships slope
  surfYawGain: 2, // the same torque bites this much harder while surfing

  // --- Broach --------------------------------------------------------------
  // Risk is a blend of three things, and the weights sum past one on purpose:
  // no single one of them should be able to put her over by itself.
  broachSurfWeight: 0.55,
  broachTorqueWeight: 0.25,
  broachOffAxisWeight: 0.45,
  broachTorqueRef: 0.08, // rad/s² of wave yaw that counts as "all of it"
  broachOffAxisRef: 0.9, // rad (52°) off the wave's heading, likewise
  broachYawKick: 0.5, // rad/s² driving her the rest of the way beam-on
  broachRoll: 0.35, // rad added to the roll target, to leeward
  broachSpeedTau: 4, // she stops, hard, once she is across the sea
  broachClearRisk: 0.6, // risk must fall this far before the latch releases
  broachClearRollRate: 0.05, // rad/s — and the roll must have settled

  // --- Pooped --------------------------------------------------------------
  poopSurfLimit: 0.3, // a sea only boards her if she is *not* running with it
  poopReleaseFactor: 0.6, // the stern must dry out this far before it can happen again
  poopDuration: 2.5, // s of ruined steerage while the water runs off
  poopAuthority: 0.3, // what is left of the rudder meanwhile

  // --- Where she starts ----------------------------------------------------
  x: 0,
  z: 0,
  headingDeg: 105,
  speed: 0,
};

/** Response taus scale as the sixth root of displacement: periods go as the
 *  square root of length, and length as the cube root of mass. */
function tauFor(base, mass) {
  return base * Math.pow(mass / HULL_DEFAULTS.mass, 1 / 6);
}

/** Signed angle into −π..π, so "off the wave's heading" is a real difference. */
function wrapPi(a) {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/** Compass bearings live in 0..2π, so `headingDeg` reads as a course. */
function wrapTau(a) {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

export class Hull {
  constructor(options = {}) {
    const mass = options.mass ?? HULL_DEFAULTS.mass;

    // Taus given explicitly win; otherwise they follow the displacement, so a
    // brig and a first rate do not answer the sea at the same rate.
    const o = {
      ...HULL_DEFAULTS,
      heaveTau: tauFor(HULL_DEFAULTS.heaveTau, mass),
      pitchTau: tauFor(HULL_DEFAULTS.pitchTau, mass),
      rollTau: tauFor(HULL_DEFAULTS.rollTau, mass),
      ...options,
    };
    this.options = o;

    this.position = new Vector3(o.x, 0, o.z);
    this.quaternion = new Quaternion();

    this.headingRad = wrapTau(MathUtils.degToRad(o.headingDeg));
    this.speed = o.speed;
    this.yawRate = 0;

    this.heave = 0;
    this.pitch = 0;
    // Positive roll is heeled to starboard — the port side lifted by higher
    // water, exactly the contract's atan((port − starboard) / span).
    this.roll = 0;

    this.surfFactor = 0;
    this.rudderAuthority = 0;
    this.waveYaw = 0;
    this.broachRisk = 0;
    this.broached = false;

    /** Fired once, at the instant the broach latches. */
    this.onBroach = null;
    /** Fired once per sea that comes aboard over the taffrail. */
    this.onPooped = null;

    this._rollRate = 0;
    this._broachSign = 1;
    this._poopTimer = 0;
    this._poopArmed = true;

    this._syncTransform();
  }

  get headingDeg() {
    return MathUtils.radToDeg(this.headingRad);
  }

  set headingDeg(deg) {
    this.headingRad = wrapTau(MathUtils.degToRad(deg));
    this._syncTransform();
  }

  /**
   * @param dt      seconds.
   * @param field   a WaveField, already advanced for this frame.
   * @param rudder  −1..1, port to starboard.
   * @param thrust  0..1, the fraction of maxSpeed her canvas is driving her at.
   */
  update(dt, field, { rudder = 0, thrust = 0 } = {}) {
    if (!(dt > 0) || !field) return this;

    const o = this.options;
    const sea = field.sea;
    const helm = clamp(rudder, -1, 1);
    const drive = clamp(thrust, 0, 1);

    // Compass frame: forward along the heading, starboard ninety to the right.
    const fx = Math.sin(this.headingRad);
    const fz = -Math.cos(this.headingRad);
    const sx = Math.cos(this.headingRad);
    const sz = Math.sin(this.headingRad);

    const px = this.position.x;
    const pz = this.position.z;

    // --- 1. What the water is doing under her -------------------------------
    const foreArm = o.length * o.sampleFore;
    const beamArm = o.beam * o.sampleBeam;
    const bowX = px + fx * foreArm;
    const bowZ = pz + fz * foreArm;
    const sternX = px - fx * foreArm;
    const sternZ = pz - fz * foreArm;

    const hBow = field.heightAt(bowX, bowZ);
    const hStern = field.heightAt(sternX, sternZ);
    const hPort = field.heightAt(px - sx * beamArm, pz - sz * beamArm);
    const hStar = field.heightAt(px + sx * beamArm, pz + sz * beamArm);

    const foreSpan = 2 * foreArm;
    const beamSpan = 2 * beamArm;

    const targetHeave = (hBow + hStern + hPort + hStar) / 4;
    const targetPitch = Math.atan2(hBow - hStern, foreSpan) * o.pitchGain;
    let targetRoll = Math.atan2(hPort - hStar, beamSpan) * o.rollGain;

    // --- 2. Surge, and how hard she is surfing ------------------------------
    // Stern up means she is on the face of a wave that is overtaking her, and
    // gravity is on her side. Bow up means she is climbing out of a trough.
    const slope = (hStern - hBow) / foreSpan;
    const surge = slope * o.surgeGain;
    const targetSpeed = clamp(
      o.maxSpeed * drive + surge,
      0,
      o.maxSpeed * o.maxSurgeFactor
    );
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt / o.surgeTau));

    const surfTarget = clamp(surge / (o.maxSpeed * o.surfSurgeFraction), 0, 1);
    this.surfFactor +=
      (surfTarget - this.surfFactor) * (1 - Math.exp(-dt / o.surfTau));

    // --- 3. What the rudder has left ----------------------------------------
    // Flow past the rudder is what steers her, and while she runs with a crest
    // the water beside her is running too. Surfing at wave speed the helm is a
    // suggestion; this single line is the feel the whole game is built on.
    if (this._poopTimer > 0) this._poopTimer -= dt;
    const flow = clamp(
      this.speed / (sea.dominantSpeed * o.rudderFlowFraction),
      0,
      1
    );
    this.rudderAuthority =
      clamp(flow * (1 - o.surfAuthorityLoss * this.surfFactor), 0, 1) *
      (this._poopTimer > 0 ? o.poopAuthority : 1);

    // --- 4. The sea slewing her ---------------------------------------------
    // Athwartships slope at the stern, less the same at the bow. A quartering
    // crest under one quarter and a trough under the other is a couple, and it
    // bites harder the more of her weight the wave is already carrying.
    const gBow = field.gradientAt(bowX, bowZ, o.slopeStencil);
    const gStern = field.gradientAt(sternX, sternZ, o.slopeStencil);
    const athwartBow = gBow.dx * sx + gBow.dz * sz;
    const athwartStern = gStern.dx * sx + gStern.dz * sz;
    this.waveYaw =
      (athwartStern - athwartBow) *
      o.waveYawGain *
      (1 + o.surfYawGain * this.surfFactor);

    let yawAccel =
      helm * o.rudderPower * this.rudderAuthority +
      this.waveYaw -
      o.yawDamping * this.yawRate;

    // --- 5. Broach ----------------------------------------------------------
    // Three things have to come together: she has to be carried, the sea has
    // to have hold of her stern, and she has to have already come off her
    // course. Any two are a bad minute; all three and she is over.
    const rel = wrapPi(this.headingRad - sea.dominantTravelRad);
    const raw =
      o.broachSurfWeight * this.surfFactor +
      o.broachTorqueWeight *
        Math.min(1, Math.abs(this.waveYaw) / o.broachTorqueRef) +
      o.broachOffAxisWeight * Math.min(1, Math.abs(rel) / o.broachOffAxisRef);
    this.broachRisk = clamp(raw, 0, 1);

    if (!this.broached && raw >= 1) {
      this.broached = true;
      // She goes the way she was already falling off.
      this._broachSign = rel > 0 || (rel === 0 && this.yawRate >= 0) ? 1 : -1;
      if (this.onBroach) this.onBroach(this);
    }

    if (this.broached) {
      // Round up until she is across the sea, then no further.
      if (Math.abs(rel) < Math.PI / 2) yawAccel += this._broachSign * o.broachYawKick;
      // Thrown down to leeward, and stopped by her own beam.
      targetRoll += this._broachSign * o.broachRoll;
      this.speed *= Math.exp(-dt / o.broachSpeedTau);

      if (
        this.broachRisk < o.broachClearRisk &&
        Math.abs(this._rollRate) < o.broachClearRollRate
      ) {
        this.broached = false;
      }
    }

    this.yawRate = clamp(
      this.yawRate + yawAccel * dt,
      -o.maxYawRate,
      o.maxYawRate
    );
    this.headingRad = wrapTau(this.headingRad + this.yawRate * dt);

    // --- 6. Pooped ----------------------------------------------------------
    // A crest overtaking a ship that is *not* running with it climbs her
    // transom and comes aboard over the taffrail. Once per sea, latched on the
    // stern drying out again, so a crest that hangs about does not machine-gun
    // the callback.
    const deck = this.heave + o.freeboard;
    if (this._poopArmed && hStern > deck && this.surfFactor < o.poopSurfLimit) {
      this._poopArmed = false;
      this._poopTimer = o.poopDuration;
      if (this.onPooped) this.onPooped(this);
    } else if (hStern < this.heave + o.freeboard * o.poopReleaseFactor) {
      this._poopArmed = true;
    }

    // --- 7. Answer the sea, and move -----------------------------------------
    const prevRoll = this.roll;
    this.heave += (targetHeave - this.heave) * (1 - Math.exp(-dt / o.heaveTau));
    this.pitch += (targetPitch - this.pitch) * (1 - Math.exp(-dt / o.pitchTau));
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-dt / o.rollTau));
    this._rollRate = (this.roll - prevRoll) / dt;

    // Way through the water, plus the water itself: the top of a wave is
    // moving, and a hull on it goes along with the orbit whether she likes it
    // or not. That is why a crest carries her bodily and not merely faster.
    field.orbitalVelocityAt(px, pz, _orbit);
    this.position.x += (fx * this.speed + _orbit.x * o.orbitalDrift) * dt;
    this.position.z += (fz * this.speed + _orbit.z * o.orbitalDrift) * dt;
    this.position.y = this.heave;

    this._syncTransform();
    return this;
  }

  _syncTransform() {
    // Compass bearing to a three.js yaw: a mesh looks down its own −Z, so a
    // clockwise bearing is an anticlockwise rotation about +Y. And +Z lifts
    // local +X, which is her starboard side, so the roll goes in negated.
    _euler.set(this.pitch, -this.headingRad, -this.roll, 'YXZ');
    this.quaternion.setFromEuler(_euler);
  }
}
