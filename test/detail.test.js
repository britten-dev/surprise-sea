// The wavelets, and the law they are allowed to exist under.
//
// render/detail.js is the one place in this library where the CPU and the GPU
// deliberately describe different water, so it is the one place where the
// difference has to be a number rather than an intention. The review allowed a
// visual-only detail layer under a sub-30cm carve-out; this file takes half of
// that and holds the code to it — over every preset, every scale and every
// wave count, summed vertical amplitude ≤ 0.15 m and summed pinch ≤ 0.3.
//
// The rest is what makes the layer worth having: dispersion that is real
// deep-water dispersion, headings that follow the wind the spectrum follows,
// and a table that is the same table every time it is built. And the gate:
// with `normalRange` at nought not one line of any of it reaches either shader.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState, PRESETS } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createOcean } from '../src/render/ocean.js';
import {
  AMP_BUDGET,
  PINCH_BUDGET,
  DETAIL_COUNT,
  DETAIL_LONG,
  DETAIL_SHORT,
  DETAIL_NEAR,
  DETAIL_FAR,
  chopEnergy,
  detailTable,
  detailUniforms,
} from '../src/render/detail.js';

const GRAVITY = 9.81;
const NAMES = Object.keys(PRESETS);
const QUALITY = { gridN: 16, halfSpan: 400, exponent: 2.2, normalRange: 400 };

const rig = (options = {}, seaOptions = {}) => {
  const field = new WaveField(createSeaState({ preset: 'storm', ...seaOptions }), 40000);
  return { field, ocean: createOcean(field, { quality: QUALITY, ...options }) };
};

// --- The law ------------------------------------------------------------------

test('no sea state can overspend the fifteen-centimetre budget', () => {
  // Every preset, and the corners a game can reach: a scale that doubles the
  // sea, a hand-set wave count, an unfamiliar wind. The budget is a
  // normalisation rather than a clamp, so this should hold by construction —
  // which is exactly why it is worth a test that would notice if it stopped.
  for (const preset of NAMES) {
    for (const scale of [0.5, 1, 2]) {
      for (const waveCount of [4, 12, 17]) {
        const sea = createSeaState({ preset, scale, waveCount, windFromDeg: 17 });
        const table = detailTable(sea);
        const label = `${preset} ×${scale} n=${waveCount}`;

        assert.ok(
          table.ampSum <= AMP_BUDGET + 1e-12,
          `${label}: ${table.ampSum.toFixed(4)} m of wavelets, over the ${AMP_BUDGET} m budget`
        );
        assert.ok(
          table.pinchSum <= PINCH_BUDGET + 1e-12,
          `${label}: ${table.pinchSum.toFixed(4)} of pinch, over the ${PINCH_BUDGET} budget`
        );
        for (const w of table.waves) {
          assert.ok(Number.isFinite(w.amp) && w.amp > 0, `${label}: amplitude ${w.amp}`);
          assert.ok(Number.isFinite(w.q), `${label}: steepness ${w.q}`);
        }
      }
    }
  }
});

test('the budget is spent in proportion to the chop the sea has earned', () => {
  const spent = NAMES.map((preset) => detailTable(createSeaState({ preset })).ampSum);
  for (let i = 1; i < spent.length; i++) {
    assert.ok(spent[i] > spent[i - 1], `not monotonic across the presets: ${spent}`);
  }

  // A glassy heave keeps a whisper of cat's paw and nothing more; a survival
  // storm gets essentially the whole budget.
  assert.ok(spent[0] < 0.03, `calm carries ${spent[0].toFixed(3)} m of chop`);
  assert.ok(spent[spent.length - 1] > 0.9 * AMP_BUDGET, 'greybeards is not spending its budget');
  assert.ok(chopEnergy({ waves: [] }) > 0, 'a sea with no waves in it breaks the energy curve');
});

test('the physics never sees any of it', () => {
  // The proof that this layer is visual-only is a negative one, so it is worth
  // stating twice: the sea state is not touched by building a table from it,
  // and the answers it gives are identical before and after an ocean — with
  // the wavelets compiled in — has been built on top of it.
  const sea = createSeaState({ preset: 'greybeards' });
  const before = [
    sea.heightAt(12, -37, 4.5),
    sea.crestAt(12, -37, 4.5),
    sea.waves.length,
    sea.hMax,
  ];

  const field = new WaveField(sea, 40000);
  const ocean = createOcean(field, { quality: QUALITY });
  ocean.setSeaState(sea);

  assert.deepEqual(
    [sea.heightAt(12, -37, 4.5), sea.crestAt(12, -37, 4.5), sea.waves.length, sea.hMax],
    before
  );

  // And the two tables are separate objects with separate uniform names, so
  // nothing walking the physical table can reach the visual one by accident.
  const detailKeys = Object.keys(detailUniforms(ocean.detail));
  for (const key of detailKeys) {
    assert.ok(!(key in { uWaveDir: 1, uWaveK: 1, uWaveOmega: 1, uWaveAmp: 1, uWaveQ: 1 }), key);
  }
});

