// The wavelets between the waves.
//
// Twelve spectrum components carry a storm from three hundred metres down to
// about twelve, and below that the shader has always been pretending: an fbm
// ripple sliding over smooth geometry, which from a masthead is fine and from
// the taffrail is a sheen on a rolling hill. Real water at ten metres' range is
// not smooth between the swells. It carries chop of its own — half a metre to
// ten, travelling at its own speeds, crossing the swell at an angle — and it is
// the *travelling* that gives it away. Noise that slides is scenery; wavelets
// that disperse are water.
//
// So this file builds a second, smaller wave table out of the same materials as
// the first, and hands it to the shader alone. The CPU never walks it. That is
// a deliberate, bounded break in the law the library is built on, and the
// bounds are the whole point:
//
//   * the summed vertical amplitude is 0.15 m, half the review's sub-30cm
//     carve-out, and enforced by construction (the table is normalised to the
//     budget, not merely checked against it) and again by test;
//   * the summed Gerstner pinch is 0.3, so nothing here can fold a crest the
//     inversion would then have to find;
//   * everything fades out entirely by four hundred metres, and is at full
//     strength only within a hundred and twenty.
//
// Fifteen centimetres is below the noise floor of every physics query in the
// library: a hull with 3.2 m of freeboard, a bird skimming at five metres, a
// broach latch keyed to a seventeen-metre sea. It is not below the noise floor
// of the eye at ten metres, which is exactly the gap this layer fills.

const GRAVITY = 9.81;

/** Components in the detail table. Eleven is where adding more stopped being
 *  visible and started being a uniform-array budget question. */
export const DETAIL_COUNT = 11;

/** The longest and shortest wavelets, in metres. The long end overlaps the
 *  bottom of the spectrum's own tail (`chopLength` is 12 m in the storm preset,
 *  1.6 m in calm), which is what keeps the join from showing as a scale gap;
 *  the short end is about the smallest thing a pixel can hold at ten metres. */
export const DETAIL_LONG = 10;
export const DETAIL_SHORT = 0.55;

/** The sacred carve-out, halved for safety: the summed vertical amplitude of
 *  everything in this file, in metres, at the roughest sea state there is. */
export const AMP_BUDGET = 0.15;

/** And the summed Gerstner pinch, on the same terms. The spectrum proper
 *  spends up to 0.8 of a possible 1.0; this is a tenth of what is left. */
export const PINCH_BUDGET = 0.3;

/** Full strength within this many metres of the camera, and gone by the far
 *  one. Both are read by the shader chunks below and by nothing else. */
export const DETAIL_NEAR = 120;
export const DETAIL_FAR = 400;

/** How far either side of downwind the wavelets fan, in degrees. Wind chop has
 *  no memory of the fetch that built the swell, so it spreads far wider than
 *  the spectrum's own tail does. */
const SPREAD_DEG = 45;

/**
 * The narrowest fan, for the longest wavelets.
 *
 * Wider than the spectrum's own narrow end, and deliberately: eleven components
 * all within a few degrees of one another read as corduroy from ten metres
 * exactly as three did from a masthead. Twenty degrees either side means the
 * two longest cross at forty, and what the eye gets is a cellular chop rather
 * than a ribbed sheet.
 */
const NARROW_DEG = 20;

const HEADING_JITTER_DEG = 6;
const AMP_JITTER = 0.18;

/**
 * Amplitude against wavelength, as a power.
 *
 * One would be constant steepness — the spectrum's own rule for its tail, and
 * the right one there. Down here it is a little wrong: a wind sea's short chop
 * is *steeper* than the swell under it, which is why it is the chop that
 * breaks first and the swell that only heaves. Under one, the slope this table
 * contributes rises gently toward the short end, and since the fifteen
 * centimetres are spent almost entirely on the long components anyway, the
 * short ones buy their texture for nearly nothing.
 */
const LENGTH_EXPONENT = 0.78;

/** What a glassy heave keeps. Not nought: a millpond in three metres of wind
 *  still has cat's paws on it, and they are a centimetre tall. */
const CALM_FLOOR = 0.08;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The same LCG the spectrum uses, seeded from the sea rather than from options.
 *
 * A detail table is not something a game asks for by name — it appears
 * underneath whatever sea state is in force — so its seed has to come from that
 * sea state, and it has to be stable: the same sea must give the same wavelets
 * on every machine and after every reload, or a preset swapped away and back
 * would visibly re-roll its own chop.
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The preset name and the spectrum's own seed, folded into one integer. FNV-1a,
 * because it scatters short strings well and is four lines.
 *
 * The seed is fished out of the wave table rather than asked for: `SeaState`
 * does not keep the number it was built from, but every phase in it came out of
 * that seeded LCG and out of nothing else, so the first one stands in for it
 * exactly. Two seas built with different seeds get different chop; the same
 * options twice get the same chop.
 *
 * Deliberately *not* the wind. The spectrum turns rigidly when the wind
 * changes — same table, new bearing — and the wavelets must turn with it in the
 * same way, or a slowly veering gale would re-roll its own chop every degree.
 */
