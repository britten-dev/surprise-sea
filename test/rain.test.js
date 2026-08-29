// Rain, without a browser.
//
// Nothing here draws: both layers are typed arrays stepped on the CPU, and an
// instanced mesh needs no GL context until something tries to render it. So the
// parts worth testing are testable exactly as the physics half is — that the
// pool is bounded and finite for ever, that nought really does cost nothing,
// that drops die on the water rather than through it, and that the seeded
// stream repeats.
//
// The amendment exempts frame-history effects from strict determinism. The
// determinism tests are here anyway: a repeatable pool is far easier to reason
// about than a random one, and it costs nothing to keep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createRain } from '../src/render/rain.js';

/** Small pools: these tests are about the arithmetic, not the budget. */
const POOL = { streaks: 80, curtains: 4 };

/** A helmsman's eye height over a sea whose mean is nought. */
const EYE = new Vector3(0, 6, 0);

/**
 * A lighting object of the shape `createOcean` takes, stubbed down to the four
 * keys the rain actually reads. Passing one proves the module tolerates a
 * partial palette, which is what every consumer will hand it.
 */
const LIGHTING = {
  skyHaze: 0xa6abab,
  sunColour: 0xdfe2de,
  glare: 0.3,
  water: { foam: 0xdfe4e4 },
};

function rig(preset, options = {}) {
  const sea = createSeaState({ preset });
  const field = new WaveField(sea, 40000);
  const rain = createRain(field, { budget: POOL, lighting: LIGHTING, ...options });
  return { sea, field, rain };
}

/** One frame of the demo's step path: advance the sea, then the rain. */
function run(field, rain, frames, dt = 1 / 60, eye = EYE) {
  for (let i = 0; i < frames; i++) {
    field.advance(dt);
    rain.update(dt, eye);
  }
}

/** Every instance buffer in the system, layer by layer. */
const buffers = (rain) =>
  rain.object3d.children.map((child) =>
    Object.entries(child.geometry.attributes)
      .filter(([name]) => name !== 'position')
      .map(([name, attr]) => [name, Array.from(attr.array)])
  );

const layers = (rain) =>
  Object.fromEntries(rain.object3d.children.map((c) => [c.name, c]));

// --- Nought costs nothing ------------------------------------------------------

test('dry weather moves nothing and draws nothing', () => {
  const { field, rain } = rig('storm');
  const before = buffers(rain);

  run(field, rain, 300);

  assert.equal(rain.object3d.visible, false, 'a dry sky is still being drawn');
  for (const child of rain.object3d.children) {
    assert.equal(child.geometry.instanceCount, 0, `${child.name} still has instances`);
  }
  assert.deepEqual(buffers(rain), before, 'a dry sky moved a particle');
  assert.deepEqual(rain.stats, { rain: 0, streaks: 0, curtains: 0 });
});

test('the weather comes on and goes off again', () => {
  const { field, rain } = rig('storm');

  rain.setWeather({ rain: 0.8 });
  run(field, rain, 120);
  assert.equal(rain.object3d.visible, true);
  assert.ok(rain.stats.streaks > 0, 'a squall threw no water at all');
  assert.ok(rain.stats.curtains > 0, 'a squall hung no curtains');

  rain.setWeather({ rain: 0 });
  assert.equal(rain.object3d.visible, false);
  for (const child of rain.object3d.children) {
    assert.equal(child.geometry.instanceCount, 0);
  }

  // And nothing steps once it is off.
  const still = buffers(rain);
  run(field, rain, 60);
  assert.deepEqual(buffers(rain), still);
});

test('the streak population scales with the rain value', () => {
  const drawn = (r) => {
    const { field, rain } = rig('gale');
    rain.setWeather({ rain: r });
    run(field, rain, 60);
    return layers(rain)['rain-streaks'].geometry.instanceCount;
  };

  const light = drawn(0.25);
  const hard = drawn(1);
  assert.ok(hard > light * 2, `quarter rain draws ${light}, full rain ${hard}`);
  assert.ok(hard <= POOL.streaks, 'the pool overflowed its budget');
});