// --- The water it describes ---------------------------------------------------

test('the wavelets are wavelets: half a metre to ten, log-spaced', () => {
  const table = detailTable(createSeaState({ preset: 'storm' }));
  assert.equal(table.waves.length, DETAIL_COUNT);
  assert.equal(table.waves[0].length, DETAIL_LONG);
  assert.equal(table.waves[table.waves.length - 1].length, DETAIL_SHORT);

  // Log-spaced means a constant ratio between neighbours, which is what keeps
  // the band from clumping at one end and leaving a hole at the other.
  const ratios = [];
  for (let i = 1; i < table.waves.length; i++) {
    ratios.push(table.waves[i].length / table.waves[i - 1].length);
  }
  for (const r of ratios) assert.ok(Math.abs(r - ratios[0]) < 1e-9, `uneven spacing: ${ratios}`);
});

test('they travel, and each at its own speed', () => {
  // Dispersive motion is most of what tells the eye this is water rather than
  // noise sliding over a hill, so the deep-water relation is not negotiable.
  const table = detailTable(createSeaState({ preset: 'gale' }));
  const speeds = [];
  for (const w of table.waves) {
    assert.ok(
      Math.abs(w.omega - Math.sqrt(GRAVITY * w.k)) < 1e-12,
      `component at ${w.length.toFixed(2)} m is not on the dispersion curve`
    );
    speeds.push(w.omega / w.k);
  }

  // Slowest to fastest, and every one distinct: a set of components sharing a
  // speed would slide as a block, which is the failure this table exists to fix.
  for (let i = 1; i < speeds.length; i++) {
    assert.ok(speeds[i] < speeds[i - 1], `speeds not ordered by length: ${speeds}`);
  }
  assert.ok(speeds[0] / speeds[speeds.length - 1] > 3, 'the band is too narrow to disperse');
});

test('they run downwind, whatever the wind is doing', () => {
  for (const windFromDeg of [0, 97, 285, 359]) {
    const sea = createSeaState({ preset: 'storm', windFromDeg });
    const travel = ((windFromDeg + 180) * Math.PI) / 180;
    const tx = Math.sin(travel);
    const tz = -Math.cos(travel);

    for (const w of detailTable(sea).waves) {
      const cos = w.dx * tx + w.dz * tz;
      assert.ok(
        cos >= Math.cos((45.5 * Math.PI) / 180),
        `wind ${windFromDeg}°: a wavelet ${((Math.acos(cos) * 180) / Math.PI).toFixed(1)}° off downwind`
      );
      assert.ok(Math.abs(Math.hypot(w.dx, w.dz) - 1) < 1e-12, 'heading is not a unit vector');
    }
  }
});

test('a change of wind turns the chop rather than re-rolling it', () => {
  // The spectrum turns rigidly with the wind; so must this, or a veering gale
  // would visibly shuffle its own chop every degree it moved.
  const a = detailTable(createSeaState({ preset: 'gale', windFromDeg: 285 }));
  const b = detailTable(createSeaState({ preset: 'gale', windFromDeg: 285 + 90 }));

  for (let i = 0; i < a.waves.length; i++) {
    assert.equal(b.waves[i].amp, a.waves[i].amp);
    assert.equal(b.waves[i].phase, a.waves[i].phase);
    // Ninety degrees clockwise: (dx, dz) → (−dz, dx).
    assert.ok(Math.abs(b.waves[i].dx - -a.waves[i].dz) < 1e-9);
    assert.ok(Math.abs(b.waves[i].dz - a.waves[i].dx) < 1e-9);
  }
});

test('the same sea gives the same wavelets, a different one does not', () => {
  const table = (options) => detailTable(createSeaState(options));
  const key = (t) => JSON.stringify(t.waves);

  assert.equal(key(table({ preset: 'storm' })), key(table({ preset: 'storm' })));
  assert.notEqual(key(table({ preset: 'storm' })), key(table({ preset: 'gale' })));
  // The spectrum's own seed reaches this table through the phases it produced,
  // so two storms from different seeds are two different storms all the way down.
  assert.notEqual(key(table({ preset: 'storm' })), key(table({ preset: 'storm', seed: 7 })));
});

// --- The gate -----------------------------------------------------------------

/** Every uniform a stage declares, and every uniform-shaped name it uses. */
function uniformAudit(source) {
  const declared = new Set();
  const body = [];
  for (const line of source.split('\n')) {
    const m = /^\s*uniform\s+\w+\s+(\w+)/.exec(line);
    if (m) declared.add(m[1]);
    else body.push(line.replace(/\/\/.*$/, ''));
  }
  const used = new Set(body.join('\n').match(/\bu[A-Z]\w*/g) ?? []);
  return { declared, used };
}

