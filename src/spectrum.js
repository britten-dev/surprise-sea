// How a wind becomes a sea.
//
// Five presets, from a glassy heave to the greybeards, each a rough Beaufort
// anchor rather than an oceanographic fit: a dominant wavelength, a
// significant height, how far the sea fans out either side of downwind, and
// how much of the energy has gone into short chop. Everything else is
// synthesised from those four numbers, deterministically, from a seeded LCG.
//
// The lessons here were all learned the hard way in the albatross game, and
// they are worth stating plainly because none of them is obvious:
//
//   One dominant wave reads as corduroy. From a masthead or from three hundred
//   metres up, a single clean swell train is visibly a ribbed sheet, and no
//   amount of chop on top of it hides that. So the primary train is split into
//   *three* near-parallel components — same neighbourhood of wavelength, five
//   or six degrees apart, slightly different speeds. They slide in and out of
//   phase over minutes, which means the sea comes on in sets: a lull, then
//   three mounting greybeards together. That is what a real ocean does, and it
//   is the single change that made the water look alive.
//
//   The tail wants constant steepness, not constant energy. Amplitude
//   proportional to wavelength keeps k·A the same all the way down, so the
//   chop looks like the same water as the swell, just smaller.
//
//   Pinch is a budget, not a per-wave setting. Gerstner sharpening is
//   horizontal displacement; if the components' pinches sum past one, aligned
//   crests fold through themselves and the surface turns inside out. So a
//   total is fixed first and shared out, and it is scaled by the sea's own
//   steepness, because a calm swell should be a smooth sinusoid and only a
//   storm sea should have knife edges.

import { SeaState } from './seastate.js';

/**
 * Beaufort anchors. `hs` is significant height (4σ of the surface elevation),
 * `dominantLength` the crest-to-crest of the primary train, `spread` the
 * widest heading offset in the tail, `chop` a multiplier on the short end and
 * `chopLength` the shortest component carried. `windSpeed` is metres per
 * second at ten metres — nothing in the surface uses it, but everything that
 * flies over the surface does.
 */
export const PRESETS = {
  calm: {
    feel: 'glassy heave',
    hs: 0.4,
    dominantLength: 60,
    spread: 12,
    chop: 0.35,
    chopLength: 1.6,
    windSpeed: 3,
  },
  breeze: {
    feel: 'whitecaps starting',
    hs: 2,
    dominantLength: 90,
    spread: 20,
    chop: 1.0,
    chopLength: 2.5,
    windSpeed: 7,
  },
  gale: {
    feel: 'heavy, streaked',
    hs: 7,
    dominantLength: 160,
    spread: 26,
    chop: 1.15,
    chopLength: 6,
    windSpeed: 18,
  },
  storm: {
    feel: 'the albatross game today',
    hs: 12,
    dominantLength: 230,
    spread: 30,
    chop: 1.1,
    chopLength: 12,
    windSpeed: 26,
  },
  greybeards: {
    feel: 'survival storm, towering',
    hs: 17,
    dominantLength: 320,
    spread: 30,
    chop: 1.0,
    chopLength: 16,
    windSpeed: 32,
  },
};

// --- The shape of the synthesis ----------------------------------------------

/** The primary train, three ways. Ratios and weights carried over from the
 *  game's hand-tuned storm spectrum, which is the one that shipped. */
const TRAIN_LENGTH_RATIO = [1, 0.865, 1.148];
const TRAIN_WEIGHT = [1, 0.618, 0.527];
const TRAIN_OFFSET_DEG = [0, 6, -5];

/** Where the log-spaced tail starts, as a fraction of the dominant. */
const TAIL_START = 0.652;

/** Tail amplitude per unit of (length / dominantLength) — constant steepness. */
const TAIL_GAIN = 0.53;

/** Heading jitter either side of each component's nominal offset, degrees. */
const HEADING_JITTER_DEG = 2.5;

/** Amplitude jitter, as a fraction. Enough to break the neatness, not enough
 *  to let the second component overtake the first. */
const AMP_JITTER = 0.12;

/** Ceiling on the summed Gerstner pinch. Past about 0.8 the crests fold. */
const MAX_PINCH = 0.8;

/** Pinch per unit of sea steepness (Hs / dominant length). Calibrated so the
 *  storm preset lands on the game's shipped total of ~0.73. */
