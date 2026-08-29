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
// dissolves everything into the haze the sky already wears. It ends with AgX,
// because storm light has more range than a display does and the alternative is
// a sea of white crests with nothing inside them.
//
// Close in it reaches back for the wave table and re-evaluates the analytic
// normal per pixel. That is not extra detail invented for the eye — it is the
// sum the CPU already walks, sampled where a metres-wide grid cell was
// interpolating the crest edges away.
//
// Two things are decoupled from the game this was ported out of. Lighting is a
// plain object handed in and swappable — no mood system, no config import — and
// foam is keyed to the sea state rather than baked for a Southern Ocean storm:
// the crest threshold is expressed in multiples of the sea's own crest pinch,
// so a glassy heave shows almost nothing and greybeards go white to the horizon
// without a single number being touched.

import * as THREE from 'three';
import { waveUniforms, oceanVertexChunk, oceanNormalChunk } from '../seastate.js';
import { warpedGrid } from './grid.js';

// The look of the shipped storm, and the shape every lighting object takes.
const DEFAULT_LIGHTING = {
  sunDir: [0.35, 0.3, 0.65],
  sunColour: 0xdfe2de,
  skyTop: 0x67737f,
  skyHaze: 0xa6abab,
  glare: 0.3,
  fogDensity: 1.1, // a multiplier on the base density, not a density
  // Stops in front of the tone map. Storm light is the reference at 1; a sun
  // break wants a little more and dusk a little less.
  exposure: 1,
  water: { deep: 0x25383c, crest: 0x3d6a5c, foam: 0xdfe4e4 },
};

// `normalRange` is how far out the fragment stage re-evaluates the analytic
// normal per pixel, in metres. Nought turns it off outright — the wave table
// then never reaches the fragment stage at all, which is the setting for a
// phone with sixteen fragment uniform vectors to its name.
const DEFAULT_QUALITY = { gridN: 352, halfSpan: 16000, exponent: 2.2, normalRange: 400 };

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

/**
 * The sky, as a function of direction.
 *
 * Two overlapping ramps rather than one, because a single smoothstep leaves a
 * seam across the sky exactly where the eye is already looking. Exported as
 * GLSL because the sea has to agree with the dome about what is overhead: a
 * reflection is only convincing if it is a reflection *of something*, and two
 * hand-tuned ramps drift apart the first time either is touched. Drop this in
 * beside the dome shader and both read the same formula.
 */
export const skyGradientChunk = /* glsl */ `
  vec3 skyGradient(vec3 dir, vec3 haze, vec3 top, vec3 sunDir, vec3 sunColour, float glare) {
    float t = smoothstep(-0.16, 0.55, dir.y);
    float t2 = smoothstep(-0.02, 0.16, dir.y);
    vec3 col = mix(haze, top, t * 0.72 + t2 * 0.28);

    // A broad, gentle glow rather than a disc — calmer, and it never glares.
    float s = max(0.0, dot(dir, sunDir));
    col += sunColour * pow(s, 16.0) * 0.16 * glare;
    col += sunColour * pow(s, 220.0) * 0.40 * glare;
    return col;
  }
`;

/**
 * AgX, in about twenty lines.
 *
 * Storm light carries an enormous range and foam sits at the top of it: with a
 * straight clamp every crest goes to paper white and all the folding inside it
 * is lost, while the dusk preset — which lives entirely in the bottom two
 * stops — has nowhere to put its highlights either. AgX takes the scene into a
 * wide gamut, log-encodes it, runs a gentle sigmoid and comes back: highlights
 * desaturate toward white the way film does instead of clipping to it.
 *
 * This is the well-known compact approximation of it. The inset matrix has the
 * sRGB → Rec.2020 conversion folded in, and a seventh-order polynomial stands
 * in for the reference curve. In and out are both linear, so whatever colour
 * space conversion the renderer does afterwards is unaffected.
 *
 * Exported so anything else drawn into the same frame — a sky dome, most
 * obviously — can be graded identically instead of clipping beside it.
 */
