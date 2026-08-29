// Water on the glass, without a browser.
//
// The lens is a pool of ten beads stepped on the CPU and an instanced quad that
// needs no GL context until something tries to render it — so everything that
// matters is testable here: that the pool is a pool and cannot be made to
// overflow however hard it is hit, that a bead clings before it runs, that it
// clears inside the two and a half seconds it promises, and that `enabled:
// false` builds no GPU object at all.
//
// The one thing node cannot see is what it looks like, and that is the one
// thing that matters most. These tests defend the budget; the helm judges the
// look.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { createLens } from '../src/render/lens.js';

/** One frame of the demo's tick. */
function run(lens, seconds, dt = 1 / 60, wind = null) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) lens.update(dt, wind);
  return lens.stats;
}

/** The instance attributes, whatever the pool has done to them. */
const beads = (lens) => lens.object3d.children[0].geometry.attributes;

// --- Building without a browser ------------------------------------------------

test('the lens builds, steps and disposes with no renderer anywhere', () => {
  const lens = createLens();

  assert.equal(lens.enabled, true);
  assert.equal(lens.object3d.name, 'lens');
  assert.equal(lens.object3d.children.length, 1);

  const mesh = lens.object3d.children[0];
  assert.equal(mesh.frustumCulled, false, 'a lens that can be culled');
  assert.equal(mesh.material.depthTest, false, 'the world would occlude the glass');
  assert.equal(mesh.material.depthWrite, false);
  assert.equal(mesh.material.transparent, true);
  assert.ok(mesh.renderOrder > 100, 'the beads would draw under the rain');

  assert.doesNotThrow(() => {
    lens.update(1 / 60);
    lens.update(0);
    lens.update(-1);
    lens.notifySpray();
    lens.setWeather({});
    lens.dispose();
  });
});

test('a lens that is switched off builds nothing at all', () => {
  const lens = createLens({ enabled: false });

  assert.equal(lens.enabled, false);
  assert.equal(lens.object3d.children.length, 0, 'an off lens still made a mesh');

  // Every method must survive being called anyway, so a caller need not test.
  assert.doesNotThrow(() => {
    lens.notifySpray(1);
    lens.update(1 / 60, { x: 1, y: 0 });
    lens.setWeather({ rain: 1 });
    lens.dispose();
  });
  assert.equal(lens.stats.alive, 0);
});

test('the aspect ratio comes out of the projection matrix, not a resize handler', () => {
  const lens = createLens();
  const vert = lens.object3d.children[0].material.vertexShader;

  // The one number the vertex stage reads from three.js. Without it a bead is
  // an oval on every screen that is not square.
  assert.ok(vert.includes('projectionMatrix[1][1] / projectionMatrix[0][0]'));
  // And nothing else: the pool already knows where it is on the screen.
  assert.ok(!vert.includes('modelViewMatrix'), 'the lens is reading a transform');
  assert.ok(!vert.includes('viewMatrix'), 'the lens is reading a transform');
});

// --- The pool -------------------------------------------------------------------

test('a burst puts beads on the glass, and they clear inside two and a half seconds', () => {
  const lens = createLens({ seed: 7 });

  assert.equal(lens.update(1 / 60).alive, 0, 'the glass did not start dry');

  lens.notifySpray(1);
  run(lens, 0.2);
  assert.ok(lens.stats.alive >= 3, `a face-full put only ${lens.stats.alive} beads on`);

  run(lens, 2.6);
  assert.equal(lens.stats.alive, 0, 'the glass never cleared');
  assert.equal(lens.object3d.children[0].visible, false, 'a dry lens is still drawn');
});

test('a bigger hit puts on more water than a fleck', () => {
  const fleck = createLens({ seed: 7 });
  fleck.notifySpray(0);
  fleck.update(1 / 60);

  const face = createLens({ seed: 7 });
  face.notifySpray(1);
  face.update(1 / 60);

  assert.ok(
    face.stats.alive > fleck.stats.alive,
    `a face-full (${face.stats.alive}) is no wetter than a fleck (${fleck.stats.alive})`
  );
  assert.ok(fleck.stats.alive >= 1, 'a fleck left nothing at all');
});

test('the pool is a ceiling: nothing can make it overflow', () => {
  const lens = createLens({ pool: 10 });

  // A caller with no rate limit of its own, calling every frame for ten
  // seconds, at full strength. The glass must be wet and must not be a wall.
  for (let i = 0; i < 600; i++) {
    lens.notifySpray(1);
    lens.update(1 / 60);
    assert.ok(lens.stats.alive <= 10, `${lens.stats.alive} beads out of a pool of ten`);
  }

  const a = beads(lens);
  assert.equal(a.iPos.count, 10);
  assert.equal(lens.object3d.children[0].geometry.instanceCount, 10);
});

test('bursts inside a quarter of a second are one burst', () => {
  const lens = createLens({ pool: 10, seed: 3 });

  const first = lens.notifySpray(0.2);
  const second = lens.notifySpray(1);
  assert.ok(first > 0);
  assert.equal(second, 0, 'a second burst landed in the same instant');

  run(lens, 0.3);
  assert.ok(lens.notifySpray(1) > 0, 'the guard never let go');
});

// --- How a bead behaves ---------------------------------------------------------

test('a bead clings before it runs', () => {
  const lens = createLens({ seed: 11 });
  lens.notifySpray(1);
  lens.update(1 / 60);

  const start = Array.from(beads(lens).iPos.array);
  // Well inside the shortest hold.
  run(lens, 0.1);
  assert.deepEqual(Array.from(beads(lens).iPos.array), start, 'it slid straight away');

  // And well past the longest.
  run(lens, 0.9);
  assert.notDeepEqual(Array.from(beads(lens).iPos.array), start, 'it never let go');
});

