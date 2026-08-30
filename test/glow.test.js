// Sea fire, without a night to see it by.
//
// Bioluminescence is the one thing in the ocean shader that is not an answer to
// the sky, and it comes with two promises that can both be kept in node. The
// first is that it costs nothing when it is off: the term is gated on a uniform
// rather than compiled away, so a game may sail from dusk into darkness without
// stopping to rebuild a material — which means the string must contain the gate
// and the uniform must sit at nought. The second is that it puts itself out. A
// sea told to glow under a daylight sky must not glow, and that clamp is CPU
// arithmetic done once per change of light, so it can be read straight off the
// uniform it lands in.
//
// The last third of this file reads demo/main.js and demo/index.html as text.
// That is not how one would like to test a workbench, but the demo boots a
// WebGL context and cannot be imported here, and the failure worth catching is
// the dull one: a new slider added to the panel and forgotten by the half of the
// code that saves it. A preset table and a form are data, and data can be read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createOcean } from '../src/render/ocean.js';
import { createFoamField } from '../src/render/foamfield.js';

const QUALITY = { gridN: 16, halfSpan: 400, exponent: 2.2, normalRange: 400 };

function rig(options = {}) {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const ocean = createOcean(field, { quality: QUALITY, ...options });
  return { field, ocean };
}

/** A sea with a memory, for the half of the term that rides the scar field. */
function scarredRig() {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const foam = createFoamField(field, { size: 64, extent: 1200 });
  return createOcean(field, { quality: QUALITY, foamField: foam });
}

// The haze colours of the four shipped presets, which is what the clamp reads.
const HAZE = {
  storm: 0xa6abab,
  sunBreak: 0xc7c3b4,
  dusk: 0x8b8178,
  night: 0x1a2434,
};

const source = (name) =>
  readFileSync(fileURLToPath(new URL(`../demo/${name}`, import.meta.url)), 'utf8');

// --- The term itself ----------------------------------------------------------

test('the fire is gated on a uniform, not compiled in and out', () => {
  const { ocean } = rig();
  const src = ocean.mesh.material.fragmentShader;

  assert.ok(src.includes('uniform vec3 uGlow;'));
  assert.ok(src.includes('uniform float uGlowAmount;'));
  assert.ok(src.includes('if (uGlowAmount > 0.0) {'), 'a dark sea pays for the whole term');
  assert.ok(src.includes('col += uGlow * (churn * 0.45 * uGlowAmount);'));

  // Emission, so it goes in as light rather than as a colour mixed toward, and
  // it goes in before the fog and the tone map: distance is entitled to take it
  // and AgX is what stops the brightest of it reading as neon.
  assert.ok(src.indexOf('col += uGlow') > src.indexOf('col = mix(col, foamCol, foam);'));
  assert.ok(src.indexOf('col += uGlow') < src.indexOf('col = mix(col, uSkyHaze, fog);'));
  assert.ok(src.indexOf('col += uGlow') < src.indexOf('agxToneMap(col, uExposure)'));
});

test('the water is dark by default and stays dark until it is asked', () => {
  const { ocean } = rig();
  assert.equal(ocean.uniforms.uGlowAmount.value, 0, 'a new sea is glowing');

  // Even under the blackest sky there is, nothing until the water is told it
  // has something in it.
  ocean.setLighting({ skyHaze: 0x000000 });
  assert.equal(ocean.uniforms.uGlowAmount.value, 0);
});

test('turning the fire up and down never rebuilds the material', () => {
  const { ocean } = rig();
  const material = ocean.mesh.material;
  const src = material.fragmentShader;

  ocean.setLighting({ skyHaze: HAZE.night, bioluminescence: 1 });
  assert.ok(ocean.uniforms.uGlowAmount.value > 0.9);
  assert.equal(ocean.mesh.material, material, 'a slider swapped the shader');
  assert.equal(ocean.mesh.material.fragmentShader, src);

  ocean.setLighting({ bioluminescence: 0 });
  assert.equal(ocean.uniforms.uGlowAmount.value, 0);
  assert.equal(ocean.mesh.material, material);
});