test('a curtain count stays in the three-to-six band the amendment asks for', () => {
  // The pool here is four, so the band is clipped to it; what matters is that a
  // drizzle hangs fewer than a squall and neither exceeds the budget.
  const { field, rain } = rig('gale');
  const counted = [];
  for (const r of [0.2, 0.6, 1]) {
    rain.setWeather({ rain: r });
    run(field, rain, 30);
    counted.push(layers(rain)['rain-curtains'].geometry.instanceCount);
  }
  assert.ok(counted[0] <= counted[1] && counted[1] <= counted[2], counted.join(', '));
  assert.ok(counted[2] <= POOL.curtains, 'more curtains than the budget');
  assert.ok(counted[0] >= 1, 'a drizzle hung no curtain at all');
});

// --- Determinism ---------------------------------------------------------------

test('the same seed makes the same rain', () => {
  const a = rig('storm', { seed: 3131, rain: 0.7 });
  const b = rig('storm', { seed: 3131, rain: 0.7 });
  run(a.field, a.rain, 240);
  run(b.field, b.rain, 240);

  assert.deepEqual(a.rain.stats, b.rain.stats);
  assert.deepEqual(buffers(a.rain), buffers(b.rain));
});

test('a different seed makes a different rain', () => {
  const a = rig('storm', { seed: 3131, rain: 0.7 });
  const b = rig('storm', { seed: 3132, rain: 0.7 });
  run(a.field, a.rain, 240);
  run(b.field, b.rain, 240);

  assert.notDeepEqual(buffers(a.rain), buffers(b.rain));
});

// --- Nothing ever goes bad ------------------------------------------------------

test('no drop goes non-finite over five minutes of every preset', () => {
  for (const preset of ['calm', 'breeze', 'gale', 'storm', 'greybeards']) {
    const { field, rain } = rig(preset, { rain: 1 });

    // The same span at a coarse step exercises the same arithmetic, and a long
    // step — every drop crossing the whole box between frames — is the harder
    // case anyway.
    const eye = new Vector3(0, 6, 0);
    for (let i = 0; i < 1800; i++) {
      field.advance(1 / 6);
      rain.update(1 / 6, eye);
      // Walk the eye about, so the box keeps re-centring and drops are left
      // behind rather than living for ever in one patch of sea.
      eye.x += 1.4;
      eye.z -= 0.9;
      eye.y = 6 + Math.sin(i * 0.03) * 9;
    }

    for (const child of rain.object3d.children) {
      for (const [name, attr] of Object.entries(child.geometry.attributes)) {
        for (const v of attr.array) {
          assert.ok(Number.isFinite(v), `${preset}: ${child.name}.${name} went non-finite`);
        }
      }
    }
  }
});

test('the eye can be walked a mile between frames and the box follows', () => {
  // The workbench walks the whole ship back to the middle of the ocean when she
  // sails out of the field. Every drop is then a mile outside its box at once,
  // and the wrap has to bring the lot back in one step.
  const { field, rain } = rig('storm', { rain: 1 });
  const eye = new Vector3(0, 6, 0);
  run(field, rain, 120, 1 / 60, eye);

  eye.set(9000, 6, -7000);
  field.advance(1 / 60);
  rain.update(1 / 60, eye);

  const streaks = layers(rain)['rain-streaks'];
  const pos = streaks.geometry.attributes.iPos.array;
  for (let i = 0; i < streaks.geometry.instanceCount; i++) {
    const dx = pos[i * 3] - eye.x;
    const dy = pos[i * 3 + 1] - eye.y;
    const dz = pos[i * 3 + 2] - eye.z;
    assert.ok(
      Math.hypot(dx, dz) < 40,
      `a drop was left ${Math.hypot(dx, dz).toFixed(0)} m astern of the eye`
    );
    assert.ok(Math.abs(dy) < 30, `a drop was left ${dy.toFixed(0)} m above the eye`);
  }
});

