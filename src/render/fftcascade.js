// The octave the table cannot hold.
//
// render/detail.js put eleven travelling wavelets under the taffrail and that
// was the right thing to do — they disperse, they cross, they are the same
// water as the swell above them. But eleven is eleven. Stand at the rail in a
// gale and the near water is not eleven wavelets: it is a continuum, thousands
// of components between half a metre and half a dozen, none of them separable
// by eye, and the interference between them is the *texture* of a sea. Eleven
// lines through that band read, on a still frame, as eleven lines. The review
// said as much when it wrote R9 stage 2 — build the cascade only if the
// discrete components still read as discrete. They do.
//
// So: a Tessendorf tile. A seeded, wind-aligned spectrum on a 128×128 lattice
// over a thirty-six metre patch, evolved with the deep-water dispersion the
// rest of the library uses, inverse-transformed on the GPU by ping-pong
// butterfly passes, and sampled as a tiling slope field under the taffrail.
// Continuous where the table is discrete, and dense where the fbm ripple it
// replaces was merely noisy.
//
// The law, and why this file cannot break it:
//
//   THE CASCADE CONTRIBUTES NORMALS ONLY. Not fifteen centimetres of
//   displacement, not one. There is no path from this file into the vertex
//   stage, and the ocean's shader-variant test asserts the vertex shader is
//   byte for byte the same with the cascade on and off. The sub-30cm carve-out
//   is not being spent here at all — it stays spent on detail.js, where it can
//   be counted. A surface the physics samples and a surface the eye sees differ
//   by a *shading* term, which is the same thing the fbm ripple has always been
//   and a good deal more honest about what it is describing.
//
// And spectrally fenced, as R12 asks: everything longer than about seven
// metres is zeroed out of the spectrum before a single mode is drawn, so the
// band physics owns is untouched by construction rather than by amplitude. The
// cascade lives entirely in the octaves below the wave table's own tail.
//
// Determinism: the spectrum is drawn on the CPU, once per sea state, from an
// LCG seeded out of the sea exactly as detail.js seeds its wavelets. Same sea,
// same tile, on every machine and after every reload. The GPU is handed a
// finished table and a clock, and the clock is `waveField.time` — never a wall
// clock, so the tile advances under the demo's `step()` like everything else.

import * as THREE from 'three';
import { chopEnergy } from './detail.js';

const GRAVITY = 9.81;

/**
 * The defaults, and what each of them costs.
 *
 * `size` costs less than it looks. The whole bill of this file is the number of
 * render passes rather than the number of texels — measured, see
 * `butterflyFragment` — and with two butterfly levels to a draw a hundred and
 * twenty-eight and two hundred and fifty-six both come to ten passes. 128 over
 * a thirty-six metre patch puts a texel every 28 cm, which resolves down to a
 * fifty-six centimetre wavelet: about the smallest thing worth drawing at ten
 * metres' range and comfortably below anything the wave table carries. Going to
 * 256 buys another octave for a few per cent.
 *
 * `patch` is the tiling period, and it is the one number with a real trade in
 * it. Larger is a longer repeat and coarser texels; smaller is finer water and
 * a repeat that shows. Thirty-six metres is a compromise the detiling below
 * makes work: from the helm the near field is sixty metres deep, so the eye
 * sees under two periods of it and never a lattice.
 */
const DEFAULTS = {
  size: 128, // texels square; 256 is the quality option
  patch: 36, // metres across the tile
  // How much slope the cascade is entitled to, as the RMS of |∇h| at the
  // roughest sea there is. Twelve hundredths is about seven degrees of
  // micro-tilt on the water: enough to break a specular highlight into glitter,
  // far too little to be mistaken for a wave. The tile is normalised to this
  // rather than clamped at it, so no preset, wind or seed can overspend it.
  slopeBudget: 0.13,
  // Gain on the micro-foam channel where it is fed into the ocean's lace. Low,
  // deliberately: it is texture on foam, not a decision that this water is foam.
  microFoam: 0.22,
  // Metres at which the tile has faded to nothing. Full strength to a little
  // under half of it, which is the sixty metres the helm actually looks at.
  far: 250,
  renderer: null, // for the feature test; see `disabled`
};

/**
 * The spectral fence, in metres of wavelength.
 *
 * Above `FENCE_OFF` the cascade carries nothing at all: that is the band the
 * wave table owns, the band `heightAt` answers for, and the band a hull floats
 * on. Below `FENCE_ON` it carries everything. Between the two it rolls off
 * smoothly in log wavelength, so there is no step in the spectrum where the two
 * halves of the library meet.
 *
 * Seven metres sits just below `DETAIL_LONG`, which is where render/detail.js
 * starts. The two layers therefore overlap through the middle of the band and
 * agree about the bottom of it — the wavelets giving it a few large, sharply
 * defined components and the cascade filling every gap between them.
 */