test('the scar field is the primary source, and only where there is one', () => {
  const withField = scarredRig().mesh.material.fragmentShader;
  const { ocean } = rig();
  const without = ocean.mesh.material.fragmentShader;

  // The field's sample, faded at the footprint edge and scaled by how far the
  // field is believed, exactly as the foam term reads it.
  assert.ok(withField.includes('float scar = ffScar * ffFade * uFoamAmount;'));
  assert.ok(withField.includes('churn = max(churn, scar * scar * (0.3 + 0.7 * scar));'));

  // And the instantaneous crest, at a third the gain, in both. Squared, both of
  // them: a mask that runs linear from a tenth to one comes back off the tone
  // curve running from two thirds to one, and the sea in it is flat.
  for (const src of [withField, without]) {
    assert.ok(src.includes('float churn = 0.16 * crestFoam * crestFoam;'));
  }
  assert.ok(!without.includes('ffScar'), 'a fieldless sea reads a field');
});

test('the glow colour is the library default and is settable', () => {
  const { ocean } = rig();
  assert.deepEqual(
    ocean.uniforms.uGlow.value.getHex(),
    new THREE.Color(0x2fd6a8).getHex(),
    'the default bloom is not the documented one'
  );

  ocean.setLighting({ water: { glow: 0x66ccff } });
  assert.equal(ocean.uniforms.uGlow.value.getHex(), new THREE.Color(0x66ccff).getHex());
  // Half an object is still a legal lighting object: the deep water must not
  // have gone black because a colour of fire was handed over on its own.
  assert.notEqual(ocean.uniforms.uDeep.value.getHex(), 0);
});

// --- The sky putting it out ---------------------------------------------------

test('daylight never shows it, whatever the water is told it has in it', () => {
  const { ocean } = rig();
  for (const [name, haze] of Object.entries(HAZE)) {
    if (name === 'night') continue;
    ocean.setLighting({ skyHaze: haze, bioluminescence: 1 });
    assert.equal(
      ocean.uniforms.uGlowAmount.value,
      0,
      `${name} would show a bloom at noon`
    );
  }
});

test('a night sky lets all of it through, and the ask scales it', () => {
  const { ocean } = rig();
  ocean.setLighting({ skyHaze: HAZE.night, bioluminescence: 1 });
  assert.ok(ocean.uniforms.uGlowAmount.value > 0.99, 'the night preset is clamped');

  for (const ask of [0, 0.25, 0.5, 1]) {
    ocean.setLighting({ bioluminescence: ask });
    assert.ok(
      Math.abs(ocean.uniforms.uGlowAmount.value - ask) < 1e-6,
      `${ask} came through as ${ocean.uniforms.uGlowAmount.value}`
    );
  }

  // Out of range is a mistake, not an instruction.
  ocean.setLighting({ bioluminescence: 4 });
  assert.equal(ocean.uniforms.uGlowAmount.value, 1);
  ocean.setLighting({ bioluminescence: -1 });
  assert.equal(ocean.uniforms.uGlowAmount.value, 0);
});

test('the clamp is a smooth ramp down a brightening sky, and never rises', () => {
  const { ocean } = rig();
  const walk = [];
  for (let i = 0; i <= 24; i++) {
    // Up the greys from black to white, which walks the luminance the clamp
    // reads across its whole range and well past both ends of it.
    const v = Math.round((i / 24) * 255);
    ocean.setLighting({ skyHaze: (v << 16) | (v << 8) | v, bioluminescence: 1 });
    walk.push(ocean.uniforms.uGlowAmount.value);
  }

  assert.equal(walk[0], 1, 'a black sky is not full dark');
  assert.equal(walk[walk.length - 1], 0, 'a white sky still burns');
  for (let i = 1; i < walk.length; i++) {
    assert.ok(walk[i] <= walk[i - 1] + 1e-12, `the fire brightened with the sky: ${walk}`);
  }
  // Smooth, not a switch: somewhere in there it is neither on nor off.
  assert.ok(walk.some((v) => v > 0.02 && v < 0.98), `a hard edge: ${walk}`);
  for (const v of walk) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
});

test('a lighting object with no fire in it at all is still legal', () => {
  const { ocean } = rig({ lighting: { skyHaze: 0x000000 } });
  assert.equal(ocean.uniforms.uGlowAmount.value, 0);
  assert.ok(Number.isFinite(ocean.uniforms.uGlowAmount.value));
});

// --- The workbench's presets --------------------------------------------------

/** The `LIGHTS` table out of demo/main.js, as data. It is a literal of numbers,
 *  strings and arrays, so reading it needs no browser and no bundler. */
function demoLights() {
  const src = source('main.js');
  const start = src.indexOf('const LIGHTS = [');
  assert.ok(start >= 0, 'demo/main.js no longer has a LIGHTS table');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, 'the LIGHTS table does not end where it used to');
  const literal = src.slice(start + 'const LIGHTS = '.length, end + 2);
  return new Function(`return ${literal}`)();
}

