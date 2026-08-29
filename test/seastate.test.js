// The law the whole library rests on: the CPU and the GPU describe the same
// water, and they describe the same water every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState, PRESETS } from '../src/spectrum.js';
import { SeaState, waveUniforms, oceanVertexChunk } from '../src/seastate.js';

const PRESET_NAMES = Object.keys(PRESETS);

/** A grid of awkward, non-commensurate points and times — nothing on a
 *  wavelength, nothing on a period, so no accidental symmetry can flatter us. */
function* probePoints() {
  for (const t of [0, 3.7, 41.3, 197.9, 1301.4]) {
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        yield [i * 137.3, j * 91.7, t];
      }
    }
  }
}

// --- CPU/GPU identity --------------------------------------------------------

test('inverting the Gerstner displacement lands back where it started', () => {
  for (const preset of ['storm', 'greybeards']) {
    const sea = createSeaState({ preset });
    let worst = 0;
    for (const [x, z, t] of probePoints()) {
      const u = sea.undisplacedAt(x, z, t);
      const p = sea.displacedPointAt(u.x, u.z, t);
      worst = Math.max(worst, Math.hypot(p.x - x, p.z - z));
    }
    assert.ok(
      worst < 0.01,
      `${preset}: inversion residual ${worst.toFixed(5)} m, want < 0.01 m`
    );
  }
});

test('heightAt agrees with the displaced surface point', () => {
  const sea = createSeaState({ preset: 'greybeards' });
  for (const [x, z, t] of probePoints()) {
    const p = sea.surfacePointAt(x, z, t);
    assert.ok(Math.abs(p.y - sea.heightAt(x, z, t)) < 1e-9);
  }
});

test('heightAt stays inside hMin..hMax for every preset', () => {
  for (const preset of PRESET_NAMES) {
    const sea = createSeaState({ preset });
    for (const [x, z, t] of probePoints()) {
      const h = sea.heightAt(x, z, t);
      assert.ok(Number.isFinite(h), `${preset}: non-finite height`);
      assert.ok(
        h >= sea.hMin && h <= sea.hMax,
        `${preset}: height ${h} outside ${sea.hMin}..${sea.hMax}`
      );
    }
  }
});

// --- Determinism -------------------------------------------------------------

test('the same options give byte-identical wave tables', () => {
  const a = createSeaState({ preset: 'gale', seed: 4242, windFromDeg: 17 });
  const b = createSeaState({ preset: 'gale', seed: 4242, windFromDeg: 17 });
  assert.deepEqual(a.waves, b.waves);
  assert.equal(a.hMax, b.hMax);
  assert.equal(a.dominantSpeed, b.dominantSpeed);
});

test('a different seed gives a different sea', () => {
  const a = createSeaState({ preset: 'gale', seed: 1 });
  const b = createSeaState({ preset: 'gale', seed: 2 });
  assert.notDeepEqual(a.waves, b.waves);
  // ...but the same sea state: the seed shuffles the sea, it does not change
  // the weather.
  assert.ok(Math.abs(a.hMax - b.hMax) / a.hMax < 0.05);
});

test('no wall clock and no Math.random leak into a sea', () => {
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => {
    throw new Error('Math.random in simulation code');
  };
  Date.now = () => {
    throw new Error('Date.now in simulation code');
  };
  try {
    for (const preset of PRESET_NAMES) {
      const sea = createSeaState({ preset });
      sea.heightAt(13, -47, 88.5);
      sea.gradientAt(13, -47, 88.5);
      sea.orbitalVelocityAt(13, -47, 88.5);
      sea.crestAt(13, -47, 88.5);
    }
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
  }
});

// --- The presets themselves --------------------------------------------------

/** Significant height, the way the sea itself defines it: four times the
 *  standard deviation of the surface elevation, sampled widely enough that the
 *  sets and the lulls both get a turn. */
function significantHeight(sea) {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let ti = 0; ti < 12; ti++) {
    const t = ti * 37.3;
    for (let i = 0; i < 60; i++) {
      for (let j = 0; j < 60; j++) {
        const h = sea.heightAt((i - 30) * 31.7, (j - 30) * 29.3, t);
        n++;
        sum += h;
        sumSq += h * h;
      }
    }
  }
  const mean = sum / n;
  return 4 * Math.sqrt(sumSq / n - mean * mean);
}

test('each preset makes the significant height it advertises', () => {
  for (const preset of PRESET_NAMES) {
    const sea = createSeaState({ preset });
    const hs = significantHeight(sea);
    const want = PRESETS[preset].hs;
    assert.ok(
      Math.abs(hs - want) / want < 0.3,
      `${preset}: Hs ${hs.toFixed(2)} m, want ${want} ±30%`
    );
  }
});

