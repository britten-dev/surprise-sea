// What comes aboard, and when.
//
// These are tuning assertions before they are unit tests. The contract states
// the feel in one sentence — calm fires nothing, a storm at working canvas
// takes occasional bow plunges and rare stern seas, greybeards at full thrust
// is regularly wet and a broach dips the rail — and the point of the file is
// to hold the default thresholds to it. So the bounds are wide enough that a
// small change of taste does not break them, and tight enough that a change of
// *behaviour* does.
//
// Everything drives a real Hull through a real preset at a fixed step, exactly
// as hull.test.js does. The runs are ten simulated minutes each and cost real
// seconds, so the scenarios are built once and shared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { Hull, HULL_DEFAULTS } from '../src/hull.js';
import { shipSeas, SHIPSEAS_DEFAULTS, DEFAULT_REGIONS } from '../src/shipseas.js';

const DT = 1 / 60;

/** Helm and canvas worried about, for the runs that must survive anything. */
const WRUNG = (hull, field) => ({
  rudder: Math.sin(field.time * 0.37),
  thrust: 0.5 + 0.5 * Math.sin(field.time * 0.11),
});

/**
 * Ten minutes of one preset at one thrust, with every event logged and the
 * broaches bracketed, so a test can ask what happened rather than watch for it.
 */
function voyage({
  preset,
  thrust = 1,
  seconds = 600,
  headingDeg = 105,
  options = {},
  controls = null,
}) {
  const sea = createSeaState({ preset });
  const field = new WaveField(sea);
  const hull = new Hull({ headingDeg });
  const seas = shipSeas(hull, field, options);
  const helm = controls === 'wrung' ? WRUNG : controls;

  const log = { plunge: [], green: [], stern: [], rail: [] };
  seas.onBowPlunge = (e) => {
    // Where the library says the bow is, against where it says the plunge was.
    const w = seas.toWorld(seas.points.bow);
    log.plunge.push({ t: field.time, ...e, offBow: Math.hypot(e.x - w.x, e.z - w.z) });
  };
  seas.onGreenWater = (e) => log.green.push({ t: field.time, ...e });
  seas.onSternSea = (e) => log.stern.push({ t: field.time, ...e });
  seas.onRailDip = (e) => log.rail.push({ t: field.time, ...e, roll: hull.roll });

  // A broach is a span, not an instant, and the side she lies to is the sign
  // of the roll at the bottom of it.
  const broaches = [];
  let open = null;

  const steps = Math.round(seconds / DT);
  let wetSteps = 0;
  let awashSteps = 0;
  let peakWater = 0;

  for (let i = 0; i < steps; i++) {
    field.advance(DT);
    hull.update(
      DT,
      field,
      typeof helm === 'function' ? helm(hull, field) : { rudder: 0, thrust }
    );
    seas.update(DT);

    if (hull.broached) {
      if (!open) open = { from: field.time, to: field.time, roll: hull.roll };
      open.to = field.time;
      if (Math.abs(hull.roll) > Math.abs(open.roll)) open.roll = hull.roll;
    } else if (open) {
      broaches.push(open);
      open = null;
    }

    const w = Math.max(...Object.values(seas.water));
    peakWater = Math.max(peakWater, w);
    if (w > 0.05) wetSteps++;
    if (w > 0.2) awashSteps++;
  }
  if (open) broaches.push(open);

  return {
    sea, field, hull, seas, log, broaches, steps,
    stats: { ...seas.stats },
    wet: wetSteps / steps,
    awash: awashSteps / steps,
    peakWater,
  };
}

const cache = new Map();
const scenario = (spec) => {
  const key = JSON.stringify(spec);
  if (!cache.has(key)) cache.set(key, voyage(spec));
  return cache.get(key);
};

const total = (stats) => Object.values(stats).reduce((a, b) => a + b, 0);

// --- The tuning sentence -----------------------------------------------------

test('a calm ships nothing at all, whatever you do with the helm', () => {
  for (const preset of ['calm', 'breeze']) {
    const steady = scenario({ preset, thrust: 1 });
    assert.equal(
      total(steady.stats),
      0,
      `${preset} ran to ${JSON.stringify(steady.stats)} running downwind`
    );
    assert.equal(steady.peakWater, 0, `${preset} left water on deck`);

    // And not merely on the one heading. Wring her out across the sea and back.
    const wrung = scenario({
      preset,
      headingDeg: 15,
      controls: 'wrung',
      seconds: 180,
    });
    assert.equal(total(wrung.stats), 0, `${preset} shipped water beam-on`);
  }
});

