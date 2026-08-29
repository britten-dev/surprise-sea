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

// --- The deck pass ---------------------------------------------------------------
//
// Every spawn candidate the system tries is one `crestAt` query, so wrapping
// `crestAt` gives the spawn distribution exactly — asked-for, before the sea has
// had its say about whether there is any water there. That is the right thing
// to measure: the corridor decides *where the system looks*, and the crest test
// that follows is untouched, which is the whole claim being made.

/** Histogram the horizontal range of every spawn candidate from the eye. */
function spawnRanges(preset, altitude, frames = 600, options = {}) {
  const sea = createSeaState({ preset });
  const field = new WaveField(sea, 40000);
  const eye = new Vector3(0, altitude, 0);
  const inside = [0, 0];   // within 15 m, within 40 m
  let total = 0;

  const real = sea.crestAt.bind(sea);
  sea.crestAt = (x, z, t) => {
    const r = Math.hypot(x - eye.x, z - eye.z);
    total++;
    if (r < 15) inside[0]++;
    if (r < 40) inside[1]++;
    return real(x, z, t);
  };

  const spray = createSpray(field, { budget: POOL, seed: 4242, ...options });
  for (let i = 0; i < frames; i++) {
    field.advance(1 / 60);
    spray.update(1 / 60, eye);
  }
  return { near: inside[0] / total, mid: inside[1] / total, total, spray };
}

test('a low eye in a strong wind is spawned around, not merely near', () => {
  const deck = spawnRanges('storm', 6);
  const aloft = spawnRanges('storm', 60);

  // Both windows are centred on the eye, so some near candidates are expected
  // either way. The corridor has to be an order of magnitude, not a nudge.
  assert.ok(
    deck.near > aloft.near * 3,
    `deck ${(deck.near * 100).toFixed(1)}% within 15 m against ${(aloft.near * 100).toFixed(1)}% aloft`
  );
  assert.ok(deck.near > 0.06, `only ${(deck.near * 100).toFixed(1)}% of spawns are close aboard`);
  assert.ok(deck.mid > aloft.mid * 2);
});

test('the corridor redistributes the budget and never inflates it', () => {
  // The pools, the attempt rate and the thresholds are untouched, so the number
  // of candidates tried and the number of particles alive must both be within
  // the noise of a camera that is out of the corridor's reach entirely.
  const deck = spawnRanges('greybeards', 6);
  const aloft = spawnRanges('greybeards', 60);

  const attempts = deck.total / aloft.total;
  assert.ok(attempts > 0.9 && attempts < 1.1, `deck tried ${attempts.toFixed(2)}× the candidates`);

  for (const cls of ['spume', 'droplets']) {
    const ratio = deck.spray.stats[cls] / aloft.spray.stats[cls];
    assert.ok(
      ratio > 0.85 && ratio < 1.15,
      `${cls}: ${deck.spray.stats[cls]} alive at the deck against ${aloft.spray.stats[cls]} aloft`
    );
  }
});

test('the pass fades out with height and is gone by the time a bird is flying', () => {
  const near = [6, 12, 18, 30].map((alt) => spawnRanges('greybeards', alt, 300).near);
  for (let i = 1; i < near.length; i++) {
    assert.ok(
      near[i] < near[i - 1],
      `the corridor did not close with height: ${near.map((n) => n.toFixed(3))}`
    );
  }
  // Two hundred metres up is the albatross game, and it must see none of this.
  const bird = spawnRanges('greybeards', 200, 300).near;
  assert.ok(bird < near[0] * 0.2, `a bird at 200 m still gets ${(bird * 100).toFixed(1)}% close spawns`);
});

