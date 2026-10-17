// Wave packets: a rogue sea. The same law as the rest of the sea — the CPU and
// the GPU describe the same water — and the physics of a group: it comes on at
// half the speed of its own crests, grows, and dies away.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState } from '../src/spectrum.js';
import { SeaState, waveUniforms, oceanVertexChunk, oceanNormalChunk, oceanCrestChunk, MAX_PACKETS } from '../src/seastate.js';
import { WaveField } from '../src/wavefield.js';

const G = 9.81;

/** A rogue on a storm, centred on the origin half way through its life at t = 100. */
function stormWithRogue(options = {}) {
  const sea = createSeaState({ preset: 'storm', seed: 7, ...options });
  const [rogue] = sea.setPackets([{ x: 0, z: 0, height: 11, born: 40, life: 120, phase: 0.4 }]);
  // Born 60 s before its peak; put it where its envelope will be centred on the
  // origin at t = 100.
  const back = rogue.groupSpeed * 60;
  sea.setPackets([{ x: -rogue.dx * back, z: -rogue.dz * back, height: 11, born: 40, life: 120, phase: 0.4 }]);
  return sea;
}

/** A packet on a flat sea, so whatever the surface does is the packet's. */
function packetAlone(packet) {
  const sea = new SeaState([], { windFromDeg: 285 });
  sea.setPackets([packet]);
  return sea;
}

function* nearTheRogue() {
  for (const t of [70.3, 100, 131.9]) {
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) yield [i * 61.3, j * 47.9, t];
    }
  }
}

test('inverting the displacement still lands back where it started, rogue and all', () => {
  for (const scale of [1, 1.4]) {
    const sea = stormWithRogue({ scale });
    let worst = 0;
    for (const [x, z, t] of nearTheRogue()) {
      const u = sea.undisplacedAt(x, z, t);
      const p = sea.displacedPointAt(u.x, u.z, t);
      worst = Math.max(worst, Math.hypot(p.x - x, p.z - z));
      assert.ok(Math.abs(sea.heightAt(x, z, t) - p.y) < 1e-9);
    }
    // The envelope moves with the point, so the step is a general 2×2 Newton
    // one, and a fourth is taken while a packet lives: well inside ten microns.
    assert.ok(worst < 1e-5, `scale ${scale}: worst residual ${worst} m`);
  }
});

test('the shader sum, walked by hand, reproduces displacedPointAt with a packet on', () => {
  // Standing in for the GPU, as the table's own test does: the arithmetic of
  // gerstner() and packetEnvelope(), from the uniform arrays alone, at camDist 0.
  const sea = stormWithRogue();
  const u = waveUniforms(sea);
  const A = u.uPacketA.value, B = u.uPacketB.value, C = u.uPacketC.value, PH = u.uPacketPhase.value;
  const envelope = (i, x, z, t) => {
    const [dx, dz, k, omega] = A.slice(i * 4, i * 4 + 4);
    const [height, , along, across] = B.slice(i * 4, i * 4 + 4);
    const [x0, z0, born, life] = C.slice(i * 4, i * 4 + 4);
    if (life <= 0 || height <= 0) return 0;
    const tau = (t - born) / life;
    if (tau <= 0 || tau >= 1) return 0;
    const g = Math.sin(Math.PI * tau);
    const run = (omega / (2 * k)) * (t - born);
    const rx = x - (x0 + dx * run), rz = z - (z0 + dz * run);
    const sa = (rx * dx + rz * dz) / along, nc = (rx * -dz + rz * dx) / across;
    return height * g * g * Math.exp(-0.5 * (sa * sa + nc * nc));
  };
  for (const t of [55.5, 100, 151.25]) {
    for (const [x, z] of [[0, 0], [131.7, -88.3], [-197.1, 55.9], [12, 260]]) {
      let px = x, py = 0, pz = z;
      for (let i = 0; i < sea.waves.length; i++) {
        const [dx, dz, k, omega] = u.uWaveA.value.slice(i * 4, i * 4 + 4);
        const [amp, q, , phase] = u.uWaveB.value.slice(i * 4, i * 4 + 4);
        const theta = k * (dx * x + dz * z) - omega * t + phase;
        px += dx * q * amp * Math.cos(theta);
        pz += dz * q * amp * Math.cos(theta);
        py += amp * Math.sin(theta);
      }
      for (let i = 0; i < MAX_PACKETS; i++) {
        const amp = envelope(i, x, z, t);
        if (amp <= 0) continue;
        const [dx, dz, k, omega] = A.slice(i * 4, i * 4 + 4);
        const q = B[i * 4 + 1];
        const theta = k * (dx * x + dz * z) - omega * t + PH[i];
        px += dx * q * amp * Math.cos(theta);
        pz += dz * q * amp * Math.cos(theta);
        py += amp * Math.sin(theta);
      }
      const p = sea.displacedPointAt(x, z, t);
      assert.ok(Math.abs(p.x - px) < 1e-9 && Math.abs(p.y - py) < 1e-9 && Math.abs(p.z - pz) < 1e-9, `${x}, ${z} at ${t}`);
    }
  }
});