test('each preset makes the dominant wavelength it advertises', () => {
  for (const preset of PRESET_NAMES) {
    const sea = createSeaState({ preset });
    assert.equal(sea.dominantLength, PRESETS[preset].dominantLength);
    // Deep-water dispersion, checked at the one wave everything else rides.
    const c = Math.sqrt((9.81 * sea.dominantLength) / (2 * Math.PI));
    assert.ok(Math.abs(sea.dominantSpeed - c) < 1e-9);
  }
});

test('scale multiplies the sea and waveCount sizes the table', () => {
  const one = createSeaState({ preset: 'storm' });
  const half = createSeaState({ preset: 'storm', scale: 0.5 });
  assert.ok(Math.abs(half.hMax / one.hMax - 0.5) < 1e-9);

  assert.equal(one.waves.length, 12);
  assert.equal(createSeaState({ preset: 'storm', waveCount: 20 }).waves.length, 20);
});

test('the primary train is split three near-parallel ways', () => {
  const sea = createSeaState({ preset: 'storm' });
  const [a, b, c] = sea.waves;
  for (const w of [b, c]) {
    // Same neighbourhood of wavelength...
    const ratio = w.length / a.length;
    assert.ok(ratio > 0.7 && ratio < 1.4, `train component at ratio ${ratio}`);
    // ...but a different speed, or they would never come in sets.
    assert.notEqual(w.omega, a.omega);
    // ...and within ten degrees of heading.
    const dot = a.dx * w.dx + a.dz * w.dz;
    assert.ok(dot > Math.cos((10 * Math.PI) / 180), `train component off by too much`);
  }
});

test('the remainder runs log-spaced down to chop, fanning out as it shortens', () => {
  const sea = createSeaState({ preset: 'storm' });
  const tail = sea.waves.slice(3);
  for (let i = 1; i < tail.length; i++) {
    assert.ok(tail[i].length < tail[i - 1].length, 'tail must shorten');
    // Alternating either side of the swell's heading.
    const cross = (w) => sea.dominant.dx * w.dz - sea.dominant.dz * w.dx;
    assert.ok(cross(tail[i]) * cross(tail[i - 1]) < 0, 'tail must alternate sides');
  }
  assert.ok(tail[tail.length - 1].length <= PRESETS.storm.chopLength + 1e-9);
});

test('the pinch budget stays under the folding limit and follows steepness', () => {
  const pinchOf = (sea) => sea.waves.reduce((a, w) => a + w.q * w.k * w.amp, 0);
  let previous = 0;
  for (const preset of PRESET_NAMES) {
    const sea = createSeaState({ preset });
    const pinch = pinchOf(sea);
    assert.ok(pinch <= 0.8 + 1e-9, `${preset}: pinch ${pinch} over budget`);
    assert.ok(pinch > previous, `${preset}: a steeper sea must be more pinched`);
    previous = pinch;
  }
  // A glassy heave is a sinusoid; a survival storm is knife edges.
  assert.ok(pinchOf(createSeaState({ preset: 'calm' })) < 0.15);
  assert.ok(pinchOf(createSeaState({ preset: 'greybeards' })) > 0.6);
});

test('wind direction turns the whole sea with it', () => {
  const sea = createSeaState({ preset: 'gale', windFromDeg: 0 });
  // Wind from the north: the swell runs south, which is +z.
  assert.ok(sea.dominant.dz > 0.98, `dominant dz ${sea.dominant.dz}`);
  assert.ok(Math.abs(sea.dominant.dx) < 0.2);
  assert.equal(sea.windFromDeg, 0);
});

test('an unknown preset is refused rather than silently guessed at', () => {
  assert.throws(() => createSeaState({ preset: 'millpond' }), /unknown preset/);
});

// --- The other queries -------------------------------------------------------

test('the gradient matches a hand-rolled difference of heightAt', () => {
  const sea = createSeaState({ preset: 'storm' });
  const t = 61.5;
  const g = sea.gradientAt(120, -80, t, 22);
  const dx = (sea.heightAt(142, -80, t) - sea.heightAt(98, -80, t)) / 44;
  const dz = (sea.heightAt(120, -58, t) - sea.heightAt(120, -102, t)) / 44;
  assert.ok(Math.abs(g.dx - dx) < 1e-12);
  assert.ok(Math.abs(g.dz - dz) < 1e-12);
});

test('the normal is unit, up, and leans away from the slope', () => {
  const sea = createSeaState({ preset: 'gale' });
  for (const [x, z, t] of probePoints()) {
    const n = sea.normalAt(x, z, t);
    assert.ok(Math.abs(n.length() - 1) < 1e-9);
    assert.ok(n.y > 0, 'the sea has no overhangs in this model');
  }
});

test('roughHeightAt is the cheap twin, close but not exact', () => {
  const sea = createSeaState({ preset: 'storm' });
  let worst = 0;
  for (const [x, z, t] of probePoints()) {
    worst = Math.max(worst, Math.abs(sea.roughHeightAt(x, z, t) - sea.heightAt(x, z, t)));
  }
  assert.ok(worst > 0.1, 'if it were exact there would be no reason for heightAt');
  assert.ok(worst < sea.hMax, 'but it must not be wild');
});

