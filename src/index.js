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

// The rendering half. Only the foam field needs a live renderer, and only in
// its update: everything here can be built, and its GLSL read, without a
// context, which is how the shaders are tested.
export { createOcean, skyGradientChunk, agxToneMapChunk } from './render/ocean.js';
export { createFoamField, wakeStamper } from './render/foamfield.js';
export { createSky } from './render/sky.js';
export { createRain } from './render/rain.js';
export { createSpray } from './render/spray.js';
export { warpedGrid } from './render/grid.js';