test('a storm at working canvas takes occasional bow plunges and rare stern seas', () => {
  const r = scenario({ preset: 'storm', thrust: 0.6 });

  // Occasional: several in ten minutes, not one a minute and not none.
  assert.ok(
    r.stats.bowPlunge >= 2 && r.stats.bowPlunge <= 25,
    `${r.stats.bowPlunge} bow plunges in ten minutes of storm`
  );
  // Rare: it happens, and it does not keep happening.
  assert.ok(
    r.stats.sternSea >= 1 && r.stats.sternSea <= 10,
    `${r.stats.sternSea} stern seas in ten minutes of storm`
  );
  assert.ok(
    r.stats.sternSea <= r.stats.bowPlunge,
    'she should bury her bow more often than she is pooped'
  );
  // Wet, but not swimming: the decks are clear the great majority of the time.
  assert.ok(r.wet > 0.002 && r.wet < 0.2, `decks wet ${(r.wet * 100).toFixed(1)}% of the time`);
});

test('greybeards at full thrust keep her decks wet', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  const storm = scenario({ preset: 'storm', thrust: 0.6 });

  assert.ok(r.stats.greenWater >= 30, `only ${r.stats.greenWater} seas aboard in ten minutes`);
  assert.ok(r.stats.bowPlunge >= 5, `only ${r.stats.bowPlunge} bow plunges`);
  assert.ok(r.awash > 0.04, `deck awash only ${(r.awash * 100).toFixed(1)}% of the time`);
  assert.ok(r.peakWater > 0.9, 'a greybeard should fill a deck completely');

  // And it must be worse than the storm, on every count that matters.
  assert.ok(r.stats.greenWater > storm.stats.greenWater);
  assert.ok(r.stats.bowPlunge > storm.stats.bowPlunge);
  assert.ok(r.awash > storm.awash);
});

test('a broach puts the rail she is lying on under', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  assert.ok(r.broaches.length > 0, 'she never broached in ten minutes of greybeards');

  // Positive roll is heeled to starboard, so that is the rail in the water.
  const leeSide = (b) => (b.roll > 0 ? 'starboard' : 'port');
  const inside = (b) => r.log.rail.filter((d) => d.t >= b.from && d.t <= b.to);

  const dipped = r.broaches.filter((b) => inside(b).some((d) => d.side === leeSide(b)));
  assert.ok(
    dipped.length > 0,
    `${r.broaches.length} broaches and not one of them put a rail under`
  );

  // Never the weather rail: she is over on her side, and it is the low one
  // that goes in.
  for (const b of r.broaches) {
    for (const d of inside(b)) {
      assert.equal(
        d.side,
        leeSide(b),
        `dipped the ${d.side} rail while lying to ${leeSide(b)} (roll ${b.roll.toFixed(2)})`
      );
    }
  }
});

// --- The continuous half -----------------------------------------------------

test('water on deck drains away once the sea stops coming aboard', () => {
  const sea = createSeaState({ preset: 'greybeards' });
  const field = new WaveField(sea);
  const hull = new Hull({ headingDeg: 105 });
  const seas = shipSeas(hull, field);

  // Run her until a deck is properly full.
  let filled = 0;
  for (let i = 0; i < 600 / DT && filled < 0.6; i++) {
    field.advance(DT);
    hull.update(DT, field, { rudder: 0, thrust: 1 });
    seas.update(DT);
    filled = Math.max(...Object.values(seas.water));
  }
  assert.ok(filled >= 0.6, 'never got a deck full enough to watch it empty');

  // Now take her out of the water altogether — nothing more can come aboard,
  // and what is aboard has only the scuppers to leave by.
  hull.position.y = 400;
  const start = filled;
  let previous = start;
  let dryAt = null;
  for (let i = 0; i < 60 / DT; i++) {
    field.advance(DT);
    seas.update(DT);
    const now = Math.max(...Object.values(seas.water));
    assert.ok(now <= previous + 1e-12, 'water rose on a deck the sea cannot reach');
    assert.ok(now >= 0, 'water went negative');
    previous = now;
    if (dryAt === null && now === 0) dryAt = (i + 1) * DT;
  }

  // At drainRate a second, and no faster: the deck holds its water for a while.
  const expected = start / SHIPSEAS_DEFAULTS.drainRate;
  assert.ok(dryAt !== null, 'the deck never emptied');
  assert.ok(
    Math.abs(dryAt - expected) < expected * 0.05 + 0.05,
    `drained in ${dryAt.toFixed(2)}s, expected about ${expected.toFixed(2)}s`
  );
  for (const v of Object.values(seas.water)) assert.equal(v, 0);
});

