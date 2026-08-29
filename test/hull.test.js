// A hull is a feel before it is a physics, so these tests check behaviour:
// does she hold a course in a calm, does the helm work, does a following sea
// take her away from you, and does she survive being left alone for ten
// minutes in the worst of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Quaternion } from 'three';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { Hull, HULL_DEFAULTS } from '../src/hull.js';
import { AirOverSea } from '../src/airoversea.js';

const DT = 1 / 60;

/** Degrees into −180..180, so a course error is a course error. */
const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

function rig(preset, hullOptions = {}, seaOptions = {}) {
  const sea = createSeaState({ preset, ...seaOptions });
  const field = new WaveField(sea);
  const hull = new Hull({ headingDeg: 105, ...hullOptions });
  return { sea, field, hull };
}

/** Run her, and hand back whatever the caller was watching for. */
function sail({ field, hull }, seconds, controls, watch) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    field.advance(DT);
    hull.update(DT, field, typeof controls === 'function' ? controls(hull, field) : controls);
    if (watch) watch(hull, field, i);
  }
  return hull;
}

// --- Course keeping ----------------------------------------------------------

test('on calm she holds her heading within two degrees over a minute', () => {
  const r = rig('calm');
  let worst = 0;
  sail(r, 60, { rudder: 0, thrust: 1 }, (hull) => {
    worst = Math.max(worst, Math.abs(wrap(hull.headingDeg - 105)));
  });
  assert.ok(worst < 2, `wandered ${worst.toFixed(2)}°, want under 2°`);
});

test('full starboard helm turns her clockwise', () => {
  const r = rig('calm');
  let turned = 0;
  let previous = r.hull.headingDeg;
  sail(r, 30, { rudder: 1, thrust: 1 }, (hull) => {
    turned += wrap(hull.headingDeg - previous);
    previous = hull.headingDeg;
  });
  assert.ok(turned > 90, `came round only ${turned.toFixed(0)}° to starboard`);

  // And the other way, for the same reason.
  const p = rig('calm');
  let back = 0;
  let was = p.hull.headingDeg;
  sail(p, 30, { rudder: -1, thrust: 1 }, (hull) => {
    back += wrap(hull.headingDeg - was);
    was = hull.headingDeg;
  });
  assert.ok(back < -90, `came round only ${back.toFixed(0)}° to port`);
});

test('a hull barely making way barely answers her helm', () => {
  const turnUnder = (thrust) => {
    const r = rig('calm');
    sail(r, 20, { rudder: 0, thrust });
    const before = r.hull.headingDeg;
    sail(r, 30, { rudder: 1, thrust });
    return {
      turned: Math.abs(wrap(r.hull.headingDeg - before)),
      authority: r.hull.rudderAuthority,
      speed: r.hull.speed,
    };
  };

  const drifting = turnUnder(0);
  const running = turnUnder(1);
  assert.ok(drifting.speed < 0.5, `still making ${drifting.speed.toFixed(2)} m/s`);
  assert.ok(drifting.authority < 0.15, `authority ${drifting.authority.toFixed(2)} with no way on`);
  assert.ok(
    drifting.turned < running.turned / 5,
    `drifting she came round ${drifting.turned.toFixed(0)}° against ${running.turned.toFixed(0)}° under way`
  );
});

// --- Surfing and the rudder --------------------------------------------------

test('rudder authority collapses as she surfs', () => {
  const r = rig('greybeards');
  let pairedLow = 0;
  let samples = 0;
  sail(r, 300, { rudder: 0, thrust: 1 }, (hull) => {
    if (hull.surfFactor > 0.7) {
      samples++;
      if (hull.rudderAuthority < 0.6) pairedLow++;
    }
    assert.ok(hull.rudderAuthority >= 0 && hull.rudderAuthority <= 1);
    assert.ok(hull.surfFactor >= 0 && hull.surfFactor <= 1);
  });
  assert.ok(samples > 0, 'she never surfed in five minutes of greybeards');
  assert.equal(pairedLow, samples, 'surfing hard must always cost her the helm');
});

test('she runs faster down a face than she does on the level', () => {
  const flat = rig('calm');
  sail(flat, 120, { rudder: 0, thrust: 1 });

  const big = rig('greybeards');
  let peak = 0;
  sail(big, 300, { rudder: 0, thrust: 1 }, (hull) => {
    peak = Math.max(peak, hull.speed);
  });
  assert.ok(
    peak > flat.hull.speed * 1.3,
    `surged to ${peak.toFixed(2)} against a flat-water ${flat.hull.speed.toFixed(2)}`
  );
  assert.ok(peak <= HULL_DEFAULTS.maxSpeed * HULL_DEFAULTS.maxSurgeFactor + 1e-9);
});

// --- Broach ------------------------------------------------------------------

