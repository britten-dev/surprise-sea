// The cascade, without a GPU.
//
// An inverse FFT is the one piece of code in this library where being nearly
// right looks exactly like being right: swap two indices in the butterfly
// schedule and the tile still comes out as plausible-looking noise, still
// tiles, still travels, and is simply not the transform of anything. There is
// no eye test for that. So the schedule is tested the only honest way — the
// identical index arithmetic, run in plain JavaScript, against a direct DFT at
// eight points and at eight by eight, to the precision the float32 twiddles in
// the table allow.
//
// Everything else here is the same trick the rest of the render tests use: a
// render target is a description until someone renders into it, a
// ShaderMaterial is two strings and a uniform map, and a spectrum is a typed
// array. All of it can be built and read in node exactly as it will be built in
// a tab, and only the pixels cannot.
//
// And the law, twice over: the vertex shader is byte for byte the same with the
// cascade on and off, and a phone build has never heard of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState, PRESETS } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createOcean } from '../src/render/ocean.js';
import { chopEnergy } from '../src/render/detail.js';
import {
  createDetailCascade,
  cascadeSpectrum,
  butterflyTable,
  canRenderFloat,
  FENCE_OFF,
} from '../src/render/fftcascade.js';

const NAMES = Object.keys(PRESETS);
const QUALITY = { gridN: 16, halfSpan: 400, exponent: 2.2, normalRange: 400 };

const rig = (options = {}, preset = 'storm') => {
  const field = new WaveField(createSeaState({ preset }), 40000);
  return { field, cascade: createDetailCascade(field, { size: 32, ...options }) };
};

/** A renderer that renders nothing and remembers everything, after the pattern
 *  test/foamfield.test.js established. */
function stubRenderer(caps = { isWebGL2: true, maxTextureSize: 4096 }) {
  let target = null;
  const draws = [];
  const viewport = { x: 0, y: 0, z: 0, w: 0 };
  return {
    autoClear: true,
    draws,
    viewport,
    capabilities: caps,
    extensions: { has: () => true },
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(rt) {
      target = rt ?? null;
    },
    getViewport(out) {
      out.set(viewport.x, viewport.y, viewport.z, viewport.w);
      return out;
    },
    setViewport(v) {
      viewport.x = v.x;
      viewport.y = v.y;
      viewport.z = v.z;
      viewport.w = v.w;
    },
    render() {
      draws.push({ target, autoClear: this.autoClear });
    },
  };
}

// --- The transform ------------------------------------------------------------
//
// The CPU mirror. This is deliberately not a tidy recursive FFT: it is the
// shader's loop, transcribed — read the twiddle and the two row indices out of
// the same table the GPU samples, fetch those two rows of the previous pass,
// multiply and add. If the table is wrong, this is wrong in exactly the way the
// tile would have been, and the DFT below will say so.

function butterflyPass(table, buf, stage) {
  const { size, stages, data } = table;
  const out = new Float64Array(size * 2);
  for (let y = 0; y < size; y++) {
    const o = (y * stages + stage) * 4;
    const wr = data[o];
    const wi = data[o + 1];
    const a = data[o + 2] | 0;
    const b = data[o + 3] | 0;
    const pr = buf[a * 2];
    const pi = buf[a * 2 + 1];
    const qr = buf[b * 2];
    const qi = buf[b * 2 + 1];
    out[y * 2] = pr + (wr * qr - wi * qi);
    out[y * 2 + 1] = pi + (wr * qi + wi * qr);
  }
  return out;
}

/**
 * And the fused pass, likewise transcribed: the later stage's entry names two
 * rows of the earlier one, each of which is itself a butterfly over rows of
 * what is in the buffer. Three lookups, four fetches, one draw where the shader
 * would otherwise have made two.
 */