export const FENCE_OFF = 7;
export const FENCE_ON = 2.4;

/**
 * How hard the spectrum is taken down at the grid's own Nyquist, as a multiple
 * of the Nyquist wavenumber. Content right at the limit is content the lattice
 * cannot represent without aliasing into a moving stipple, so it is taped off
 * before it is drawn: at 1.38 the shortest wavelength the grid can hold keeps
 * about a seventh of its energy, and the taper is imperceptible an octave up.
 */
const NYQUIST_TAPER = 1.38;

/**
 * How far the short chop runs against the wind. Nought would be a spectrum with
 * a hard edge across it; wind sea at this scale is nearly isotropic and a fifth
 * is enough to keep the tile from reading as combed.
 */
const AGAINST_WIND = 0.2;

/** Steep facets, in multiples of the field's own slope RMS: where the micro
 *  foam starts and where it is solid. A Rayleigh-ish field puts a per cent or
 *  two of its area past three sigma, which is what scattered white looks like. */
const FOAM_LO_SIGMA = 2.0;
const FOAM_HI_SIGMA = 3.3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** GLSL will not coerce an integer to a float; 5 must be written 5.0. */
const glslFloat = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

// --- The seed -----------------------------------------------------------------

/**
 * The same LCG the spectrum and the wavelets use.
 *
 * Draws happen in one fixed scan order and every texel takes exactly two of
 * them, whatever its spectral density turns out to be — including the zeroes
 * outside the fence. A table whose draw count depended on its values would
 * reshuffle itself the moment the fence moved, and the tile would stop being
 * reproducible from the sea state alone.
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * The preset name and the spectrum's own seed, folded into one integer, exactly
 * as render/detail.js recovers it — FNV-1a over the name, folded with the first
 * wave's phase, which came out of the seeded LCG and out of nothing else.
 *
 * Deliberately the same recovery and deliberately not the same *number*: the
 * salt below moves this table off the wavelets' one, so the cascade and the
 * wavelets are two independent draws from one sea rather than two views of one
 * draw. Written out again rather than imported because detail.js keeps it
 * private, and because a shared helper would be a dependency between two layers
 * that should not have one.
 */
function seedFrom(sea) {
  const name = String(sea?.preset ?? 'sea');
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  }
  h = Math.imul(h ^ Math.round((sea?.waves?.[0]?.phase ?? 0) * 1e6), 16777619);
  // The salt. Any constant would do; this one is 'fft' in FNV.
  h = Math.imul(h ^ 0x6d5a2f19, 16777619);
  return h >>> 0;
}

/**
 * Two independent standard normals, by Box–Muller.
 *
 * The uniform is nudged off nought rather than redrawn, because a redraw would
 * make the number of draws depend on the values and the table would stop being
 * reproducible. The nudge is at the twelfth decimal place and can move a
 * gaussian by nothing a float could record.
 */
function gaussians(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  const a = 2 * Math.PI * v;
  return [r * Math.cos(a), r * Math.sin(a)];
}

// --- The spectrum -------------------------------------------------------------

/** Smoothstep, with the edges either way round. */
function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Build the tile's spectrum for a sea state.
 *
 * Phillips, which is the equilibrium tail of a wind sea and the right shape for
 * the band this file lives in: amplitude going as k⁻² gives slope energy that
 * is flat per octave, so nothing in the cascade has a scale of its own and the
 * eye reads texture rather than a wavelength. On top of it: a cos² directional
 * term about downwind so the chop combs the way the wind combs it, the fence
 * that keeps this layer out of the wave table's band, and the Nyquist taper.
 *
 * The result is packed one texel per lattice point as
 * `(h0(k).re, h0(k).im, h0(−k).re, h0(−k).im)` — the pair the time evolution
 * needs, so the shader can build a Hermitian field without ever having to read
 * a second texel. It is that pairing, and nothing else, that makes the inverse
 * transform come out real.
 *
 * Amplitudes are normalised to the slope budget rather than checked against it:
 * the table is *defined* as the budget shared out, and the sum can be neither
 * more nor less.
 *
 * @returns `{ data, size, patch, energy, slopeRms, foamLo, foamHi, modes,
 *            shortest, longest }`
 */