test('running downwind in greybeards she is in danger within five minutes', () => {
  const r = rig('greybeards');
  let first = null;
  sail(r, 300, { rudder: 0, thrust: 1 }, (hull, field) => {
    if (first === null && hull.broachRisk > 0.5) first = field.time;
  });
  assert.ok(first !== null, 'broachRisk never passed 0.5 in five minutes');
  assert.ok(first < 300);
});

test('a broach latches once, throws her down, and lets go again', () => {
  const r = rig('greybeards');
  const events = [];
  r.hull.onBroach = (hull) => {
    events.push({ t: r.field.time, risk: hull.broachRisk, broached: hull.broached });
  };

  let broachedFor = 0;
  let peakRoll = 0;
  sail(r, 300, { rudder: 0, thrust: 1 }, (hull) => {
    if (hull.broached) {
      broachedFor += DT;
      peakRoll = Math.max(peakRoll, Math.abs(hull.roll));
    }
  });

  assert.ok(events.length > 0, 'she never broached in five minutes of greybeards');
  for (const e of events) {
    assert.equal(e.broached, true, 'onBroach must fire with the latch already set');
    assert.ok(e.risk >= 1 - 1e-9, 'onBroach must fire at full risk');
  }
  assert.ok(broachedFor > 1, 'a broach that lasts no time is not a broach');
  assert.ok(peakRoll > 0.2, `only rolled ${peakRoll.toFixed(2)} rad going over`);
  assert.equal(r.hull.broached, false, 'she must come out of it eventually');
});

test('once the broach clears the helm brings her back', () => {
  const r = rig('greybeards');
  let broached = false;
  r.hull.onBroach = () => {
    broached = true;
  };

  // Leave her to it until she goes over and comes back out.
  const steps = Math.round(300 / DT);
  let cleared = false;
  for (let i = 0; i < steps && !cleared; i++) {
    r.field.advance(DT);
    r.hull.update(DT, r.field, { rudder: 0, thrust: 1 });
    cleared = broached && !r.hull.broached;
  }
  assert.ok(cleared, 'she never broached and recovered');

  // Now put a helmsman back on her and steer the old course.
  sail(r, 180, (hull) => ({
    rudder: Math.max(-1, Math.min(1, wrap(105 - hull.headingDeg) / 20)),
    thrust: 0.6,
  }));
  assert.ok(
    Math.abs(wrap(r.hull.headingDeg - 105)) < 20,
    `left ${wrap(r.hull.headingDeg - 105).toFixed(0)}° off course after recovery`
  );
  assert.equal(r.hull.broached, false);
});

test('a calm sea cannot broach her', () => {
  const r = rig('calm');
  r.hull.onBroach = () => assert.fail('broached in a glassy heave');
  sail(r, 600, { rudder: 0, thrust: 1 }, (hull) => {
    assert.ok(hull.broachRisk < 0.5);
  });
});

// --- Pooped ------------------------------------------------------------------

test('seas come aboard over the taffrail in a storm, once each', () => {
  const r = rig('storm');
  const at = [];
  r.hull.onPooped = () => at.push(r.field.time);
  sail(r, 600, { rudder: 0, thrust: 1 });

  assert.ok(at.length > 0, 'nothing came aboard in ten minutes of storm');
  // The latch is on the stern drying out, so two seas cannot share a crest.
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] - at[i - 1] > 1, `two poopings ${at[i] - at[i - 1]}s apart`);
  }
});

test('a pooping costs her the helm for a moment', () => {
  const r = rig('storm');
  let checked = false;
  r.hull.onPooped = (hull) => {
    // The penalty lands on the following step, so look then.
    const before = hull.rudderAuthority;
    r.field.advance(DT);
    hull.update(DT, r.field, { rudder: 0, thrust: 1 });
    assert.ok(
      hull.rudderAuthority <= before * HULL_DEFAULTS.poopAuthority + 0.05,
      'the rudder should be all but gone with the deck full of water'
    );
    checked = true;
  };
  sail(r, 300, { rudder: 0, thrust: 1 });
  assert.ok(checked);
});

test('nothing comes aboard a glassy heave', () => {
  const r = rig('calm');
  r.hull.onPooped = () => assert.fail('pooped in a calm');
  sail(r, 300, { rudder: 0, thrust: 1 });
});

// --- Robustness --------------------------------------------------------------

