// Spray, without a browser.
//
// Nothing here draws anything: the three particle classes are plain typed
// arrays stepped on the CPU, and a THREE.Points needs no GL context until
// something tries to render it. So the parts worth testing — the sea-relative
// thresholds, the seeded spawn stream, and the arithmetic staying finite over a
// long run — are all testable exactly as the physics half is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createSpray, sprayProfile } from '../src/render/spray.js';

/** Small pools: these tests are about the arithmetic, not the budget. */
const POOL = { spume: 120, droplets: 80, sheets: 8 };

/** Low enough that every altitude gate is wide open. */
const EYE = new Vector3(0, 9, 0);

function rig(preset, options = {}) {
  const sea = createSeaState({ preset });
  const field = new WaveField(sea, 40000);
  const spray = createSpray(field, { budget: POOL, ...options });
  return { sea, field, spray };
}

/** One frame of the demo's step path: advance the sea, then the spray. */
function run(field, spray, frames, dt = 1 / 60, eye = EYE) {
  for (let i = 0; i < frames; i++) {
    field.advance(dt);
    spray.update(dt, eye);
  }
}

/**
 * Every particle position in the system. The sheets are instanced, so their
 * `position` attribute is the static unit quad and the thing that actually
 * moves is `iPos` — take that first, or this compares four corners that never
 * change and proves nothing.
 */
const buffers = (spray) =>
  spray.object3d.children.map((child) => {
    const a = child.geometry.attributes;
    return Array.from((a.iPos ?? a.position).array);
  });

// --- The sea-relative threshold ----------------------------------------------

test('the storm preset reproduces the game\'s proven absolute threshold', () => {
  // The albatross game spawns spume at `crestAt > 0.3`, tuned by eye on this
  // sea. That absolute is 1.8 standard deviations of the storm's crest pinch,
  // which is the whole justification for expressing it in sigmas instead.
  const p = sprayProfile(createSeaState({ preset: 'storm' }));
  assert.ok(
    Math.abs(p.crestSigma - 0.3 / 1.8) < 0.01,
    `storm crest sigma ${p.crestSigma.toFixed(4)}, want ${(0.3 / 1.8).toFixed(4)}`
  );
  assert.ok(
    Math.abs(p.spumeThreshold - 0.3) < 0.02,
    `storm spume threshold ${p.spumeThreshold.toFixed(4)}, want 0.30`
  );
});

test('the threshold slides down in sigmas as the sea builds', () => {
  const sigmas = ['calm', 'breeze', 'gale', 'storm', 'greybeards'].map((preset) => {
    const p = sprayProfile(createSeaState({ preset }));
    return p.spumeThreshold / p.crestSigma;
  });

  for (let i = 1; i < sigmas.length; i++) {
    assert.ok(
      sigmas[i] < sigmas[i - 1],
      `thresholds not monotonic in sigmas: ${sigmas.map((s) => s.toFixed(2))}`
    );
  }
  // A glassy heave must be effectively unreachable; a survival sea must not be.
  assert.ok(sigmas[0] > 3.5, `calm at ${sigmas[0].toFixed(2)} sigma is too easy`);
  assert.ok(sigmas[4] < 1.6, `greybeards at ${sigmas[4].toFixed(2)} sigma is too hard`);
});

test('droplets need a harder break than spume, and sheets harder still', () => {
  for (const preset of ['gale', 'storm', 'greybeards']) {
    const p = sprayProfile(createSeaState({ preset }));
    assert.ok(p.dropletThreshold > p.spumeThreshold, preset);
    assert.ok(p.sheetThreshold > p.dropletThreshold, preset);
  }
});

test('sheets peel off only above Force 9', () => {
  for (const preset of ['calm', 'breeze', 'gale']) {
    assert.equal(sprayProfile(createSeaState({ preset })).sheetChance, 0, preset);
  }
  const storm = sprayProfile(createSeaState({ preset: 'storm' })).sheetChance;
  const grey = sprayProfile(createSeaState({ preset: 'greybeards' })).sheetChance;
  assert.ok(storm > 0 && storm < grey, `storm ${storm}, greybeards ${grey}`);
});

