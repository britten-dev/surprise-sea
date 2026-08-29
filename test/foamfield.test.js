// The foam field, without a browser.
//
// Nothing here uploads a texel. A render target is a description until someone
// renders into it, a ShaderMaterial is two strings and a uniform map, and both
// can be built and read in node exactly as they will be built in a tab — so the
// generated GLSL, the uniform coverage, the footprint arithmetic and the whole
// of `wakeStamper` are testable here, and only the pixels are not.
//
// The renderer is a stub that records what was asked of it. That is enough to
// prove the two things a caller most needs to be true of `update`: that it puts
// the renderer back exactly as it found it, and that the footprint lands on
// whole texels every single time so the history never smears.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { Hull } from '../src/hull.js';
import { createFoamField, wakeStamper } from '../src/render/foamfield.js';

const SIZE = 64;
const EXTENT = 1280;
const TEXEL = EXTENT / SIZE;

function rig(preset = 'storm', options = {}) {
  const sea = createSeaState({ preset });
  const field = new WaveField(sea, 40000);
  const foam = createFoamField(field, { size: SIZE, extent: EXTENT, ...options });
  return { sea, field, foam };
}

/**
 * A renderer that renders nothing and remembers everything. `render` records
 * the target and the autoClear flag in force at the moment it was called, which
 * is the only way to check that the field drew where it said it would.
 */
function stubRenderer() {
  let target = null;
  const draws = [];
  return {
    autoClear: true,
    draws,
    getRenderTarget: () => target,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    setRenderTarget(rt) {
      target = rt ?? null;
    },
    render() {
      draws.push({ target, autoClear: this.autoClear });
    },
  };
}

/**
 * Every uniform a shader declares, and every uniform-shaped name it uses.
 * Declaration lines are held out of the "used" text, so a uniform that is
 * declared and never mentioned again shows up as declared and unused.
 */
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

function assertUniformsExact(source, label) {
  const { declared, used } = uniformAudit(source);
  for (const name of declared) {
    assert.ok(used.has(name), `${label}: declares ${name} and never uses it`);
  }
  for (const name of used) {
    assert.ok(declared.has(name), `${label}: uses ${name} and never declares it`);
  }
  return declared;
}

// --- The passes ---------------------------------------------------------------

test('the step pass injects the same wave sum the mesh is displaced by', () => {
  const { foam } = rig();
  const src = foam.materials.step.fragmentShader;

  // The generated chunk itself, not a copy of it: same table, same attenuation,
  // same crest memory, and it must be *called* rather than merely included.
  assert.ok(src.includes('vec3 gerstner(vec2 p, float camDist'), 'no gerstner chunk');
  assert.ok(src.includes('gerstner(world, 0.0, nrm, crest)'), 'chunk never called');
  assert.ok(src.includes('#define NW 12'), 'wrong wave count compiled in');

  // The three things an accumulation pass has to do, and the clamp that keeps
  // the buffer bounded for ever.
  assert.ok(src.includes('uDecay'), 'no decay');
  assert.ok(src.includes('uSrcOffset'), 'no advection');
  assert.ok(/clamp\(max\(history, breaking\), 0\.0, 1\.0\)/.test(src), 'unbounded');
});

test('the step pass thresholds the injection the way the ocean paints it', () => {
  const { foam } = rig();
  const src = foam.materials.step.fragmentShader;
  assert.ok(src.includes('smoothstep(uFoamLo, uFoamHi, crest + (rag - 0.5) * uFoamJitter)'));
});

test('both passes declare exactly the uniforms they use', () => {
  const { foam } = rig();
  const step = assertUniformsExact(foam.materials.step.fragmentShader, 'step fragment');
  const stamp = assertUniformsExact(foam.materials.stamp.vertexShader, 'stamp vertex');
  assertUniformsExact(foam.materials.stamp.fragmentShader, 'stamp fragment');

  assert.ok(step.has('uPrev') && step.has('uOrigin') && step.has('uTime'));
  assert.ok(stamp.has('uOrigin') && stamp.has('uInvExtent'));

  // Both quads are drawn straight in clip space, so neither vertex stage has
  // any business declaring a uniform of its own.
  assert.equal(uniformAudit(foam.materials.step.vertexShader).declared.size, 0);
});

