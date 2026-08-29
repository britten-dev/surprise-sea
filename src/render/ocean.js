// The visible sea.
//
// One mesh, following the camera, displaced by exactly the wave sum the CPU
// walks — that identity is the whole point of the library, and every uniform in
// here comes out of the SeaState rather than being tuned by hand.
//
// The fragment shader does the things that make water read as water, in rough
// order of importance: a fresnel blend from dark upwelling colour into a mirror
// of the sky, foam keyed off Gerstner crest pinch, spindrift streaked downwind,
// a green translucent glow where a crest thins against the light, and fog that
// dissolves everything into the haze the sky already wears.
//
// Two things are decoupled from the game this was ported out of. Lighting is a
// plain object handed in and swappable — no mood system, no config import — and
// foam is keyed to the sea state rather than baked for a Southern Ocean storm:
// the crest threshold is expressed in multiples of the sea's own crest pinch,
// so a glassy heave shows almost nothing and greybeards go white to the horizon
// without a single number being touched.

import * as THREE from 'three';
import { waveUniforms, oceanVertexChunk } from '../seastate.js';
import { warpedGrid } from './grid.js';

// The look of the shipped storm, and the shape every lighting object takes.
const DEFAULT_LIGHTING = {
  sunDir: [0.35, 0.3, 0.65],
  sunColour: 0xdfe2de,
  skyTop: 0x67737f,
  skyHaze: 0xa6abab,
  glare: 0.3,
  fogDensity: 1.1, // a multiplier on the base density, not a density
  water: { deep: 0x25383c, crest: 0x3d6a5c, foam: 0xdfe4e4 },
};