function fusedPass(table, buf, stage) {
  const { size, stages, data } = table;
  const entry = (s, y) => {
    const o = (y * stages + s) * 4;
    return [data[o], data[o + 1], data[o + 2] | 0, data[o + 3] | 0];
  };
  const wing = (s, y) => {
    const [wr, wi, a, b] = entry(s, y);
    const pr = buf[a * 2];
    const pi = buf[a * 2 + 1];
    const qr = buf[b * 2];
    const qi = buf[b * 2 + 1];
    return [pr + (wr * qr - wi * qi), pi + (wr * qi + wi * qr)];
  };

  const out = new Float64Array(size * 2);
  for (let y = 0; y < size; y++) {
    const [wr, wi, A, B] = entry(stage + 1, y);
    const [ar, ai] = wing(stage, A);
    const [br, bi] = wing(stage, B);
    out[y * 2] = ar + (wr * br - wi * bi);
    out[y * 2 + 1] = ai + (wr * bi + wi * br);
  }
  return out;
}

/** The schedule the cascade actually runs: two levels a pass wherever two are
 *  left, one where they are not. */
function mirrorFft(table, input) {
  let buf = Float64Array.from(input);
  let stage = 0;
  while (stage < table.stages) {
    if (stage + 1 < table.stages) {
      buf = fusedPass(table, buf, stage);
      stage += 2;
    } else {
      buf = butterflyPass(table, buf, stage);
      stage += 1;
    }
  }
  return buf;
}

/** The same schedule one stage at a time, which is what the fused pass claims
 *  to be an exact economy over. */
function mirrorFftSingly(table, input) {
  let buf = Float64Array.from(input);
  for (let stage = 0; stage < table.stages; stage++) buf = butterflyPass(table, buf, stage);
  return buf;
}

/** X[k] = Σ x[n]·e^{+2πikn/N}: the synthesis convention the tile is built in. */
function directDft(input, size) {
  const out = new Float64Array(size * 2);
  for (let k = 0; k < size; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < size; n++) {
      const a = (2 * Math.PI * k * n) / size;
      const c = Math.cos(a);
      const s = Math.sin(a);
      re += input[n * 2] * c - input[n * 2 + 1] * s;
      im += input[n * 2] * s + input[n * 2 + 1] * c;
    }
    out[k * 2] = re;
    out[k * 2 + 1] = im;
  }
  return out;
}

/** A fixed, unremarkable complex signal. Seeded rather than random, because a
 *  failing FFT test that cannot be run again is not a test. */
function signal(n, seed = 12345) {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
  const out = new Float64Array(n * 2);
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2;
  return out;
}

// The twiddles are stored as float32, so the mirror carries about seven
// significant figures against the direct transform's sixteen. On sums of eight
// terms of order one that is a few parts in ten million; anything looser than
// this would let a genuinely wrong index through, and anything tighter would be
// testing the width of a float rather than the schedule.
const FFT_TOLERANCE = 1e-5;

test('the butterfly schedule is an inverse DFT, eight points of it', () => {
  const table = butterflyTable(8);
  const input = signal(8);

  const mine = mirrorFft(table, input);
  const truth = directDft(input, 8);

  for (let i = 0; i < mine.length; i++) {
    assert.ok(
      Math.abs(mine[i] - truth[i]) < FFT_TOLERANCE,
      `component ${i >> 1}${i % 2 ? ' (imaginary)' : ' (real)'}: ` +
        `${mine[i]} against ${truth[i]}`
    );
  }
});