function seedFrom(sea) {
  const name = String(sea?.preset ?? 'sea');
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  }
  h = Math.imul(h ^ Math.round((sea?.waves?.[0]?.phase ?? 0) * 1e6), 16777619);
  return h >>> 0;
}

/**
 * How much chop this sea is entitled to, 0..1.
 *
 * The same statistic `foamProfile` keys its thresholds off — significant
 * height, which is 4σ of the surface — put through the same curve, so the
 * wavelets arrive with the whitecaps and not before. Recomputed here rather
 * than imported so that the dependency runs one way only: the ocean knows about
 * the detail layer, the detail layer knows only about the sea.
 */
export function chopEnergy(sea) {
  let heightVar = 0;
  for (const w of sea?.waves ?? []) heightVar += w.amp * w.amp * 0.5;
  const significant = 4 * Math.sqrt(heightVar);
  const coverage = Math.pow(clamp((significant - 0.35) / 17, 0, 1), 0.55);
  return CALM_FLOOR + (1 - CALM_FLOOR) * coverage;
}

/**
 * Build the detail table for a sea state.
 *
 * The shape is the spectrum's own, one octave band lower: log-spaced
 * wavelengths, amplitude a power of wavelength so the chop looks like the same
 * water as the swell — only smaller, and a shade steeper for its size, which is
 * what a wind sea does (see LENGTH_EXPONENT) — headings alternating either side
 * of downwind and fanning wider as they shorten, deep-water dispersion
 * ω = √(g·k) so each one travels
 * at its own speed and the interference between them crawls the way a real
 * sea's does.
 *
 * Amplitudes are then normalised to the budget rather than checked against it,
 * which is what makes the fifteen-centimetre law structural: there is no
 * combination of preset, wind and scale that can overspend it.
 *
 * @returns { waves, ampSum, pinchSum, energy, count } — `waves` in exactly the
 *          shape `SeaState.waves` uses, so anything that can walk one can walk
 *          the other.
 */
export function detailTable(sea, count = DETAIL_COUNT) {
  const n = Math.max(1, Math.floor(count));
  const rand = makeRandom(seedFrom(sea));
  const energy = chopEnergy(sea);

  const travelDeg = (sea?.windFromDeg ?? 285) + 180;

  // Draws in one fixed order per component, so changing the count never
  // reshuffles the components before it — the spectrum's rule, and for the
  // same reason.
  const lengths = [];
  const headings = [];
  const weights = [];
  const phases = [];

  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    const length = DETAIL_LONG * Math.pow(DETAIL_SHORT / DETAIL_LONG, f);
    const fan = NARROW_DEG + (SPREAD_DEG - NARROW_DEG) * f;

    lengths.push(length);
    headings.push(
      clamp(
        (i % 2 === 0 ? -1 : 1) * fan + (rand() * 2 - 1) * HEADING_JITTER_DEG,
        -SPREAD_DEG,
        SPREAD_DEG
      )
    );
    weights.push(Math.pow(length, LENGTH_EXPONENT) * (1 + (rand() * 2 - 1) * AMP_JITTER));
    phases.push(rand() * Math.PI * 2);
  }

  // Normalise to the budget. Not a clamp: the table is *defined* as the budget
  // shared out, so the sum is the budget times the sea's own chop energy and
  // can be neither more nor less.
  const weightSum = weights.reduce((a, w) => a + w, 0) || 1;
  const ampScale = (AMP_BUDGET * energy) / weightSum;
  const amps = weights.map((w) => w * ampScale);

  // Pinch as the spectrum shares it: by the square root of amplitude, so the
  // longer wavelets get the sharper crests and the short ones stay sinusoidal.
  const pinchTotal = PINCH_BUDGET * energy;
  const roots = amps.map((a) => Math.sqrt(Math.max(a, 0)));
  const rootSum = roots.reduce((a, r) => a + r, 0) || 1;

  const waves = amps.map((amp, i) => {
    const bearing = ((travelDeg + headings[i]) * Math.PI) / 180;
    const k = (2 * Math.PI) / lengths[i];
    const pinch = (pinchTotal * roots[i]) / rootSum;
    return {
      dx: Math.sin(bearing),
      dz: -Math.cos(bearing),
      k,
      omega: Math.sqrt(GRAVITY * k),
      amp,
      q: amp > 0 ? pinch / (k * amp) : 0,
      length: lengths[i],
      phase: phases[i],
      off: headings[i],
    };
  });

  return {
    waves,
    count: n,
    energy,
    ampSum: waves.reduce((a, w) => a + w.amp, 0),
    pinchSum: waves.reduce((a, w) => a + w.q * w.k * w.amp, 0),
  };
}

/** Uniform values in the layout the chunks below expect. Deliberately a
 *  separate set of arrays from `waveUniforms`: nothing that walks the physical
 *  table must ever be able to reach this one by accident. */