const DEFAULT_QUALITY = { gridN: 352, halfSpan: 16000, exponent: 2.2 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The vertex stage: displace the datum plane by the Gerstner sum and hand the
 * fragment stage the normal, the crest pinch and the undisplaced footprint —
 * the last of these is what the foam noise is anchored to, because sampling
 * noise at the *displaced* position would make the lace crawl with the orbit.
 */
const vertexShader = (waveCount) => /* glsl */ `
  ${oceanVertexChunk(waveCount)}

  uniform vec3 uCameraPos;

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vCrest;
  varying float vHeight;
  varying vec2 vUndisp;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec2 p = wp.xz;

    float camDist = distance(p, uCameraPos.xz);

    vec3 n;
    float crest;
    vec3 displaced = gerstner(p, camDist, n, crest);

    vNormal = n;
    vWorldPos = displaced;
    vCrest = crest;
    vHeight = displaced.y;
    vUndisp = p;

    gl_Position = projectionMatrix * viewMatrix * vec4(displaced, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uDeep;
  uniform vec3 uCrestGlow;
  uniform vec3 uFoam;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHaze;
  uniform vec3 uSunDir;
  uniform vec3 uSunColour;
  uniform float uGlare;
  uniform float uFogDensity;
  uniform vec3 uCameraPos;
  uniform vec2 uWindDir;
  uniform float uTime;

  // Everything the sea state decides. Heights are in metres; the foam
  // thresholds are in the same units as the Gerstner pinch the vertex stage
  // hands over, so they mean the same thing in a millpond and in a survival sea.
  uniform float uHeightScale;  // one standard deviation of surface height
  uniform float uFoamLo;       // pinch at which a crest starts to break
  uniform float uFoamHi;       // pinch at which it is solid white
  uniform float uFoamJitter;   // how much noise ragged the threshold
  uniform float uSpindrift;    // how much old foam the wind has to drag out
  uniform float uFoamScale;    // foam texture frequency, from the dominant wave
  uniform float uRipple;       // strength of the wind-texture normal

  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying float vCrest;
  varying float vHeight;
  varying vec2 vUndisp;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) {
    return noise(p) * 0.65 + noise(p * 2.7) * 0.35;
  }

  void main() {
    vec3 viewDir = normalize(uCameraPos - vWorldPos);
    float dist = distance(uCameraPos, vWorldPos);
    vec3 sun = normalize(uSunDir);

    // Ripple the analytic normal with drifting noise, close in. This is the
    // texture of wind on water; beyond a few hundred metres it would only
    // shimmer, so it fades out. The fade is in metres because it is about what
    // a pixel can resolve, not about how big the sea is.
    vec3 n = vNormal;
    float rippleAmt = uRipple * exp(-dist / 900.0);
    if (rippleAmt > 0.01) {
      vec2 rp = vUndisp * 0.31 + uWindDir * uTime * -1.4;
      float e = 0.9;
      float gx = fbm(rp + vec2(e, 0.0)) - fbm(rp - vec2(e, 0.0));
      float gz = fbm(rp + vec2(0.0, e)) - fbm(rp - vec2(0.0, e));
      n = normalize(n + vec3(gx, 0.0, gz) * rippleAmt);
    }

    // --- Water body ---------------------------------------------------------
    // Looking down into it: near-black green. Grazing: it vanishes behind the
    // reflected sky. That switch is most of what the eye uses.
    float facing = clamp(dot(viewDir, n), 0.0, 1.0);
    // Damped well below the physical value: a storm sea is rough, and rough
    // water is a poor mirror. Full fresnel turns the whole distance to silver.
    float fresnel = 0.02 + 0.5 * pow(1.0 - facing, 5.0);

    vec3 water = uDeep;

    // Thin crests catch the light from behind and glow bottle-green. The band
    // is set in standard deviations of wave height, so it finds the crests of
    // whatever sea is running rather than a fixed metre mark.
    vec2 sunH = normalize(uSunDir.xz);
    float backlit = pow(max(0.0, dot(-viewDir.xz, sunH) * 0.5 + 0.5), 3.0);
    float lifted = smoothstep(0.19 * uHeightScale, 1.23 * uHeightScale, vHeight);
    water += uCrestGlow * (backlit * lifted * (0.35 + uGlare * 0.65));

    // Reflected sky, from the same palette the dome is drawn with.
    vec3 reflDir = reflect(-viewDir, n);
    float sk = smoothstep(-0.08, 0.45, reflDir.y);
    vec3 skyCol = mix(uSkyHaze, uSkyTop, sk);
    skyCol += uSunColour * pow(max(0.0, dot(reflDir, sun)), 60.0) * uGlare * 0.55;

    vec3 col = mix(water, skyCol, fresnel);

    // Sun glint: one tight and one broad lobe, so there is both sparkle and
    // a soft path of light when the sun is out.
    vec3 h = normalize(sun + viewDir);
    float ndh = max(0.0, dot(n, h));
    col += uSunColour * pow(ndh, 240.0) * 0.9 * uGlare;
    col += uSunColour * pow(ndh, 24.0) * 0.06 * uGlare;

    // --- Foam ---------------------------------------------------------------
    // Breaking crests, where the Gerstner pinch says the surface is folding.
    // Faded hard with distance, or every far crest becomes a solid white bar.
    float rag = fbm(vUndisp * 0.13 * uFoamScale + uWindDir * uTime * -0.5);
    float crestFoam = smoothstep(uFoamLo, uFoamHi, vCrest + (rag - 0.5) * uFoamJitter);
    crestFoam *= 0.22 + 0.78 * exp(-dist / 5500.0);

    // Spindrift: old foam drawn out downwind in long lace streaks — narrow
    // across the wind, long along it, broken up so it never reads as sheets.
    vec2 windPerp = vec2(-uWindDir.y, uWindDir.x);
    vec2 sp = vec2(dot(vUndisp, windPerp) * 0.11 * uFoamScale,
                   dot(vUndisp, uWindDir) * 0.008 * uFoamScale - uTime * 0.05);
    float lace = fbm(vUndisp * 0.6 * uFoamScale + sp);
    float streaks = smoothstep(0.62, 0.88, fbm(sp)) * (0.35 + 0.65 * lace);
    streaks *= smoothstep(-0.28 * uHeightScale, 0.47 * uHeightScale, vHeight)
             * uSpindrift * exp(-dist / 2600.0);

    float foam = clamp(crestFoam + streaks, 0.0, 1.0);

    // Foam is matte and lit like cloth: sun lambert plus sky ambient.
    float lam = max(0.0, dot(n, sun));
    vec3 foamCol = uFoam * (0.55 + 0.45 * lam) + uSunColour * lam * 0.12 * uGlare;
    col = mix(col, foamCol, foam);

    // --- Air ----------------------------------------------------------------
    float f = dist * uFogDensity;
    float fog = 1.0 - exp(-f * f);
    col = mix(col, uSkyHaze, fog);

    gl_FragColor = vec4(col, 1.0);

    #include <colorspace_fragment>
  }
`;

/**
 * How much white water a sea state is entitled to.
 *
 * Every preset budgets its Gerstner pinch to roughly the same total — that is a
 * stability constraint, not a weather one — so the crest field looks much the
 * same in a millpond as in a storm and a fixed threshold would foam them alike.
 * The honest signal is how big the sea actually is: significant height, which
 * is 4σ of the surface. Whitecaps start around Force 4 and the sea is streaked
 * white by Force 10, so coverage is a gentle curve between those.
 *
 * Everything else is expressed as a multiple of the sea's own statistics, which
 * is what makes the shader sea-state agnostic: at the storm preset the numbers
 * below land within a percent or two of the hand-tuned constants they replaced.
 */
function foamProfile(sea) {
  const waves = sea?.waves ?? [];

  let heightVar = 0;
  let pinchVar = 0;
  for (const w of waves) {
    heightVar += w.amp * w.amp * 0.5;
    const pinch = w.q * w.k * w.amp;
    pinchVar += pinch * pinch * 0.5;
  }

  const heightSigma = Math.sqrt(heightVar) || 0.05;
  const crestSigma = Math.sqrt(pinchVar) || 0.02;
  const significant = 4 * heightSigma;

  // 0 at a glassy heave, 1 in a survival sea.
  const coverage = Math.pow(clamp((significant - 0.35) / 17, 0, 1), 0.55);

  // Foam patches are the size of the breaking wave, so the lace coarsens as the
  // sea lengthens. Normalised to the 230 m swell this shader was tuned against.
  const dominant = sea?.dominant?.length ?? waves[0]?.length ?? 230;

  // Where a crest starts to break, and how far past that it is solid white —
  // both in standard deviations of pinch, both sliding down as the sea builds.
  const foamLo = crestSigma * (3.7 - 2.5 * coverage);
  const band = crestSigma * (1.9 - 0.6 * coverage);

  return {
    heightScale: heightSigma,
    foamLo,
    foamHi: foamLo + band,
    foamJitter: crestSigma * 1.8,
    spindrift: 0.37 * coverage,
    foamScale: clamp(230 / dominant, 0.45, 2.6),
    ripple: 0.12 + 0.22 * coverage,
  };
}

/** Direction the wind blows *toward*, as a unit vector on the xz plane. */
function downwind(windFromDeg, out = new THREE.Vector2()) {
  const rad = THREE.MathUtils.degToRad(windFromDeg);
  return out.set(-Math.sin(rad), Math.cos(rad)).normalize();
}

/** Hex numbers, CSS strings and THREE.Colors are all fair game for a palette. */
function setColour(uniform, value) {
  if (value === undefined || value === null) return;
  if (typeof value === 'number') uniform.value.setHex(value);
  else uniform.value.set(value);
}

/**
 * The sea, drawn.
 *
 * @param waveField  a WaveField; its `sea` supplies the spectrum and its `time`
 *                   the clock, so the mesh can never drift out of step with the
 *                   physics reading the same field.
 * @param options    { quality, windFromDeg, fogDensity, lighting }
 */
export function createOcean(waveField, options = {}) {
  const quality = { ...DEFAULT_QUALITY, ...(options.quality ?? {}) };
  const geometry = warpedGrid(quality.gridN, quality.halfSpan, quality.exponent);

  // The base density; a lighting preset scales it. Kept separately because
  // setLighting hands over a multiplier, not an answer.
  const baseFog = options.fogDensity ?? 1.05e-4;

  // A wind direction given here is a deliberate choice and survives sea-state
  // swaps; left out, the streaks follow whatever wind the sea state carries.
  const pinnedWind = options.windFromDeg ?? null;

  let sea = waveField.sea;
  let waveCount = sea.waves.length;

  const uniforms = {
    ...waveUniforms(sea),
    uTime: { value: waveField.time ?? 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uWindDir: { value: downwind(pinnedWind ?? sea.windFromDeg ?? 285) },
    uDeep: { value: new THREE.Color() },
    uCrestGlow: { value: new THREE.Color() },
    uFoam: { value: new THREE.Color() },
    uSkyTop: { value: new THREE.Color() },
    uSkyHaze: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3() },
    uSunColour: { value: new THREE.Color() },
    uGlare: { value: 0.3 },
    uFogDensity: { value: baseFog },
    uHeightScale: { value: 1 },
    uFoamLo: { value: 0.33 },
    uFoamHi: { value: 0.6 },
    uFoamJitter: { value: 0.35 },
    uSpindrift: { value: 0.3 },
    uFoamScale: { value: 1 },
    uRipple: { value: 0.3 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: vertexShader(waveCount),
    fragmentShader,
    uniforms,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ocean';
  // Every vertex moves in the shader and the mesh is always under the camera:
  // there is nothing useful for the frustum test to say about it.
  mesh.frustumCulled = false;

  function applyFoam() {
    const p = foamProfile(sea);
    uniforms.uHeightScale.value = p.heightScale;
    uniforms.uFoamLo.value = p.foamLo;
    uniforms.uFoamHi.value = p.foamHi;
    uniforms.uFoamJitter.value = p.foamJitter;
    uniforms.uSpindrift.value = p.spindrift;
    uniforms.uFoamScale.value = p.foamScale;
    uniforms.uRipple.value = p.ripple;
  }

  // The lighting actually in force, so a caller may hand over half an object —
  // "just the glare" — without the rest of the sky going black.
  let lighting = { ...DEFAULT_LIGHTING, water: { ...DEFAULT_LIGHTING.water } };

  function setLighting(next = {}) {
    lighting = {
      ...lighting,
      ...next,
      water: { ...lighting.water, ...(next.water ?? {}) },
    };

    setColour(uniforms.uDeep, lighting.water.deep);
    setColour(uniforms.uCrestGlow, lighting.water.crest);
    setColour(uniforms.uFoam, lighting.water.foam);
    setColour(uniforms.uSkyTop, lighting.skyTop);
    setColour(uniforms.uSkyHaze, lighting.skyHaze);
    setColour(uniforms.uSunColour, lighting.sunColour);
    uniforms.uSunDir.value.set(...lighting.sunDir).normalize();
    uniforms.uGlare.value = lighting.glare ?? 0.4;
    uniforms.uFogDensity.value = baseFog * (lighting.fogDensity ?? 1);
  }

  applyFoam();
  setLighting(options.lighting ?? {});

  return {
    mesh,
    uniforms,

    update(cameraPos) {
      // The mesh's clock *is* the wave field's clock. One sea.
      uniforms.uTime.value = waveField.time;
      uniforms.uCameraPos.value.copy(cameraPos);
      mesh.position.x = cameraPos.x;
      mesh.position.z = cameraPos.z;
    },

    setLighting,

    /**
     * Swap the spectrum under a running sea.
     *
     * The wave tables are plain arrays inside the uniform objects, so a sea of
     * the same size is a straight re-upload and the surface simply becomes a
     * different sea between one frame and the next. A different *number* of
     * waves changes `#define NW`, which is compiled in: that needs a new
     * material, so the old one is disposed and replaced in place.
     */
    setSeaState(nextSea) {
      sea = nextSea ?? waveField.sea;
      const fresh = waveUniforms(sea);

      if (sea.waves.length !== waveCount) {
        waveCount = sea.waves.length;
        for (const key of Object.keys(fresh)) uniforms[key] = fresh[key];
        const replacement = new THREE.ShaderMaterial({
          vertexShader: vertexShader(waveCount),
          fragmentShader,
          uniforms,
        });
        mesh.material.dispose();
        mesh.material = replacement;
      } else {
        for (const key of Object.keys(fresh)) uniforms[key].value = fresh[key].value;
      }

      if (pinnedWind === null && sea.windFromDeg !== undefined) {
        downwind(sea.windFromDeg, uniforms.uWindDir.value);
      }

      applyFoam();
    },

    dispose() {
      geometry.dispose();
      mesh.material.dispose();
    },
  };
}