test('ten minutes at a sixtieth of a second produces no NaN anywhere', () => {
  for (const preset of ['calm', 'breeze', 'gale', 'storm', 'greybeards']) {
    const r = rig(preset);
    // Wring her out: helm hard over both ways, thrust up and down.
    sail(r, 600, (hull, field) => ({
      rudder: Math.sin(field.time * 0.37),
      thrust: 0.5 + 0.5 * Math.sin(field.time * 0.11),
    }), (hull) => {
      const q = hull.quaternion;
      const numbers = [
        hull.position.x, hull.position.y, hull.position.z,
        hull.speed, hull.heave, hull.pitch, hull.roll,
        hull.headingRad, hull.headingDeg, hull.yawRate,
        hull.surfFactor, hull.broachRisk, hull.rudderAuthority, hull.waveYaw,
        q.x, q.y, q.z, q.w,
      ];
      for (const v of numbers) {
        assert.ok(Number.isFinite(v), `${preset}: non-finite ${v}`);
      }
      assert.ok(Math.abs(q.length() - 1) < 1e-6, `${preset}: quaternion not unit`);
      assert.ok(hull.position.y >= r.sea.hMin - 1 && hull.position.y <= r.sea.hMax + 1);
    });
  }
});

test('a zero or negative step is ignored rather than dividing by it', () => {
  const r = rig('storm');
  sail(r, 5, { rudder: 0.4, thrust: 1 });
  const before = { ...r.hull.position };
  r.hull.update(0, r.field, { rudder: 1, thrust: 1 });
  r.hull.update(-1, r.field, { rudder: 1, thrust: 1 });
  assert.equal(r.hull.position.x, before.x);
  assert.ok(Number.isFinite(r.hull.roll));
});

// --- What a renderer is handed -----------------------------------------------

test('the transform is a mesh you can drop straight on the water', () => {
  const r = rig('storm');
  sail(r, 40, { rudder: 0.2, thrust: 1 });
  const hull = r.hull;

  assert.ok(Math.abs(hull.position.y - hull.heave) < 1e-12, 'y must be the heave');

  // Bow down her own −Z, so a mesh built the three.js way points where she is
  // going: compass forward is (sin β, −cos β).
  const forward = { x: 0, y: 0, z: -1 };
  const q = hull.quaternion;
  // Rotate (0,0,−1) by q, longhand, to avoid leaning on the same helper twice.
  const ix = q.w * forward.x + q.y * forward.z - q.z * forward.y;
  const iy = q.w * forward.y + q.z * forward.x - q.x * forward.z;
  const iz = q.w * forward.z + q.x * forward.y - q.y * forward.x;
  const iw = -q.x * forward.x - q.y * forward.y - q.z * forward.z;
  const fx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  const fz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;

  // Pitch tips that vector out of the horizontal, so compare where she is
  // pointing on the chart, not in space.
  const hlen = Math.hypot(fx, fz);
  const beta = hull.headingRad;
  assert.ok(Math.abs(fx / hlen - Math.sin(beta)) < 1e-6, `forward x ${fx / hlen} vs ${Math.sin(beta)}`);
  assert.ok(Math.abs(fz / hlen + Math.cos(beta)) < 1e-6, `forward z ${fz / hlen} vs ${-Math.cos(beta)}`);

  // And the attitude is exactly the eased scalars, in three.js's reading.
  const expected = new Quaternion().setFromEuler(
    new Euler(hull.pitch, -hull.headingRad, -hull.roll, 'YXZ')
  );
  assert.ok(Math.abs(q.dot(expected)) > 1 - 1e-9);
});

test('headingDeg reads as a compass course, both ways', () => {
  const hull = new Hull({ headingDeg: 359 });
  assert.ok(Math.abs(hull.headingDeg - 359) < 1e-9);
  hull.headingDeg = -30;
  assert.ok(Math.abs(hull.headingDeg - 330) < 1e-9);
});

// --- Every constant is a tunable ---------------------------------------------

test('every constant the model uses is on the options object', () => {
  const hull = new Hull();
  for (const key of Object.keys(HULL_DEFAULTS)) {
    assert.ok(key in hull.options, `${key} is not a tunable`);
    assert.ok(Number.isFinite(hull.options[key]), `${key} is not a number`);
  }
  // The contract's own numbers, which nothing may quietly change.
  assert.equal(HULL_DEFAULTS.length, 39);
  assert.equal(HULL_DEFAULTS.beam, 9.9);
  assert.equal(HULL_DEFAULTS.draught, 4.3);
  assert.equal(HULL_DEFAULTS.mass, 500e3);
  assert.equal(HULL_DEFAULTS.heaveTau, 1.5);
  assert.equal(HULL_DEFAULTS.pitchTau, 1.9);
  assert.equal(HULL_DEFAULTS.rollTau, 2.1);
  assert.equal(HULL_DEFAULTS.maxSpeed, 6);
  assert.equal(HULL_DEFAULTS.rudderPower, 0.25);
  assert.equal(HULL_DEFAULTS.yawDamping, 0.8);
  assert.equal(HULL_DEFAULTS.headingDeg, 105);
  assert.equal(HULL_DEFAULTS.sampleFore, 0.35);
  assert.equal(HULL_DEFAULTS.sampleBeam, 0.45);
  assert.equal(HULL_DEFAULTS.pitchGain, 0.85);
  assert.equal(HULL_DEFAULTS.rollGain, 0.6);
  assert.equal(HULL_DEFAULTS.surfAuthorityLoss, 0.8);
  assert.equal(HULL_DEFAULTS.rudderFlowFraction, 0.5);
  assert.equal(HULL_DEFAULTS.surfYawGain, 2);
  assert.equal(HULL_DEFAULTS.broachRoll, 0.35);
  assert.equal(HULL_DEFAULTS.poopSurfLimit, 0.3);
  assert.equal(HULL_DEFAULTS.poopAuthority, 0.3);
});

