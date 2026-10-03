import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hull } from '../src/hull.js';

const flat = {
  sea: { dominantSpeed: 10, dominantTravelRad: 0 }, heightAt: () => 0,
  gradientAt: () => ({ dx: 0, dz: 0 }), orbitalVelocityAt: (x, z, out) => out.set(0, 0, 0),
};

test('inertial attitude carries velocity through a sudden change in loading', () => {
  const hull = new Hull({ attitudeInertia: true });
  for (let i = 0; i < 30; i++) hull.update(1 / 30, flat, { heel: .2 });
  const before = hull.roll;
  hull.update(1 / 30, flat, { heel: -.2 });
  assert.ok(hull.roll > before, 'a reversed target cannot instantly reverse angular velocity');
  for (let i = 0; i < 900; i++) hull.update(1 / 30, flat, { heel: -.2 });
  assert.ok(Math.abs(hull.roll + .2) < 1e-9, 'the other tack still settles correctly');
});

test('inertial heave and heel settle without overshoot, independently of frame rate', () => {
  const results = [];
  for (const hz of [30, 60, 120]) {
    const hull = new Hull({ attitudeInertia: true });
    for (let i = 0; i < hz * 12; i++) {
      hull.update(1 / hz, { ...flat, heightAt: () => .8 }, { heel: .2 });
      assert.ok(hull.heave >= 0 && hull.heave <= .8);
      assert.ok(hull.roll >= 0 && hull.roll <= .2);
    }
    results.push([hull.heave, hull.roll]);
  }
  assert.ok(Math.abs(results[0][0] - .8) < 1e-5);
  assert.ok(Math.abs(results[0][1] - .2) < 3e-5);
  for (const values of results) values.forEach((v, i) => assert.ok(Math.abs(v - results[0][i]) < 1e-12));
});