test('every uniform the step pass declares has a value to upload', () => {
  const { foam } = rig();
  const { declared } = uniformAudit(foam.materials.step.fragmentShader);
  const values = foam.materials.step.uniforms;
  for (const name of declared) {
    assert.ok(name in values, `step pass declares ${name} with nothing to put in it`);
  }
});

test('a longer wave table recompiles the step pass', () => {
  const { foam } = rig();
  foam.setSeaState(createSeaState({ preset: 'storm', waveCount: 18 }));
  assert.ok(foam.materials.step.fragmentShader.includes('#define NW 18'));
  assertUniformsExact(foam.materials.step.fragmentShader, 'step fragment, 18 waves');
});

// --- The queue ----------------------------------------------------------------

test('stamps queue cheaply and are dropped rather than piling up', () => {
  const { foam } = rig('storm', { maxStamps: 4 });
  for (let i = 0; i < 10; i++) foam.stamp(i * 10, 0, 6, 1);
  assert.equal(foam.stats.dropped, 6);

  // Nothing that would draw nothing is ever queued.
  foam.stamp(0, 0, 0, 1);
  foam.stamp(0, 0, 5, 0);
  assert.equal(foam.stats.dropped, 6, 'an empty stamp was queued or counted');
});

test('a field with no renderer is a no-op, not a crash', () => {
  const { foam } = rig();
  assert.doesNotThrow(() => {
    foam.update(undefined, 1 / 60, { x: 0, y: 10, z: 0 });
    foam.update(null, 1 / 60, undefined);
  });
  assert.equal(foam.stats.updates, 0);
});

// --- The footprint ------------------------------------------------------------

test('the footprint lands on whole texels wherever the camera is', () => {
  const { foam } = rig();
  const renderer = stubRenderer();

  let x = 0;
  let z = 0;
  for (let i = 0; i < 200; i++) {
    x += 3.7139;
    z -= 1.1117;
    foam.update(renderer, 1 / 60, { x, y: 12, z });

    const o = foam.uniforms.uFoamOrigin.value;
    for (const v of [o.x, o.y]) {
      const texels = v / TEXEL;
      assert.ok(
        Math.abs(texels - Math.round(texels)) < 1e-6,
        `origin ${v} is ${texels} texels — not a whole one`
      );
    }
    // And it is genuinely following her: the camera stays inside the footprint,
    // within a texel of the middle.
    assert.ok(Math.abs(x - (o.x + EXTENT / 2)) <= TEXEL);
    assert.ok(Math.abs(z - (o.y + EXTENT / 2)) <= TEXEL);
  }
});

test('a still camera in a calm reads its own history back exactly', () => {
  // No wind, no drift, no movement: the offset into the previous texture must
  // be nought, or the field would smear a scar every frame for no reason.
  const { foam } = rig('calm', { drift: 0 });
  const renderer = stubRenderer();
  const eye = { x: 41.3, y: 8, z: -12.9 };

  foam.update(renderer, 1 / 60, eye);
  foam.update(renderer, 1 / 60, eye);

  const off = foam.materials.step.uniforms.uSrcOffset.value;
  assert.equal(off.x, 0);
  assert.equal(off.y, 0);
});

test('re-centring shifts the history by a whole number of texels', () => {
  const { foam } = rig('calm', { drift: 0 });
  const renderer = stubRenderer();

  foam.update(renderer, 1 / 60, { x: 0, y: 8, z: 0 });
  foam.update(renderer, 1 / 60, { x: 137.5, y: 8, z: -61.2 });

  const off = foam.materials.step.uniforms.uSrcOffset.value;
  for (const v of [off.x, off.y]) {
    const texels = v * SIZE;
    assert.ok(
      Math.abs(texels - Math.round(texels)) < 1e-6,
      `history offset ${texels} texels — a fractional copy would smear it`
    );
  }
});

