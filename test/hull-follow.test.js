import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hull, HULL_DEFAULTS } from '../src/hull.js';
import { createSeaState, WaveField } from '../src/index.js';

// A sea that rises and falls in place: the whole surface at one height, so heave
// is the only thing it asks of her. `height` is a function of the field's clock.
function swell(height) {
  const field = {
    time: 0,
    sea: { dominantSpeed: 10, dominantTravelRad: 0 },
    advance(dt) { this.time += dt; },
    heightAt() { return height(this.time); },
    gradientAt: () => ({ dx: 0, dz: 0 }),
    orbitalVelocityAt: (x, z, out) => out.set(0, 0, 0),
  };
  return field;
}

const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);

/** Heave error against the water, and heave amplitude, once she has settled. */
function ride(options, height, { hz = 60, seconds = 60, settle = 20 } = {}) {
  const field = swell(height);
  const hull = new Hull({ attitudeInertia: true, heaveTau: 0.7, ...options });
  const error = [], heave = [];
  for (let i = 0; i < hz * seconds; i++) {
    field.advance(1 / hz);
    hull.update(1 / hz, field);
    if (field.time < settle) continue;
    error.push(hull.heave - height(field.time));
    heave.push(hull.heave);
  }
  return { error: rms(error), amplitude: rms(heave) * Math.SQRT2, hull };
}

test('following the water, she rides a long swell instead of trailing it', () => {
  const long = (t) => 5 * Math.sin((2 * Math.PI / 12) * t);
  const trailing = ride({}, long).error;
  const riding = ride({ heaveFollow: 1 }, long).error;
  assert.ok(trailing > 1, `the plain ease trails a 12 s swell by a metre or more (${trailing.toFixed(2)})`);
  assert.ok(riding < trailing * 0.1, `following, she is within a tenth of that (${riding.toFixed(3)})`);
});

test('following the water, she still smooths what is quicker than her tau', () => {
  const chop = (t) => Math.sin((2 * Math.PI / 0.8) * t);
  const { amplitude } = ride({ heaveFollow: 1, heaveTau: 1.5 }, chop);
  assert.ok(amplitude < 0.45, `a 0.8 s chop comes through at under half (${amplitude.toFixed(2)})`);
});

test('a part follow takes out that part of the lag', () => {
  const ramp = (t) => 0.5 * t;
  const lag = (follow) => {
    const { hull } = ride({ heaveFollow: follow }, ramp, { seconds: 30 });
    return ramp(30) - hull.heave;
  };
  // On a steady rise the plain ease lags by tau times the rate.
  // Sampled once a step, so each is good to about a step's worth of rise.
  assert.ok(Math.abs(lag(0) - 0.7 * 0.5) < 0.01);
  assert.ok(Math.abs(lag(0.5) - 0.5 * 0.7 * 0.5) < 0.01);
  assert.ok(Math.abs(lag(1)) < 0.01);
});

test('following is the same at thirty, sixty and a hundred and twenty steps a second', () => {
  const long = (t) => 5 * Math.sin((2 * Math.PI / 12) * t);
  const ends = [30, 60, 120].map((hz) => ride({ heaveFollow: 1, pitchFollow: 1 }, long, { hz }).hull.heave);
  // The rate is read off the last step, so a slower step sees it a little late: a few
  // centimetres on a five-metre swell, and no gain.
  for (const h of ends) assert.ok(Math.abs(h - ends[1]) < 0.06, `${h} against ${ends[1]}`);
});

test('a sea swapped under her is a jump, not a shove', () => {
  // The same rise, once as a sea that changes and once as a sea that is replaced.
  const run = (follow) => {
    const field = swell(() => 0);
    const hull = new Hull({ attitudeInertia: true, heaveTau: 0.7, heaveFollow: follow });
    const trace = [];
    for (let i = 0; i < 600; i++) {
      if (i === 120) {
        field.sea = { ...field.sea };
        field.heightAt = () => 3;
      }
      field.advance(1 / 60);
      hull.update(1 / 60, field);
      trace.push(hull.heave);
    }
    return trace;
  };
  const plain = run(0), following = run(1);
  for (let i = 0; i < plain.length; i++) assert.equal(following[i], plain[i]);
  assert.ok(Math.max(...following) <= 3, 'and she does not overshoot the new water');
});

