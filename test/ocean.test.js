// The sea's shader, without a browser.
//
// `createOcean` builds a geometry, two strings and a uniform map, and none of
// that needs a GL context — the material is only compiled the first time
// something renders it. So the whole of the generated GLSL can be read here,
// which matters more for this file than for most: the ocean shader now comes in
// four shapes (foam field on or off, sky reflection on or off) and the promise
// attached to the plainest of them is that it is the shader that shipped before
// either layer existed, down to the uniform declarations. A phone pays for
// nothing it has not asked for, and that is a claim about a string.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSeaState } from '../src/spectrum.js';
import { WaveField } from '../src/wavefield.js';
import { createOcean, foamProfile } from '../src/render/ocean.js';
import { createFoamField } from '../src/render/foamfield.js';

const QUALITY = { gridN: 16, halfSpan: 400, exponent: 2.2, normalRange: 400 };

function rig(options = {}) {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const ocean = createOcean(field, { quality: QUALITY, ...options });
  return { field, ocean };
}

/** A field, built but never rendered: all this file wants is its uniforms. */
function fieldFor(waveField) {
  return createFoamField(waveField, { size: 64, extent: 1200 });
}

/** Every uniform a shader declares, and every uniform-shaped name it uses. */
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

// --- The four shapes ----------------------------------------------------------

/** The four combinations, built from one wave field so they are comparable. */
function fourWays() {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const foam = fieldFor(field);
  const cube = { isCubeTexture: true, name: 'sky' };

  const build = (withField, withRefl) => {
    const ocean = createOcean(field, {
      quality: QUALITY,
      foamField: withField ? foam : null,
    });
    if (withRefl) ocean.setReflection(cube, 1);
    return ocean;
  };

  return {
    foam,
    cube,
    plain: build(false, false),
    fieldOnly: build(true, false),
    reflOnly: build(false, true),
    both: build(true, true),
  };
}

test('the four combinations are four different shaders', () => {
  const o = fourWays();
  const sources = [o.plain, o.fieldOnly, o.reflOnly, o.both].map(
    (ocean) => ocean.mesh.material.fragmentShader
  );
  assert.equal(new Set(sources).size, 4, 'two of the four compiled to the same thing');

  // And the vertex stage is untouched by either: this is shading only, and the
  // geometry the physics samples must not know any of it is happening.
  const verts = new Set(
    [o.plain, o.fieldOnly, o.reflOnly, o.both].map((ocean) => ocean.mesh.material.vertexShader)
  );
  assert.equal(verts.size, 1, 'a shading layer moved a vertex');
});

test('each of the four declares exactly the uniforms it uses', () => {
  const o = fourWays();
  for (const [name, ocean] of Object.entries(o)) {
    if (!ocean?.mesh) continue;
    assertUniformsExact(ocean.mesh.material.fragmentShader, `${name} fragment`);
    assertUniformsExact(ocean.mesh.material.vertexShader, `${name} vertex`);
  }
});

test('the plain shader has never heard of either layer', () => {
  const { plain } = fourWays();
  const src = plain.mesh.material.fragmentShader;
  for (const name of ['uFoamField', 'uFoamOrigin', 'uFoamInvExtent', 'uFoamAmount',
                      'uSkyRefl', 'uSkyReflAmount', 'texture2D', 'samplerCube']) {
    assert.ok(!src.includes(name), `the phone path is paying for ${name}`);
  }
});