test('a heavier ship answers the sea more slowly', () => {
  const light = new Hull({ mass: 500e3 / 64 });
  const heavy = new Hull({ mass: 500e3 * 64 });
  assert.ok(light.options.heaveTau < HULL_DEFAULTS.heaveTau);
  assert.ok(heavy.options.rollTau > HULL_DEFAULTS.rollTau);
  // Unless you say otherwise, in which case you win.
  assert.equal(new Hull({ mass: 9e9, heaveTau: 0.4 }).options.heaveTau, 0.4);
});

test('two hulls given the same sea and the same helm do the same thing', () => {
  const a = rig('storm');
  const b = rig('storm');
  const helm = (hull, field) => ({ rudder: Math.sin(field.time * 0.3), thrust: 0.8 });
  sail(a, 120, helm);
  sail(b, 120, helm);
  assert.equal(a.hull.headingRad, b.hull.headingRad);
  assert.equal(a.hull.position.x, b.hull.position.x);
  assert.equal(a.hull.position.z, b.hull.position.z);
  assert.equal(a.hull.roll, b.hull.roll);
});

// --- The field and the air ---------------------------------------------------

test('the field steps once and every query in the frame sees the same sea', () => {
  const sea = createSeaState({ preset: 'gale' });
  const field = new WaveField(sea, 12000);
  assert.equal(field.extent, 12000);
  assert.equal(field.half, 6000);
  assert.equal(field.time, 0);
  assert.ok(field.contains(0, 0));
  assert.ok(!field.contains(6001, 0));
  assert.ok(!field.contains(0, 5950, 100));

  field.advance(3.5);
  assert.equal(field.time, 3.5);
  assert.equal(field.heightAt(10, 20), sea.heightAt(10, 20, 3.5));
  assert.deepEqual(field.gradientAt(10, 20), sea.gradientAt(10, 20, 3.5));
});

test('a live sea change keeps the clock running', () => {
  const field = new WaveField(createSeaState({ preset: 'calm' }));
  field.advance(11);
  const bigger = createSeaState({ preset: 'greybeards' });
  field.setSeaState(bigger);
  assert.equal(field.time, 11);
  assert.equal(field.sea, bigger);
  assert.equal(field.hMax, bigger.hMax);
});

test('the air takes its wind from the sea, and follows a change of weather', () => {
  const field = new WaveField(createSeaState({ preset: 'gale', windFromDeg: 0 }));
  const air = new AirOverSea(field);
  air.update(0.5);

  assert.ok(air.windSpeed > 10, `gale wind only ${air.windSpeed.toFixed(1)} m/s`);
  // Wind from the north blows toward the south, which is +z.
  assert.ok(air.wind.z > 0);
  assert.ok(Math.abs(air.wind.x) < 1e-6);
  assert.deepEqual(air.nearbyThermals(), []);
  assert.deepEqual(air.thermals, []);

  const gentle = air.windSpeed;
  field.setSeaState(createSeaState({ preset: 'calm', windFromDeg: 90 }));
  air.update(0.5);
  assert.ok(air.windSpeed < gentle / 2, 'the air must ease with the sea');
  assert.ok(air.wind.x < 0, 'wind from the east blows toward the west');
});

test('the air lifts on a windward face and finite everywhere', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }));
  const air = new AirOverSea(field);
  air.update(1);

  let up = 0;
  let down = 0;
  for (let i = -20; i <= 20; i++) {
    for (let j = -20; j <= 20; j++) {
      const x = i * 37;
      const z = j * 41;
      const y = field.heightAt(x, z) + 12;
      const v = air.velocityAt(x, y, z).clone();
      assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
      if (v.y > 0) up++;
      else down++;
    }
  }
  assert.ok(up > 100 && down > 100, `lift ${up} / sink ${down} — one-sided`);

  // Streets are a boundary-layer thing; there is nothing up at the scud base
  // and nothing down in the water.
  assert.equal(air.streetLiftAt(0, 5, 0), 0);
  assert.equal(air.streetLiftAt(0, 5000, 0), 0);
  assert.equal(air.waveLiftAt(0, field.heightAt(0, 0) - 5, 0), 0);
});