test('a hull put somewhere by hand, or a clock that jumps, is not a shove either', () => {
  // Water that slopes along x and rises with time: moving her, or jumping the
  // clock, changes the height under her at once.
  const make = () => {
    const field = swell(() => 0);
    field.heightAt = (x) => 0.05 * x + 0.2 * field.time;
    return field;
  };
  const run = (follow, poke) => {
    const field = make();
    const hull = new Hull({ attitudeInertia: true, heaveTau: 0.7, heaveFollow: follow });
    let peak = 0;
    for (let i = 0; i < 600; i++) {
      if (i === 300) poke(hull, field);
      field.advance(1 / 60);
      hull.update(1 / 60, field);
      if (i >= 300) peak = Math.max(peak, Math.abs(hull._attitudeVelocity.heave));
    }
    return peak;
  };
  const moved = (hull) => { hull.position.x += 200; };
  const turned = (hull) => { hull.headingDeg = hull.headingDeg + 90; };
  const jumped = (hull, field) => { field.time += 30; };
  for (const poke of [moved, turned, jumped]) {
    // Ten metres of water arrive at once; the plain ease's answer to that is the bound.
    assert.ok(run(1, poke) <= run(0, poke) + 0.2 + 1e-9, poke.name);
  }
});

test('roll follows the waves, not the heel or the broach', () => {
  const field = swell(() => 0);
  const plain = new Hull({ attitudeInertia: true });
  const following = new Hull({ attitudeInertia: true, rollFollow: 1 });
  for (let i = 0; i < 300; i++) {
    field.advance(1 / 60);
    const heel = i < 100 ? 0 : 0.25;
    plain.update(1 / 60, field, { heel });
    following.update(1 / 60, field, { heel });
    assert.equal(following.roll, plain.roll);
  }
});

test('on a real storm she sits in the water when pitch and heave follow it', () => {
  const sail = (follow) => {
    const field = new WaveField(createSeaState({ preset: 'storm', seed: 1805, windFromDeg: 285 }), 40000);
    const hull = new Hull({ attitudeInertia: true, heaveTau: 0.7, headingDeg: 130, speed: 6,
      heaveFollow: follow, pitchFollow: follow });
    const bow = [], centre = [];
    const arm = hull.options.length * 0.45;
    for (let i = 0; i < 60 * 90; i++) {
      field.advance(1 / 60);
      hull.update(1 / 60, field, { thrust: 0.5 });
      if (i < 60 * 20) continue;
      const fx = Math.sin(hull.headingRad), fz = -Math.cos(hull.headingRad);
      const water = field.heightAt(hull.position.x + fx * arm, hull.position.z + fz * arm);
      bow.push(water - (hull.heave + Math.tan(hull.pitch) * arm));
      centre.push(field.heightAt(hull.position.x, hull.position.z) - hull.heave);
      assert.ok(Number.isFinite(hull.heave) && Number.isFinite(hull.pitch));
    }
    return { bow: rms(bow), centre: rms(centre) };
  };
  const plain = sail(0), following = sail(1);
  // The bow cannot follow the curve of a crest along her, only its slope.
  assert.ok(following.bow < plain.bow * 0.75, `bow ${following.bow.toFixed(2)} against ${plain.bow.toFixed(2)}`);
  assert.ok(following.centre < plain.centre * 0.6, `centre ${following.centre.toFixed(2)} against ${plain.centre.toFixed(2)}`);
});

test('nothing follows unless asked, so every other host floats as it did', () => {
  assert.equal(HULL_DEFAULTS.heaveFollow, 0);
  assert.equal(HULL_DEFAULTS.pitchFollow, 0);
  assert.equal(HULL_DEFAULTS.rollFollow, 0);
  const long = (t) => 5 * Math.sin((2 * Math.PI / 12) * t);
  const a = ride({}, long).hull, b = ride({ heaveFollow: 0, pitchFollow: 0, rollFollow: 0 }, long).hull;
  assert.equal(a.heave, b.heave);
  assert.equal(a.pitch, b.pitch);
});