test('the field shader samples the field and takes the whitest answer', () => {
  const { fieldOnly } = fourWays();
  const src = fieldOnly.mesh.material.fragmentShader;
  assert.ok(src.includes('uniform sampler2D uFoamField;'));
  assert.ok(src.includes('texture2D(uFoamField, ffUv).r * uFoamAmount * ffFade'));
  assert.ok(/crestFoam = max\(crestFoam,/.test(src), 'the field can take white away');
  // Anchored to the datum footprint, which is where the field evaluated it.
  assert.ok(src.includes('(vUndisp - uFoamOrigin) * uFoamInvExtent'));
  // And it fades out at the edge of the footprint rather than ending at a line.
  assert.ok(src.includes('smoothstep(0.0, 0.045, min(ffEdge.x, ffEdge.y))'));
  // The distance fade still applies to it: a far scar is not a white bar either.
  assert.ok(
    src.indexOf('crestFoam = max(') < src.indexOf('crestFoam *= 0.22'),
    'the field sample dodges the distance fade'
  );
});

test('the reflection shader mixes the ramp toward a roughness-biased cube', () => {
  const { reflOnly } = fourWays();
  const src = reflOnly.mesh.material.fragmentShader;
  assert.ok(src.includes('uniform samplerCube uSkyRefl;'));
  assert.ok(src.includes('uniform float uSkyReflAmount;'));
  assert.ok(src.includes('if (uSkyReflAmount > 0.0)'), 'amount 0 still costs a sample');
  assert.ok(/textureCube\(uSkyRefl, reflDir, rough \* 5\.0\)/.test(src), 'no mip bias');
  assert.ok(src.includes('skyCol = mix(skyCol,'), 'the ramp was replaced, not mixed');

  // Foam and glints are none of the reflection's business.
  const plain = fourWays().plain.mesh.material.fragmentShader;
  for (const line of ['float lam = max(0.0, dot(n, sun));',
                      'col += uSunColour * pow(ndh, 240.0) * 0.9 * uGlare;']) {
    assert.ok(src.includes(line) && plain.includes(line), line);
  }
});

// --- Switching it on and off --------------------------------------------------

test('setFoamField takes the sea back to the shader it started with', () => {
  const { field, ocean } = rig();
  const before = ocean.mesh.material.fragmentShader;
  const foam = fieldFor(field);

  ocean.setFoamField(foam);
  assert.notEqual(ocean.mesh.material.fragmentShader, before);

  ocean.setFoamField(null);
  assert.equal(ocean.mesh.material.fragmentShader, before, 'not the same shader, byte for byte');
  assert.ok(!('uFoamField' in ocean.uniforms), 'a dead texture is still held');
});

test("the sea adopts the field's own uniform objects, ping-pong and all", () => {
  const { field, ocean } = rig();
  const foam = fieldFor(field);
  ocean.setFoamField(foam);

  for (const key of ['uFoamField', 'uFoamOrigin', 'uFoamInvExtent', 'uFoamAmount']) {
    assert.equal(ocean.uniforms[key], foam.uniforms[key], `${key} was copied, not shared`);
  }

  // Which is the whole point: the field swaps its buffers under the sea and
  // nobody has to be told.
  foam.uniforms.uFoamField.value = 'a different buffer';
  assert.equal(ocean.uniforms.uFoamField.value, 'a different buffer');
});

test('a field handed in at construction needs no second call', () => {
  const field = new WaveField(createSeaState({ preset: 'storm' }), 40000);
  const foam = fieldFor(field);
  const ocean = createOcean(field, { quality: QUALITY, foamField: foam });
  assert.ok(ocean.mesh.material.fragmentShader.includes('uFoamField'));
  assert.equal(ocean.uniforms.uFoamField, foam.uniforms.uFoamField);
});

test('setReflection defaults to the shipped look and returns to it', () => {
  const { ocean } = rig();
  const before = ocean.mesh.material.fragmentShader;
  assert.equal(ocean.uniforms.uSkyReflAmount.value, 0, 'reflections on by default');

  const cube = { isCubeTexture: true };
  ocean.setReflection(cube);
  assert.equal(ocean.uniforms.uSkyRefl.value, cube);
  assert.equal(ocean.uniforms.uSkyReflAmount.value, 1, 'the default amount is not one');

  ocean.setReflection(cube, 0.4);
  assert.equal(ocean.uniforms.uSkyReflAmount.value, 0.4);
  assert.equal(
    ocean.mesh.material.fragmentShader.includes('uSkyRefl'),
    true,
    'changing the amount lost the reflection'
  );

  ocean.setReflection(null);
  assert.equal(ocean.uniforms.uSkyReflAmount.value, 0);
  assert.equal(ocean.mesh.material.fragmentShader, before, 'not the same shader, byte for byte');
});

test('a texture with amount zero compiles in, so it can be faded up for free', () => {
  const { ocean } = rig();
  ocean.setReflection({ isCubeTexture: true }, 0);
  const src = ocean.mesh.material.fragmentShader;
  ocean.setReflection({ isCubeTexture: true }, 0.8);
  assert.equal(ocean.mesh.material.fragmentShader, src, 'the amount forced a recompile');
});

test('a live change of sea keeps whatever layers are switched on', () => {
  const { field, ocean } = rig();
  ocean.setFoamField(fieldFor(field));
  ocean.setReflection({ isCubeTexture: true }, 1);

  // A different *number* of waves changes #define NW, which is compiled in: the
  // rebuild that answers it must not quietly drop the layers with it.
  ocean.setSeaState(createSeaState({ preset: 'greybeards', waveCount: 17 }));
  const src = ocean.mesh.material.fragmentShader;
  assert.ok(src.includes('#define NW 17'));
  assert.ok(src.includes('uFoamField'), 'the foam field went with the old material');
  assert.ok(src.includes('uSkyRefl'), 'the reflection went with the old material');
  assertUniformsExact(src, 'seventeen-wave fragment');
});

test('the material is disposed of when it is replaced, and only once', () => {
  const { field, ocean } = rig();
  const first = ocean.mesh.material;
  let disposals = 0;
  first.addEventListener('dispose', () => disposals++);

  ocean.setFoamField(fieldFor(field));
  assert.notEqual(ocean.mesh.material, first);
  assert.equal(disposals, 1);

  ocean.dispose();
  assert.equal(disposals, 1, 'the old material was disposed of twice');
});

// --- The thresholds the field shares ------------------------------------------

test('the foam profile is the sea state, not the storm it was tuned on', () => {
  const coverage = ['calm', 'breeze', 'gale', 'storm', 'greybeards'].map(
    (preset) => foamProfile(createSeaState({ preset })).spindrift
  );
  for (let i = 1; i < coverage.length; i++) {
    assert.ok(coverage[i] > coverage[i - 1], `spindrift not monotonic: ${coverage}`);
  }

  // And the field injects at the same thresholds the shader paints at, which is
  // what keeps a scar the same shape as the crest that made it.
  const field = new WaveField(createSeaState({ preset: 'gale' }), 40000);
  const foam = fieldFor(field);
  const p = foamProfile(field.sea);
  const u = foam.materials.step.uniforms;
  assert.equal(u.uFoamLo.value, p.foamLo);
  assert.equal(u.uFoamHi.value, p.foamHi);
  assert.equal(u.uFoamJitter.value, p.foamJitter);
  assert.equal(u.uFoamScale.value, p.foamScale);
});

test('a foam profile survives a sea with no waves in it at all', () => {
  const p = foamProfile({ waves: [] });
  for (const v of Object.values(p)) assert.ok(Number.isFinite(v), JSON.stringify(p));
  assert.ok(p.foamHi > p.foamLo);
});
