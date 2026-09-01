// What the sea remembers.
//
// A Gerstner pinch heals the instant the wave moves on. Foam keyed straight off
// the crest sum therefore appears and vanishes with the crest, which is why the
// sea has always looked freshly laundered between sets — and why `FOAM_LAGS`
// exists, faking a few seconds of memory by asking the same sum what it was
// doing at t − 2.5 and t − 5. That trick is bounded by what a vertex can afford
// to evaluate. Real broken water stays white for half a minute, streams away
// downwind, and — this is the part no analytic dodge can reach — remembers
// things that were never waves at all: a ship's wake, a broach, anything that
// churned that particular patch of water.
//
// So: a texture, following the camera, holding one number per texel — how white
// this piece of sea is. Every update it decays by a half-life, slides a little
// downwind, takes the maximum of itself and the crest sum evaluated *in the
// render-target's own pass* from the very same wave uniforms the mesh is
// displaced by, and finally accepts whatever splats the game has queued. The
// history is world-anchored: the footprint is snapped to whole texels before it
// is drawn, so re-centring on a moving camera shifts the history by an integer
// number of texels and never smears it, and texels that scroll in over the
// leading edge start clean rather than inheriting their neighbour's scar.
//
// Nothing here is deterministic in the library's usual sense — it is frame
// history, and a machine that drops a frame gets a very slightly different
// texture. Amendment II exempts it on those grounds. What it must be instead is
// *bounded*: the value written is clamped into 0..1 every single pass, the
// sources of it are a decayed read and a smoothstep, and there is no arithmetic
// anywhere in the shader that can manufacture a NaN and then keep it for ever.
//
// The identity is untouched. Geometry never reads this; physics never reads
// this. It is a stain on the water, and the water underneath it is the same
// water the CPU walks.

import * as THREE from 'three';
import { waveUniforms, oceanVertexChunk } from '../seastate.js';
import { foamProfile } from './ocean.js';

/**
 * The defaults, and what each of them costs.
 *
 * `size` is the whole GPU bill: the step pass runs the full wave table per
 * texel, so a thousand-and-twenty-four square is four times the work of a five
 * hundred and twelve. `extent` is the resolution, in a way `size` is not — a
 * 2.4 km footprint at 1024² is 2.3 m to a texel, which is about as coarse as a
 * wake can be drawn and still read as a lane rather than as a row of blobs.
 */
const DEFAULTS = {
  size: 1024, // texels square
  extent: 2400, // metres covered, centred on the camera
  // Seconds for a scar to fade by half. 22 was the first cut, and it drowned:
  // in a storm nearly every texel breaks at least once inside two half-lives,
  // so the union of a minute's breaking painted the whole sea white. At 8 the
  // scar is lace by the second wave and gone by the fourth, and the sea reads
  // as scarred rather than snowed on.
  halfLife: 8,
  windFromDeg: null, // advection direction; from the sea state if left out
  drift: null, // m/s of downwind drift; from the wind speed if left out
  // Surface water goes downwind at about three per cent of the wind, which is
  // the number the oceanography uses and it is not a coincidence that it looks
  // right: it is what the foam is actually doing out there.
  windDrift: 0.03,
  // The feedback blur, in texels at sixty hertz, applied as the history is
  // read. Sea of Thieves does exactly this and it is nearly free: four bilinear
  // taps, and the scar softens a little every pass instead of staying a hard
  // stencil of the crest that made it. It is diffusion rather than a filter —
  // see the square root in `update`.
  spread: 0.6,
  // Gain on the analytic injection; 0 leaves only the stamps. Deliberately
  // well under one: the ocean paints the *instantaneous* break at full white
  // by itself, so the field's job is only the aftermath — and through the
  // squared paint curve, 0.6 starts a fresh scar as lace (~0.36) rather than
  // as a second coat of white over half the sea.
  inject: 0.6,
  maxStamps: 256, // splats accepted per update before the queue starts dropping
};

/** Longest step the field will integrate in one go. A tab that has been in the
 *  background for a minute should not advect the whole footprint off its edge. */
const MAX_STEP = 0.25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Direction the wind blows *toward*, as a unit vector on the xz plane. */
function downwind(windFromDeg, out = new THREE.Vector2()) {
  const rad = THREE.MathUtils.degToRad(windFromDeg);
  return out.set(-Math.sin(rad), Math.cos(rad)).normalize();
}