test('and the same schedule down the columns is a two-dimensional one', () => {
  // Which is the whole claim the two-pass structure rests on: a 2-D transform
  // is the 1-D transform along the rows and then along the columns, and if the
  // index arithmetic is right in one direction it is right in the other.
  const n = 8;
  const table = butterflyTable(n);
  const grid = signal(n * n, 777);

  // Rows.
  const rows = new Float64Array(n * n * 2);
  for (let y = 0; y < n; y++) {
    const row = grid.slice(y * n * 2, (y + 1) * n * 2);
    rows.set(mirrorFft(table, row), y * n * 2);
  }
  // Columns.
  const mine = new Float64Array(n * n * 2);
  for (let x = 0; x < n; x++) {
    const col = new Float64Array(n * 2);
    for (let y = 0; y < n; y++) {
      col[y * 2] = rows[(y * n + x) * 2];
      col[y * 2 + 1] = rows[(y * n + x) * 2 + 1];
    }
    const done = mirrorFft(table, col);
    for (let y = 0; y < n; y++) {
      mine[(y * n + x) * 2] = done[y * 2];
      mine[(y * n + x) * 2 + 1] = done[y * 2 + 1];
    }
  }

  // The direct 2-D transform, four nested loops of it.
  for (let ky = 0; ky < n; ky++) {
    for (let kx = 0; kx < n; kx++) {
      let re = 0;
      let im = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const a = 2 * Math.PI * ((kx * x) / n + (ky * y) / n);
          const c = Math.cos(a);
          const s = Math.sin(a);
          const gr = grid[(y * n + x) * 2];
          const gi = grid[(y * n + x) * 2 + 1];
          re += gr * c - gi * s;
          im += gr * s + gi * c;
        }
      }
      const o = (ky * n + kx) * 2;
      assert.ok(Math.abs(mine[o] - re) < FFT_TOLERANCE * 4, `(${kx},${ky}) real`);
      assert.ok(Math.abs(mine[o + 1] - im) < FFT_TOLERANCE * 4, `(${kx},${ky}) imaginary`);
    }
  }
});

test('folding two levels into one pass changes the answer not at all', () => {
  // The economy the whole cost model rests on. It has to be exact rather than
  // merely close: if the fused pass were an approximation it would be a second
  // transform, and half the point of the schedule table is that there is only
  // ever one.
  for (const size of [8, 16, 32]) {
    const table = butterflyTable(size);
    const input = signal(size, 4242);
    const fused = mirrorFft(table, input);
    const singly = mirrorFftSingly(table, input);
    for (let i = 0; i < fused.length; i++) {
      assert.ok(
        Math.abs(fused[i] - singly[i]) < 1e-12,
        `${size}: ${fused[i]} against ${singly[i]} at ${i}`
      );
    }
  }
});

test('the schedule is a schedule: unit twiddles, indices on the grid', () => {
  for (const size of [8, 32, 128]) {
    const { data, stages } = butterflyTable(size);
    assert.equal(stages, Math.log2(size));
    for (let i = 0; i < data.length; i += 4) {
      const mag = Math.hypot(data[i], data[i + 1]);
      assert.ok(Math.abs(mag - 1) < 1e-6, `twiddle of modulus ${mag} at ${size}`);
      for (const idx of [data[i + 2], data[i + 3]]) {
        assert.ok(Number.isInteger(idx) && idx >= 0 && idx < size, `row index ${idx}`);
      }
    }
  }
  assert.throws(() => butterflyTable(96), /power of two/);
});

// --- The spectrum -------------------------------------------------------------

test('the tile spends exactly the slope budget the sea has earned', () => {
  // A normalisation, not a clamp: there is no preset, scale, wind or seed that
  // can put more slope in the tile than the budget times the sea's own chop
  // energy — the same energy render/detail.js shares its fifteen centimetres by.
  const budget = 0.13;
  for (const preset of NAMES) {
    for (const scale of [0.5, 1, 2]) {
      const sea = createSeaState({ preset, scale, windFromDeg: 41 });
      const table = cascadeSpectrum(sea, { size: 64, patch: 36, slopeBudget: budget });
      const want = budget * chopEnergy(sea);
      assert.ok(
        Math.abs(table.slopeRms - want) < want * 1e-5,
        `${preset} ×${scale}: ${table.slopeRms} of slope against a budget of ${want}`
      );
    }
  }
});

