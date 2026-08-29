// The sea, wearing a heightfield's interface.
//
// Everything that asks the world questions — the hull, the air, a camera, a
// bird — asks through heightAt / gradientAt / normalAt / contains. This class
// answers all of them from the wave table instead of a decoded heightmap,
// which is the whole trick: the game never finds out the ground is moving.
//
// The one addition is `advance(dt)`. Terrain holds still; the sea does not,
// and it must be stepped once per frame *before* anything reads it, so every
// query in a frame sees the same instant of the same sea. A hull that sampled
// its bow at t and its stern at t + a few microseconds would pitch on noise.

import { Vector3 } from 'three';

/** A square of ocean twenty kilometres on a side — well past any horizon. */
const DEFAULT_EXTENT = 20000;

export class WaveField {
  /**
   * @param seaState  the spectrum this field answers from.
   * @param extent    metres, square, centred on the origin. Only `contains`
   *                  and `half` care: the waves themselves run forever.
   */
  constructor(seaState, extent = DEFAULT_EXTENT) {
    this.extent = extent;
    this.half = extent / 2;
    this.time = 0;
    this.setSeaState(seaState);
  }

  /** Swap the sea underneath everything. The clock keeps running, so a swap
   *  mid-game is a change of weather rather than a jump cut. */
  setSeaState(seaState) {
    this.sea = seaState;
    this.hMin = seaState.hMin;
    this.hMax = seaState.hMax;
    return this;
  }

  advance(dt) {
    this.time += dt;
  }

  heightAt(x, z) {
    return this.sea.heightAt(x, z, this.time);
  }

  roughHeightAt(x, z) {
    return this.sea.roughHeightAt(x, z, this.time);
  }

  gradientAt(x, z, spread = 22) {
    return this.sea.gradientAt(x, z, this.time, spread);
  }

  normalAt(x, z, spread = 22, out = new Vector3()) {
    return this.sea.normalAt(x, z, this.time, spread, out);
  }

  crestAt(x, z) {
    return this.sea.crestAt(x, z, this.time);
  }

  orbitalVelocityAt(x, z, out = new Vector3()) {
    return this.sea.orbitalVelocityAt(x, z, this.time, out);
  }

  contains(x, z, margin = 0) {
    const lim = this.half - margin;
    return x >= -lim && x <= lim && z >= -lim && z <= lim;
  }
}