test('the rain follows the eye up and down as well as along', () => {
  // The helm rises and falls seventeen metres in a survival sea, and a slot
  // that has been idle while the weather was light must not come back stranded
  // in the air above the box.
  const { field, rain } = rig('greybeards');
  const eye = new Vector3(0, 6, 0);

  rain.setWeather({ rain: 0.15 });
  run(field, rain, 200, 1 / 60, eye);
  eye.y = 80;
  rain.setWeather({ rain: 1 });
  field.advance(1 / 60);
  rain.update(1 / 60, eye);

  const streaks = layers(rain)['rain-streaks'];
  const pos = streaks.geometry.attributes.iPos.array;
  for (let i = 0; i < streaks.geometry.instanceCount; i++) {
    assert.ok(
      Math.abs(pos[i * 3 + 1] - eye.y) < 30,
      `a drop sat ${(pos[i * 3 + 1] - eye.y).toFixed(0)} m from the eye`
    );
  }
});

test('every live drop is above the water it is about to die on', () => {
  const { field, rain, sea } = rig('greybeards', { rain: 1 });
  const eye = new Vector3(0, 8, 0);
  run(field, rain, 400, 1 / 60, eye);

  const streaks = layers(rain)['rain-streaks'];
  const pos = streaks.geometry.attributes.iPos.array;
  const t = field.time;

  for (let i = 0; i < streaks.geometry.instanceCount; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    assert.ok(
      y >= sea.roughHeightAt(x, z, t) - 1e-6,
      `a drop is ${(sea.roughHeightAt(x, z, t) - y).toFixed(2)} m under the sea`
    );
  }
});

test('the curtains stay in the middle distance', () => {
  const { field, rain } = rig('storm', { rain: 1 });
  const eye = new Vector3(0, 6, 0);
  run(field, rain, 900, 1 / 6, eye);

  const curtains = layers(rain)['rain-curtains'];
  const pos = curtains.geometry.attributes.iPos.array;
  for (let i = 0; i < curtains.geometry.instanceCount; i++) {
    const r = Math.hypot(pos[i * 3] - eye.x, pos[i * 3 + 2] - eye.z);
    // Never close enough to be a wall across the lens, never so far off that it
    // has walked out of the fog it was drawn for.
    assert.ok(r > 400 && r <= 3500, `a curtain stood ${r.toFixed(0)} m off`);
  }
});

// --- Living with the rest of the library ----------------------------------------

test('a live change of sea state leans the rain the other way', () => {
  const { field, rain } = rig('greybeards', { rain: 1 });
  run(field, rain, 60);
  const gale = rain.uniforms.streaks.uLength.value;

  const calm = createSeaState({ preset: 'calm' });
  field.setSeaState(calm);
  rain.setSeaState(calm);
  run(field, rain, 60);

  // A survival wind pours the rain sideways and draws long streaks; a millpond
  // drops it straight down and draws short ones.
  assert.ok(
    rain.uniforms.streaks.uLength.value < gale * 0.6,
    `streaks stayed ${rain.uniforms.streaks.uLength.value.toFixed(3)} long in a calm`
  );
  assert.ok(rain.uniforms.streaks.uFall.value.y < 0, 'the rain stopped falling');
});

test('a partial lighting object leaves the rest of the palette alone', () => {
  const { rain } = rig('storm', { rain: 0.5 });
  const before = rain.uniforms.curtains.uColour.value.clone();

  rain.setLighting({ glare: 1 });
  assert.deepEqual(
    rain.uniforms.curtains.uColour.value.toArray(),
    before.toArray(),
    'a glare change repainted the curtains'
  );

  rain.setLighting({ skyHaze: 0x223344 });
  assert.notDeepEqual(rain.uniforms.curtains.uColour.value.toArray(), before.toArray());
  for (const v of rain.uniforms.streaks.uColour.value.toArray()) {
    assert.ok(Number.isFinite(v));
  }
});

test('rain with no camera and no time still steps', () => {
  const { field, rain } = rig('storm', { rain: 1 });
  assert.doesNotThrow(() => {
    field.advance(1 / 60);
    rain.update(1 / 60, undefined);
    rain.update(0, EYE);
    rain.update(-1, EYE);
  });
});

test('dispose empties the group', () => {
  const { rain } = rig('storm', { rain: 1 });
  assert.equal(rain.object3d.children.length, 2);
  rain.dispose();
  assert.equal(rain.object3d.children.length, 0);
});