test('the water scalars stay inside nought and one', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  for (const v of Object.values(r.seas.water)) {
    assert.ok(v >= 0 && v <= 1, `water ${v} out of range`);
  }
  assert.ok(r.peakWater <= 1);
});

// --- Rate limits -------------------------------------------------------------

test('no two events of a kind inside their cooldown', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  const o = SHIPSEAS_DEFAULTS;

  const gaps = (times) => times.slice(1).map((t, i) => t - times[i]);
  const noneCloserThan = (times, limit, what) => {
    for (const g of gaps(times)) {
      assert.ok(g >= limit - 1e-9, `two ${what} ${g.toFixed(2)}s apart, limit ${limit}s`);
    }
  };

  assert.ok(r.log.plunge.length > 1, 'not enough bow plunges to test the rate limit');
  noneCloserThan(r.log.plunge.map((e) => e.t), o.plungeCooldown, 'bow plunges');
  noneCloserThan(r.log.stern.map((e) => e.t), o.sternSeaCooldown, 'stern seas');

  // Green water and rail dips are limited per region and per side: the waist
  // filling has nothing to say about the foredeck, and one rail going under
  // does not stop the other.
  for (const region of DEFAULT_REGIONS.map((x) => x.name)) {
    const times = r.log.green.filter((e) => e.region === region).map((e) => e.t);
    assert.ok(times.length > 1, `not enough green water on the ${region}`);
    noneCloserThan(times, o.greenWaterCooldown, `${region} seas`);
  }
  for (const side of ['port', 'starboard']) {
    const times = r.log.rail.filter((e) => e.side === side).map((e) => e.t);
    assert.ok(times.length > 1, `not enough ${side} rail dips`);
    noneCloserThan(times, o.railDipCooldown, `${side} rail dips`);
  }
});

test('an immersion that hangs about is one event, not thirty', () => {
  // Hold her still under a sea that never leaves: the deck stays buried, and
  // the latch must not release, so nothing fires again.
  const field = new WaveField(createSeaState({ preset: 'calm' }));
  const hull = new Hull({ headingDeg: 0 });
  const flood = { sea: field.sea, heightAt: () => 60 };
  const seas = shipSeas(hull, flood);

  for (let i = 0; i < 120 / DT; i++) seas.update(DT);

  assert.equal(seas.stats.greenWater, DEFAULT_REGIONS.length, 'one sea per region, no more');
  assert.equal(seas.stats.railDip, 2, 'one dip a side');
  for (const v of Object.values(seas.water)) assert.equal(v, 1, 'and the decks stay full');
});

// --- The payloads ------------------------------------------------------------

test('every payload says what the contract says it says', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  const names = DEFAULT_REGIONS.map((x) => x.name);

  for (const e of r.log.plunge) {
    assert.ok(e.energy > 0 && e.energy <= 1, `plunge energy ${e.energy}`);
    assert.ok(Number.isFinite(e.x) && Number.isFinite(e.z));
    // The place is where the bow was, not where the hull's origin was.
    assert.ok(Math.hypot(e.x, e.z) > 0);
  }
  for (const e of r.log.green) {
    assert.ok(names.includes(e.region), `unknown region ${e.region}`);
    assert.ok(e.depth > SHIPSEAS_DEFAULTS.greenWaterDepth, `shipped only ${e.depth} m`);
  }
  for (const e of r.log.stern) {
    assert.ok(e.force > 0 && e.force <= 1, `stern force ${e.force}`);
  }
  for (const e of r.log.rail) {
    assert.ok(e.side === 'port' || e.side === 'starboard', `side ${e.side}`);
  }

  // The stats are exactly the callbacks, counted.
  assert.deepEqual(r.stats, {
    bowPlunge: r.log.plunge.length,
    greenWater: r.log.green.length,
    sternSea: r.log.stern.length,
    railDip: r.log.rail.length,
  });
});

