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
// One term in there is not reflected light at all. Under a dark enough sky the
// churned water lights itself: sea fire, keyed off the scar field, so a wake is
// a green trail that outlives the white it was made of. It is gated on a
// uniform that a lit sky drives to nought, and a daylight sea therefore pays a
// comparison for it and nothing else.
//
// Close in it reaches back for the wave table and re-evaluates the analytic
// normal per pixel. That is not extra detail invented for the eye — it is the
// sum the CPU already walks, sampled where a metres-wide grid cell was
// interpolating the crest edges away.
//
// Closer still — inside a hundred metres, which from the helm is everything
// between the taffrail and the next sea — three things happen that are for the
// eye alone, all of them switched by the same `normalRange` that governs the
// per-pixel normal, and all of them described in render/detail.js: a second
// wave table of half-metre-to-ten-metre wavelets travelling at their own
// speeds, capped at fifteen centimetres in total; lace and a harder edge in the
// near foam; and shadow on the leading face under a crest at the top of its
// pinch. The first is the review's sub-30cm carve-out spent deliberately; the
// third is its sanctioned fake for a breaking lip, which must never be built
// out of geometry the physics cannot see.
//
// And optionally, underneath all of that, a spectral tile: a GPU inverse-FFT
// of a fenced, wind-aligned spectrum, sampled twice at two turns and two scales
// so its period never shows, and used to perturb the near-field normal and
// nothing else. It moves no vertex — not a millimetre, ever — which is why it
// costs the identity nothing at all and why the vertex stage below is byte for
// byte the same whether it is switched on or off. See render/fftcascade.js.
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
import {
  DETAIL_COUNT,
  detailTable,
  detailUniforms,
  detailVertexChunk,
  detailNormalChunk,
} from './detail.js';

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
  // How much sea fire is in the water, 0..1. Nought is every daylight preset
  // there will ever be; one is a moonless night over a bloom.
  bioluminescence: 0,
  water: { deep: 0x25383c, crest: 0x3d6a5c, foam: 0xdfe4e4, glow: 0x2fd6a8 },
};

// The band of sky brightness over which sea fire is put out, measured as the
// luminance of the haze colour in linear light. Below the first number the sky
// is dark enough to see a bloom by; above the second there is daylight on the
// water and there is nothing to see, however hard the water is glowing. Storm
// grey sits at 0.40 and dusk at 0.23, so both are well clear of it: a preset
// has to be night before the term can turn on at all.
const GLOW_SKY_LO = 0.02;
const GLOW_SKY_HI = 0.18;

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
const vertexShader = (waveCount, detailCount) => /* glsl */ `
  ${oceanVertexChunk(waveCount)}
${detailCount > 0 ? detailVertexChunk(detailCount) : ''}
  uniform vec3 uCameraPos;
${detailCount > 0 ? '  uniform float uDetail;' : ''}

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
${detailCount > 0 ? `
    // And the wavelets on top of it, near the camera only, and never more than
    // fifteen centimetres of them all told. The crest the fragment stage keys
    // its foam off is left exactly as the spectrum reported it: this layer is
    // texture, and it has no business deciding where the sea breaks.
    vec3 chopSlope;
    displaced += detailDisplace(p, camDist, uTime, chopSlope) * uDetail;
    n = normalize(n + chopSlope * uDetail);
` : ''}
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
 * field, the sky reflection and the spectral cascade are compiled in the same
 * way and for the same reason: a phone with none of them is running the shader
 * it ran before any of them existed, down to the uniform declarations.
 */
const fragmentShader = (waveCount, normalRange, detailCount, features = {}) => /* glsl */ `
  ${normalRange > 0 ? oceanNormalChunk(waveCount) : ''}
  ${detailCount > 0 ? detailNormalChunk(detailCount) : ''}
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
  uniform vec3 uGlow;          // sea fire: the colour churned water burns
  uniform float uGlowAmount;   // 0..1, already put out by whatever sky is up