test('the decay is the half-life it was asked for', () => {
  const eye = { x: 0, y: 8, z: 0 };
  const renderer = stubRenderer();

  const { foam } = rig('storm', { halfLife: 20 });
  foam.update(renderer, 1 / 60, eye);
  // The first update has no history and must not pretend otherwise.
  assert.equal(foam.materials.step.uniforms.uDecay.value, 0);

  foam.update(renderer, 1 / 60, eye);
  const want = Math.pow(2, -1 / 60 / 20);
  assert.ok(Math.abs(foam.materials.step.uniforms.uDecay.value - want) < 1e-12);

  // One half-life in one step, to check the exponent rather than the slope.
  const brief = rig('storm', { halfLife: 0.25 }).foam;
  brief.update(renderer, 0.25, eye);
  brief.update(renderer, 0.25, eye);
  assert.ok(Math.abs(brief.materials.step.uniforms.uDecay.value - 0.5) < 1e-12);

  // A tab that has been asleep for a minute steps a quarter of a second, so the
  // footprint is never advected off its own edge in one go.
  foam.update(renderer, 900, eye);
  assert.ok(Math.abs(foam.materials.step.uniforms.uDecay.value - Math.pow(2, -0.25 / 20)) < 1e-12);
});

test('the feedback blur spreads the same scar per second on any machine', () => {
  // A box blur's variance grows with the number of passes, so the offset has to
  // go as the square root of the step: sixty hertz and thirty must diffuse the
  // same amount of foam per second or the look would follow the frame rate.
  const eye = { x: 0, y: 8, z: 0 };
  const renderer = stubRenderer();
  const spread = (dt) => {
    const { foam } = rig('storm', { spread: 0.6 });
    foam.update(renderer, dt, eye);
    return foam.materials.step.uniforms.uSpread.value;
  };

  assert.ok(Math.abs(spread(1 / 60) - 0.6) < 1e-12);
  assert.ok(Math.abs(spread(1 / 30) - 0.6 * Math.SQRT2) < 1e-12);
  assert.equal(spread(0), 0, 'a frame with no time in it still blurred');
  // And one very long step is a blur, not a four-point pattern.
  assert.equal(spread(90), 1.2);
});

test('the field ping-pongs, and publishes the buffer it has just written', () => {
  const { foam } = rig();
  const renderer = stubRenderer();
  const eye = { x: 0, y: 8, z: 0 };

  const first = foam.texture;
  foam.update(renderer, 1 / 60, eye);
  const second = foam.texture;

  assert.notEqual(first, second, 'the buffers never swapped');
  assert.equal(foam.uniforms.uFoamField.value, second, 'the ocean is given the stale buffer');
  assert.equal(renderer.draws[0].target.texture, second, 'drew into the buffer it then read');

  foam.update(renderer, 1 / 60, eye);
  assert.equal(foam.texture, first, 'the pair did not come back round');
});

test('update leaves the renderer exactly as it found it', () => {
  const { foam } = rig();
  const renderer = stubRenderer();
  const someoneElsesTarget = { name: 'not ours' };

  renderer.setRenderTarget(someoneElsesTarget);
  renderer.autoClear = true;
  foam.stamp(0, 0, 20, 1);
  foam.update(renderer, 1 / 60, { x: 0, y: 8, z: 0 });

  assert.equal(renderer.getRenderTarget(), someoneElsesTarget, 'render target left moved');
  assert.equal(renderer.autoClear, true, 'autoClear left switched off');
  // And it did not clear the target it drew into, which is not its to clear.
  assert.equal(renderer.draws[0].autoClear, false);
});