test('a glassy heave is nearly flat and a survival sea is not', () => {
  const spent = NAMES.map(
    (preset) => cascadeSpectrum(createSeaState({ preset }), { size: 64, patch: 36 }).slopeRms
  );
  for (let i = 1; i < spent.length; i++) {
    assert.ok(spent[i] > spent[i - 1], `not monotonic across the presets: ${spent}`);
  }
  // A millpond keeps a cat's paw and nothing more: under two degrees of tilt.
  assert.ok(spent[0] < 0.02, `calm carries ${spent[0].toFixed(4)} of slope`);
  assert.ok(spent[spent.length - 1] > 0.1, 'greybeards is not spending its budget');
});

test('every number in the table is a number', () => {
  for (const preset of NAMES) {
    const table = cascadeSpectrum(createSeaState({ preset }), { size: 64, patch: 36 });
    for (let i = 0; i < table.data.length; i++) {
      if (!Number.isFinite(table.data[i])) {
        assert.fail(`${preset}: ${table.data[i]} at ${i}`);
      }
    }
    for (const key of ['slopeRms', 'foamLo', 'foamHi', 'energy']) {
      assert.ok(Number.isFinite(table[key]), `${preset}: ${key} is ${table[key]}`);
    }
    assert.ok(table.foamHi > table.foamLo);
  }
});

test('the spectrum is Hermitian, so the surface it makes is real', () => {
  // Each texel carries its own mode and its partner at −k. The two texels of a
  // pair must therefore hold the same two numbers, the other way round — that
  // pairing, and nothing else, is what makes the inverse transform come out
  // real and the imaginary halves the tile discards mere round-off.
  const size = 32;
  const table = cascadeSpectrum(createSeaState({ preset: 'gale' }), { size, patch: 36 });
  const at = (i, j) => {
    const o = (j * size + i) * 4;
    return [table.data[o], table.data[o + 1], table.data[o + 2], table.data[o + 3]];
  };

  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const here = at(i, j);
      const there = at((size - i) % size, (size - j) % size);
      assert.deepEqual(
        [here[0], here[1], here[2], here[3]],
        [there[2], there[3], there[0], there[1]],
        `the mode at (${i}, ${j}) is not paired with its own reflection`
      );
    }
  }
});

test('the fence keeps the cascade out of the wave table\'s band', () => {
  // R12's requirement in one assertion: everything physics can feel stays
  // analytic, and this layer lives entirely above the cutoff. Not faint below
  // the fence — nought, by construction, before a mode is even drawn.
  const size = 64;
  const patch = 36;
  const table = cascadeSpectrum(createSeaState({ preset: 'greybeards' }), { size, patch });

  for (let j = 0; j < size; j++) {
    const mz = j < size / 2 ? j : j - size;
    for (let i = 0; i < size; i++) {
      const mx = i < size / 2 ? i : i - size;
      const k = (2 * Math.PI * Math.hypot(mx, mz)) / patch;
      if (k <= 0) continue;
      const wavelength = (2 * Math.PI) / k;
      if (wavelength < FENCE_OFF) continue;
      const o = (j * size + i) * 4;
      assert.equal(table.data[o], 0, `${wavelength.toFixed(1)} m carries energy`);
      assert.equal(table.data[o + 1], 0, `${wavelength.toFixed(1)} m carries energy`);
    }
  }

  assert.ok(table.longest < FENCE_OFF, `the band runs to ${table.longest.toFixed(2)} m`);
  assert.ok(table.shortest < 1, 'the band never reaches the octave it exists for');
});