export function cascadeSpectrum(sea, options = {}) {
  const size = Math.max(4, 1 << Math.round(Math.log2(options.size ?? DEFAULTS.size)));
  const patch = Math.max(1, options.patch ?? DEFAULTS.patch);
  const budget = Math.max(0, options.slopeBudget ?? DEFAULTS.slopeBudget) * chopEnergy(sea);

  const dk = (2 * Math.PI) / patch;
  const kNyquist = (Math.PI * size) / patch;
  const taper = NYQUIST_TAPER / kNyquist;

  // Downwind, which is where the chop runs.
  const travel = ((sea?.windFromDeg ?? 285) + 180) * (Math.PI / 180);
  const wx = Math.sin(travel);
  const wz = -Math.cos(travel);

  // The wind's own largest wave. In this band the envelope is one to within a
  // rounding error — the fence is doing all the low-k work — but it is what
  // makes the formula Phillips rather than a power law with a haircut, and a
  // calmer preset does narrow the top of the band a little.
  const bigL = Math.max(1e-3, (sea?.windSpeed ?? 8) ** 2 / GRAVITY);

  const logOff = Math.log(FENCE_OFF);
  const logOn = Math.log(FENCE_ON);

  const rand = makeRandom(seedFrom(sea));

  const n = size * size;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const kSq = new Float64Array(n);
  let modes = 0;
  let shortest = Infinity;
  let longest = 0;

  // Pass one: draw every mode, in scan order, two gaussians each.
  for (let j = 0; j < size; j++) {
    const mz = j < size / 2 ? j : j - size;
    const kz = mz * dk;
    for (let i = 0; i < size; i++) {
      const mx = i < size / 2 ? i : i - size;
      const kx = mx * dk;
      const idx = j * size + i;

      const [g1, g2] = gaussians(rand);

      const k2 = kx * kx + kz * kz;
      kSq[idx] = k2;
      if (k2 < 1e-12) continue;

      const k = Math.sqrt(k2);
      const wavelength = (2 * Math.PI) / k;

      // The fence, in log wavelength: nothing at seven metres and above,
      // everything at two and a bit and below.
      const fence = smoothstep(logOff, logOn, Math.log(wavelength));
      if (fence <= 0) continue;

      // cos² about downwind, with the against-wind half cut down rather than
      // cut out — a spectrum with a hard edge across it reads as combed.
      const cosine = (kx * wx + kz * wz) / k;
      let dir = cosine * cosine;
      if (cosine < 0) dir *= AGAINST_WIND;

      const phillips =
        (Math.exp(-1 / (k2 * bigL * bigL)) / (k2 * k2)) *
        dir *
        fence *
        Math.exp(-k2 * taper * taper);

      if (!(phillips > 0)) continue;

      const a = Math.sqrt(phillips * 0.5);
      re[idx] = g1 * a;
      im[idx] = g2 * a;
      modes++;
      if (wavelength < shortest) shortest = wavelength;
      if (wavelength > longest) longest = wavelength;
    }
  }

  // Pass two: pair every mode with the one at −k, and total the slope energy
  // the pair will produce. Parseval does the rest — for f(x) = Σ F e^{ik·x} the
  // mean square of f over the lattice is exactly Σ|F|², so the spatial variance
  // of the slope field is Σ k²|h̃|², and its time average is Σ k²(|h0(k)|² +
  // |h0(−k)|²). No transform has to be run to know how steep the tile will be.
  const data = new Float32Array(n * 4);
  let variance = 0;

  for (let j = 0; j < size; j++) {
    const jm = (size - j) % size;
    for (let i = 0; i < size; i++) {
      const im0 = (size - i) % size;
      const idx = j * size + i;
      const mdx = jm * size + im0;
      const o = idx * 4;

      data[o] = re[idx];
      data[o + 1] = im[idx];
      data[o + 2] = re[mdx];
      data[o + 3] = im[mdx];

      variance +=
        kSq[idx] *
        (re[idx] * re[idx] + im[idx] * im[idx] + re[mdx] * re[mdx] + im[mdx] * im[mdx]);
    }
  }

  const scale = variance > 0 ? budget / Math.sqrt(variance) : 0;
  for (let i = 0; i < data.length; i++) data[i] *= scale;

  // And measure what was actually written, in the float32 the GPU will read,
  // rather than trusting the arithmetic above. This is the number the tests
  // hold the budget to.
  let measured = 0;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const idx = j * size + i;
      const o = idx * 4;
      measured +=
        kSq[idx] *
        (data[o] * data[o] +
          data[o + 1] * data[o + 1] +
          data[o + 2] * data[o + 2] +
          data[o + 3] * data[o + 3]);
    }
  }

  const slopeRms = Math.sqrt(measured);

  return {
    data,
    size,
    patch,
    energy: chopEnergy(sea),
    slopeRms,
    budget,
    foamLo: slopeRms * FOAM_LO_SIGMA,
    foamHi: slopeRms * FOAM_HI_SIGMA,
    modes,
    shortest: Number.isFinite(shortest) ? shortest : 0,
    longest,
    nyquistLength: (2 * patch) / size,
  };
}

// --- The transform ------------------------------------------------------------

/** An integer with its low `bits` bits reversed. */
function reverseBits(value, bits) {
  let out = 0;
  for (let i = 0; i < bits; i++) out = (out << 1) | ((value >> i) & 1);
  return out;
}

