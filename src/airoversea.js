// The moving air over a big sea.
//
// Same shape as any air model a flight sim would want — a wind vector and a
// vertical component you sample anywhere — but the weather here is peculiar,
// because there are no thermals over cold water. What there is instead:
//
//   Wave lift. Wind striking the windward face of a swell is deflected up,
//   exactly as it is by a hillside: the same wind-dot-gradient, read from the
//   moving wave field. This is the albatross's whole living. The lift band
//   travels with the wave, at very nearly the bird's own trim speed, so it can
//   hold one face and ride it for miles.
//
//   Streets. Strong wind over a long fetch rolls the lowest kilometre of air
//   into slow vortices aligned downwind, and along the seams the air goes up.
//   They are the way back to height once the waves have been surfed enough,
//   and the scud tends to lie along them.
//
//   Gusts. The wind breathes on slow cycles, so nothing is ever quite steady.
//
// Wind speed and direction come from the sea state by default, which keeps the
// two honest: change the weather and the air changes with it, including on a
// live swap. Pass either explicitly to pin it.

import { Vector3, MathUtils } from 'three';

const _sample = new Vector3();

export const AIR_DEFAULTS = {
  // --- Streets --------------------------------------------------------------
  streetSpacing: 850, // metres between one rising seam and the next
  streetWidth: 130, // gaussian half-width of the rising core
  streetStrength: 2.7, // m/s in the core, before the band and pulse
  streetTop: 620, // roughly the scud base
  streetBase: 25, // no street structure below this — the waves own it
  streetDrift: 1.1, // m/s the whole pattern slides sideways, so none is a fixture
  streetSink: 0.35, // m/s of compensating descent between the streets

  // --- Wave lift ------------------------------------------------------------
  waveLiftGain: 1.5, // multiplier on wind·slope going up a face
  waveSinkGain: 0.7, // and, softened, coming down the back of one
  waveLiftDecay: 120, // metres of e-folding height; waves stir a shallow layer
  waveLiftStencil: 20, // metres, the gradient stencil the lift is read from

  // --- Everything else ------------------------------------------------------
  baseSink: 0.4, // m/s of general subsidence, so nothing floats for free
  gustPeriodA: 0.11, // rad/s
  gustPeriodB: 0.031,
  gustAmpA: 0.13,
  gustAmpB: 0.07,
};

export class AirOverSea {
  /**
   * @param waveField  the sea beneath. Its `sea` supplies the wind unless the
   *                   options override it.
   * @param options    AIR_DEFAULTS, plus optional `windFromDeg` / `windSpeed`.
   */
  constructor(waveField, options = {}) {
    this.waveField = waveField;
    this.options = { ...AIR_DEFAULTS, ...options };

    // null means "follow the sea state", which is the useful default.
    this._fixedFromDeg = options.windFromDeg ?? null;
    this._fixedSpeed = options.windSpeed ?? null;

    this.wind = new Vector3();
    this.time = 0;

    /** For interface compatibility with a land Air — nothing thermal out here. */
    this.thermals = [];

    this.windFromDeg = 0;
    this.baseSpeed = 0;
    this.windSpeed = 0;
    this._axisDeg = null;

    this._syncToSea();
    this._updateWindVector();
  }

  /** Read the wind off the sea state, unless it was pinned in the options. */
  _syncToSea() {
    const sea = this.waveField.sea;
    this.windFromDeg = this._fixedFromDeg ?? sea.windFromDeg;
    this.baseSpeed = this._fixedSpeed ?? sea.windSpeed;

    // The street lattice is laid out along the wind, so it only has to be
    // rebuilt when the wind actually swings.
    if (this._axisDeg !== this.windFromDeg) {
      this._axisDeg = this.windFromDeg;
      const rad = MathUtils.degToRad(this.windFromDeg);
      this._alongX = -Math.sin(rad);
      this._alongZ = Math.cos(rad);
      this._acrossX = -this._alongZ;
      this._acrossZ = this._alongX;
    }
  }

  _updateWindVector() {
    const rad = MathUtils.degToRad(this.windFromDeg);
    this.wind
      .set(-Math.sin(rad), 0, Math.cos(rad))
      .multiplyScalar(this.windSpeed);
  }

  update(dt) {
    this.time += dt;
    this._syncToSea();

    const o = this.options;
    // Two slow cycles beating against each other: ±20% or so, never repeating
    // on any timescale a flight lasts.
    const gust =
      1 +
      o.gustAmpA * Math.sin(this.time * o.gustPeriodA) +
      o.gustAmpB * Math.sin(this.time * o.gustPeriodB + 2.1);
    this.windSpeed = this.baseSpeed * gust;
    this._updateWindVector();
  }

  velocityAt(x, y, z, out = _sample) {
    out.copy(this.wind);
    out.y =
      this.waveLiftAt(x, y, z) +
      this.streetLiftAt(x, y, z) -
      this.options.baseSink;
    return out;
  }

  /** Wind deflected up the face of a sea. Strongest just above the water. */
  waveLiftAt(x, y, z) {
    const o = this.options;
    const wf = this.waveField;
    const agl = y - wf.heightAt(x, z);
    if (agl < 0) return 0;

    const g = wf.gradientAt(x, z, o.waveLiftStencil);
    const w = -(this.wind.x * g.dx + this.wind.z * g.dz);

    // This is skimming lift: strong, and close. Sink to leeward is softened
    // the same way a hill's is, because the air separates rather than
    // following the back of the wave down.
    const scaled = w > 0 ? w * o.waveLiftGain : w * o.waveSinkGain;
    return scaled * Math.exp(-agl / o.waveLiftDecay);
  }

  /** Rows of rising air along the wind. */
  streetLiftAt(x, y, z) {
    const o = this.options;
    // Streets are a boundary-layer structure; they do not care about the
    // instantaneous wave under them, so height is measured from the datum.
    const height = y;
    if (height < o.streetBase || height > o.streetTop + 150) return 0;

    // Distance across the wind, folded into the repeating pattern.
    const across =
      x * this._acrossX + z * this._acrossZ + this.time * o.streetDrift;
    const local =
      ((across % o.streetSpacing) + o.streetSpacing * 1.5) % o.streetSpacing -
      o.streetSpacing / 2;

    const core = Math.exp(-(local * local) / (2 * o.streetWidth * o.streetWidth));

    // Fades in off the water, out toward the scud base; between the streets
    // the compensating air comes down.
    const band =
      Math.min(1, (height - o.streetBase) / 90) *
      Math.min(1, Math.max(0, (o.streetTop + 150 - height) / 220));

    const pulse = 0.8 + 0.2 * Math.sin(this.time * 0.05 + across * 0.001);

    return (core * o.streetStrength - o.streetSink) * band * pulse;
  }

  /** Nothing circles a thermal out here; the spume marks the air instead. */
  nearbyThermals() {
    return [];
  }
}