// --- The passes ---------------------------------------------------------------

/**
 * Both passes are drawn straight in clip space — no view matrix, no projection,
 * no camera worth the name. The quad is two units across about the origin, so
 * `position.xy` *is* the clip position and `vUv` is the footprint.
 */
const quadVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * The step: decay, advect, inject.
 *
 * The injection is the whole reason this is a shader and not a canvas blit. It
 * evaluates `gerstner()` — the generated chunk, the same one the ocean mesh is
 * displaced by, reading the same uniform arrays — at the world position of the
 * texel, and takes its crest pinch through the same thresholds the fragment
 * shader paints foam with. Where the mesh is breaking, the field goes white,
 * because both are asking one wave table the same question. This is the
 * Jacobian-fold injection every FFT ocean does, done against an analytic sum:
 * cheaper, and exactly consistent with the surface by construction.
 *
 * Only the crest output is used. The position and normal the chunk also
 * computes are dead code the compiler removes; what survives is the sines, and
 * they would have been needed anyway.
 */
const stepFragment = (waveCount) => /* glsl */ `
  ${oceanVertexChunk(waveCount)}

  uniform sampler2D uPrev;
  uniform vec2 uOrigin;      // world xz of the footprint's near corner, this pass
  uniform float uExtent;     // metres across the footprint
  uniform vec2 uSrcOffset;   // where this texel's history was last pass, in uv
  uniform vec2 uTexel;       // 1 / size
  uniform float uSpread;     // feedback blur, in texels
  uniform float uDecay;      // 2^(-dt/halfLife)
  uniform float uInject;     // gain on the analytic injection
  uniform float uFoamLo;     // pinch at which a crest starts to break
  uniform float uFoamHi;     // pinch at which it is solid white
  uniform float uFoamJitter; // how much noise ragged the threshold
  uniform float uFoamScale;  // foam texture frequency, from the dominant wave
  uniform vec2 uWindDir;

  varying vec2 vUv;

  // The same value noise the ocean shader ravels its foam edge with. Copied
  // rather than shared because the two stages are compiled separately, and kept
  // identical on purpose: the scar this pass lays down has to have the same
  // ragged edge as the foam that will be drawn over it, or the maximum of the
  // two is a smooth blob with lace round the outside.
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
    // Where this piece of water's history is in the previous texture: the
    // re-centring offset, which is a whole number of texels, plus the drift,
    // which is not. Reading upwind is what makes the scar travel downwind.
    vec2 src = vUv + uSrcOffset;

    // Four bilinear taps rather than one: the history softens as it ages
    // instead of holding the stencil of the crest that made it.
    vec2 o = uTexel * uSpread;
    float history =
      (texture2D(uPrev, src + vec2( o.x,  o.y)).r +
       texture2D(uPrev, src + vec2(-o.x,  o.y)).r +
       texture2D(uPrev, src + vec2( o.x, -o.y)).r +
       texture2D(uPrev, src + vec2(-o.x, -o.y)).r) * 0.25;

    // Water that has just scrolled in over the leading edge has no history, and
    // must not be given the edge texel's. Clean sea comes in clean.
    float inside = step(0.0, src.x) * step(0.0, src.y)
                 * step(src.x, 1.0) * step(src.y, 1.0);
    history *= inside * uDecay;

    // The injection, from the same table the mesh is displaced by. The camera
    // distance passed in is nought, and deliberately: the mesh attenuates the
    // long waves it cannot resolve at range, but a texel two kilometres off is
    // the same size as a texel underfoot and the water there is really breaking.
    vec2 world = uOrigin + vUv * uExtent;
    vec3 nrm;
    float crest;
    gerstner(world, 0.0, nrm, crest);

    float rag = fbm(world * 0.13 * uFoamScale + uWindDir * uTime * -0.5);
    float breaking =
      smoothstep(uFoamLo, uFoamHi, crest + (rag - 0.5) * uFoamJitter) * uInject;

    // Whitest wins, and the answer is clamped every pass. There is no path
    // through this shader by which the buffer can run away or go bad.
    gl_FragColor = vec4(clamp(max(history, breaking), 0.0, 1.0), 0.0, 0.0, 1.0);
  }
`;