/**
 * The butterfly schedule, precomputed.
 *
 * One texel per (stage, row): the twiddle factor as a complex pair, and the two
 * rows of the previous pass this one reads. Everything the GPU would otherwise
 * have to work out per fragment — which wing of the butterfly it is on, what
 * power of the root of unity belongs to it, and the bit-reversal permutation
 * folded into the first stage — is a lookup instead, and the pass shader
 * collapses to two fetches and a complex multiply.
 *
 * The convention is the synthesis one: the twiddle is e^{+2πik/N}, so the chain
 * computes f[j] = Σ h̃[n]·e^{+2πinj/N}, which is the inverse transform this
 * library's wave sum is written in. The bottom wing needs no sign flip because
 * its twiddle exponent lands half a turn round the circle by itself.
 *
 * Exported because it is the part of an FFT that is easy to get subtly,
 * silently wrong, and the only honest way to test index arithmetic without a
 * GPU is to run the identical schedule on the CPU and compare it against a
 * direct DFT. test/fftcascade.test.js does exactly that at eight points.
 *
 * @returns `{ data, size, stages }` — `data` laid out row-major with width
 *          `stages` and height `size`, four floats to a texel.
 */
export function butterflyTable(size) {
  const stages = Math.round(Math.log2(size));
  if (1 << stages !== size) throw new Error(`butterflyTable: ${size} is not a power of two`);

  const reversed = new Int32Array(size);
  for (let i = 0; i < size; i++) reversed[i] = reverseBits(i, stages);

  const data = new Float32Array(stages * size * 4);

  for (let stage = 0; stage < stages; stage++) {
    const span = 1 << stage;
    for (let y = 0; y < size; y++) {
      // The twiddle exponent. On the lower wing this comes out half a turn
      // further round than on the upper one, which is the minus sign in
      // X[k + N/2] = E[k] − W·O[k], already applied.
      const power = (y * (size / (span * 2))) % size;
      const angle = (2 * Math.PI * power) / size;

      const upper = y % (span * 2) < span;
      let a;
      let b;
      if (stage === 0) {
        // The permutation, folded into the gather rather than run as a pass.
        a = upper ? reversed[y] : reversed[y - 1];
        b = upper ? reversed[y + 1] : reversed[y];
      } else {
        a = upper ? y : y - span;
        b = upper ? y + span : y;
      }

      const o = (y * stages + stage) * 4;
      data[o] = Math.cos(angle);
      data[o + 1] = Math.sin(angle);
      data[o + 2] = a;
      data[o + 3] = b;
    }
  }

  return { data, size, stages };
}

// --- The passes ---------------------------------------------------------------

/**
 * Every pass is a quad drawn straight in clip space — no view matrix, no
 * projection, no camera worth the name — exactly as render/foamfield.js does it.
 */
const quadVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Time evolution: the seeded table, turned into this instant's spectrum.
 *
 * h̃(k, t) = h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt}, with ω = √(g·k) — the same
 * deep-water dispersion `spectrum.js` gives every component of the wave table,
 * so the cascade's wavelets travel at the speeds their lengths demand and the
 * interference between them crawls the way a real sea's does. The pair is what
 * keeps the field Hermitian and therefore the surface real.
 *
 * What comes out is not the height spectrum but the two slope spectra, ik·h̃.
 * Multiplying by i in the frequency domain is a swap and a sign; doing it here
 * rather than differencing a height field afterwards saves a whole transform of
 * a field we would only have thrown away, and the two slopes fit in one RGBA
 * texel, so the butterfly chain carries both of them at once for the price of
 * one.
 */
const spectrumFragment = /* glsl */ `
  uniform sampler2D uH0;
  uniform float uSize;
  uniform float uDk;      // 2π / patch: one lattice step in wavenumber
  uniform float uTime;

  varying vec2 vUv;

  void main() {
    vec2 xy = floor(vUv * uSize);
    vec4 h0 = texture2D(uH0, (xy + 0.5) / uSize);

    // The upper half of the lattice is the negative half of the wavenumber
    // plane. Storing it that way is what lets the chain below be an ordinary
    // DFT with no shuffling: e^{2πi(n−N)j/N} and e^{2πinj/N} are the same
    // number, so negative frequencies land where they belong by themselves.
    vec2 m = xy - uSize * step(uSize * 0.5, xy);
    vec2 k = m * uDk;
    float kl = length(k);

    float w = sqrt(${glslFloat(GRAVITY)} * kl);
    float c = cos(w * uTime);
    float s = sin(w * uTime);

    vec2 a = vec2(h0.x * c - h0.y * s, h0.x * s + h0.y * c);
    vec2 b = vec2(h0.z * c - h0.w * s, -h0.z * s - h0.w * c);
    vec2 h = a + b;

    vec2 ih = vec2(-h.y, h.x);
    gl_FragColor = vec4(k.x * ih, k.y * ih);
  }
`;