test('the same sea gives the same tile, a different one does not', () => {
  const build = (options) =>
    cascadeSpectrum(createSeaState(options), { size: 32, patch: 36 }).data;
  const key = (d) => Array.from(d).join(',');

  assert.equal(key(build({ preset: 'storm' })), key(build({ preset: 'storm' })));
  assert.notEqual(key(build({ preset: 'storm' })), key(build({ preset: 'gale' })));
  // The spectrum's own seed reaches this table through the phases it produced,
  // so two storms from different seeds are two different storms all the way down.
  assert.notEqual(key(build({ preset: 'storm' })), key(build({ preset: 'storm', seed: 7 })));

  // And a running cascade re-seeds to the same place a fresh one would.
  const { cascade } = rig();
  const first = Array.from(cascade.table.data);
  cascade.setSeaState(createSeaState({ preset: 'calm' }));
  cascade.setSeaState(createSeaState({ preset: 'storm' }));
  assert.deepEqual(Array.from(cascade.table.data), first, 'a preset came back changed');
});

// --- The passes ---------------------------------------------------------------

test('one update is the whole transform, and it hands the renderer back', () => {
  const { cascade } = rig();
  const renderer = stubRenderer();
  renderer.setViewport({ x: 7, y: 9, z: 640, w: 480 });
  renderer.autoClear = true;

  cascade.update(renderer);

  // Two to the fifth is five stages each way, which fuses to three passes an
  // axis, plus the spectrum and the tile.
  const stages = Math.log2(cascade.size);
  const passes = 2 + 2 * Math.ceil(stages / 2);
  assert.equal(renderer.draws.length, passes);
  assert.equal(cascade.stats.passes, passes);
  assert.equal(cascade.stats.updates, 1);
  // Half again what the textbook one-stage-a-draw schedule would have cost, and
  // the whole bill of this file is passes rather than texels.
  assert.ok(passes < 2 + stages * 2);

  // Nothing was cleared, because every pass writes every texel of its target
  // and a clear here would be the renderer's colour, which is not ours.
  for (const draw of renderer.draws) assert.equal(draw.autoClear, false);

  // The spectrum first, the tile last, and the ping-pong in between never
  // reading and writing the same buffer in one pass.
  assert.equal(renderer.draws[0].target, cascade.targets.ping);
  assert.equal(renderer.draws[renderer.draws.length - 1].target, cascade.targets.tile);
  for (let i = 1; i < renderer.draws.length - 1; i++) {
    assert.notEqual(renderer.draws[i].target, renderer.draws[i - 1].target);
  }

  // And everything is where it was found.
  assert.equal(renderer.getRenderTarget(), null);
  assert.equal(renderer.autoClear, true);
  assert.deepEqual(
    [renderer.viewport.x, renderer.viewport.y, renderer.viewport.z, renderer.viewport.w],
    [7, 9, 640, 480],
    'the cascade kept the viewport it borrowed'
  );
});

test('the clock is the wave field, never a wall clock', () => {
  const { field, cascade } = rig();
  const renderer = stubRenderer();

  field.advance(3.5);
  cascade.update(renderer);
  assert.equal(cascade.materials.spectrum.uniforms.uTime.value, field.time);

  field.advance(1.25);
  assert.notEqual(cascade.materials.spectrum.uniforms.uTime.value, field.time);
  cascade.update(renderer);
  assert.equal(cascade.materials.spectrum.uniforms.uTime.value, field.time);
});

test('an update with no renderer costs nothing at all', () => {
  const { cascade } = rig();
  cascade.update(null);
  cascade.update(undefined);
  assert.equal(cascade.stats.updates, 0);
});

test('the dials are dials, and they are clamped', () => {
  const { cascade } = rig();
  assert.equal(cascade.uniforms.uCascadeGain.value, 1);
  cascade.setGain(0);
  assert.equal(cascade.uniforms.uCascadeGain.value, 0);
  cascade.setGain(9);
  assert.equal(cascade.uniforms.uCascadeGain.value, 1);
  cascade.setGain(-1);
  assert.equal(cascade.uniforms.uCascadeGain.value, 0);

  cascade.setMicroFoam(0.4);
  assert.equal(cascade.uniforms.uCascadeFoam.value, 0.4);
  cascade.setMicroFoam(3);
  assert.equal(cascade.uniforms.uCascadeFoam.value, 1);
});