/**
 * The stamps: one instanced quad per splat, covering only its own disc.
 *
 * A wake could be injected by the step pass — hand it the hull's track as
 * uniforms and let every texel work out how far it is from the line — but that
 * is a million distance tests to whiten a few thousand texels. A quad each is
 * the same picture for a fraction of a millisecond, and it scales with the
 * number of ships rather than with the size of the field.
 */
const stampVertex = /* glsl */ `
  attribute vec4 aStamp;     // xz centre, radius in metres, strength 0..1

  uniform vec2 uOrigin;
  uniform float uInvExtent;

  varying vec2 vLocal;
  varying float vStrength;

  void main() {
    vLocal = position.xy * 2.0;
    vStrength = aStamp.w;

    vec2 world = aStamp.xy + position.xy * 2.0 * aStamp.z;
    gl_Position = vec4((world - uOrigin) * uInvExtent * 2.0 - 1.0, 0.0, 1.0);
  }
`;

// Squared, so the disc has no visible rim: a wake is white in the middle and
// argues with the water at its edges.
const stampFragment = /* glsl */ `
  uniform float uSoftness;

  varying vec2 vLocal;
  varying float vStrength;

  void main() {
    float fall = smoothstep(1.0, uSoftness, length(vLocal));
    gl_FragColor = vec4(vStrength * fall * fall, 0.0, 0.0, 1.0);
  }
`;

// --- The field ----------------------------------------------------------------

/**
 * A camera-following accumulation texture: where the sea has broken or a ship
 * has passed, the water stays scarred until it fades.
 *
 * @param waveField  a WaveField; its `sea` supplies the spectrum and the foam
 *                   thresholds, and its `time` the clock — so the injection can
 *                   never be a different instant from the mesh it whitens.
 * @param options    `{ size, extent, halfLife, windFromDeg, drift, windDrift,
 *                      spread, inject, maxStamps }`, and `format` for anyone
 *                   whose GPU will not render a single-channel half float.
 *
 * @returns `{ update(renderer, dt, cameraPos), stamp(x, z, radius, strength),
 *            texture, uniforms, setSeaState, setWindFromDeg, dispose, stats,
 *            extent, size, origin, materials }`
 */