test('the workbench has four moods and one of them is night', () => {
  const lights = demoLights();
  assert.equal(lights.length, 4);
  assert.deepEqual(
    lights.map((l) => l.label),
    ['Storm grey', 'Sun break', 'Dusk', 'Night']
  );

  const night = lights[3];
  assert.equal(night.bioluminescence, 1);
  assert.equal(night.rain, 0);
  assert.ok(night.water.glow !== undefined, 'the night has no colour of fire');
  assert.ok(night.exposure < 0.8, 'a night at daylight exposure');
  // A moonlit night, by request — first cut was moonless and the fire had the
  // whole stage. The moon is present but gentle: a silver path on the water,
  // a faintly lit hull, and never anything a sun would own.
  assert.ok(night.glare >= 0.2 && night.glare <= 0.6, 'the moon path is missing or glaring');
  assert.ok(night.sunIntensity >= 0.2 && night.sunIntensity <= 0.6,
    'the moon should light the hull faintly, and no more than faintly');

  // And the other three are exactly as dark as they were: nought fire, and the
  // key present rather than merely absent, so the table says what it means.
  for (const light of lights.slice(0, 3)) {
    assert.equal(light.bioluminescence, 0, `${light.label} has caught fire`);
  }
});

test("each preset's own sky decides what its fire is worth", () => {
  const { ocean } = rig();
  const lights = demoLights();

  for (const light of lights.slice(0, 3)) {
    // Even asked for outright, a lit sky refuses it. This is the property that
    // lets the panel's slider exist on every preset without spoiling three.
    ocean.setLighting({ ...light, bioluminescence: 1 });
    assert.equal(ocean.uniforms.uGlowAmount.value, 0, `${light.label} glows`);
  }

  ocean.setLighting(lights[3]);
  assert.ok(ocean.uniforms.uGlowAmount.value > 0.95, 'the night preset barely burns');
  assert.equal(ocean.uniforms.uGlow.value.getHex(), new THREE.Color(lights[3].water.glow).getHex());
});

// --- The panel ----------------------------------------------------------------

test('every slider on the panel has the markup it addresses', () => {
  const main = source('main.js');
  const html = source('index.html');

  const sliders = [...main.matchAll(/\{ key: '(\w+)', input: '(\w+)', out: '(\w+)'/g)];
  assert.ok(sliders.length >= 7, `only ${sliders.length} sliders found`);
  assert.ok(sliders.some(([, key]) => key === 'bioluminescence'), 'no Glow slider');

  for (const [, key, input, out] of sliders) {
    assert.ok(
      new RegExp(`<input type="range" id="${input}" min=`).test(html),
      `${key}: no range input #${input}`
    );
    assert.ok(html.includes(`id="${out}"`), `${key}: no readout #${out}`);
  }
});

test('the Glow slider runs nought to one, like the value it carries', () => {
  const html = source('index.html');
  const input = /<input type="range" id="wGlow" min="([\d.]+)" max="([\d.]+)"/.exec(html);
  assert.ok(input, 'no Glow slider in the panel');
  assert.equal(Number(input[1]), 0);
  assert.equal(Number(input[2]), 1);
});

test('what the panel can change, the panel remembers', () => {
  const main = source('main.js');

  // The round trip itself wants a browser; what can be checked here is the half
  // of it that is always forgotten — a new control wired to the sea and to the
  // clipboard, and never to storage, which loses a night's tuning to a refresh.
  for (const line of [
    'bioluminescence: light.bioluminescence ?? 0',          // out of a preset
    'bioluminescence: clamp(weather.bioluminescence, 0, 1)', // into the lighting
    'bioluminescence: env.bioluminescence',                  // into the clipboard
    'weather.bioluminescence = num(saved.bioluminescence, 0, 1, weather.bioluminescence)',
    'weather.water.glow = col(saved.water?.glow, weather.water.glow)',
  ]) {
    assert.ok(main.includes(line), `demo/main.js has lost: ${line}`);
  }
});

test('rain greys the sea and leaves the fire its colour', () => {
  const main = source('main.js');
  // Five of the six palette entries are surfaces standing in a squall; the
  // sixth is an emission, and a bloom under rain is not a grey bloom.
  assert.ok(main.includes('glow: drained(weather.water.glow, 0)'));
  for (const key of ['deep', 'crest', 'foam']) {
    assert.ok(main.includes(`${key}: drained(weather.water.${key}, desat)`), key);
  }
});