// --- The GPU that cannot ------------------------------------------------------

test('a machine with no float targets gets a cascade that does nothing', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const poor = { capabilities: { isWebGL2: false }, extensions: { has: () => false } };
  assert.equal(canRenderFloat(poor), false);

  const cascade = createDetailCascade(field, { size: 32, renderer: poor });
  assert.equal(cascade.disabled, true);
  assert.equal(cascade.texture, null);
  assert.equal(cascade.uniforms.uCascadeGain.value, 0);

  // Every call still answers, because the caller's guard is `if (cascade)` and
  // the demo's is `cascade?.update?.()`: a disabled cascade must be safe to
  // drive rather than something that must be tested for at every line.
  cascade.update(stubRenderer());
  cascade.setGain(1);
  cascade.setSeaState(createSeaState({ preset: 'calm' }));
  cascade.dispose();
  assert.equal(cascade.stats.updates, 0);
  assert.equal(cascade.uniforms.uCascadeGain.value, 0);
  assert.ok(cascade.table.slopeRms > 0, 'the table is still there to be read');
});

test('the feature test knows a yes from a no from a question it cannot answer', () => {
  assert.equal(canRenderFloat(null), null, 'no renderer is not the same as no support');
  assert.equal(canRenderFloat({}), null);
  assert.equal(
    canRenderFloat({ capabilities: { isWebGL2: true, maxTextureSize: 4096 },
                     extensions: { has: (n) => n === 'EXT_color_buffer_half_float' } }),
    true
  );
  assert.equal(
    canRenderFloat({ capabilities: { isWebGL2: true, maxTextureSize: 4096 },
                     extensions: { has: () => false } }),
    false
  );
  // WebGL1 is a flat no whatever extensions it claims.
  assert.equal(
    canRenderFloat({ capabilities: { isWebGL2: false, maxTextureSize: 4096 },
                     extensions: { has: () => true } }),
    false
  );
});

test('a cascade that finds out late puts itself out', () => {
  // Built with no renderer to ask, handed one that cannot: it stops rather than
  // drawing sixteen passes of nothing every frame for the rest of the session.
  const { cascade } = rig();
  cascade.update(stubRenderer({ isWebGL2: false }));
  assert.equal(cascade.disabled, true);
  assert.equal(cascade.uniforms.uCascadeGain.value, 0);
  assert.equal(cascade.stats.updates, 0);
});

// --- The sea that samples it --------------------------------------------------

test('the cascade never touches a vertex, whatever else is switched on', () => {
  // The law. The tile is shading and only shading; if this ever fails, the
  // fifteen-centimetre budget in render/detail.js has stopped being the whole
  // of the library's honest divergence and the identity is no longer bounded.
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const cascade = createDetailCascade(field, { size: 32 });

  const without = createOcean(field, { quality: QUALITY });
  const with_ = createOcean(field, { quality: QUALITY, cascade });

  assert.equal(
    with_.mesh.material.vertexShader,
    without.mesh.material.vertexShader,
    'the cascade moved a vertex'
  );
  assert.ok(!with_.mesh.material.vertexShader.includes('uCascade'));
  assert.notEqual(with_.mesh.material.fragmentShader, without.mesh.material.fragmentShader);
});

test('setDetailCascade takes the sea back to the shader it started with', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const ocean = createOcean(field, { quality: QUALITY });
  const before = ocean.mesh.material.fragmentShader;
  const cascade = createDetailCascade(field, { size: 32 });

  ocean.setDetailCascade(cascade);
  assert.notEqual(ocean.mesh.material.fragmentShader, before);
  // Adopted, not copied: the cascade's own uniform objects, so a rebuild of the
  // tile arrives at the sea with nobody having to be told.
  for (const key of ['uCascade', 'uCascadeInvPatch', 'uCascadeGain', 'uCascadeFoam',
                     'uCascadeFar']) {
    assert.equal(ocean.uniforms[key], cascade.uniforms[key], `${key} was copied, not shared`);
  }

  ocean.setDetailCascade(null);
  assert.equal(ocean.mesh.material.fragmentShader, before, 'not the same shader, byte for byte');
  assert.ok(!('uCascade' in ocean.uniforms), 'a dead sampler is still held');
});