test('a phone has never heard of the wavelets', () => {
  // normalRange at nought is the phone path: no per-pixel normal, and with it
  // no wavelet table, no lace and no fold shadow. Not faded to nothing —
  // absent, down to the uniform declarations.
  const { ocean } = rig({ quality: { ...QUALITY, normalRange: 0 } });
  for (const src of [ocean.mesh.material.vertexShader, ocean.mesh.material.fragmentShader]) {
    for (const name of ['uDet', 'uDetail', '#define ND', 'detailDisplace', 'detailSlope',
                        'detailFade', 'veins(', 'underFold', 'laceAmt']) {
      assert.ok(!src.includes(name), `the phone path is paying for ${name}`);
    }
  }
});

test('with the near field on, both stages carry the same table', () => {
  const { ocean } = rig();
  const v = ocean.mesh.material.vertexShader;
  const f = ocean.mesh.material.fragmentShader;

  assert.ok(v.includes(`#define ND ${DETAIL_COUNT}`), 'the vertex stage has no wavelets');
  assert.ok(f.includes(`#define ND ${DETAIL_COUNT}`), 'the fragment stage has no wavelets');
  assert.ok(v.includes('displaced += detailDisplace('), 'the wavelets move no geometry');
  assert.ok(f.includes('nf = normalize(nf + detailSlope('), 'the wavelets light no pixel');

  // The fade is the contract: full strength near, gone by the far range, in
  // both stages and from the same constants.
  const fade = `smoothstep(${DETAIL_NEAR.toFixed(1)}, ${DETAIL_FAR.toFixed(1)}, camDist)`;
  assert.ok(v.includes(fade) && f.includes(fade), 'the two stages fade differently');

  // And every uniform either stage names, it declares.
  for (const [label, src] of [['vertex', v], ['fragment', f]]) {
    const { declared, used } = uniformAudit(src);
    for (const name of declared) assert.ok(used.has(name), `${label} declares unused ${name}`);
    for (const name of used) assert.ok(declared.has(name), `${label} uses undeclared ${name}`);
  }
});

test('the whole treatment answers to one dial', () => {
  const { ocean } = rig();
  const f = ocean.mesh.material.fragmentShader;

  // Wavelets, lace and fold shadow all pass through uDetail, so nought is the
  // sea exactly as it was before any of them and the eye can be asked to
  // compare the two rather than to remember.
  assert.ok(/detailSlope\(vUndisp, camDistF, uTime\) \* uDetail/.test(f));
  assert.ok(/float laceAmt = .*\* uDetail;/.test(f));
  assert.ok(/\* uDetail;\s*\n\s*water = mix\(water, uDeep/.test(f));

  assert.equal(ocean.uniforms.uDetail.value, 1);
  ocean.setDetail(0.4);
  assert.equal(ocean.uniforms.uDetail.value, 0.4);
  ocean.setDetail(9);
  assert.equal(ocean.uniforms.uDetail.value, 1, 'the dial is not clamped');
  ocean.setDetail(-1);
  assert.equal(ocean.uniforms.uDetail.value, 0);

  // A dial, not a recompile: a game may animate it.
  assert.equal(ocean.mesh.material.fragmentShader, f);
});

test('the uniforms are the table, and a change of sea re-uploads them', () => {
  const { ocean } = rig();
  const material = ocean.mesh.material;
  const table = ocean.detail;

  assert.deepEqual(ocean.uniforms.uDetAmp.value, table.waves.map((w) => w.amp));
  assert.deepEqual(ocean.uniforms.uDetLen.value, table.waves.map((w) => w.length));
  assert.deepEqual(
    ocean.uniforms.uDetDir.value,
    table.waves.flatMap((w) => [w.dx, w.dz])
  );

  ocean.setSeaState(createSeaState({ preset: 'calm' }));
  assert.ok(ocean.detail.ampSum < table.ampSum, 'a calm sea kept the storm chop');
  assert.deepEqual(ocean.uniforms.uDetAmp.value, ocean.detail.waves.map((w) => w.amp));

  // The count never changes, so this is a re-upload and never a recompile.
  assert.equal(ocean.mesh.material, material, 'a change of sea rebuilt the material');
});

test('the fold shadow is shading, and the vertex stage stays as it was', () => {
  // R11's whole point: the lip is faked in the fragment stage or not at all.
  // Whatever the near-field treatment does to the look, the geometry the
  // physics samples must be the wave sum plus the fifteen capped centimetres —
  // there is no third thing moving a vertex.
  const { ocean } = rig();
  const v = ocean.mesh.material.vertexShader;
  assert.ok(!v.includes('underFold') && !v.includes('uFoamLo'), 'the fold reached the geometry');
  assert.equal((v.match(/displaced \+=/g) ?? []).length, 1);
});