${detailCount > 0 ? '  uniform float uDetail;       // 0 turns the near-field treatment off' : ''}
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
` : ''}${features.cascade ? `
  // The spectral cascade: one tiling patch of inverse-FFT slope, plus a scalar
  // of micro-foam energy in its third channel. See render/fftcascade.js.
  uniform sampler2D uCascade;
  uniform float uCascadeInvPatch; // 1 / the tile's width in metres
  uniform float uCascadeGain;     // 0 leaves the near field exactly as it was
  uniform float uCascadeFoam;     // micro-foam into the lace, at a low gain
  uniform float uCascadeFar;      // metres at which the tile has faded out
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
${detailCount > 0 ? `  // The same octave folded about its own middle, which turns blobs into veins
  // for the price of an abs(). Foam close to does not lie on the water in
  // patches: it lies in lace, thick along the folds and thin between them.
  float veins(vec2 p) {
    return 1.0 - abs(noise(p) * 2.0 - 1.0);
  }` : ''}

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
      vec3 nf = gerstnerNormal(vUndisp, camDistF, uTime);${detailCount > 0 ? `
      // The wavelets, where a pixel can hold one. The same sum the vertex
      // stage displaced by, evaluated at the same datum footprint — but carried
      // an order of magnitude further out, because a pixel resolves half a
      // metre of chop at twenty metres and a vertex resolves it nowhere.
      nf = normalize(nf + detailSlope(vUndisp, camDistF, uTime) * uDetail);` : ''}
      n = normalize(mix(vNormal, nf, nearAmt));
    }
` : ''}${features.cascade ? `
    // --- The spectral cascade -----------------------------------------------
    // Below the wavelets, the octaves no table could hold: a hundred and
    // twenty-eight square of inverse-FFT slope over a thirty-six metre patch,
    // world-anchored and tiling. It perturbs this normal and it does nothing
    // else — no vertex has ever heard of it — so all it can cost the identity
    // is a shade of light on water that is exactly where the CPU says it is.
    //
    // Sampled twice, which is the whole of the detiling. The first sample is
    // the tile as it lies; the second is the same tile turned sixty-two degrees
    // and shrunk to two fifths, at an offset of its own. Two lattices at an
    // angle with no common period leave nothing for the eye to lock on to, and
    // the small one comes with a bonus: at two fifths the scale it carries the
    // octave *below* the grid's own Nyquist, for the price of a second fetch.
    float cascFoam = 0.0;
    float cascAmt = uCascadeGain * (1.0 - smoothstep(uCascadeFar * 0.45, uCascadeFar, dist));
    if (cascAmt > 0.002) {
      vec2 cp = vUndisp * uCascadeInvPatch;
      vec4 broad = texture2D(uCascade, cp);

      vec2 rp = vec2(cp.x * 0.4695 - cp.y * 0.8829, cp.x * 0.8829 + cp.y * 0.4695)
              * 0.41 + vec2(0.317, 0.113);
      vec4 fine = texture2D(uCascade, rp);
      // The turned sample's slope is measured in its own turned frame, so it is
      // turned back before the two are added. Miss this and the fine octave
      // lights from sixty degrees off the wind.
      vec2 fineSlope = vec2(fine.x * 0.4695 + fine.y * 0.8829,
                           -fine.x * 0.8829 + fine.y * 0.4695);

      vec2 slope = broad.xy * 0.62 + fineSlope * 0.52;
      cascFoam = max(broad.z, fine.z) * cascAmt;

      n = normalize(n + vec3(-slope.x, 0.0, -slope.y) * cascAmt);
    }