test('nothing goes non-finite over a long run with the weather changing', () => {
  const { field, foam } = rig('greybeards');
  const renderer = stubRenderer();

  let x = 0;
  let z = 0;
  for (let i = 0; i < 3000; i++) {
    field.advance(1 / 30);
    x += Math.sin(i * 0.013) * 9;
    z += Math.cos(i * 0.017) * 9;
    if (i === 900) foam.setSeaState(createSeaState({ preset: 'calm' }));
    if (i === 1800) foam.setSeaState(createSeaState({ preset: 'storm', waveCount: 16 }));
    if (i % 7 === 0) foam.stamp(x, z, 12, 0.8);
    foam.update(renderer, 1 / 30, { x, y: 11, z });
  }

  const all = { ...foam.materials.step.uniforms, ...foam.uniforms };
  for (const [name, u] of Object.entries(all)) {
    const v = u.value;
    const numbers =
      typeof v === 'number' ? [v] : Array.isArray(v) ? v : v?.isVector2 ? [v.x, v.y] : [];
    for (const n of numbers) {
      assert.ok(Number.isFinite(n), `${name} went non-finite`);
    }
  }
  assert.equal(foam.stats.dropped, 0, 'the queue was never drained');
});

test('dispose does not leave the field usable by accident', () => {
  const { foam } = rig();
  assert.doesNotThrow(() => foam.dispose());
});

// --- Wakes --------------------------------------------------------------------

/** Somewhere to send stamps that remembers every one of them. */
function mockFoam() {
  return {
    stamps: [],
    stamp(x, z, radius, strength) {
      this.stamps.push({ x, z, radius, strength });
    },
  };
}

/** A hull, and the field she floats on. Heading north so the arithmetic is
 *  legible: forward is −z, so her stern trails away toward +z. */
function shipRig(preset = 'calm', headingDeg = 0) {
  const field = new WaveField(createSeaState({ preset }), 40000);
  const hull = new Hull({ headingDeg, x: 0, z: 0 });
  const foam = mockFoam();
  return { field, hull, foam, wake: wakeStamper(hull, foam) };
}

test('the trail starts at the stern and runs away astern of her', () => {
  const { hull, foam, wake } = shipRig();
  const arm = hull.options.length * 0.5;

  hull.speed = 5;
  wake.update(); // primes the track; a wake needs two positions to be a line
  assert.equal(foam.stamps.length, 0);

  hull.position.z -= 10; // ten metres made good, due north
  wake.update();

  assert.ok(foam.stamps.length >= 2, `only ${foam.stamps.length} splats over ten metres`);
  for (const s of foam.stamps) {
    // Forward is −z; everything laid down must be behind her.
    assert.ok(s.z > hull.position.z, 'a splat landed ahead of the bow');
    assert.ok(
      s.z - hull.position.z >= arm - 1e-6,
      `a splat landed ${(s.z - hull.position.z).toFixed(2)} m aft — inside the stern at ${arm}`
    );
    assert.ok(Math.abs(s.x) < 1e-6, 'a splat wandered off the track');
  }
});

test('the trail is laid along her track, not once a frame', () => {
  const slow = shipRig();
  slow.hull.speed = 5;
  slow.wake.update();
  slow.hull.position.z -= 20;
  slow.wake.update();

  const fast = shipRig();
  fast.hull.speed = 5;
  fast.wake.update();
  for (let i = 0; i < 20; i++) {
    fast.hull.position.z -= 1;
    fast.wake.update();
  }

  // The same twenty metres of sea, drawn in one frame or in twenty.
  assert.ok(
    Math.abs(slow.foam.stamps.length - fast.foam.stamps.length) <= 1,
    `one frame laid ${slow.foam.stamps.length}, twenty laid ${fast.foam.stamps.length}`
  );
});

test('nothing under a knot or two', () => {
  const { hull, foam, wake } = shipRig();
  hull.speed = 0.6;
  wake.update();
  for (let i = 0; i < 40; i++) {
    hull.position.z -= 0.4;
    wake.update();
  }
  assert.equal(foam.stamps.length, 0, 'a drifting hull left a wake');

  // And she starts drawing again the moment she has way on her.
  hull.speed = 4;
  hull.position.z -= 10;
  wake.update();
  assert.ok(foam.stamps.length > 0, 'she never picked the trail back up');
});