test('a bow plunge reports the place the bow actually was', () => {
  const r = scenario({ preset: 'greybeards', thrust: 1 });
  assert.ok(r.log.plunge.length > 0, 'she never buried her bow');
  for (const e of r.log.plunge) {
    assert.ok(e.offBow < 1e-9, `plunge reported ${e.offBow} m from the bow`);
  }
});

// --- Where the points are ----------------------------------------------------

test('a hull picked up and put down somewhere else is not a plunge', () => {
  // Sea room wrapping teleports a demo hull across the ocean, and the gap
  // under her bow changes by a hundred metres in one step. That is not a wave.
  const field = new WaveField(createSeaState({ preset: 'storm' }));
  const level = { h: -100 };
  const jumped = shipSeas(new Hull({ headingDeg: 105 }), {
    sea: field.sea,
    heightAt: () => level.h,
  });
  jumped.update(DT);
  level.h = 60;
  jumped.update(DT);
  assert.equal(jumped.stats.bowPlunge, 0, 'a teleport read as the plunge of the century');

  // A sea arriving at a speed a sea can manage still counts.
  const met = shipSeas(new Hull({ headingDeg: 105 }), {
    sea: field.sea,
    heightAt: () => level.h,
  });
  level.h = SHIPSEAS_DEFAULTS.freeboard + SHIPSEAS_DEFAULTS.sheer - 0.1;
  met.update(DT);
  level.h += 0.2;
  met.update(DT);
  assert.equal(met.stats.bowPlunge, 1, 'a bow meeting a face at 12 m/s is a plunge');
});

test('the region defaults span her from stem to sternpost', () => {
  const seas = shipSeas(new Hull(), new WaveField(createSeaState({ preset: 'calm' })));
  const regions = seas.regions;

  assert.deepEqual(
    regions.map((r) => r.name),
    ['foredeck', 'waist', 'quarterdeck']
  );
  assert.equal(regions[0].from, -0.5, 'the foredeck must start at the stem');
  assert.equal(regions[regions.length - 1].to, 0.5, 'the quarterdeck must end at the sternpost');
  for (let i = 1; i < regions.length; i++) {
    assert.equal(regions[i].from, regions[i - 1].to, 'a gap between decks would swallow a sea');
  }
  // Every centre point is on her, on the centreline, and above the waterline.
  const half = HULL_DEFAULTS.length / 2;
  for (const r of regions) {
    assert.ok(Math.abs(r.point.z) < half, `${r.name} centre is off the ship`);
    assert.equal(r.point.x, 0);
    assert.ok(r.point.y >= SHIPSEAS_DEFAULTS.freeboard);
    assert.ok(r.name in seas.water && seas.water[r.name] === 0);
  }
  // The ends stand highest: that is what sheer is for.
  const stemHead = SHIPSEAS_DEFAULTS.freeboard + SHIPSEAS_DEFAULTS.sheer;
  assert.ok(Math.abs(seas.points.bow.y - stemHead) < 1e-12);
  assert.equal(seas.points.stern.y, seas.points.bow.y);
  assert.ok(seas.points.bow.y > regions[1].point.y, 'the waist must be the lowest deck');
});