` : ''}
    // Ripple the analytic normal with drifting noise. This is the texture of
    // wind on water; beyond a few hundred metres it would only shimmer, so it
    // fades out. The fade is in metres because it is about what a pixel can
    // resolve, not about how big the sea is. Where the per-pixel normal is
    // running it is turned down to what it is honestly for — micro-detail
    // below the shortest wave in the table — rather than standing in for the
    // definition the vertex normal was losing. Where the wavelet table is
    // running as well it is turned down further still: the noise and the
    // wavelets are both standing in for the same missing octaves, and the point
    // of building the wavelets was to *replace* fakery rather than add to it.
    float rippleAmt = uRipple * exp(-dist / 900.0)
                    * (1.0 - ${detailCount > 0 ? '(0.55 + 0.30 * uDetail)' : '0.55'} * nearAmt);
${features.cascade ? `    // And down again wherever the cascade is running. The noise and the tile
    // stand in for the same missing octaves, and the point of building the tile
    // was to *replace* fakery rather than to add to it — so the total quantity
    // of invention on the near water falls as this layer lands, which is the
    // trade R9 asked for by name.
    rippleAmt *= 1.0 - 0.75 * cascAmt;
` : ''}    if (rippleAmt > 0.01) {
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
${detailCount > 0 ? `
    // Under the fold. A crest at the top of its pinch is already thickening
    // toward throwing its lip forward, and the face beneath one goes into its
    // shadow long before there is anything an oceanographer would call a
    // breaker. Showing that with geometry would put water where heightAt says
    // there is none, in the exact twenty metres where a hull and a wingtip
    // live, so the water darkens instead — the review's sanctioned fake, and
    // the only honest way to buy the mass of an overturning face.
    //
    // Two things have to be true together, which is what keeps it from reading
    // as a painted stripe. The pinch has come up to where this sea breaks —
    // measured off the foam thresholds, so it means the same in a gale as in a
    // survival storm, and starting a little below foamLo so the shade is
    // already there under the white rather than arriving with it. And it is the
    // *leading* face: on a wave running downwind the normal ahead of the crest
    // tilts downwind too, which picks out the side that overturns and nothing
    // else — the back of the crest and the apex itself both fall to nought
    // without a second term. The shape normal is the right one to ask, not the
    // detailed one: this is about which face of a wave a pixel is on, and the
    // wavelets have no opinion worth having about that.
    float pinchBand = max(uFoamHi - uFoamLo, 1e-4);
    float underFold = smoothstep(uFoamLo - 0.35 * pinchBand, uFoamLo + 0.55 * pinchBand, vCrest)
                    * clamp(dot(vNormal.xz, uWindDir) * 3.5, 0.0, 1.0)
                    * (1.0 - smoothstep(45.0, 190.0, dist))
                    * uDetail;
    water = mix(water, uDeep * 0.34, 0.62 * underFold);

    // And less sky in it: a face in the shadow of its own crest is looking up
    // at the water above it rather than out at the horizon.
    fresnel *= 1.0 - 0.4 * underFold;
` : ''}

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
${detailCount > 0 ? `
    // Close in, break the wash into lace. Two octaves of ridged noise at about
    // a metre and a third of a metre, drifting downwind with everything else,
    // and living in the mid tones only: fresh white stays white, bare water
    // stays bare, and what gains structure is the half-broken water between
    // them — which at ten metres is most of what there is to look at.
    float laceAmt = (1.0 - smoothstep(40.0, 165.0, dist)) * uDetail;
    if (laceAmt > 0.004) {
      vec2 lp = vUndisp * 0.95 * uFoamScale + uWindDir * uTime * -0.7;
      float lacework = veins(lp) * 0.62 + veins(lp * 2.6 + 11.3) * 0.38;
      float mids = 4.0 * crestFoam * (1.0 - crestFoam);
      // The pivot is the ridged noise's own mean, so the lace neither adds
      // white nor takes it away on balance: it moves white about inside a
      // patch, which is what lace is, rather than eating holes in one.
      crestFoam = clamp(crestFoam + (lacework - 0.62) * mids * laceAmt * 0.85, 0.0, 1.0);
      // And a harder edge than the far field wants. The soft threshold that
      // stops a crest half a mile off from becoming a white bar is the wrong
      // answer twenty metres astern, where broken water has a rim to it.
      crestFoam = mix(crestFoam, smoothstep(0.12, 0.72, crestFoam), laceAmt * 0.6);
    }