test('a bead runs down the glass, and the wind takes it across', () => {
  const still = createLens({ seed: 5 });
  still.notifySpray(1);
  still.update(1 / 60);
  const born = Array.from(beads(still).iPos.array);
  run(still, 1.0);

  const blown = createLens({ seed: 5 });
  blown.notifySpray(1);
  run(blown, 1.0 + 1 / 60, 1 / 60, { x: 1, y: 0 });

  const y = (lens) => beads(lens).iPos.array[1];
  const x = (lens) => beads(lens).iPos.array[0];

  // A creep, not a fall: water on glass is nearly all friction, and the whole
  // travel of a bead over its life is a fifth of the frame.
  assert.ok(y(still) < born[1] - 0.02, 'nothing ran downscreen');
  assert.ok(y(still) > born[1] - 0.4, 'it fell rather than crept');

  assert.ok(x(blown) > x(still) + 0.02, 'a gale across the lens moved nothing sideways');
  // The shear is a shear, not a substitute for gravity.
  assert.ok(y(blown) < born[1], 'the wind lifted the water off the glass');
});

test('every bead stays finite, and on the glass, over five minutes of squall', () => {
  const lens = createLens({ seed: 99 });
  lens.setWeather({ rain: 1 });

  const wind = { x: 0, y: 0 };
  for (let i = 0; i < 18000; i++) {
    // A camera swinging about, so the shear reverses under the beads.
    wind.x = Math.cos(i * 0.01);
    wind.y = Math.sin(i * 0.01) * 0.3;
    lens.update(1 / 60, wind);
    if (i % 300 === 0) lens.notifySpray(1);
  }

  const a = beads(lens);
  for (const [name, attr] of Object.entries(a)) {
    for (const v of attr.array) {
      assert.ok(Number.isFinite(v), `lens ${name} went non-finite`);
    }
  }
  for (const v of a.iPos.array) {
    assert.ok(v >= -1.4 && v <= 1.4, `a bead is at ${v}, off the glass and still alive`);
  }
  assert.ok(lens.stats.alive <= 10);
});

// --- Rain ------------------------------------------------------------------------

test('drizzle does not bead; a downpour trickles', () => {
  const dry = createLens({ seed: 21 });
  dry.setWeather({ rain: 0.3 });
  run(dry, 20);
  assert.equal(dry.stats.alive, 0, 'a drizzle stood on the glass');

  const wet = createLens({ seed: 21 });
  wet.setWeather({ rain: 1 });
  run(wet, 20);
  assert.ok(wet.stats.alive > 0, 'a squall left the glass dry');
  // A trickle, and never more than that: about one bead a second against a
  // life of two, so a couple at a time.
  assert.ok(wet.stats.alive <= 5, `a squall put ${wet.stats.alive} beads on at once`);
});

test('the rain is clamped, and rubbish never reaches a uniform', () => {
  const lens = createLens();
  lens.setWeather({ rain: 40 });
  assert.equal(lens.stats.rain, 1);
  lens.setWeather({ rain: -3 });
  assert.equal(lens.stats.rain, 0);
  lens.setWeather({ rain: NaN });
  assert.equal(lens.stats.rain, 0);

  assert.doesNotThrow(() => lens.notifySpray(NaN));
  for (const v of beads(lens).iPos.array) assert.ok(Number.isFinite(v));
});

// --- Determinism ------------------------------------------------------------------

test('the same seed wets the glass the same way', () => {
  const a = createLens({ seed: 808 });
  const b = createLens({ seed: 808 });
  for (const lens of [a, b]) {
    lens.notifySpray(0.8);
    run(lens, 1.2, 1 / 60, { x: 0.4, y: -0.9 });
  }
  assert.deepEqual(
    Array.from(beads(a).iPos.array),
    Array.from(beads(b).iPos.array)
  );

  const c = createLens({ seed: 809 });
  c.notifySpray(0.8);
  run(c, 1.2, 1 / 60, { x: 0.4, y: -0.9 });
  assert.notDeepEqual(
    Array.from(beads(a).iPos.array),
    Array.from(beads(c).iPos.array)
  );
});

test('dispose empties the group', () => {
  const lens = createLens();
  assert.equal(lens.object3d.children.length, 1);
  lens.dispose();
  assert.equal(lens.object3d.children.length, 0);
});

test('the lens is a garnish: the opacity ceiling is low and settable', () => {
  const lens = createLens();
  assert.ok(lens.uniforms.uOpacity.value <= 0.6, 'the default lens obscures the sea');

  const loud = createLens({ opacity: 4 });
  assert.equal(loud.uniforms.uOpacity.value, 1, 'the ceiling is not a ceiling');

  // And the colours a caller may hand it, in either notation.
  const tinted = createLens({ colour: '#112233', core: 0x445566 });
  assert.equal(tinted.uniforms.uColour.value.getHexString(), '112233');
  assert.equal(tinted.uniforms.uCore.value.getHexString(), '445566');
});

test('a lens attached to a camera is drawn wherever the camera is', () => {
  // The contract in the header: the vertex stage writes clip space, so the
  // parent transform never reaches the geometry. This is the property that lets
  // it hang off the camera at all.
  const lens = createLens();
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.4, 26000);
  camera.add(lens.object3d);
  camera.position.set(1200, 40, -800);
  camera.updateMatrixWorld(true);

  lens.notifySpray(1);
  lens.update(1 / 60);

  assert.equal(lens.object3d.parent, camera);
  for (const v of beads(lens).iPos.array) {
    assert.ok(v >= -1.4 && v <= 1.4, 'the camera position leaked into the glass');
  }
});
