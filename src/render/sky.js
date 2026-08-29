// The sky, and what the sea makes of it.
//
// The dome came out of the demo, where it had quietly become library-quality:
// two overlapping gradient ramps rather than one, because a single smoothstep
// leaves a seam across the sky exactly where the eye is already looking, plus
// two sun lobes — a broad haze and a tight core — and the same AgX grade the
// water wears, so the horizon carries no step where the two meet.
//
// It is here rather than in the demo for one reason: the sea must be able to
// reflect the sky that is actually overhead. `ocean.js` already draws its
// reflected sky with `skyGradient()`, and this file draws the dome with the very
// same GLSL, so the two can no longer drift apart the first time either is
// tuned. That is the cheap half of the job. The dear half is `reflection`.
//
// The reflection is a small mipmapped cube — one hundred and twenty-eight
// pixels a face — with nothing in it but this dome. A procedural sky changes
// only when the lighting changes, so it is rendered only when the lighting
// changes: `setLighting` marks the cube stale, `updateReflection` re-renders it
// if it is, and a caller who forgets and calls it every frame pays nothing.
// Six faces of a shader with no textures and no loops is about a third of a
// megapixel — cheaper than one frame of the sea, and it happens when a slider
// moves rather than sixty times a second.
//
// The cube is drawn *ungraded*: linear scene radiance straight out of
// `skyGradient`, no tone curve and no colour-space conversion. That is
// deliberate. The ocean mixes the cube sample into its own colour and then tone
// maps the result once; a cube that had already been through AgX would be
// graded twice, and the sun's reflection would come back flat and grey. The
// dome you look at is graded, the dome the sea looks at is not, and the two
// share one set of uniforms so they can never disagree about the weather.
//
// Every GPU object is built on first use, so this file imports and constructs
// in node without a WebGL context — the geometry, the materials and the mesh
// need none, and the cube render target is not made until a renderer arrives.

import * as THREE from 'three';
import { skyGradientChunk, agxToneMapChunk } from './ocean.js';

/** The shipped storm, and the shape a lighting object takes. */
const DEFAULT_LIGHTING = {
  sunDir: [0.35, 0.3, 0.65],
  sunColour: 0xdfe2de,
  skyTop: 0x67737f,
  skyHaze: 0xa6abab,
  glare: 0.3,
  exposure: 1,
};

/**
 * Face size of the reflection cube.
 *
 * A power of two, so three.js will mip it; small, because a rough sea is a poor
 * mirror and every sample the water takes is blurred anyway. The review asked
 * for 64–128 and the upper end costs nothing.
 */
const REFLECTION_SIZE = 128;

/** Hex numbers, CSS strings and THREE.Colors are all fair game for a palette. */
function readColour(out, value) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'number') out.setHex(value);
  else out.set(value);
  return out;
}

// The dome never moves relative to the eye and is always at the far plane, so
// the vertex stage throws away the view translation and forces w into z. That
// works for a cube camera exactly as it works for a perspective one: only the
// rotation of each face matters, and every face is filled.
const vertexShader = /* glsl */ `
  varying vec3 vDir;

  void main() {
    vDir = position;
    mat4 rotOnly = mat4(mat3(viewMatrix));
    vec4 pos = projectionMatrix * rotOnly * vec4(position, 1.0);
    gl_Position = pos.xyww;
  }
`;

/**
 * @param graded  true for the dome the eye sees — AgX and the renderer's
 *                colour space. False for the dome the sea reflects: linear,
 *                unclamped, un-graded, because the water tone maps once at the
 *                end and a twice-graded reflection is a dead one.
 */
const fragmentShader = (graded) => /* glsl */ `
  ${skyGradientChunk}
  ${graded ? agxToneMapChunk : ''}

  uniform vec3 uTop;
  uniform vec3 uHaze;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform float uGlare;
  uniform float uExposure;

  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    vec3 col = skyGradient(d, uHaze, uTop, normalize(uSunDir), uSunColour, uGlare);
${graded ? `
    gl_FragColor = vec4(agxToneMap(col, uExposure), 1.0);

    #include <colorspace_fragment>
` : `
    gl_FragColor = vec4(col, 1.0);
`}
  }
`;

/**
 * The sky overhead, and a cube of it for the water.
 *
 * @param options
 *   `lighting`        the same object `createOcean` takes; `sunDir`,
 *                     `sunColour`, `skyTop`, `skyHaze`, `glare` and `exposure`
 *                     are the keys read. Partial objects are welcome — what is
 *                     left out keeps the value it had.
 *   `reflectionSize`  face size of the cube; 128 by default, 0 to do without
 *                     one entirely.
 *
 * @returns `{ mesh, uniforms, reflection, updateReflection(renderer),
 *            setLighting(lighting), dispose() }`
 *
 * `reflection` is null until `updateReflection` has been handed a renderer
 * once. Ask for it after that call, not before.
 */