export const agxToneMapChunk = /* glsl */ `
  vec3 agxContrast(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }

  vec3 agxToneMap(vec3 col, float exposure) {
    const mat3 agxInset = mat3(
      0.842479062253094, 0.0423282422610123, 0.0423756549057051,
      0.0784335999999992, 0.878468636469772, 0.0784336,
      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
    const mat3 agxOutset = mat3(
      1.19687900512017, -0.0528968517574562, -0.0529716355144438,
      -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
      -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
    const float minEv = -12.47393;
    const float maxEv = 4.026069;

    col = agxInset * max(col * exposure, 0.0);
    col = clamp(log2(max(col, 1e-10)), minEv, maxEv);
    col = agxContrast((col - minEv) / (maxEv - minEv));

    // A whisper of a grade on top. The sigmoid is deliberately flat and a grey
    // sea comes back greyer; this is saturation only, no lift and no crush.
    float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = luma + 1.12 * (col - luma);

    col = agxOutset * col;
    return clamp(pow(max(col, 0.0), vec3(2.2)), 0.0, 1.0);
  }
`;

/**
 * The fragment stage.
 *
 * Generated rather than constant, because the near-field normal pass needs the
 * wave table compiled in at the right length — and because a caller who has
 * turned that pass off should not be paying for the uniforms either. The foam
 * field and the sky reflection are compiled in the same way and for the same
 * reason: a phone with no foam field is running the shader it ran before either
 * of them existed, down to the uniform declarations.
 */
const fragmentShader = (waveCount, normalRange, features = {}) => /* glsl */ `
  ${normalRange > 0 ? oceanNormalChunk(waveCount) : ''}
  ${skyGradientChunk}
  ${agxToneMapChunk}

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
  uniform float uExposure;     // stops in front of the tone map
${features.foamField ? `
  // The scar field: one channel of accumulated white water, world-anchored on a
  // footprint that follows the camera. See render/foamfield.js.
  uniform sampler2D uFoamField;
  uniform vec2 uFoamOrigin;    // world xz of the footprint's near corner
  uniform float uFoamInvExtent;
  uniform float uFoamAmount;   // 0 falls back to the analytic foam entirely
` : ''}${features.reflection ? `
  uniform samplerCube uSkyRefl;
  uniform float uSkyReflAmount; // 0 = the procedural ramp, exactly as before
` : ''}
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

    // --- Surface definition -------------------------------------------------
    // The vertex normal is exact at the vertices and mush between them: at
    // three hundred metres the warped grid's cells are metres wide and every
    // crest edge inside one is interpolated away. So close in, re-evaluate the
    // *same* analytic Gerstner normal per pixel at this fragment's datum
    // footprint, and blend back to the vertex normal as the cells shrink
    // against the pixel and the difference stops being visible.
    vec3 n = vNormal;
    float nearAmt = 0.0;
${normalRange > 0 ? `
    nearAmt = 1.0 - smoothstep(${(normalRange * 0.55).toFixed(1)}, ${normalRange.toFixed(1)}, dist);
    if (nearAmt > 0.002) {
      // Horizontal range, to match the attenuation the vertex stage applied.
      float camDistF = distance(vUndisp, uCameraPos.xz);
      vec3 nf = gerstnerNormal(vUndisp, camDistF, uTime);
      n = normalize(mix(vNormal, nf, nearAmt));
    }