const PINCH_GAIN = 14;

/** Below four components the primary train has nothing riding on it. */
const MIN_WAVES = 4;

/**
 * The one source of randomness in the library. A plain LCG, seeded, so that
 * the same options give the same sea on every run and on every machine —
 * which matters because two agents' worth of code, on two processors, have to
 * agree about where the water is.
 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Build a sea.
 *
 * @param preset       'calm' | 'breeze' | 'gale' | 'storm' | 'greybeards'
 * @param windFromDeg  meteorological; the swell runs downwind.
 * @param seed         integer. Same seed, same sea.
 * @param scale        overall amplitude multiplier.
 * @param waveCount    components in the table; the GLSL twin must match.
 */
export function createSeaState({
  preset = 'storm',
  windFromDeg = 285,
  seed = 1796,
  scale = 1,
  waveCount = 12,
} = {}) {
  const spec = PRESETS[preset];
  if (!spec) {
    throw new Error(
      `surprise-sea: unknown preset "${preset}" (have ${Object.keys(PRESETS).join(', ')})`
    );
  }

  const n = Math.max(MIN_WAVES, Math.floor(waveCount));
  const rand = makeRandom(seed);
  const L0 = spec.dominantLength;

  // --- Lengths, nominal headings, relative weights --------------------------
  const lengths = [];
  const offsets = [];
  const weights = [];

  for (let i = 0; i < 3; i++) {
    lengths.push(L0 * TRAIN_LENGTH_RATIO[i]);
    offsets.push(TRAIN_OFFSET_DEG[i]);
    weights.push(TRAIN_WEIGHT[i]);
  }

  // The remainder, log-spaced from just under the dominant down to chop, with
  // headings alternating either side of downwind and widening as they shorten.
  // Short waves are generated locally by the wind and have no memory of the
  // fetch that built the swell, so they fan out; long ones do not.
  const tail = n - 3;
  const tailTop = L0 * TAIL_START;
  const tailEnd = Math.min(spec.chopLength, tailTop * 0.5);
  const narrow = spec.spread / 3;

  for (let j = 0; j < tail; j++) {
    const f = tail === 1 ? 0 : j / (tail - 1);
    const length = tailTop * Math.pow(tailEnd / tailTop, f);
    lengths.push(length);
    offsets.push((j % 2 === 0 ? -1 : 1) * (narrow + (spec.spread - narrow) * f));
    weights.push(spec.chop * TAIL_GAIN * (length / L0));
  }

  // --- Jitter, then normalise to the significant height ---------------------
  // Draw every random number in one fixed order, so adding a component never
  // reshuffles the ones before it.
  const jittered = [];
  const phases = [];
  const headings = [];
  for (let i = 0; i < n; i++) {
    headings.push(offsets[i] + (rand() * 2 - 1) * HEADING_JITTER_DEG);
    jittered.push(weights[i] * (1 + (rand() * 2 - 1) * AMP_JITTER));
    phases.push(rand() * Math.PI * 2);
  }

  // Significant height is 4σ, and for a sum of components at distinct
  // frequencies the variance is just Σa²/2 — so the whole table scales by one
  // number to hit the preset's Hs exactly.
  const targetHs = spec.hs * scale;
  const rms = Math.sqrt(jittered.reduce((a, w) => a + w * w, 0));
  const ampScale = targetHs / (2 * Math.SQRT2 * rms);
  const amps = jittered.map((w) => w * ampScale);

  // --- Share out the pinch --------------------------------------------------
  // Steeper seas get more of it; a calm swell gets almost none. Within a sea
  // it goes as √amplitude, which puts most of the sharpening on the big trains
  // while still letting the chop have edges of its own.
  const budget = Math.min(MAX_PINCH, (PINCH_GAIN * targetHs) / L0);
  const roots = amps.map((a) => Math.sqrt(Math.max(a, 0)));
  const rootSum = roots.reduce((a, r) => a + r, 0) || 1;

  const components = amps.map((amp, i) => ({
    length: lengths[i],
    amp,
    off: headings[i],
    pinch: (budget * roots[i]) / rootSum,
    phase: phases[i],
  }));

  return new SeaState(components, {
    preset,
    windFromDeg,
    windSpeed: spec.windSpeed,
  });
}