test('orbital velocity is finite and scales with the sea', () => {
  const calm = createSeaState({ preset: 'calm' });
  const big = createSeaState({ preset: 'greybeards' });
  const speed = (sea) => {
    let peak = 0;
    for (const [x, z, t] of probePoints()) {
      peak = Math.max(peak, sea.orbitalVelocityAt(x, z, t).length());
    }
    return peak;
  };
  const a = speed(calm);
  const b = speed(big);
  assert.ok(Number.isFinite(a) && Number.isFinite(b));
  assert.ok(b > a * 5, `orbital speeds ${a.toFixed(2)} vs ${b.toFixed(2)}`);
});

test('crest pinch peaks where the surface is sharpest', () => {
  const sea = createSeaState({ preset: 'storm' });
  let peak = 0;
  for (const [x, z, t] of probePoints()) peak = Math.max(peak, Math.abs(sea.crestAt(x, z, t)));
  const budget = sea.waves.reduce((a, w) => a + w.q * w.k * w.amp, 0);
  assert.ok(peak > 0.1 && peak <= budget + 1e-9);
});

// --- The GPU twin ------------------------------------------------------------

test('the uniform arrays carry the whole table, in the shader layout', () => {
  const sea = createSeaState({ preset: 'storm', waveCount: 9 });
  const u = waveUniforms(sea);
  assert.equal(u.uWaveDir.value.length, 18);
  for (const key of ['uWaveK', 'uWaveOmega', 'uWaveAmp', 'uWaveQ', 'uWaveLen', 'uWavePhase']) {
    assert.equal(u[key].value.length, 9, key);
    for (const v of u[key].value) assert.ok(Number.isFinite(v), key);
  }
  assert.equal(u.uWaveDir.value[0], sea.waves[0].dx);
  assert.equal(u.uWaveDir.value[1], sea.waves[0].dz);
});

test('the GLSL chunk is generated for the table it will be given', () => {
  const chunk = oceanVertexChunk(9);
  assert.match(chunk, /#define NW 9/);
  assert.match(chunk, /vec3 gerstner\(vec2 p, float camDist, out vec3 normal, out float crest\)/);
  // The distance attenuation is the one thing in the shader the CPU does not
  // do, and it is load-bearing: without it the horizon aliases.
  assert.match(chunk, /exp\(-camDist \/ \(uWaveLen\[i\] \* 45\.0 \+ 600\.0\)\)/);
  for (const name of ['uWaveDir', 'uWaveK', 'uWaveOmega', 'uWaveAmp', 'uWaveQ', 'uWaveLen', 'uWavePhase', 'uTime']) {
    assert.ok(chunk.includes(name), `chunk is missing uniform ${name}`);
  }
});

test('the shader sum, walked by hand, reproduces displacedPointAt', () => {
  // Standing in for a GPU: the same arithmetic the chunk performs, at camDist
  // zero where the attenuation is one. If these two ever disagree, a hull is
  // floating somewhere other than the water it appears to be on.
  const sea = createSeaState({ preset: 'greybeards' });
  const u = waveUniforms(sea);
  const t = 88.25;
  for (const [x, z] of [[0, 0], [231.7, -418.3], [-97.1, 55.9]]) {
    let px = x;
    let py = 0;
    let pz = z;
    for (let i = 0; i < sea.waves.length; i++) {
      const dx = u.uWaveDir.value[i * 2];
      const dz = u.uWaveDir.value[i * 2 + 1];
      const amp = u.uWaveAmp.value[i];
      const theta =
        u.uWaveK.value[i] * (dx * x + dz * z) - u.uWaveOmega.value[i] * t + u.uWavePhase.value[i];
      const qa = u.uWaveQ.value[i] * amp;
      px += dx * qa * Math.cos(theta);
      pz += dz * qa * Math.cos(theta);
      py += amp * Math.sin(theta);
    }
    const p = sea.displacedPointAt(x, z, t);
    assert.ok(Math.abs(p.x - px) < 1e-9);
    assert.ok(Math.abs(p.y - py) < 1e-9);
    assert.ok(Math.abs(p.z - pz) < 1e-9);
  }
});

// --- The field wrapper -------------------------------------------------------

test('a SeaState can be built straight from components', () => {
  const sea = new SeaState(
    [{ length: 100, amp: 2, off: 0, pinch: 0.2, phase: 0.5 }],
    { windFromDeg: 90, windSpeed: 12, preset: 'hand-made' }
  );
  assert.equal(sea.waves.length, 1);
  assert.equal(sea.hMax, 2);
  assert.equal(sea.preset, 'hand-made');
  assert.equal(sea.windSpeed, 12);
  assert.ok(Math.abs(sea.waves[0].q * sea.waves[0].k * 2 - 0.2) < 1e-12);
});