test('a calm sea pays nothing for a corridor it would never fill', () => {
  // The gate is the wind, not the swell: below Force 6 there is nothing to
  // carry water past a face, however big the sea has got.
  assert.equal(sprayProfile(createSeaState({ preset: 'calm' })).deckWind, 0);
  assert.equal(sprayProfile(createSeaState({ preset: 'breeze' })).deckWind, 0);
  assert.equal(sprayProfile(createSeaState({ preset: 'gale' })).deckWind, 1);
  assert.equal(sprayProfile(createSeaState({ preset: 'storm' })).deckWind, 1);

  // And with the gate shut the arithmetic is the arithmetic that shipped: the
  // corridor draws no random number, so the whole stream is untouched.
  const low = rig('breeze', { seed: 606 });
  const eye = new Vector3(0, 4, 0);
  run(low.field, low.spray, 240, 1 / 60, eye);

  const high = rig('breeze', { seed: 606 });
  run(high.field, high.spray, 240, 1 / 60, eye);

  assert.deepEqual(buffers(low.spray), buffers(high.spray));
});

// --- Water in the face -----------------------------------------------------------

test('thrown water that passes the eye is reported, at most once a second', () => {
  const hits = [];
  const { field, spray } = rig('greybeards', {
    seed: 4242,
    onCameraHit: (s) => hits.push({ t: field.time, s }),
  });

  const eye = new Vector3(0, 0, 0);
  for (let i = 0; i < 3600; i++) {
    field.advance(1 / 60);
    // A helmsman's eye, riding the water rather than pinned above mean level.
    eye.y = field.sea.roughHeightAt(0, 0, field.time) + 6;
    spray.update(1 / 60, eye);
  }

  assert.ok(hits.length > 0, 'a minute in a survival sea and nothing hit the helm');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(
      hits[i].t - hits[i - 1].t >= 0.99,
      `two face-fulls ${(hits[i].t - hits[i - 1].t).toFixed(2)} s apart`
    );
  }
  for (const h of hits) {
    assert.ok(h.s > 0 && h.s <= 1, `strength ${h.s} is not a strength`);
    assert.ok(h.s >= 0.25, 'even a fleck is worth a quarter of a face-full');
  }
});

test('the callback is deterministic, settable, and free when nobody listens', () => {
  const seen = [[], []];
  const rigs = [rig('greybeards', { seed: 31 }), rig('greybeards', { seed: 31 })];

  // One takes it as an option's worth of callback after the fact, the other was
  // given nothing and has it assigned — the two must not differ.
  rigs[0].spray.onCameraHit = (s) => seen[0].push(s);
  rigs[1].spray.onCameraHit = (s) => seen[1].push(s);

  for (const [n, { field, spray }] of rigs.entries()) {
    const eye = new Vector3(0, 0, 0);
    for (let i = 0; i < 1800; i++) {
      field.advance(1 / 60);
      eye.y = field.sea.roughHeightAt(0, 0, field.time) + 6;
      spray.update(1 / 60, eye);
      // Take the ear away halfway through the second run and put it back: the
      // particles must not care whether anyone was listening.
      if (n === 1 && i === 900) spray.onCameraHit = null;
      if (n === 1 && i === 901) spray.onCameraHit = (s) => seen[1].push(s);
    }
  }

  assert.deepEqual(buffers(rigs[0].spray), buffers(rigs[1].spray),
    'listening changed the water');
  assert.ok(seen[0].length > 0);

  // Anything that is not a function is nobody, and stepping must still be safe.
  assert.doesNotThrow(() => {
    rigs[0].spray.onCameraHit = 'not a function';
    assert.equal(rigs[0].spray.onCameraHit, null);
    rigs[0].field.advance(1 / 60);
    rigs[0].spray.update(1 / 60, new Vector3(0, 6, 0));
  });
});

test('an albatross at altitude is never rained on by its own spray', () => {
  let hits = 0;
  const { field, spray } = rig('greybeards', { onCameraHit: () => hits++ });

  const eye = new Vector3(0, 0, 0);
  for (let i = 0; i < 1800; i++) {
    field.advance(1 / 60);
    eye.y = field.sea.roughHeightAt(0, 0, field.time) + 200;
    spray.update(1 / 60, eye);
  }
  assert.equal(hits, 0, 'a bird two hundred metres up was hit in the face');
});