` : ''}
    // Ripple the analytic normal with drifting noise. This is the texture of
    // wind on water; beyond a few hundred metres it would only shimmer, so it
    // fades out. The fade is in metres because it is about what a pixel can
    // resolve, not about how big the sea is. Where the per-pixel normal is
    // running it is turned down to what it is honestly for — micro-detail
    // below the shortest wave in the table — rather than standing in for the
    // definition the vertex normal was losing.
    float rippleAmt = uRipple * exp(-dist / 900.0) * (1.0 - 0.55 * nearAmt);
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

    // Transmission: light that went in the back of a crest and came out this
    // side, which is what the bottle-green actually is. Four things have to be
    // true at once and the term is the product of all four, so it switches off
    // honestly instead of glowing wherever the water happens to be high.
    //
    //   forward — the sun is behind the surface from here and scattering on
    //             through toward the eye. Two lobes stand in for the
    //             Henyey-Greenstein one: a broad haze and a tight core.
    //   thin    — a pinched crest is a thin crest. Measured against the very
    //             threshold the foam breaks at, so it stays sea-state agnostic.
    //   lifted  — the height band, in standard deviations of this sea's own
    //             surface: crests, not troughs, whatever size the sea is.
    //   lean    — a face tilted toward the eye has water to see through; a
    //             flat one presents its whole depth and reads as deep.
    float forward = max(0.0, dot(viewDir, -sun));
    float lobe = 0.35 * forward * forward + 0.65 * pow(forward, 8.0);
    float thin = smoothstep(0.45, 1.0, vCrest / max(uFoamHi, 1e-4));
    float lifted = smoothstep(0.19 * uHeightScale, 1.23 * uHeightScale, vHeight);
    float lean = smoothstep(0.0, 0.45, 1.0 - n.y);
    float sss = lobe * lifted * (0.35 + 0.65 * thin) * (0.5 + 0.5 * lean);
    water += uCrestGlow * (sss * (1.4 + uGlare * 2.6));

    // Reflected sky — the same two-ramp gradient the dome overhead is drawn
    // with, evaluated along the reflected ray, so the sea mirrors the sky that
    // is actually there rather than an approximation of it.
    vec3 reflDir = reflect(-viewDir, n);
    vec3 skyCol = skyGradient(reflDir, uSkyHaze, uSkyTop, sun, uSunColour, uGlare);
${features.reflection ? `
    // Better than the ramp: the sky dome that is actually overhead, prefiltered
    // into a cube and sampled along the reflected ray, so the sun sits where the
    // sun is and the dusk orange arrives in the wave backs by itself. Rough
    // water is a poor mirror and a pinched crest is the roughest water there is,
    // so the sample is pushed down the mip chain by the very pinch the foam keys
    // off — a bias rather than an exact LOD, which is all the difference a sea
    // this broken could show anyway.
    if (uSkyReflAmount > 0.0) {
      float rough = clamp(0.3 + uRipple * 1.4
                        + 0.9 * smoothstep(0.0, uFoamHi, vCrest), 0.0, 1.0);
      skyCol = mix(skyCol, textureCube(uSkyRefl, reflDir, rough * 5.0).rgb,
                   uSkyReflAmount);
    }