test('a phone build declines the cascade outright', () => {
  // normalRange at nought compiles the whole near-field treatment away, and the
  // tile is sampled from inside it. Not faded to nothing — absent, down to the
  // uniform declarations, and the offer is refused rather than half taken.
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const cascade = createDetailCascade(field, { size: 32 });
  const ocean = createOcean(field, {
    quality: { ...QUALITY, normalRange: 0 },
    cascade,
  });

  const before = ocean.mesh.material.fragmentShader;
  ocean.setDetailCascade(cascade);
  assert.equal(ocean.mesh.material.fragmentShader, before, 'the phone path took a cascade');

  for (const src of [ocean.mesh.material.vertexShader, before]) {
    for (const name of ['uCascade', 'cascAmt', 'cascFoam', 'fineSlope']) {
      assert.ok(!src.includes(name), `the phone path is paying for ${name}`);
    }
  }
  assert.ok(!('uCascade' in ocean.uniforms));
});

test('a disabled cascade is declined the same way', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const poor = { capabilities: { isWebGL2: false }, extensions: { has: () => false } };
  const cascade = createDetailCascade(field, { size: 32, renderer: poor });

  const ocean = createOcean(field, { quality: QUALITY, cascade });
  const plain = createOcean(field, { quality: QUALITY });
  assert.equal(
    ocean.mesh.material.fragmentShader,
    plain.mesh.material.fragmentShader,
    'a cascade that cannot run still changed the shader'
  );
});

test('the fragment stage samples the tile twice and turns the second one back', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const ocean = createOcean(field, {
    quality: QUALITY,
    cascade: createDetailCascade(field, { size: 32 }),
  });
  const src = ocean.mesh.material.fragmentShader;

  assert.ok(src.includes('uniform sampler2D uCascade;'));
  // Two fetches of one tile: the detiling is the whole reason a thirty-six
  // metre period is allowed under a sixty-metre view.
  assert.equal((src.match(/texture2D\(uCascade,/g) ?? []).length, 2);
  assert.ok(src.includes('vec2 fineSlope = vec2(fine.x * 0.4695 + fine.y * 0.8829,'));
  // The perturbation goes into the normal and nowhere near a position.
  assert.ok(/n = normalize\(n \+ vec3\(-slope\.x, 0\.0, -slope\.y\) \* cascAmt\);/.test(src));
  // And the noise it replaces is turned down by the same amount, so the total
  // quantity of invention on the near water falls rather than rises.
  assert.ok(src.includes('rippleAmt *= 1.0 - 0.75 * cascAmt;'));
  // Micro foam reaches the lace, at the gain the cascade owns, before the
  // distance fade that keeps a far crest from becoming a white bar.
  assert.ok(
    src.indexOf('cascFoam * uCascadeFoam') < src.indexOf('crestFoam *= 0.22'),
    'the micro foam dodges the distance fade'
  );
});

test('a live change of sea keeps the cascade with it', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const ocean = createOcean(field, {
    quality: QUALITY,
    cascade: createDetailCascade(field, { size: 32 }),
  });

  // A different *number* of waves changes #define NW, which is compiled in: the
  // rebuild that answers it must not quietly drop the cascade with it.
  ocean.setSeaState(createSeaState({ preset: 'greybeards', waveCount: 17 }));
  const src = ocean.mesh.material.fragmentShader;
  assert.ok(src.includes('#define NW 17'));
  assert.ok(src.includes('uCascade'), 'the cascade went with the old material');
});