test('the sample points ride her the way a mesh does', () => {
  const field = new WaveField(createSeaState({ preset: 'calm' }));
  const hull = new Hull({ headingDeg: 30, x: 120, z: -40 });
  const seas = shipSeas(hull, field);

  const beta = hull.headingRad;
  const forward = { x: Math.sin(beta), z: -Math.cos(beta) };
  const starboard = { x: Math.cos(beta), z: Math.sin(beta) };

  // Bow down her own −Z, which on the chart is her course.
  const bow = seas.toWorld(seas.points.bow, new Vector3());
  const arm = HULL_DEFAULTS.length / 2;
  assert.ok(Math.abs(bow.x - (120 + forward.x * arm)) < 1e-9);
  assert.ok(Math.abs(bow.z - (-40 + forward.z * arm)) < 1e-9);
  assert.ok(Math.abs(bow.y - seas.points.bow.y) < 1e-9);

  const stern = seas.toWorld(seas.points.stern, new Vector3());
  assert.ok(Math.abs(stern.x - (120 - forward.x * arm)) < 1e-9);

  // Local +X is her starboard side.
  const rail = seas.toWorld(seas.points.rails.starboard[2], new Vector3());
  const off = { x: rail.x - 120, z: rail.z + 40 };
  assert.ok(off.x * starboard.x + off.z * starboard.z > 0, 'the starboard rail is to port');

  // And when she lies over, the lee rail is the one in the water.
  const heeled = new Hull({ headingDeg: 30 });
  const heeledSeas = shipSeas(heeled, field);
  heeled.roll = 0.4;
  heeled.headingDeg = 30; // the setter re-syncs the transform from the scalars
  const port = heeledSeas.toWorld(heeledSeas.points.rails.port[2], new Vector3());
  const stbd = heeledSeas.toWorld(heeledSeas.points.rails.starboard[2], new Vector3());
  assert.ok(stbd.y < port.y, 'heeled to starboard, the starboard rail must be the low one');
});

test('the decks and the rails can be moved wherever a ship wants them', () => {
  const field = new WaveField(createSeaState({ preset: 'calm' }));
  const hull = new Hull({ length: 60 });
  const seas = shipSeas(hull, field, {
    freeboard: 1,
    sheer: 0,
    railPoints: 3,
    regions: [
      { name: 'forward', from: -0.5, to: 0 },
      { name: 'aft', from: 0, to: 0.5 },
    ],
  });

  assert.deepEqual(Object.keys(seas.water), ['forward', 'aft']);
  assert.equal(seas.regions[0].point.z, -15);
  assert.equal(seas.regions[1].point.z, 15);
  assert.equal(seas.points.bow.y, 1, 'no sheer, so the stem head is the plain freeboard');
  assert.equal(seas.points.rails.port.length, 3);
  assert.equal(seas.points.bow.z, -30);
});

// --- The hull is read, never written -----------------------------------------

test('nothing here touches the hull', () => {
  const field = new WaveField(createSeaState({ preset: 'greybeards' }));
  const hull = new Hull({ headingDeg: 105 });
  const seas = shipSeas(hull, field);

  // Everything the hull owns, deeply, including its private latches.
  const snapshot = () => JSON.parse(JSON.stringify(hull));

  for (let i = 0; i < 120 / DT; i++) {
    field.advance(DT);
    hull.update(DT, field, { rudder: 0.3, thrust: 1 });
    const before = snapshot();
    seas.update(DT);
    assert.deepEqual(snapshot(), before, 'the sea layer moved the ship');
  }
  assert.ok(total(seas.stats) > 0, 'a run with no events proves nothing');
});

// --- Determinism and arithmetic ----------------------------------------------

test('two identical voyages ship identical water', () => {
  const a = voyage({ preset: 'greybeards', thrust: 1, seconds: 180 });
  const b = voyage({ preset: 'greybeards', thrust: 1, seconds: 180 });

  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(a.seas.water, b.seas.water);
  assert.deepEqual(a.seas.depth, b.seas.depth);
  assert.deepEqual(a.log, b.log);
  assert.equal(a.seas.time, b.seas.time);
});

