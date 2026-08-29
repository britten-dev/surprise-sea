// The sky, without a WebGL context.
//
// A dome is nothing but a sphere and a shader string until something renders
// it, so most of this file is about *not* needing a browser: the module must
// import, build, take a lighting object and dispose in node, and every GPU
// object it owns must wait until a renderer is actually offered. That property
// is not a convenience for the tests — it is what lets a game construct its sky
// before it has decided which canvas to draw on.
//
// The rest is string-level GLSL, which the amendment asks for wherever a
// browser is not available: the dome the eye sees and the sea's reflected sky
// must be generated from the same shared chunk, because two hand-tuned ramps
// drift apart the first time either is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createSky } from '../src/render/sky.js';
import { skyGradientChunk, agxToneMapChunk } from '../src/render/ocean.js';

const STORM = {
  sunDir: [0.35, 0.3, 0.65],
  sunColour: 0xdfe2de,
  skyTop: 0x67737f,
  skyHaze: 0xa6abab,
  glare: 0.3,
  exposure: 1,
};

/**
 * The smallest thing `CubeCamera.update` will accept. It counts renders, which
 * is the only number this file really wants to know.
 */
function stubRenderer(floatTargets = false) {
  const calls = { render: 0, setRenderTarget: 0, scenes: [] };
  return {
    calls,
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: false },
    extensions: { has: () => floatTargets },
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget() { calls.setRenderTarget++; },
    render(scene) { calls.render++; calls.scenes.push(scene); },
  };
}

// --- Building without a browser ------------------------------------------------

test('the sky builds, lights and disposes with no renderer anywhere', () => {
  const sky = createSky({ lighting: STORM });

  assert.ok(sky.mesh.isMesh, 'no dome');
  assert.equal(sky.mesh.name, 'sky');
  assert.equal(sky.mesh.frustumCulled, false, 'a dome that can be culled');
  assert.ok(sky.mesh.renderOrder < 0, 'the dome would draw over the sea');

  // Nothing on the GPU until a renderer says there is a GPU.
  assert.equal(sky.reflection, null);
  assert.equal(sky.updateReflection(undefined), null);
  assert.equal(sky.updateReflection(null), null);
  assert.equal(sky.reflection, null);

  assert.doesNotThrow(() => sky.dispose());
});

test('lighting takes hex numbers, CSS strings and half an object', () => {
  const sky = createSky({ lighting: STORM });
  const top = sky.uniforms.uTop.value.clone();

  // A partial object must leave everything it does not mention alone.
  sky.setLighting({ glare: 0.9 });
  assert.equal(sky.uniforms.uGlare.value, 0.9);
  assert.deepEqual(sky.uniforms.uTop.value.toArray(), top.toArray());

  sky.setLighting({ skyTop: '#112233' });
  assert.equal(sky.uniforms.uTop.value.getHexString(), '112233');

  sky.setLighting({ skyHaze: 0x445566 });
  assert.equal(sky.uniforms.uHaze.value.getHexString(), '445566');

  // The sun arrives unnormalised from every preset in the library.
  sky.setLighting({ sunDir: [0.35, 0.3, 0.65] });
  assert.ok(Math.abs(sky.uniforms.uSunDir.value.length() - 1) < 1e-6);

  for (const v of [
    ...sky.uniforms.uTop.value.toArray(),
    ...sky.uniforms.uHaze.value.toArray(),
    ...sky.uniforms.uSunColour.value.toArray(),
    sky.uniforms.uGlare.value,
    sky.uniforms.uExposure.value,
  ]) {
    assert.ok(Number.isFinite(v));
  }
});

test('an empty options object still gives a lit sky', () => {
  const sky = createSky();
  assert.ok(sky.uniforms.uTop.value.getHexString().length === 6);
  assert.equal(sky.uniforms.uExposure.value, 1);
  assert.ok(Math.abs(sky.uniforms.uSunDir.value.length() - 1) < 1e-6);
});

// --- One formula for the dome and the sea ---------------------------------------

test('the dome is drawn with the shader chunk the sea reflects with', () => {
  const sky = createSky({ lighting: STORM });
  const frag = sky.mesh.material.fragmentShader;

  // Not a lookalike: the very text `ocean.js` compiles into its own fragment
  // stage. If either ramp is ever retuned, both move together or neither does.
  assert.ok(frag.includes(skyGradientChunk), 'the dome has its own sky formula');
  assert.ok(frag.includes('skyGradient(d,'), 'the dome does not call it');

  // And the same grade, or the horizon carries a step where the two meet.
  assert.ok(frag.includes(agxToneMapChunk), 'the dome is not AgX graded');
  assert.ok(frag.includes('agxToneMap(col, uExposure)'));
  assert.ok(frag.includes('<colorspace_fragment>'));

  // The dome is pinned to the far plane by the vertex stage, not by geometry.
  assert.ok(sky.mesh.material.vertexShader.includes('pos.xyww'));
  assert.equal(sky.mesh.material.side, THREE.BackSide);
  assert.equal(sky.mesh.material.depthWrite, false);
  assert.equal(sky.mesh.material.toneMapped, false, 'the renderer would grade it twice');
});