` : ''}
    vec3 col = mix(water, skyCol, fresnel);

    // Sun glint: one tight and one broad lobe, so there is both sparkle and
    // a soft path of light when the sun is out.
    vec3 h = normalize(sun + viewDir);
    float ndh = max(0.0, dot(n, h));
    col += uSunColour * pow(ndh, 240.0) * 0.9 * uGlare;
    col += uSunColour * pow(ndh, 24.0) * 0.06 * uGlare;

    // --- Foam ---------------------------------------------------------------
    // Breaking crests, where the Gerstner pinch says the surface is folding.
    // Faded hard with distance, or every far crest becomes a solid white bar —
    // the field's scars included, since they are the same white water.
    float rag = fbm(vUndisp * 0.13 * uFoamScale + uWindDir * uTime * -0.5);
    float crestFoam = smoothstep(uFoamLo, uFoamHi, vCrest + (rag - 0.5) * uFoamJitter);${features.foamField ? `

    // What this piece of sea remembers. Sampled at the datum footprint, which
    // is where the field's own pass evaluated the crest sum, so the scar and the
    // crest that made it are anchored to the same water. Whitest wins: the field
    // can only ever add memory to the analytic answer, never take white away
    // from a crest that is breaking right now. Outside the footprint it fades
    // out over a few per cent of the edge and the analytic foam carries on
    // alone, so there is no line on the water where the texture stops.
    vec2 ffUv = (vUndisp - uFoamOrigin) * uFoamInvExtent;
    vec2 ffEdge = min(ffUv, 1.0 - ffUv);
    float ffFade = smoothstep(0.0, 0.045, min(ffEdge.x, ffEdge.y));
    // Squared, not linear: a half-faded memory should read as lace on the
    // water, not as half a coat of paint. Fresh white is still fresh white.
    float ffScar = texture2D(uFoamField, ffUv).r;
    crestFoam = max(crestFoam, ffScar * ffScar * uFoamAmount * ffFade);` : ''}
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

    // Exposure and the tone curve last, on the assembled scene value — foam
    // and glint arrive here well over one and are rolled off rather than cut.
    gl_FragColor = vec4(agxToneMap(col, uExposure), 1.0);

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
export function foamProfile(sea) {
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
 * @param options    { quality, windFromDeg, fogDensity, lighting, foamField }
 *                   quality: { gridN, halfSpan, exponent, normalRange }
 *                   lighting: { sunDir, sunColour, skyTop, skyHaze, glare,
 *                               fogDensity, exposure, water }
 *                   foamField: a createFoamField, or nothing at all — see
 *                              `setFoamField` below.
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
    uExposure: { value: 1 },
    // Only ever read by a material that has the reflection compiled into it;
    // kept here always so `setReflection` has somewhere to put its answer.
    uSkyRefl: { value: null },
    uSkyReflAmount: { value: 0 },
  };

  // Nought disables the near-field normal pass; anything else is a range in
  // metres, and the shader is generated around it.
  const normalRange = Math.max(0, quality.normalRange ?? 0);

  // The two optional layers. Both are compiled in rather than switched at
  // runtime, so an ocean with neither is byte for byte the shader it was before
  // either existed — no sampler bound, no uniform declared, nothing to pay for.
  // The names of the uniform objects are fixed by Amendment II because two
  // agents build against them from opposite sides.
  const FIELD_UNIFORMS = ['uFoamField', 'uFoamOrigin', 'uFoamInvExtent', 'uFoamAmount'];
  let foamField = null;
  let reflection = null;

  /** Adopt the field's own uniform objects: it ping-pongs its render targets
   *  every update, and this is what saves the sea from being told about it. */
  function adoptFoamField(next) {
    for (const key of FIELD_UNIFORMS) delete uniforms[key];
    foamField = next ?? null;
    if (!foamField) return;
    for (const key of FIELD_UNIFORMS) {
      uniforms[key] = foamField.uniforms?.[key] ?? { value: null };
    }
  }

  const makeMaterial = () =>
    new THREE.ShaderMaterial({
      vertexShader: vertexShader(waveCount),
      fragmentShader: fragmentShader(waveCount, normalRange, {
        foamField: foamField !== null,
        reflection: reflection !== null,
      }),
      uniforms,
      // The tone curve is applied in the shader, on the assembled scene value.
      // Say so, or a renderer with its own tone mapping switched on will grade
      // the sea a second time.
      toneMapped: false,
    });

  adoptFoamField(options.foamField);

  const material = makeMaterial();

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
    uniforms.uExposure.value = lighting.exposure ?? 1;
  }

  /** Swap the material for one generated around the flags as they now stand.
   *  The uniform map is the same object, so nothing has to be re-uploaded. */
  function rebuild() {
    const replacement = makeMaterial();
    mesh.material.dispose();
    mesh.material = replacement;
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
     * Give the sea a memory, or take it away again.
     *
     * With a field set, the foam term becomes the whitest of the analytic
     * answer and the field's — so broken water stays broken until the field
     * fades it — and inside the footprint only, with a soft edge back to the
     * analytic foam beyond. With `null` the shader is regenerated without any
     * of it: no sampler, no uniforms, not a cycle spent. That is the phone
     * path, and it is why this is a recompile rather than a branch.
     *
     * The field's own uniform objects are adopted rather than copied, because
     * it ping-pongs two render targets and the texture changes every update.
     */
    setFoamField(foamOrNull) {
      const had = foamField !== null;
      adoptFoamField(foamOrNull);
      if (had !== (foamField !== null)) rebuild();
    },

    /**
     * Reflect a real sky instead of a ramp that resembles one.
     *
     * @param cubeTexture  a mipmapped cube — `createSky().reflection` — or null
     *                     to go back to the procedural gradient.
     * @param amount       0..1, how far the ramp is mixed toward it. Zero is
     *                     the shipped look exactly; the branch is compiled in
     *                     as soon as there is a texture, so a game may animate
     *                     the amount from nought without a recompile.
     */
    setReflection(cubeTexture, amount = 1) {
      const had = reflection !== null;
      reflection = cubeTexture ?? null;
      uniforms.uSkyRefl.value = reflection;
      uniforms.uSkyReflAmount.value = reflection ? clamp(amount, 0, 1) : 0;
      if (had !== (reflection !== null)) rebuild();
    },

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
        rebuild();
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