export function createFoamField(waveField, options = {}) {
  const o = { ...DEFAULTS, ...options };

  // A coarse pointer is a phone, and a phone gets a quarter of the work.
  // Guarded, because this module is imported by the tests, which have no
  // window to ask — and skipped outright if a size was asked for by name.
  const coarse =
    options.size === undefined &&
    typeof matchMedia === 'function' &&
    matchMedia('(pointer: coarse)').matches;

  const size = Math.max(16, Math.round(coarse ? o.size / 2 : o.size));
  const extent = Math.max(1, o.extent);
  const texel = extent / size;
  let halfLife = Math.max(0.05, o.halfLife);
  const maxStamps = Math.max(1, Math.round(o.maxStamps));

  let sea = waveField.sea;
  let waveCount = sea.waves.length;

  // A wind given here is a deliberate choice and survives sea-state swaps; left
  // out, the drift follows whatever wind the sea state carries.
  const pinnedWind = o.windFromDeg ?? null;
  const windDir = downwind(pinnedWind ?? sea.windFromDeg ?? 285);

  // --- The two buffers --------------------------------------------------------
  // One channel, because the value is a single coverage between nought and one,
  // and half float rather than a byte because that one number is multiplied by
  // something a shade under one every frame for half a minute — at eight bits
  // the fade goes down a visible staircase, and near the bottom of it the decay
  // stops moving at all and the scar never clears. WebGL guarantees a new
  // texture reads as zero, so the first pass has clean history by right.
  const makeTarget = () => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: o.format ?? THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.name = 'foam-field';
    return rt;
  };

  let read = makeTarget();
  let write = makeTarget();

  // --- What the ocean is handed ----------------------------------------------
  // These uniform objects are adopted wholesale by `ocean.setFoamField`, which
  // is why the ping-pong needs no plumbing on the far side: the sea is holding
  // the very object this file writes the new texture into.
  const uniforms = {
    uFoamField: { value: read.texture },
    uFoamOrigin: { value: new THREE.Vector2() },
    uFoamInvExtent: { value: 1 / extent },
    uFoamAmount: { value: 1 },
  };

  // --- The step pass ----------------------------------------------------------
  const stepUniforms = {
    ...waveUniforms(sea),
    uTime: { value: waveField.time ?? 0 },
    uPrev: { value: read.texture },
    uOrigin: { value: new THREE.Vector2() },
    uExtent: { value: extent },
    uSrcOffset: { value: new THREE.Vector2() },
    uTexel: { value: new THREE.Vector2(1 / size, 1 / size) },
    uSpread: { value: o.spread },
    uDecay: { value: 0 },
    uInject: { value: o.inject },
    uFoamLo: { value: 0.33 },
    uFoamHi: { value: 0.6 },
    uFoamJitter: { value: 0.35 },
    uFoamScale: { value: 1 },
    uWindDir: { value: windDir },
  };

  const makeStepMaterial = () =>
    new THREE.ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: stepFragment(waveCount),
      uniforms: stepUniforms,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      // Both passes place their own clip coordinates, so which way a triangle
      // happens to wind is not a thing this file should be able to get wrong.
      side: THREE.DoubleSide,
    });

  const stepMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), makeStepMaterial());
  stepMesh.frustumCulled = false;
  stepMesh.renderOrder = 0;

  // --- The stamp pass ---------------------------------------------------------
  const stampData = new Float32Array(maxStamps * 4);
  const stampAttribute = new THREE.InstancedBufferAttribute(stampData, 4);
  stampAttribute.setUsage(THREE.DynamicDrawUsage);

  const stampGeometry = new THREE.InstancedBufferGeometry();
  stampGeometry.setIndex([0, 1, 2, 0, 2, 3]);
  stampGeometry.setAttribute(
    'position',
    new THREE.BufferAttribute(
      new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
      3
    )
  );
  stampGeometry.setAttribute('aStamp', stampAttribute);
  stampGeometry.instanceCount = 0;

  // The same Vector2 the step pass holds, deliberately: the two passes draw
  // into one buffer in one call and there is no version of this where they are
  // allowed to disagree about where the footprint is.
  const stampUniforms = {
    uOrigin: { value: stepUniforms.uOrigin.value },
    uInvExtent: { value: 1 / extent },
    uSoftness: { value: 0.15 },
  };

  // Maximum, not addition. A stamp says "this water is at least this white",
  // which is what laying foam down means; adding would let a ship holding
  // station in a following sea drive the buffer past one for ever.
  const stampMaterial = new THREE.ShaderMaterial({
    vertexShader: stampVertex,
    fragmentShader: stampFragment,
    uniforms: stampUniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
    // Transparent, so three.js draws it after the step quad rather than
    // alongside it: the splats have to land on the decayed history, not under
    // the pass that writes it.
    transparent: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
  });

  const stampMesh = new THREE.Mesh(stampGeometry, stampMaterial);
  stampMesh.frustumCulled = false;
  stampMesh.renderOrder = 1;
  stampMesh.visible = false;

  // One scene, two draws, one render call: the step writes every texel with no
  // blending and the stamps are max-blended over it afterwards.
  const scene = new THREE.Scene();
  scene.add(stepMesh, stampMesh);
  const camera = new THREE.Camera();

  // --- State ------------------------------------------------------------------
  const stats = { stamps: 0, dropped: 0, updates: 0 };
  let queued = 0;
  let first = true;
  let prevOriginX = 0;
  let prevOriginZ = 0;

  function applyProfile() {
    const p = foamProfile(sea);
    stepUniforms.uFoamLo.value = p.foamLo;
    stepUniforms.uFoamHi.value = p.foamHi;
    stepUniforms.uFoamJitter.value = p.foamJitter;
    stepUniforms.uFoamScale.value = p.foamScale;
  }

  applyProfile();

  const api = {
    uniforms,
    stats,
    extent,
    size,
    /** Where the footprint's near corner is, in world metres. Read-only. */
    origin: uniforms.uFoamOrigin.value,
    /** The passes, so they can be inspected, profiled or retuned in place. */
    materials: { step: stepMesh.material, stamp: stampMaterial },

    /** The texture the ocean samples. It changes every update — the ping-pong
     *  is the whole mechanism — so this is a getter, not a field. */
    get texture() {
      return read.texture;
    },

    /**
     * Queue a splat. Cheap: it writes four floats into an array, and many per
     * update is exactly what a wake is. Anything past the queue's capacity is
     * dropped and counted rather than growing the buffer under a caller who has
     * stopped calling `update`.
     *
     * @param x,z       centre, in world metres.
     * @param radius    metres to the soft edge.
     * @param strength  0..1 coverage laid down at the centre.
     */
    stamp(x, z, radius, strength = 1) {
      if (!(radius > 0) || !(strength > 0)) return;
      if (queued >= maxStamps) {
        stats.dropped++;
        return;
      }
      const i = queued * 4;
      stampData[i] = x;
      stampData[i + 1] = z;
      stampData[i + 2] = radius;
      stampData[i + 3] = clamp(strength, 0, 1);
      queued++;
    },

    /**
     * One update. Safe to call from a plain tick — there is no animation frame
     * assumption in here and no internal clock — and it leaves the renderer
     * exactly as it found it, because the very next thing the caller does is
     * draw the frame this texture is for.
     *
     * @param renderer   a WebGLRenderer.
     * @param dt         seconds. Clamped, and a nonsense value costs nothing.
     * @param cameraPos  the eye; the footprint is centred on it.
     */
    update(renderer, dt, cameraPos) {
      if (!renderer) return;

      const step = clamp(Number.isFinite(dt) ? dt : 0, 0, MAX_STEP);

      // The footprint, snapped to the global texel lattice. This is the line
      // that keeps the history from smearing: between updates the origin moves
      // by a whole number of texels, so the offset the shader reads its history
      // at is an integer and the bilinear tap is an exact copy.
      const cx = cameraPos?.x ?? 0;
      const cz = cameraPos?.z ?? 0;
      const originX = Math.floor((cx - extent * 0.5) / texel) * texel;
      const originZ = Math.floor((cz - extent * 0.5) / texel) * texel;

      if (first) {
        prevOriginX = originX;
        prevOriginZ = originZ;
      }

      // Downwind drift, in metres this step. Sub-texel, and deliberately not
      // snapped: advection is a smear, and pretending otherwise would make the
      // foam crawl in steps.
      const speed = o.drift ?? (sea.windSpeed ?? 0) * o.windDrift;
      const driftX = windDir.x * speed * step;
      const driftZ = windDir.y * speed * step;

      stepUniforms.uSrcOffset.value.set(
        (originX - prevOriginX - driftX) / extent,
        (originZ - prevOriginZ - driftZ) / extent
      );
      stepUniforms.uOrigin.value.set(originX, originZ);
      stepUniforms.uTime.value = waveField.time;
      // Half-life, as asked for: two to the minus dt over tau. The first update
      // has no history to keep and says so.
      stepUniforms.uDecay.value = first ? 0 : Math.pow(2, -step / halfLife);
      stepUniforms.uPrev.value = read.texture;

      // The blur is diffusion, not a filter, and it must spread the same scar
      // per second on every machine. A box blur's variance grows with the
      // number of passes, so the offset has to go as the square root of the
      // step or a hundred-and-twenty-hertz monitor would keep its foam sharp
      // and a thirty-hertz one would smear it. Capped, because four taps two
      // texels apart have stopped being a blur and started being a pattern.
      stepUniforms.uSpread.value = Math.min(o.spread * Math.sqrt(step * 60), 1.2);

      stampGeometry.instanceCount = queued;
      stampMesh.visible = queued > 0;
      if (queued > 0) stampAttribute.needsUpdate = true;
      stats.stamps = queued;

      // Everything the main pass is entitled to find where it left it.
      const prevTarget = renderer.getRenderTarget();
      const prevCubeFace = renderer.getActiveCubeFace();
      const prevMipLevel = renderer.getActiveMipmapLevel();
      const prevAutoClear = renderer.autoClear;

      // The step quad writes every texel unblended, so there is nothing for a
      // clear to do — and a clear here would be the renderer's clear colour,
      // which is not ours to assume anything about.
      renderer.autoClear = false;
      renderer.setRenderTarget(write);
      renderer.render(scene, camera);
      renderer.setRenderTarget(prevTarget, prevCubeFace, prevMipLevel);
      renderer.autoClear = prevAutoClear;

      const spent = read;
      read = write;
      write = spent;

      uniforms.uFoamField.value = read.texture;
      uniforms.uFoamOrigin.value.set(originX, originZ);

      prevOriginX = originX;
      prevOriginZ = originZ;
      queued = 0;
      first = false;
      stats.updates++;
    },

    /**
     * Swap the spectrum under a running field. The scar the old sea left is
     * kept — a change of weather does not un-break water that has broken — but
     * every crest injected from here on is the new sea's. A different *number*
     * of waves changes `#define NW`, which is compiled in, so that case needs a
     * new material.
     */
    setSeaState(nextSea) {
      sea = nextSea ?? waveField.sea;
      const fresh = waveUniforms(sea);

      if (sea.waves.length !== waveCount) {
        waveCount = sea.waves.length;
        for (const key of Object.keys(fresh)) stepUniforms[key] = fresh[key];
        const replacement = makeStepMaterial();
        stepMesh.material.dispose();
        stepMesh.material = replacement;
        api.materials.step = replacement;
      } else {
        for (const key of Object.keys(fresh)) stepUniforms[key].value = fresh[key].value;
      }

      if (pinnedWind === null && sea.windFromDeg !== undefined) {
        downwind(sea.windFromDeg, windDir);
      }

      applyProfile();
    },

    /** Point the drift somewhere else. Meteorological: where it comes *from*. */
    setWindFromDeg(deg) {
      downwind(deg, windDir);
    },

    /**
     * Change how long the water remembers. By day 8 s keeps the scars as
     * lace rather than a whitewash; by night the bioluminescence squares the
     * field before painting it, so the same buffer can safely hold a much
     * longer memory — a glowing wake road that lasts half a minute — without
     * the daylight trade-off that fixed 8 in the first place. Takes effect on
     * the next update; the history already in the buffer is untouched.
     */
    setHalfLife(seconds) {
      halfLife = Math.max(0.05, seconds);
    },

    get halfLife() {
      return halfLife;
    },

    dispose() {
      read.dispose();
      write.dispose();
      stepMesh.geometry.dispose();
      stepMesh.material.dispose();
      stampGeometry.dispose();
      stampMaterial.dispose();
      scene.clear();
    },
  };

  return api;
}