test('ten minutes of every preset produces no NaN and nothing out of range', () => {
  for (const preset of ['calm', 'breeze', 'gale', 'storm', 'greybeards']) {
    const sea = createSeaState({ preset });
    const field = new WaveField(sea);
    const hull = new Hull({ headingDeg: 105 });
    const seas = shipSeas(hull, field);

    let plunges = 0;
    let sterns = 0;
    seas.onBowPlunge = (e) => {
      plunges++;
      assert.ok(Number.isFinite(e.energy) && Number.isFinite(e.x) && Number.isFinite(e.z));
    };
    seas.onSternSea = (e) => {
      sterns++;
      assert.ok(Number.isFinite(e.force));
    };

    for (let i = 0; i < 600 / DT; i++) {
      field.advance(DT);
      // Wring her out: helm hard over both ways, thrust up and down.
      hull.update(DT, field, {
        rudder: Math.sin(field.time * 0.37),
        thrust: 0.5 + 0.5 * Math.sin(field.time * 0.11),
      });
      seas.update(DT);

      for (const [k, v] of Object.entries(seas.water)) {
        assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${preset}: water.${k} = ${v}`);
      }
      for (const [k, v] of Object.entries(seas.depth)) {
        assert.ok(Number.isFinite(v), `${preset}: depth.${k} = ${v}`);
        assert.ok(v > sea.hMin - 100 && v < sea.hMax + 100, `${preset}: depth.${k} = ${v}`);
      }
      for (const v of Object.values(seas.stats)) assert.ok(Number.isInteger(v));
    }
    assert.ok(Number.isFinite(seas.time));
    assert.ok(plunges >= 0 && sterns >= 0);
  }
});

test('a zero or negative step is ignored rather than divided by', () => {
  const r = voyage({ preset: 'storm', thrust: 1, seconds: 60 });
  const { seas } = r;
  const stats = { ...seas.stats };
  const water = { ...seas.water };
  const t = seas.time;

  seas.update(0);
  seas.update(-1);
  seas.update(NaN);

  assert.deepEqual({ ...seas.stats }, stats);
  assert.deepEqual({ ...seas.water }, water);
  assert.equal(seas.time, t);
});

test('reset dries her out and forgets', () => {
  const r = voyage({ preset: 'greybeards', thrust: 1, seconds: 240 });
  assert.ok(total(r.seas.stats) > 0);

  r.seas.reset();
  assert.deepEqual(r.seas.stats, { bowPlunge: 0, greenWater: 0, sternSea: 0, railDip: 0 });
  for (const v of Object.values(r.seas.water)) assert.equal(v, 0);
  for (const v of Object.values(r.seas.depth)) assert.equal(v, 0);
  assert.equal(r.seas.time, 0);

  // And she goes on working afterwards.
  for (let i = 0; i < 120 / DT; i++) {
    r.field.advance(DT);
    r.hull.update(DT, r.field, { rudder: 0, thrust: 1 });
    r.seas.update(DT);
  }
  assert.ok(total(r.seas.stats) > 0, 'she stopped reporting after a reset');
});

// --- The options -------------------------------------------------------------

test('every threshold the model uses is a named option with a number behind it', () => {
  const seas = shipSeas(new Hull(), new WaveField(createSeaState({ preset: 'calm' })));
  for (const key of Object.keys(SHIPSEAS_DEFAULTS)) {
    assert.ok(key in seas.options, `${key} is not a tunable`);
    assert.ok(Number.isFinite(seas.options[key]), `${key} is not a number`);
  }

  // The contract's own numbers, and the ones the tuning above stands on.
  assert.equal(SHIPSEAS_DEFAULTS.freeboard, 3.2);
  assert.equal(SHIPSEAS_DEFAULTS.sheer, 1.2);
  assert.equal(SHIPSEAS_DEFAULTS.drainRate, 0.4);
  assert.equal(SHIPSEAS_DEFAULTS.plungeCooldown, 1);
});

test('the callbacks can be handed in with the options, or hung on afterwards', () => {
  const field = new WaveField(createSeaState({ preset: 'greybeards' }));
  const hull = new Hull({ headingDeg: 105 });
  let early = 0;
  const seas = shipSeas(hull, field, { onGreenWater: () => early++ });

  let late = 0;
  for (let i = 0; i < 300 / DT; i++) {
    field.advance(DT);
    hull.update(DT, field, { rudder: 0, thrust: 1 });
    seas.update(DT);
    if (i === Math.round(150 / DT)) seas.onRailDip = () => late++;
  }
  assert.ok(early > 0, 'the option callback never fired');
  assert.ok(late > 0, 'the assigned callback never fired');

  // Nothing listening costs nothing and breaks nothing.
  seas.onGreenWater = null;
  seas.onRailDip = null;
  const counted = seas.stats.greenWater;
  for (let i = 0; i < 60 / DT; i++) {
    field.advance(DT);
    hull.update(DT, field, { rudder: 0, thrust: 1 });
    seas.update(DT);
  }
  assert.ok(seas.stats.greenWater > counted, 'the stats must count whether anyone listens or not');
});

test('the library exports it', async () => {
  const lib = await import('../src/index.js');
  assert.equal(typeof lib.shipSeas, 'function');
  assert.equal(lib.SHIPSEAS_DEFAULTS, SHIPSEAS_DEFAULTS);
  assert.equal(lib.DEFAULT_REGIONS, DEFAULT_REGIONS);
});