/**
 * The butterfly pass, in two shapes: one stage a draw, or two.
 *
 * The plain shape is the textbook one — two fetches from the previous pass at
 * the rows the lookup names, one complex multiply, one add, done twice over on
 * `xy` and `zw` because the two slope fields ride the same transform. Rows and
 * columns share the shader and differ by one uniform: a 2-D transform is the
 * 1-D transform run along each axis in turn, and there is no version of this
 * where the two directions should be allowed to drift apart.
 *
 * The fused shape exists because of a measurement. Timed with readPixels-synced
 * batches on the machine this was built on, a pass of this transform cost about
 * twenty-seven microseconds *whatever size it was* — sixteen texels square and
 * two hundred and fifty-six came out within a per cent of each other. The
 * arithmetic is free; the bill is the cost of starting a render pass at all. So
 * the thing to economise is passes, not texels.
 *
 * Two levels of radix-two butterfly fold into one draw perfectly well: the
 * output row's entry in stage s+1 names two rows of stage s, and each of those
 * has its own entry in stage s naming two rows of what is actually in the
 * buffer. Three lookups and four fetches, against six fetches for the two
 * passes it replaces. It is radix-four in everything but the name, and — the
 * part that makes it worth having — it needs no second table: it reads the same
 * schedule the plain pass reads, at two of its columns, so everything the CPU
 * mirror proves about that table it proves about this too.
 *
 * A hundred and twenty-eight is seven stages, which fuses to three pairs and
 * one single: four passes an axis rather than seven, ten in all rather than
 * sixteen. Measured, that is 0.29 ms against 0.44. Two hundred and fifty-six is
 * eight stages, which fuses to four and comes to the same ten passes — and
 * therefore, measured, the same 0.28 ms for four times the texels. Depth here
 * is very nearly free; only the pass count is not.
 */
const butterflyFragment = (fused) => /* glsl */ `
  uniform sampler2D uButterfly;
  uniform sampler2D uSrc;
  uniform float uSize;
  uniform float uStages;
  uniform float uStage;
${fused ? '  uniform float uStageB;    // the second level, folded into this draw\n' : ''}  uniform float uVertical;  // 0 along rows, 1 along columns

  varying vec2 vUv;

  vec2 cmul(vec2 a, vec2 b) {
    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
  }

  /** The schedule for one row of one stage: twiddle in xy, source rows in zw. */
  vec4 lookup(float stage, float idx) {
    return texture2D(uButterfly, vec2((stage + 0.5) / uStages, (idx + 0.5) / uSize));
  }

  /** One row of the buffer, along whichever axis this pass is working. */
  vec4 fetch(float idx, vec2 xy) {
    vec2 at = mix(vec2(idx, xy.y), vec2(xy.x, idx), uVertical);
    return texture2D(uSrc, (at + 0.5) / uSize);
  }

  /** One butterfly: the two rows the entry names, combined by its twiddle. */
  vec4 wing(vec4 bt, vec2 xy) {
    vec4 p = fetch(bt.z, xy);
    vec4 q = fetch(bt.w, xy);
    return vec4(p.xy + cmul(bt.xy, q.xy), p.zw + cmul(bt.xy, q.zw));
  }

  void main() {
    vec2 xy = floor(vUv * uSize);
    float idx = mix(xy.x, xy.y, uVertical);
${fused ? `
    // The later stage names two rows of the earlier one; each of those is a
    // butterfly over rows of what is actually in the buffer. The intermediates
    // never leave a register, so this is not merely as accurate as the two
    // passes it replaces — it is a shade more so.
    vec4 outer = lookup(uStageB, idx);
    vec4 a = wing(lookup(uStage, outer.z), xy);
    vec4 b = wing(lookup(uStage, outer.w), xy);
    gl_FragColor = vec4(a.xy + cmul(outer.xy, b.xy), a.zw + cmul(outer.xy, b.zw));
` : `
    gl_FragColor = wing(lookup(uStage, idx), xy);
`}  }
`;

/**
 * The tile the ocean samples: two slopes and a scalar.
 *
 * The imaginary halves that come out of the transform are the round-off the
 * Hermitian pairing was built to leave behind — a few parts in ten thousand of
 * the real parts, and dropped here without ceremony.
 *
 * The third channel is micro foam: how steep this patch of the wavelet field
 * is, against the field's own RMS. It is a facet-steepness proxy and not a
 * Jacobian — nothing here folds, because nothing here displaces — but steep
 * micro-facets are exactly where a wind sea goes white at a scale no crest sum
 * could ever reach, and it costs one length() to have.
 */