// --- Wakes --------------------------------------------------------------------

/**
 * Every number a wake is drawn from. Lengths are in ship's beams and ship's
 * lengths rather than metres, so the same stamper serves a cutter and a first
 * rate without being retuned.
 */
const WAKE_DEFAULTS = {
  minSpeed: 1, // m/s. Below this she is not making a wake, she is drifting.
  sternFraction: 0.5, // where the trail starts, as a fraction of her length
  widthFactor: 0.9, // stamp radius as a fraction of her beam
  spacingFactor: 0.5, // distance between splats, likewise
  strength: 0.85, // coverage laid down at full speed
  broachWidth: 2, // the trail doubles in width while she is over
  broachRadius: 3.5, // beams. A broach leaves an enormous scar — free drama.
  broachStrength: 1,
  maxPerUpdate: 24, // splats per call, so one long frame cannot flood the queue
  maxSegment: 4, // ship lengths of travel past which this is a teleport
  // How organic the lane is. At 0 the splats land identically, dead on the
  // track, and the result is a marker line dragged across the sea — a wake
  // you can see was *stamped*. At 1 the churn wanders half a radius and no
  // two splats match. Seeded, so the same voyage leaves the same wake.
  jitter: 0.55,
  seed: 1796,
};

/**
 * The library's wake: a hull's public state, turned into splats.
 *
 * This reads the hull and never writes to it — a wake is a consequence, and the
 * one thing it must not do is become an input. It also does not touch the
 * hull's `onBroach` callback, tempting as that is: those belong to the game, and
 * a library that quietly took one would break the first game that wanted it. The
 * `broached` flag is public and polling it is exact, because the latch is only
 * ever cleared in `Hull.update`.
 *
 * @param hull     a Hull, or anything with `position`, `headingRad` (or
 *                 `headingDeg`), `speed`, `broached` and `options`.
 * @param foam     anything with `stamp(x, z, radius, strength)`.
 * @param options  see `WAKE_DEFAULTS`.
 *
 * @returns `{ update(dt), reset(), stats }`
 */