` : ''}${features.cascade ? `
    // The tile's own micro foam: the steepest facets in the wavelet field,
    // which is where a wind sea goes white at a scale no crest sum could reach.
    // Weighted toward water that is already breaking, because that is where a
    // fleck of white belongs — but not only there. A storm sea has scattered
    // white all over it, and a quarter of the term reaches bare water for
    // exactly that reason. The gain is low by construction: this is texture on
    // foam, not a second opinion about where the sea is breaking.
    crestFoam = clamp(
      crestFoam + cascFoam * uCascadeFoam * (0.25 + 0.75 * crestFoam), 0.0, 1.0);
` : ''}
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

    // --- Sea fire -------------------------------------------------------------
    // Bioluminescence, which is the one thing in this shader the sky is not
    // responsible for: the water is not being lit, it is alight. Dinoflagellates
    // fire where the water around them is sheared, so the mask is the same broken
    // water the foam is painted on — and the half of it worth having is the half
    // the sea remembers. A hull carves a lane into the scar field, the field
    // holds it while it decays, and the lane goes on burning green long after it
    // has stopped showing white: at night the foam colour is a dim grey that is
    // lost against a black sea almost at once, and the fire is not.
    //
    // Added as light, before the fog and before the tone map. Before the fog
    // because it is emitted at the surface and distance is entitled to take it
    // like anything else; before the tone map because AgX is what keeps the
    // brightest of it rolling off toward white instead of standing on the
    // display's ceiling as a neon line.
    //
    // Both terms go in squared, and that is the difference between a sea and a
    // green bedsheet. The same tone curve that rescues storm highlights lifts the
    // bottom of the range enormously — a hundredth of scene light comes back as a
    // quarter of the display — so a mask running linearly from a tenth to one
    // arrives at the eye running from two thirds to one, with every wave in it
    // flattened out. Measured in a survival sea, the field's ambient wash is
    // about a tenth and a fresh wake is six times that: squaring is what turns
    // those into a whisper of green under a bright road. It is not only a fix for
    // the curve, either — the fire goes as the water that was actually sheared,
    // and a patch half covered in broken water has nothing like half of it.
    if (uGlowAmount > 0.0) {
      // This instant's breaking crest, at a third the gain: a wave going over
      // now burns, but it is nothing beside the acre of sea it tore a minute
      // ago. Distance-faded already, along with the foam it is measured from.
      float churn = 0.34 * crestFoam * crestFoam;${features.foamField ? `
      // And the memory, at full gain: the same sample the foam took, with the
      // same fade at the edge of the footprint and the same say in how far the
      // field is believed at all. The white water and the fire fade together
      // from here, but they do not fade to the same place — a dim grey foam
      // colour is lost against a black sea long before a green one is — so a
      // lane goes on burning after it has stopped showing white.
      float scar = ffScar * ffFade * uFoamAmount;
      churn = max(churn, scar * scar);` : ''}
      col += uGlow * (churn * 1.2 * uGlowAmount);
    }

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

/**
 * How much sea fire actually reaches the water.
 *
 * Bioluminescence is not faint — a bloom under a bow wave is bright enough to
 * read a chart by — but it is hopelessly outmatched by any sky at all, which is
 * why nobody has seen it from a ferry deck at four in the afternoon. So the
 * lighting's `bioluminescence` is what the sea *has* in it, and this is how much
 * of that survives the sky overhead: the haze colour is the light on the
 * horizon, and once there is a useful amount of it the fire is gone.
 *
 * Done here, on the CPU, once per change of light, rather than in the shader
 * where it would be recomputed a million times a frame to arrive at the same
 * answer. The luminance is of the colour as the shader has it — linear light,
 * not the sRGB the hex was written in — because that is what the eye is being
 * asked about.
 */
function glowAmount(bioluminescence, haze) {
  const luma = haze.r * 0.2126 + haze.g * 0.7152 + haze.b * 0.0722;
  const t = clamp((luma - GLOW_SKY_LO) / (GLOW_SKY_HI - GLOW_SKY_LO), 0, 1);
  const dark = 1 - t * t * (3 - 2 * t);
  return clamp(bioluminescence ?? 0, 0, 1) * dark;
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
 * @param options    { quality, windFromDeg, fogDensity, lighting, foamField,
 *                     cascade, detail }
 *                   quality: { gridN, halfSpan, exponent, normalRange } —
 *                            normalRange also governs the near-field wavelets;
 *                            nought compiles both out.
 *                   lighting: { sunDir, sunColour, skyTop, skyHaze, glare,
 *                               fogDensity, exposure, bioluminescence, water }
 *                             — water is { deep, crest, foam, glow }, the last
 *                               of them the colour of the sea fire.
 *                   foamField: a createFoamField, or nothing at all — see
 *                              `setFoamField` below.
 *                   cascade: a createDetailCascade, or nothing at all — see
 *                            `setDetailCascade` below. Declined if it reports
 *                            itself disabled or if normalRange is nought.
 *                   detail: 0..1, the starting value of `setDetail`.
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
    // Sea fire. The amount is the gate: at nought the term is a comparison that
    // fails, which is why it is a uniform and not a compile flag — a game may
    // sail from dusk into darkness and the sea must not stop to be rebuilt.
    uGlow: { value: new THREE.Color() },
    uGlowAmount: { value: 0 },
    // How much of the near-field treatment is in force. One is the shipped
    // look; nought is the sea exactly as it was before render/detail.js
    // existed, wavelets, lace, fold-shadow and all, which is what makes it
    // possible to judge the three of them against the water they replaced
    // rather than against a memory of it.
    uDetail: { value: clamp(options.detail ?? 1, 0, 1) },
    // Only ever read by a material that has the reflection compiled into it;
    // kept here always so `setReflection` has somewhere to put its answer.
    uSkyRefl: { value: null },
    uSkyReflAmount: { value: 0 },
  };

  // Nought disables the near-field normal pass; anything else is a range in
  // metres, and the shader is generated around it.
  const normalRange = Math.max(0, quality.normalRange ?? 0);

  // The wavelet table rides on the same switch, and for the same reason: it is
  // a second wave loop in both stages, and a machine that cannot afford the
  // first one per pixel certainly cannot afford this. Nought compiles every
  // line of render/detail.js out of both shaders — no arrays, no loop, no
  // uniform declared — and what is left is the phone path unchanged.
  const detailCount = normalRange > 0 ? DETAIL_COUNT : 0;

  // Built either way — it is a dozen sines' worth of arithmetic and a caller
  // may want to read the budget back — but only uploaded where it is compiled.
  let detail = detailTable(sea);
  if (detailCount > 0) Object.assign(uniforms, detailUniforms(detail));

  // The three optional layers. Every one of them is compiled in rather than
  // switched at runtime, so an ocean with none is byte for byte the shader it
  // was before any of them existed — no sampler bound, no uniform declared,
  // nothing to pay for. The foam and reflection uniform names are fixed by
  // Amendment II because two agents build against them from opposite sides;
  // the cascade's follow the same rule for the same reason.
  const FIELD_UNIFORMS = ['uFoamField', 'uFoamOrigin', 'uFoamInvExtent', 'uFoamAmount'];
  const CASCADE_UNIFORMS = [
    'uCascade', 'uCascadeInvPatch', 'uCascadeGain', 'uCascadeFoam', 'uCascadeFar',
  ];
  let foamField = null;
  let reflection = null;
  let cascade = null;

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

  /**
   * The same arrangement for the cascade, with two refusals in it.
   *
   * A cascade that reported itself disabled — no float render targets on this
   * machine — is declined here rather than at every call site, so a game may
   * hand one over unconditionally and still get the sea it would have had. And
   * a phone build, which is what `normalRange` at nought means, never takes one
   * at all: the tile is sampled inside the near-field treatment and there is no
   * near-field treatment to sample it from.
   */
  function adoptCascade(next) {
    for (const key of CASCADE_UNIFORMS) delete uniforms[key];
    cascade = next && !next.disabled && normalRange > 0 ? next : null;
    if (!cascade) return;
    for (const key of CASCADE_UNIFORMS) {
      uniforms[key] = cascade.uniforms?.[key] ?? { value: null };
    }
  }

  const makeMaterial = () =>
    new THREE.ShaderMaterial({
      vertexShader: vertexShader(waveCount, detailCount),
      fragmentShader: fragmentShader(waveCount, normalRange, detailCount, {
        foamField: foamField !== null,
        reflection: reflection !== null,
        cascade: cascade !== null,
      }),
      uniforms,
      // The tone curve is applied in the shader, on the assembled scene value.
      // Say so, or a renderer with its own tone mapping switched on will grade
      // the sea a second time.
      toneMapped: false,
    });

  adoptFoamField(options.foamField);
  adoptCascade(options.cascade);

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

  /** Re-roll the wavelets for the sea now in force. The count never changes, so
   *  this is a re-upload into the same arrays and never a recompile — and the
   *  table is deterministic in the sea state, so a preset swapped away and back
   *  comes back with the chop it had. */
  function applyDetail() {
    detail = detailTable(sea);
    if (detailCount === 0) return;
    const fresh = detailUniforms(detail);
    for (const key of Object.keys(fresh)) uniforms[key].value = fresh[key].value;
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

    // After the haze, which the gate is computed from.
    setColour(uniforms.uGlow, lighting.water.glow);
    uniforms.uGlowAmount.value = glowAmount(lighting.bioluminescence, uniforms.uSkyHaze.value);
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

    /** The wavelet table in force, budget and all. Read-only, and mostly read
     *  by the tests that hold this file to the fifteen-centimetre law. */
    get detail() {
      return detail;
    },

    update(cameraPos) {
      // The mesh's clock *is* the wave field's clock. One sea.
      uniforms.uTime.value = waveField.time;
      uniforms.uCameraPos.value.copy(cameraPos);
      mesh.position.x = cameraPos.x;
      mesh.position.z = cameraPos.z;
    },

    setLighting,

    /**
     * How much of the near-field treatment to run, 0..1.
     *
     * One dial for all three of the things render/detail.js brought: the
     * wavelets, the foam lace and the shadow under a fold. Nought is the sea as
     * it was before any of them, which is what it is for — put it on a key in a
     * workbench and the eye can be asked the only question that matters, which
     * is whether the water is better with them than without. It is a uniform,
     * not a recompile, so it can be animated; to be rid of the cost as well as
     * the look, build with `quality.normalRange` at nought.
     */
    setDetail(amount) {
      uniforms.uDetail.value = clamp(amount ?? 1, 0, 1);
    },

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
     * Put the spectral cascade under the near field, or take it away again.
     *
     * With one set, the fragment stage samples a tiling slope tile twice and
     * perturbs the near-field normal with it, and turns the fbm ripple down by
     * the same amount — the tile is what the noise was pretending to be. With
     * `null` the shader is regenerated without a line of it: no sampler, no
     * uniforms, not a cycle spent, and the source is byte for byte the string
     * it was before. That is the phone path and the A/B both, which is why this
     * is a recompile rather than a branch.
     *
     * The cascade's own uniform objects are adopted rather than copied, the
     * arrangement `setFoamField` already uses. A cascade that could not build
     * its render targets, or an ocean built with `quality.normalRange` at
     * nought, is quietly declined: see `adoptCascade`.
     *
     * @param cascadeOrNull  a createDetailCascade, or null.
     */
    setDetailCascade(cascadeOrNull) {
      const had = cascade !== null;
      adoptCascade(cascadeOrNull);
      if (had !== (cascade !== null)) rebuild();
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
      applyDetail();
    },

    dispose() {
      geometry.dispose();
      mesh.material.dispose();
    },
  };
}