test('a calm sea throws almost nothing into the air, a survival sea streams', () => {
  const calm = rig('calm');
  run(calm.field, calm.spray, 600);

  const grey = rig('greybeards');
  run(grey.field, grey.spray, 600);

  assert.ok(
    grey.spray.stats.spume > POOL.spume * 0.5,
    `greybeards holds only ${grey.spray.stats.spume} of ${POOL.spume} spume alive`
  );
  assert.ok(
    calm.spray.stats.spume < grey.spray.stats.spume * 0.05,
    `calm holds ${calm.spray.stats.spume} spume against greybeards' ${grey.spray.stats.spume}`
  );
  assert.equal(calm.spray.stats.sheets, 0, 'a millpond has no spindrift');
});

// --- Determinism --------------------------------------------------------------

test('the same seed spawns the same spray', () => {
  const a = rig('storm', { seed: 4242 });
  const b = rig('storm', { seed: 4242 });
  run(a.field, a.spray, 240);
  run(b.field, b.spray, 240);

  assert.deepEqual(a.spray.stats, b.spray.stats);
  assert.deepEqual(buffers(a.spray), buffers(b.spray));
});

test('a different seed spawns a different spray', () => {
  const a = rig('storm', { seed: 4242 });
  const b = rig('storm', { seed: 4243 });
  run(a.field, a.spray, 240);
  run(b.field, b.spray, 240);

  assert.notDeepEqual(buffers(a.spray), buffers(b.spray));
});

test('the population does not depend on the frame rate', () => {
  // The game's version tried one spawn per dead particle per frame, so a
  // thirty-hertz machine got half the spray. This one carries the fraction.
  const fast = rig('storm', { seed: 11 });
  run(fast.field, fast.spray, 600, 1 / 60);

  const slow = rig('storm', { seed: 11 });
  run(slow.field, slow.spray, 300, 1 / 30);

  const ratio = slow.spray.stats.spume / fast.spray.stats.spume;
  assert.ok(
    ratio > 0.8 && ratio < 1.25,
    `thirty hertz holds ${slow.spray.stats.spume} against sixty's ${fast.spray.stats.spume}`
  );
});

// --- Nothing ever goes bad ----------------------------------------------------

test('no particle goes non-finite over five minutes of every preset', () => {
  for (const preset of ['calm', 'breeze', 'gale', 'storm', 'greybeards']) {
    const { field, spray, sea } = rig(preset);

    // Five minutes at sixty hertz would be slow to run; the same span at a
    // coarse step exercises the same arithmetic, and a long step — every
    // particle jumping a third of a wavelength between frames — is the harder
    // case anyway.
    const eye = new Vector3(0, 14, 0);
    for (let i = 0; i < 1800; i++) {
      field.advance(1 / 6);
      spray.update(1 / 6, eye);
      // Walk the eye about, so the spawn window keeps moving and particles are
      // left behind rather than living for ever in one patch of sea.
      eye.x += 1.4;
      eye.z -= 0.9;
    }

    for (const child of spray.object3d.children) {
      for (const [name, attr] of Object.entries(child.geometry.attributes)) {
        for (const v of attr.array) {
          assert.ok(
            Number.isFinite(v),
            `${preset}: ${child.name}.${name} went non-finite`
          );
        }
      }
    }

    // Nothing should be underground, or a kilometre up in the air.
    const pos = spray.object3d.children[0].geometry.attributes.position.array;
    for (let i = 1; i < pos.length; i += 3) {
      assert.ok(
        pos[i] > sea.hMin - 50 && pos[i] < sea.hMax + 200,
        `${preset}: spume at y = ${pos[i]}, outside ${sea.hMin}..${sea.hMax}`
      );
    }
  }
});

test('a live change of weather does not disturb anything already in the air', () => {
  const { field, spray } = rig('greybeards');
  run(field, spray, 300);
  const before = spray.stats.spume;

  spray.setSeaState(createSeaState({ preset: 'calm' }));
  field.setSeaState(createSeaState({ preset: 'calm' }));
  run(field, spray, 1);

  // The water already thrown is still up; it simply stops being replaced.
  assert.ok(spray.stats.spume > before * 0.9, 'the swap killed live particles');
  run(field, spray, 600);
  assert.ok(spray.stats.spume < before * 0.1, 'the calm sea kept making spume');
});

test('a spray with no camera and no wind still steps', () => {
  const { field, spray } = rig('storm');
  assert.doesNotThrow(() => {
    field.advance(1 / 60);
    spray.update(1 / 60, undefined);
    spray.update(0, EYE);
  });
});

test('dispose empties the group', () => {
  const { spray } = rig('storm');
  assert.equal(spray.object3d.children.length, 3);
  spray.dispose();
  assert.equal(spray.object3d.children.length, 0);
});