test('every shader chunk walks the packets as well as the table', () => {
  const sea = stormWithRogue();
  for (const chunk of [oceanVertexChunk(sea.waves.length), oceanNormalChunk(sea.waves.length) + oceanCrestChunk()]) {
    assert.match(chunk, new RegExp(`#define NP ${MAX_PACKETS}`));
    assert.match(chunk, /float packetEnvelope\(int i, vec2 p, float t\)/);
  }
  assert.equal((oceanVertexChunk(9).match(/for \(int i = 0; i < NP; i\+\+\)/g) ?? []).length, 1, 'the vertex sum');
  const fragment = oceanNormalChunk(9) + oceanCrestChunk();
  assert.equal((fragment.match(/for \(int i = 0; i < NP; i\+\+\)/g) ?? []).length, 2, 'the normal and the crest');
  // The crest memory and the spill follow each packet's own frequency.
  assert.match(oceanVertexChunk(9), /crestLag0 \+= qka \* sin\(theta \+ uPacketA\[i\]\.w/);
  assert.match(oceanCrestChunk(), /lead0 \+= qka \* sin\(theta - uPacketA\[i\]\.w/);
});

test('the group comes on at the group speed, half the speed of its own crests', () => {
  const length = 260;
  const k = (2 * Math.PI) / length;
  const cg = Math.sqrt(G / k) / 2;
  const sea = packetAlone({ x: 0, z: 0, bearingDeg: 90, length, height: 8, born: 0, life: 400 });
  // Along its track (east), find the envelope: the mean square height over one
  // wavelength, at its greatest.
  const centreAt = (t) => {
    let best = -1, at = 0;
    for (let x = -600; x <= 3000; x += 5) {
      let e = 0;
      for (let s = -length / 2; s < length / 2; s += 5) e += sea.roughHeightAt(x + s, 0, t) ** 2;
      if (e > best) { best = e; at = x; }
    }
    return at;
  };
  const a = centreAt(150), b = centreAt(210);
  const measured = (b - a) / 60;
  assert.ok(Math.abs(measured - cg) / cg < 0.05, `envelope ${measured.toFixed(2)} m/s, group speed ${cg.toFixed(2)}`);
  // A crest near the centre, followed for a second: it runs at the phase speed.
  const crestNear = (x0, t) => {
    let best = -Infinity, at = x0;
    for (let x = x0 - length / 2; x <= x0 + length / 2; x += 0.25) {
      const h = sea.roughHeightAt(x, 0, t);
      if (h > best) { best = h; at = x; }
    }
    return at;
  };
  const c0 = crestNear(a, 150), c1 = crestNear(c0 + 2 * cg, 151);
  assert.ok(Math.abs((c1 - c0) - 2 * cg) / (2 * cg) < 0.05, `crest ${(c1 - c0).toFixed(2)} m/s, phase speed ${(2 * cg).toFixed(2)}`);
  assert.deepEqual(
    { group: +sea.packets[0].groupSpeed.toFixed(6), phase: +sea.packets[0].phaseSpeed.toFixed(6) },
    { group: +cg.toFixed(6), phase: +(2 * cg).toFixed(6) }
  );
});

test('it grows, peaks half way through its life, and dies away to nothing', () => {
  const plain = createSeaState({ preset: 'storm', seed: 7 });
  const sea = stormWithRogue();
  const p = sea.packets[0];
  // Outside its life the sea is the sea without it, exactly.
  for (const t of [0, 39.99, 160.01, 400]) {
    for (const [x, z] of [[0, 0], [300, -100], [-500, 220]]) {
      assert.equal(sea.heightAt(x, z, t), plain.heightAt(x, z, t), `t ${t}`);
      assert.equal(sea.crestAt(x, z, t), plain.crestAt(x, z, t));
    }
  }
  // Its height at the centre of its envelope rises to its peak and falls away.
  const heights = [];
  for (let t = 40; t <= 160; t += 10) heights.push(sea.packetAt(0, t).height);
  const peak = heights.indexOf(Math.max(...heights));
  assert.equal(peak, 6, 'the peak is half way, at t = 100');
  assert.ok(Math.abs(heights[peak] - p.height) < 1e-9);
  for (let i = 1; i <= peak; i++) assert.ok(heights[i] > heights[i - 1], 'growing');
  for (let i = peak + 1; i < heights.length; i++) assert.ok(heights[i] < heights[i - 1], 'dying away');
  // And at its peak the water it makes is a great sea: crests over the plain
  // sea's by most of its height somewhere in the group.
  let lift = 0;
  for (let x = -400; x <= 400; x += 4) {
    const along = [x * p.dx, x * p.dz];
    lift = Math.max(lift, sea.roughHeightAt(along[0], along[1], 100) - plain.roughHeightAt(along[0], along[1], 100));
  }
  assert.ok(lift > p.height * 0.9, `lifted ${lift.toFixed(1)} m of ${p.height}`);
  assert.equal(sea.packetAt(0, 30).alive, false);
  assert.equal(sea.packetAt(0, 100).alive, true);
});

test('a packet sharpens the crest it rides on but never folds it', () => {
  for (const [preset, scale] of [['storm', 1], ['storm', 1.4], ['greybeards', 1.4], ['gale', 1]]) {
    const sea = createSeaState({ preset, scale });
    const [p] = sea.setPackets([{ height: 14, born: 0, life: 100 }]);
    assert.ok(sea.pinch + p.pinch <= 0.95 + 1e-12, `${preset} × ${scale}: ${(sea.pinch + p.pinch).toFixed(3)}`);
    // An asked-for pinch is taken only as far as the room left.
    const [greedy] = sea.setPackets([{ height: 14, born: 0, life: 100, pinch: 2 }]);
    assert.equal(greedy.pinch, p.pinch);
    const [gentle] = sea.setPackets([{ height: 14, born: 0, life: 100, pinch: 0.01 }]);
    assert.equal(gentle.pinch, 0.01);
  }
});

test('putting packets on a sea fills the uniforms in place and widens its bounds', () => {
  const sea = createSeaState({ preset: 'storm' });
  const u = waveUniforms(sea);
  const before = { min: sea.hMin, max: sea.hMax };
  const field = new WaveField(sea);
  sea.setPackets([{ height: 9, born: 10, life: 60, x: 5, z: -7, phase: 1.25 }, { height: 4, born: 0, life: 30 }]);
  const [a, b] = sea.packets;
  assert.deepEqual(u.uPacketA.value, [a.dx, a.dz, a.k, a.omega, b.dx, b.dz, b.k, b.omega]);
  assert.deepEqual(u.uPacketB.value, [a.height, a.q, a.along, a.across, b.height, b.q, b.along, b.across]);
  assert.deepEqual(u.uPacketC.value, [5, -7, 10, 60, b.x, b.z, 0, 30]);
  assert.deepEqual(u.uPacketPhase.value, [1.25, 0]);
  assert.equal(sea.hMax, before.max + 13);
  assert.equal(sea.hMin, before.min - 13);
  assert.equal(field.hMax, sea.hMax, 'the field reads the bounds through');
  // Cleared, the table is empty again and the bounds what they were.
  sea.setPackets([]);
  assert.deepEqual(u.uPacketB.value, new Array(MAX_PACKETS * 4).fill(0));
  assert.deepEqual({ min: sea.hMin, max: sea.hMax }, before);
  assert.throws(() => sea.setPackets(new Array(MAX_PACKETS + 1).fill({ height: 1, life: 1 })), RangeError);
  // Given at construction, as a sea rebuilt for the weather would be.
  const again = new SeaState([], { packets: [{ height: 3, life: 10 }] });
  assert.equal(again.packets.length, 1);
});

test('the water in a packet moves: it carries a hull as it passes', () => {
  const sea = packetAlone({ x: 0, z: 0, bearingDeg: 90, length: 240, height: 10, born: 0, life: 100 });
  let fastest = 0;
  const centre = sea.packetAt(0, 50).x;
  for (let x = centre - 240; x <= centre + 240; x += 3) fastest = Math.max(fastest, Math.hypot(...sea.orbitalVelocityAt(x, 0, 50).toArray()));
  const omega = Math.sqrt(G * (2 * Math.PI) / 240);
  // Deep-water orbit at the crest: ω·A.
  assert.ok(Math.abs(fastest - omega * 10) / (omega * 10) < 0.05, `${fastest.toFixed(2)} m/s`);
});