// --- The reflection cube --------------------------------------------------------

test('the cube is rendered on the first offer of a renderer', () => {
  const sky = createSky({ lighting: STORM });
  const renderer = stubRenderer();

  const texture = sky.updateReflection(renderer);
  assert.ok(texture, 'no cube came back');
  assert.equal(sky.reflection, texture);
  assert.equal(texture.isTexture, true);
  assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace,
    'a display-encoded cube would be tone mapped twice by the water');
  assert.equal(texture.generateMipmaps, true, 'a rough sea needs the mips');
  assert.equal(renderer.calls.render, 6, 'a cube has six faces');
});

test('the cube is re-rendered when the lighting changes, and never otherwise', () => {
  const sky = createSky({ lighting: STORM });
  const renderer = stubRenderer();

  sky.updateReflection(renderer);
  assert.equal(renderer.calls.render, 6);

  // A demo that calls it every frame — sixty times a second, for a second —
  // must pay for exactly none of them.
  for (let i = 0; i < 60; i++) sky.updateReflection(renderer);
  assert.equal(renderer.calls.render, 6, 'a still sky re-rendered its cube');

  sky.setLighting({ glare: 0.8 });
  sky.updateReflection(renderer);
  assert.equal(renderer.calls.render, 12, 'a change of light did not reach the cube');

  // And once more is once more, not twice.
  sky.updateReflection(renderer);
  assert.equal(renderer.calls.render, 12);

  // The one escape hatch: a context loss the flag cannot see.
  sky.updateReflection(renderer, true);
  assert.equal(renderer.calls.render, 18);
});

test('the reflection dome is ungraded, so the water may grade it itself', () => {
  const sky = createSky({ lighting: STORM });
  const renderer = stubRenderer();
  sky.updateReflection(renderer);

  // The cube scene is private, so catch it the way three.js hands it over: the
  // cube camera renders one scene six times, and it holds the raw dome.
  const scene = renderer.calls.scenes[0];
  assert.ok(scene && scene !== null, 'nothing was rendered into the cube');
  const raw = scene.children[0];
  assert.equal(raw.name, 'sky-reflection-dome');

  // Both domes share the ramp; only the visible one wears the grade. A cube
  // that had already been through AgX would come back through the water's own
  // tone curve a second time, and the sun's reflection would arrive flat.
  assert.ok(raw.material.fragmentShader.includes(skyGradientChunk));
  assert.ok(!raw.material.fragmentShader.includes('agxToneMap'),
    'the reflected sky is graded, and will be graded again by the sea');
  assert.ok(!raw.material.fragmentShader.includes('colorspace_fragment'),
    'the reflected sky is display-encoded, and the sea works in linear');
  assert.ok(sky.mesh.material.fragmentShader.includes('agxToneMap'),
    'guard: the visible dome is graded');

  // One uniform object between them, so they can never disagree on the weather.
  assert.equal(raw.material.uniforms, sky.mesh.material.uniforms);

  // Six renders, one target bind per face, plus the restore at the end.
  assert.equal(renderer.calls.render, 6);
  assert.ok(renderer.calls.setRenderTarget >= 7);
});

test('half-float targets are used where the driver has them, bytes where not', () => {
  const plain = createSky({ lighting: STORM });
  plain.updateReflection(stubRenderer(false));
  assert.equal(plain.reflection.type, THREE.UnsignedByteType);

  const floating = createSky({ lighting: STORM });
  floating.updateReflection(stubRenderer(true));
  assert.equal(floating.reflection.type, THREE.HalfFloatType,
    'the sun lobes would clip out of an eight-bit cube');
});

test('a sky asked for no reflection builds none', () => {
  const sky = createSky({ lighting: STORM, reflectionSize: 0 });
  const renderer = stubRenderer();

  assert.equal(sky.updateReflection(renderer), null);
  assert.equal(sky.reflection, null);
  assert.equal(renderer.calls.render, 0);
  assert.doesNotThrow(() => sky.dispose());
});

test('dispose lets go of the cube, and disposing twice is safe', () => {
  const sky = createSky({ lighting: STORM });
  sky.updateReflection(stubRenderer());
  assert.ok(sky.reflection);

  sky.dispose();
  assert.equal(sky.reflection, null);
  assert.doesNotThrow(() => sky.dispose());
});