export function wakeStamper(hull, foam, options = {}) {
  const o = { ...WAKE_DEFAULTS, ...options };

  const ship = hull?.options ?? {};
  const length = ship.length ?? 39;
  const beam = ship.beam ?? 9.9;
  const maxSpeed = ship.maxSpeed ?? 6;

  const arm = length * o.sternFraction;
  const spacing = Math.max(0.5, beam * o.spacingFactor);
  const jumpLimit = length * o.maxSegment;

  const stats = { trail: 0, broaches: 0, stamps: 0 };

  let prevX = null;
  let prevZ = null;
  let carry = 0;
  let wasBroached = false;

  // The library's LCG, one private stream per stamper: churn is not pattern.
  let rngState = ((o.seed ^ 0x9e3779b9) >>> 0) || 1;
  const rand = () => {
    rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
    return rngState / 4294967296;
  };

  const heading = () =>
    hull.headingRad ?? THREE.MathUtils.degToRad(hull.headingDeg ?? 0);

  return {
    stats,

    /**
     * Lay down whatever she has earned since the last call.
     *
     * Splats go down at a fixed spacing *along her track*, not once per frame:
     * a wake is a line on the water and how fast the machine is drawing it has
     * nothing to do with how long that line is.
     *
     * @param dt  seconds. Optional, and used only to tell a fast ship from a
     *            hull that has been picked up and put down somewhere else.
     */
    update(dt = 0) {
      if (!hull || !foam) return stats;

      const speed = hull.speed ?? 0;
      const broached = !!hull.broached;

      // The broach splat, before anything else and regardless of speed: she has
      // just been thrown across the sea and stopped, and the water where that
      // happened is white for a long way round.
      if (broached && !wasBroached) {
        foam.stamp(
          hull.position.x,
          hull.position.z,
          beam * o.broachRadius,
          o.broachStrength
        );
        stats.broaches++;
        stats.stamps++;
      }
      wasBroached = broached;

      const rad = heading();
      const x = hull.position.x - Math.sin(rad) * arm;
      const z = hull.position.z + Math.cos(rad) * arm;

      if (prevX === null) {
        prevX = x;
        prevZ = z;
        return stats;
      }

      const dx = x - prevX;
      const dz = z - prevZ;
      const moved = Math.hypot(dx, dz);

      // Sea room in the demo teleports her back to the middle of the ocean, and
      // a game will do worse. Whatever the reason, a hull that has covered more
      // ground than she could have swum did not swim it, and joining the two
      // ends of that with foam would draw a lane across the whole sea.
      const reach = dt > 0 ? speed * dt * 3 + spacing : jumpLimit;
      if (moved > Math.min(jumpLimit, Math.max(reach, spacing))) {
        prevX = x;
        prevZ = z;
        carry = 0;
        return stats;
      }

      // Nothing under a knot or two. A ship lying to has no wake, and stamping
      // one would pile splats on top of each other until the water went white
      // around a hull that is not moving.
      if (speed < o.minSpeed) {
        prevX = x;
        prevZ = z;
        carry = 0;
        return stats;
      }

      const over = clamp(
        (speed - o.minSpeed) / Math.max(1e-3, maxSpeed - o.minSpeed),
        0,
        1
      );
      const radius = beam * o.widthFactor * (0.55 + 0.45 * over) *
        (broached ? o.broachWidth : 1);
      const strength = clamp(o.strength * (0.35 + 0.65 * over), 0, 1);

      const ux = dx / moved;
      const uz = dz / moved;

      let laid = 0;
      let along = spacing - carry;
      while (along <= moved && laid < o.maxPerUpdate) {
        // Identical splats laid dead on a line read as exactly that. Real
        // churn meanders, thins, widens: each splat wanders across the track,
        // and no two carry the same weight or reach. All bounded, so the lane
        // stays a lane; all seeded, so a replay leaves the same water.
        const lat = (rand() * 2 - 1) * radius * 0.5 * o.jitter;
        const rf = 1 + (rand() * 2 - 1) * 0.35 * o.jitter;
        const sf = 1 - rand() * 0.5 * o.jitter;
        foam.stamp(
          prevX + ux * along - uz * lat,
          prevZ + uz * along + ux * lat,
          radius * rf,
          strength * sf
        );
        laid++;
        along += spacing;
      }

      carry = laid > 0 ? moved - (along - spacing) : carry + moved;
      // Only reachable if the per-call cap bit, which means a length of track
      // has gone unstamped. Start the count again from where she is rather than
      // carrying a debt that would lay the next splats behind her.
      if (carry >= spacing) carry = 0;
      stats.trail += laid;
      stats.stamps += laid;

      prevX = x;
      prevZ = z;
      return stats;
    },

    /** Forget the track. For a game that has moved her deliberately. */
    reset() {
      prevX = null;
      prevZ = null;
      carry = 0;
      wasBroached = !!hull?.broached;
    },
  };
}