export function detailUniforms(table) {
  return {
    uDetDir: { value: table.waves.flatMap((w) => [w.dx, w.dz]) },
    uDetK: { value: table.waves.map((w) => w.k) },
    uDetOmega: { value: table.waves.map((w) => w.omega) },
    uDetAmp: { value: table.waves.map((w) => w.amp) },
    uDetQ: { value: table.waves.map((w) => w.q) },
    uDetLen: { value: table.waves.map((w) => w.length) },
    uDetPhase: { value: table.waves.map((w) => w.phase) },
  };
}

/** GLSL will not coerce an integer to a float; 5 must be written 5.0. */
const glslFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** Shared by both stages, which are separate programs' worth of declarations
 *  against the same uniforms — the arrangement `waveArrayDeclarations` already
 *  uses for the physical table. */
function detailDeclarations(count) {
  return /* glsl */ `
  #define ND ${count}

  uniform vec2 uDetDir[ND];
  uniform float uDetK[ND];
  uniform float uDetOmega[ND];
  uniform float uDetAmp[ND];
  uniform float uDetQ[ND];
  uniform float uDetLen[ND];
  uniform float uDetPhase[ND];

  // The near field, and only the near field. Beyond the far range there is no
  // pixel that could resolve half a metre of chop and no vertex that could
  // carry it, so the layer is not merely faint out there — it is absent, and
  // the sea beyond is the sea that shipped before this file existed.
  float detailFade(float camDist) {
    return 1.0 - smoothstep(${glslFloat(DETAIL_NEAR)}, ${glslFloat(DETAIL_FAR)}, camDist);
  }
`;
}

/**
 * The vertex half: displace by the wavelet sum, and report the slope it adds.
 *
 * Honest about what this can achieve. The warped grid puts its cells at about
 * two and a half metres by five metres out and twelve by a hundred, so the mesh
 * cannot carry a two-metre wavelet anywhere the eye would see one, and the
 * per-component attenuation here says so: each fades out at a range
 * proportional to its own wavelength, steeply, so nothing is displaced where it
 * would only alias. What survives is a few centimetres of the longest wavelets
 * right under the taffrail. The *look* is carried by the fragment half below;
 * this exists so that the geometry and the shading are describing the same
 * water rather than the second contradicting the first, and it is bounded so
 * tightly that it could not lie to the physics if it tried.
 */
export function detailVertexChunk(count = DETAIL_COUNT) {
  return /* glsl */ `
  ${detailDeclarations(count)}

  vec3 detailDisplace(vec2 p, float camDist, float t, out vec3 slope) {
    vec3 d = vec3(0.0);
    slope = vec3(0.0);

    float fade = detailFade(camDist);
    if (fade < 0.004) return d;

    for (int i = 0; i < ND; i++) {
      float amp = uDetAmp[i] * fade * exp(-camDist / (uDetLen[i] * 2.5 + 1.0));
      if (amp < 0.0004) continue;

      vec2 dir = uDetDir[i];
      float theta = uDetK[i] * dot(dir, p) - uDetOmega[i] * t + uDetPhase[i];
      float s = sin(theta);
      float c = cos(theta);
      float qa = uDetQ[i] * amp;
      float ka = uDetK[i] * amp;

      d.x += dir.x * qa * c;
      d.z += dir.y * qa * c;
      d.y += amp * s;

      slope.x -= dir.x * ka * c;
      slope.z -= dir.y * ka * c;
      slope.y -= uDetQ[i] * ka * s;
    }

    return d;
  }
`;
}

/**
 * The fragment half: the slope alone, per pixel, where the eye can resolve it.
 *
 * This is where the layer earns its keep. A pixel of near water can hold a
 * half-metre wavelet perfectly well; a vertex cannot. The attenuation is the
 * same shape as the vertex's and an order of magnitude longer-ranged — a
 * half-metre component is gone by thirty metres, a ten-metre one runs out to
 * the far fade — which is a statement about what a pixel can hold without
 * shimmering, not about where the water is.
 */
export function detailNormalChunk(count = DETAIL_COUNT) {
  return /* glsl */ `
  ${detailDeclarations(count)}

  vec3 detailSlope(vec2 p, float camDist, float t) {
    vec3 slope = vec3(0.0);

    float fade = detailFade(camDist);
    if (fade < 0.004) return slope;

    for (int i = 0; i < ND; i++) {
      float amp = uDetAmp[i] * fade * exp(-camDist / (uDetLen[i] * 34.0 + 8.0));
      if (amp < 0.0004) continue;

      vec2 dir = uDetDir[i];
      float theta = uDetK[i] * dot(dir, p) - uDetOmega[i] * t + uDetPhase[i];
      float ka = uDetK[i] * amp;

      slope.x -= dir.x * ka * cos(theta);
      slope.z -= dir.y * ka * cos(theta);
      slope.y -= uDetQ[i] * ka * sin(theta);
    }

    return slope;
  }
`;
}
