// surprise-sea — a reusable Southern Ocean.
//
// One spectrum, described once and consumed twice: the CPU samples the surface
// analytically, the GPU displaces a mesh with the same wave sum, and a ship or
// a bird touching the water touches what the eye sees.

export { createSeaState, PRESETS } from './spectrum.js';
export {
  SeaState,
  waveUniforms,
  oceanVertexChunk,
  oceanNormalChunk,
  FOAM_LAGS,
} from './seastate.js';
export { WaveField } from './wavefield.js';
export { Hull, HULL_DEFAULTS } from './hull.js';
export { AirOverSea, AIR_DEFAULTS } from './airoversea.js';

// The rendering half. Needs a WebGL context, so nothing under test/ touches it.
export { createOcean, skyGradientChunk, agxToneMapChunk } from './render/ocean.js';
export { createSpray } from './render/spray.js';
export { warpedGrid } from './render/grid.js';