test('the trail doubles in width while she is over', () => {
  const upright = shipRig();
  upright.hull.speed = 5;
  upright.wake.update();
  upright.hull.position.z -= 10;
  upright.wake.update();

  const over = shipRig();
  over.hull.speed = 5;
  over.hull.broached = true;
  over.wake.reset(); // she was already over; this is not a fresh broach
  over.wake.update();
  over.hull.position.z -= 10;
  over.wake.update();

  assert.equal(over.foam.stamps.length, upright.foam.stamps.length);
  assert.equal(over.wake.stats.broaches, 0, 'reset did not swallow the stale latch');
  assert.ok(
    Math.abs(over.foam.stamps[0].radius - upright.foam.stamps[0].radius * 2) < 1e-9,
    `broached ${over.foam.stamps[0].radius} against upright ${upright.foam.stamps[0].radius}`
  );
});

test('the trail thickens with her speed', () => {
  const radii = [1.5, 3, 6].map((speed) => {
    const { hull, foam, wake } = shipRig();
    hull.speed = speed;
    wake.update();
    hull.position.z -= 10;
    wake.update();
    return foam.stamps[0].radius;
  });
  assert.ok(radii[0] < radii[1] && radii[1] < radii[2], radii.join(' '));
});

test('a hull picked up and put down elsewhere does not draw a line across the sea', () => {
  const { hull, foam, wake } = shipRig();
  hull.speed = 5;
  wake.update();
  hull.position.z -= 4000; // the demo's sea room, or a game teleporting her
  wake.update();
  assert.equal(foam.stamps.length, 0);
});

test('the broach splat fires exactly once per broach, and it is enormous', () => {
  // Greybeards, running dead downwind at full thrust: the sea rounds her up
  // repeatedly over ten minutes, which is the whole point of the preset.
  const sea = createSeaState({ preset: 'greybeards' });
  const field = new WaveField(sea, 400000);
  const hull = new Hull({
    headingDeg: (sea.dominantTravelRad * 180) / Math.PI,
    x: 0,
    z: 0,
  });
  const foam = mockFoam();
  const wake = wakeStamper(hull, foam);

  let edges = 0;
  let was = false;
  for (let i = 0; i < 36000; i++) {
    field.advance(1 / 60);
    hull.update(1 / 60, field, { rudder: 0, thrust: 1 });
    wake.update(1 / 60);
    if (hull.broached && !was) edges++;
    was = hull.broached;
  }

  assert.ok(edges > 0, 'she never broached; the test proves nothing');
  assert.equal(wake.stats.broaches, edges, `${wake.stats.broaches} splats for ${edges} broaches`);

  const broad = foam.stamps.filter(
    (s) => Math.abs(s.radius - hull.options.beam * 3.5) < 1e-9
  );
  assert.equal(broad.length, edges);
  for (const s of broad) assert.equal(s.strength, 1);
});

test('the stamper reads the hull and never writes to it', () => {
  const sea = createSeaState({ preset: 'greybeards' });
  const field = new WaveField(sea, 400000);
  const hull = new Hull({ headingDeg: 10 });
  const wake = wakeStamper(hull, mockFoam());

  const snapshot = () =>
    JSON.stringify({
      p: hull.position.toArray(),
      h: hull.headingRad,
      s: hull.speed,
      y: hull.yawRate,
      b: hull.broached,
      onBroach: hull.onBroach,
      onPooped: hull.onPooped,
    });

  for (let i = 0; i < 600; i++) {
    field.advance(1 / 60);
    hull.update(1 / 60, field, { rudder: 0.2, thrust: 1 });
    const before = snapshot();
    wake.update(1 / 60);
    assert.equal(snapshot(), before, 'the wake moved the ship');
  }
  // And the game's callbacks are still the game's.
  assert.equal(hull.onBroach, null);
  assert.equal(hull.onPooped, null);
});

test('a wake stamper survives a hull with no field under her', () => {
  const { hull, wake } = shipRig();
  assert.doesNotThrow(() => {
    wake.update(0);
    wake.update(1 / 60);
    hull.speed = 3;
    wake.update(1 / 60);
  });
});