export function createSky(options = {}) {
  const uniforms = {
    uTop: { value: new THREE.Color() },
    uHaze: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0.35, 0.3, 0.65) },
    uSunColour: { value: new THREE.Color() },
    uGlare: { value: 0.3 },
    uExposure: { value: 1 },
  };

  const size = options.reflectionSize ?? REFLECTION_SIZE;

  const geometry = new THREE.SphereGeometry(1, 32, 16);

  const makeMaterial = (graded) =>
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader: fragmentShader(graded),
      side: THREE.BackSide,
      depthWrite: false,
      // The grade is in the shader. Say so, or a renderer with tone mapping of
      // its own switched on will grade the dome a second time.
      toneMapped: false,
    });

  const material = makeMaterial(true);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';

  // Everything below is built the first time a renderer is offered, and never
  // if `reflectionSize` is nought — which is also what lets this file be
  // imported and constructed by a test with no GL context anywhere near it.
  let cubeTarget = null;
  let cubeCamera = null;
  let cubeScene = null;
  let rawMaterial = null;

  // Stale until proven otherwise. The whole economy of the cube rests on this
  // flag: `setLighting` sets it, `updateReflection` clears it, and a caller who
  // calls updateReflection every frame re-renders nothing at all.
  let stale = true;

  function buildReflection(renderer) {
    if (cubeTarget || size <= 0) return;

    // Half float where the driver will give it, so the sun lobes — which leave
    // `skyGradient` well above one — survive into the mips instead of clipping
    // to white. Eight bits is the fallback and it is a fair one: a reflection
    // in a storm sea is blurred past caring.
    const float = !!renderer?.extensions?.has?.('EXT_color_buffer_float');

    cubeTarget = new THREE.WebGLCubeRenderTarget(size, {
      type: float ? THREE.HalfFloatType : THREE.UnsignedByteType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    // Linear in, linear out. The water mixes this into scene values it has not
    // yet tone mapped, so nothing here may be encoded for a display.
    cubeTarget.texture.colorSpace = THREE.LinearSRGBColorSpace;
    cubeTarget.texture.name = 'sky-reflection';

    // Near and far only have to bracket a unit sphere; the vertex stage throws
    // the depth away regardless.
    cubeCamera = new THREE.CubeCamera(0.1, 10, cubeTarget);

    rawMaterial = makeMaterial(false);
    const rawMesh = new THREE.Mesh(geometry, rawMaterial);
    rawMesh.frustumCulled = false;
    rawMesh.name = 'sky-reflection-dome';

    cubeScene = new THREE.Scene();
    cubeScene.add(rawMesh);
  }

  function setLighting(next = {}) {
    const light = { ...DEFAULT_LIGHTING, ...next };

    readColour(uniforms.uTop.value, light.skyTop);
    readColour(uniforms.uHaze.value, light.skyHaze);
    readColour(uniforms.uSunColour.value, light.sunColour);
    if (light.sunDir) uniforms.uSunDir.value.set(...light.sunDir).normalize();
    uniforms.uGlare.value = light.glare ?? 0.4;
    uniforms.uExposure.value = light.exposure ?? 1;

    // The sky the sea reflects is now a lie. It stays one until someone with a
    // renderer says otherwise.
    stale = true;
  }

  setLighting(options.lighting ?? {});

  return {
    mesh,
    uniforms,

    /** The cube texture, or null until `updateReflection` has run once. */
    get reflection() {
      return cubeTarget ? cubeTarget.texture : null;
    },

    setLighting,

    /**
     * Re-render the cube, if the weather has moved since the last time.
     *
     * Call it after `setLighting` and nowhere else — though calling it every
     * frame is harmless, since a clean cube returns immediately. `force` is for
     * the one case the flag cannot see: a context loss that took the texture
     * with it.
     *
     * @returns the cube texture, or null if there is nothing to render into.
     */
    updateReflection(renderer, force = false) {
      if (size <= 0 || !renderer || typeof renderer.render !== 'function') return null;
      buildReflection(renderer);
      if (!stale && !force) return cubeTarget.texture;

      cubeCamera.update(renderer, cubeScene);
      stale = false;
      return cubeTarget.texture;
    },

    dispose() {
      geometry.dispose();
      material.dispose();
      rawMaterial?.dispose();
      cubeTarget?.dispose();
      cubeScene?.clear();
      cubeTarget = null;
      cubeCamera = null;
      cubeScene = null;
      rawMaterial = null;
      stale = true;
    },
  };
}