const normalFragment = /* glsl */ `
  uniform sampler2D uField;
  uniform float uFoamLo;
  uniform float uFoamHi;

  varying vec2 vUv;

  void main() {
    vec4 f = texture2D(uField, vUv);
    vec2 slope = vec2(f.x, f.z);
    gl_FragColor = vec4(slope, smoothstep(uFoamLo, uFoamHi, length(slope)), 1.0);
  }
`;

// --- The cascade --------------------------------------------------------------

/**
 * Can this renderer render into a float target at all?
 *
 * Returns `null` when there is nothing to ask — a test, or a caller who has not
 * built a renderer yet — so that "no opinion" and "no" stay different answers.
 * WebGL1 is a flat no: the half-float path there needs three extensions to line
 * up and the machines that lack them are the machines that could not afford
 * sixteen passes anyway.
 */
export function canRenderFloat(renderer) {
  if (!renderer) return null;
  const caps = renderer.capabilities;
  const ext = renderer.extensions;
  if (!caps || !ext || typeof ext.has !== 'function') return null;
  if (!caps.isWebGL2) return false;
  if ((caps.maxTextureSize ?? 0) < 256) return false;
  return !!(ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float'));
}

/**
 * A GPU spectral detail cascade: normals only, for the near field.
 *
 * @param waveField  a WaveField; its `sea` supplies the spectrum and the wind,
 *                   and its `time` the clock — so the tile can never be a
 *                   different instant from the mesh it textures.
 * @param options    `{ size, patch, slopeBudget, microFoam, far, renderer }`.
 *                   `renderer` is only ever read for the feature test; the
 *                   cascade holds no reference to it.
 *
 * @returns `{ update(renderer), uniforms, texture, table, stats, disabled,
 *            setSeaState, setGain, setMicroFoam, dispose, size, patch,
 *            materials, targets }`
 */
export function createDetailCascade(waveField, options = {}) {
  const o = { ...DEFAULTS, ...options };

  const size = Math.max(8, 1 << Math.round(Math.log2(o.size)));
  const patch = Math.max(1, o.patch);
  const far = Math.max(1, o.far);
  const stages = Math.round(Math.log2(size));

  let sea = waveField.sea;
  let table = cascadeSpectrum(sea, { size, patch, slopeBudget: o.slopeBudget });

  // The feature test, and the whole of the graceful failure. A cascade that
  // cannot run says so at construction, holds no GPU objects, and does nothing
  // when it is updated — so the guarded wiring every other layer already uses
  // ("build it, and hand it over only if it is there") boots a machine without
  // float targets into exactly the sea it had before this file existed.
  const supported = canRenderFloat(o.renderer);
  const disabled = supported === false;

  // What the ocean is handed. The objects are adopted wholesale by
  // `ocean.setDetailCascade`, the arrangement render/foamfield.js established:
  // whatever this file writes into them arrives at the shader with nobody
  // having to be told.
  const uniforms = {
    uCascade: { value: null },
    uCascadeInvPatch: { value: 1 / patch },
    uCascadeGain: { value: disabled ? 0 : 1 },
    uCascadeFoam: { value: clamp(o.microFoam, 0, 1) },
    uCascadeFar: { value: far },
  };

  const stats = { updates: 0, passes: 0, rebuilds: 1 };

  if (disabled) {
    // Everything below this line allocates. None of it is reachable.
    return {
      uniforms,
      stats,
      size,
      patch,
      disabled: true,
      get table() {
        return table;
      },
      get texture() {
        return null;
      },
      update() {},
      setSeaState(next) {
        sea = next ?? waveField.sea;
        table = cascadeSpectrum(sea, { size, patch, slopeBudget: o.slopeBudget });
        stats.rebuilds++;
      },
      setGain() {},
      setMicroFoam(amount) {
        uniforms.uCascadeFoam.value = clamp(amount ?? 0, 0, 1);
      },
      dispose() {},
    };
  }

  // --- The data textures ------------------------------------------------------
  // Neither is ever rendered into, so neither needs the colour-buffer extension
  // the ping-pong targets do: a float texture sampled with NEAREST is core in
  // WebGL2, and NEAREST is all either of them wants. The butterfly table holds
  // row indices as floats, which are exact to well past a thousand.

  const h0Texture = new THREE.DataTexture(table.data, size, size, THREE.RGBAFormat, THREE.FloatType);
  h0Texture.minFilter = THREE.NearestFilter;
  h0Texture.magFilter = THREE.NearestFilter;
  h0Texture.wrapS = THREE.ClampToEdgeWrapping;
  h0Texture.wrapT = THREE.ClampToEdgeWrapping;
  h0Texture.generateMipmaps = false;
  h0Texture.colorSpace = THREE.NoColorSpace;
  h0Texture.name = 'cascade-h0';
  h0Texture.needsUpdate = true;

  const butterfly = butterflyTable(size);
  const butterflyTexture = new THREE.DataTexture(
    butterfly.data,
    butterfly.stages,
    size,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  butterflyTexture.minFilter = THREE.NearestFilter;
  butterflyTexture.magFilter = THREE.NearestFilter;
  butterflyTexture.wrapS = THREE.ClampToEdgeWrapping;
  butterflyTexture.wrapT = THREE.ClampToEdgeWrapping;
  butterflyTexture.generateMipmaps = false;
  butterflyTexture.colorSpace = THREE.NoColorSpace;
  butterflyTexture.name = 'cascade-butterfly';
  butterflyTexture.needsUpdate = true;

  // --- The targets ------------------------------------------------------------
  // Half float throughout. The intermediates run from about a thousandth at the
  // spectrum to a tenth at the tile, which is the middle of the format's range,
  // and the eleven bits of mantissa are four orders below the smallest slope
  // the eye could resolve on a lit crest.

  const makeWork = () => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.name = 'cascade-work';
    return rt;
  };

  let ping = makeWork();
  let pong = makeWork();

  // The tile itself: repeated across the water, filtered, and mipped. The mips
  // are the anti-aliasing — a half-metre wavelet a hundred metres off is well
  // under a pixel, and without a mip chain it would arrive as a crawling
  // stipple rather than as the smooth sheen it should be. Three.js regenerates
  // them at the end of every render into the target, which for sixty-four
  // kilobytes is a rounding error on the pass that filled it.
  const tile = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: true,
    colorSpace: THREE.NoColorSpace,
  });
  tile.texture.name = 'cascade-tile';

  uniforms.uCascade.value = tile.texture;

  // --- The materials ----------------------------------------------------------

  const shared = {
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    // Every pass places its own clip coordinates, so which way a triangle
    // happens to wind is not a thing this file should be able to get wrong.
    side: THREE.DoubleSide,
  };

  const spectrumUniforms = {
    uH0: { value: h0Texture },
    uSize: { value: size },
    uDk: { value: (2 * Math.PI) / patch },
    uTime: { value: waveField.time ?? 0 },
  };

  // One map for both butterfly materials: they are the same pass at two
  // depths, and there is no version of this where they should be allowed to
  // disagree about which buffer or which axis they are working on.
  const butterflyUniforms = {
    uButterfly: { value: butterflyTexture },
    uSrc: { value: ping.texture },
    uSize: { value: size },
    uStages: { value: stages },
    uStage: { value: 0 },
    uStageB: { value: 1 },
    uVertical: { value: 0 },
  };

  const normalUniforms = {
    uField: { value: ping.texture },
    uFoamLo: { value: table.foamLo },
    uFoamHi: { value: table.foamHi },
  };

  const spectrumMaterial = new THREE.ShaderMaterial({
    ...shared,
    vertexShader: quadVertex,
    fragmentShader: spectrumFragment,
    uniforms: spectrumUniforms,
  });

  const butterflyMaterial = new THREE.ShaderMaterial({
    ...shared,
    vertexShader: quadVertex,
    fragmentShader: butterflyFragment(false),
    uniforms: butterflyUniforms,
  });

  const pairMaterial = new THREE.ShaderMaterial({
    ...shared,
    vertexShader: quadVertex,
    fragmentShader: butterflyFragment(true),
    uniforms: butterflyUniforms,
  });

  const normalMaterial = new THREE.ShaderMaterial({
    ...shared,
    vertexShader: quadVertex,
    fragmentShader: normalFragment,
    uniforms: normalUniforms,
  });

  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, spectrumMaterial);
  mesh.frustumCulled = false;

  const scene = new THREE.Scene();
  scene.add(mesh);
  // Sixteen renders a frame of a scene that will never move: the matrix walk is
  // not much, but it is not nothing either, and it is pure waste here.
  scene.matrixWorldAutoUpdate = false;
  scene.updateMatrixWorld(true);

  const camera = new THREE.Camera();

  const api = {
    uniforms,
    stats,
    size,
    patch,
    disabled: false,
    /** The passes, so they can be inspected, profiled or retuned in place. */
    materials: {
      spectrum: spectrumMaterial,
      butterfly: butterflyMaterial,
      butterflyPair: pairMaterial,
      normal: normalMaterial,
    },
    /** The targets, for anyone profiling with a readPixels sync. Read-only. */
    targets: { ping, pong, tile },

    /** The spectrum in force: budget, band, mode count and all. */
    get table() {
      return table;
    },

    /** The tile the ocean samples. One target, not a ping-pong, so this is
     *  stable — but a getter all the same, so a rebuild can move it. */
    get texture() {
      return tile.texture;
    },

    /**
     * One update: the whole transform, ten passes of it at a hundred and
     * twenty-eight square.
     *
     * Safe to call from a plain tick — there is no animation-frame assumption in
     * here and no internal clock — and it leaves the renderer exactly as it
     * found it, because the very next thing the caller does is draw the frame
     * this tile is for.
     *
     * @param renderer  a WebGLRenderer.
     */
    update(renderer) {
      if (!renderer) return;

      // The second chance at the feature test, for a cascade built before the
      // renderer existed. Once it fails it stays failed: the gain goes to
      // nought, so the ocean's shader keeps its branch and paints nothing.
      if (canRenderFloat(renderer) === false) {
        api.disabled = true;
        uniforms.uCascadeGain.value = 0;
        return;
      }

      spectrumUniforms.uTime.value = waveField.time ?? 0;

      // Everything the main pass is entitled to find where it left it. The
      // viewport as well as the target: `setRenderTarget` resets it to the
      // target's own size, and a game drawing into a sub-viewport of the canvas
      // would otherwise find its frame drawn to the wrong corner.
      const prevTarget = renderer.getRenderTarget();
      const prevCubeFace = renderer.getActiveCubeFace();
      const prevMipLevel = renderer.getActiveMipmapLevel();
      const prevAutoClear = renderer.autoClear;
      const prevViewport = renderer.getViewport?.(new THREE.Vector4());

      // Every pass writes every texel with no blending, so there is nothing for
      // a clear to do — and a clear here would be the renderer's clear colour,
      // which is not ours to assume anything about.
      renderer.autoClear = false;

      // The spectrum, into ping.
      let passes = 1;
      mesh.material = spectrumMaterial;
      renderer.setRenderTarget(ping);
      renderer.render(scene, camera);

      // The transform: every stage along the rows, then every stage down the
      // columns, two levels to a draw wherever two are left. The buffers swap
      // after each pass, so where the answer ends up depends on how many there
      // were — which is why the code reads `src` rather than trusting a count.
      let src = ping;
      let dst = pong;
      for (let axis = 0; axis < 2; axis++) {
        butterflyUniforms.uVertical.value = axis;
        let stage = 0;
        while (stage < stages) {
          if (stage + 1 < stages) {
            mesh.material = pairMaterial;
            butterflyUniforms.uStage.value = stage;
            butterflyUniforms.uStageB.value = stage + 1;
            stage += 2;
          } else {
            mesh.material = butterflyMaterial;
            butterflyUniforms.uStage.value = stage;
            stage += 1;
          }
          butterflyUniforms.uSrc.value = src.texture;
          renderer.setRenderTarget(dst);
          renderer.render(scene, camera);
          passes++;
          const spent = src;
          src = dst;
          dst = spent;
        }
      }

      // And the tile: slopes out of the real parts, micro foam out of their
      // length. This is the pass that fills the texture the sea reads.
      mesh.material = normalMaterial;
      normalUniforms.uField.value = src.texture;
      renderer.setRenderTarget(tile);
      renderer.render(scene, camera);
      passes++;

      renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
      if (prevViewport) renderer.setViewport(prevViewport);
      renderer.autoClear = prevAutoClear;

      stats.updates++;
      // Counted rather than predicted: this is the number the whole cost of
      // this file is proportional to, and it should be a measurement.
      stats.passes = passes;
    },

    /**
     * Swap the spectrum under a running cascade.
     *
     * The lattice and the patch never change, so this is a re-upload into the
     * same data texture and never a reallocation — and the table is
     * deterministic in the sea state, so a preset swapped away and back comes
     * back with the chop it had.
     */
    setSeaState(nextSea) {
      sea = nextSea ?? waveField.sea;
      table = cascadeSpectrum(sea, { size, patch, slopeBudget: o.slopeBudget });
      h0Texture.image.data.set(table.data);
      h0Texture.needsUpdate = true;
      normalUniforms.uFoamLo.value = table.foamLo;
      normalUniforms.uFoamHi.value = table.foamHi;
      stats.rebuilds++;
    },

    /**
     * How much of the cascade to run, 0..1.
     *
     * A uniform, not a recompile, so it can be animated — and so a workbench
     * can put it on a key and ask the eye the only question that matters, which
     * is whether the near water is better with it than without. Nought is the
     * sea exactly as it was before this file existed.
     */
    setGain(amount) {
      uniforms.uCascadeGain.value = clamp(amount ?? 1, 0, 1);
    },

    /** How much micro foam reaches the ocean's lace, 0..1. */
    setMicroFoam(amount) {
      uniforms.uCascadeFoam.value = clamp(amount ?? 0, 0, 1);
    },

    dispose() {
      ping.dispose();
      pong.dispose();
      tile.dispose();
      h0Texture.dispose();
      butterflyTexture.dispose();
      geometry.dispose();
      spectrumMaterial.dispose();
      butterflyMaterial.dispose();
      pairMaterial.dispose();
      normalMaterial.dispose();
      scene.clear();
      uniforms.uCascade.value = null;
    },
  };

  return api;
}
