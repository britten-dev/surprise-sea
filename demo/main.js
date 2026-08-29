// The workbench.
//
// Everything the library can do, on one page, with nothing else in the way: a
// gradient sky, the sea, and a grey block that stands in for a ship until a
// real hull arrives from another project. The block is deliberately crude —
// what is being judged here is the water and the way she rides it, and a
// handsome model would only flatter both.
//
// The view that matters is the helm: eye height on the quarterdeck, looking
// aft over the stern at the sea coming up behind. Everything in the seakeeping
// model — the rudder going soft as she surfs, the stern slewing in a quartering
// sea, the moment before a broach — is legible from there and nowhere else.
//
// No framework, no build step of its own, no dependency but three. The HUD is
// plain DOM. The simulation is driven by one `tick(dt)` that does the whole
// frame, so `window.sea.step()` can run it by hand in a tab the browser has
// decided not to animate.

import * as THREE from 'three';
// Straight from their own files rather than through the barrel, so that a
// half-built `src/index.js` — the two halves of this library are written by two
// hands and one of them always lands first — cannot take the sky and the rain
// down with it.
import { createSky } from '../src/render/sky.js';
import { createRain } from '../src/render/rain.js';
import { createLens } from '../src/render/lens.js';

// --- Settings ----------------------------------------------------------------

const PRESETS = ['calm', 'breeze', 'gale', 'storm', 'greybeards'];

// Meteorological, and the same for every preset so switching between them
// changes the sea and nothing else.
const WIND_FROM_DEG = 285;

// The stand-in ship. Roughly a small weather ship: the dimensions the contract
// suggests for Hull, plus the freeboard the deck and the eye are measured from.
const SHIP = {
  length: 39,
  beam: 9.9,
  draught: 4.3,
  freeboard: 3.2,
  quarterdeck: 1.0, // the raised deck aft, where the helm is
  eye: 1.65,        // a helmsman's eye above whatever he is standing on
};

// Four ways to light the same sea: three lifted from the reference game's
// Southern Ocean moods, and the night the review asked for. `sunIntensity` and
// `ambient` are for the scene lights the block hull needs; createOcean reads
// only the keys it knows. All four are dry — rain is weather rather than light,
// and it is the panel's to add — and only the last has any fire in the water.
const LIGHTS = [
  {
    label: 'Storm grey',
    sunIntensity: 0.85,
    sunDir: [0.35, 0.3, 0.65],
    sunColour: 0xdfe2de,
    skyTop: 0x67737f,
    skyHaze: 0xa6abab,
    ambient: 0x8b959c,
    fogDensity: 1.1,
    glare: 0.3,
    exposure: 1.0,
    rain: 0,
    bioluminescence: 0,
    water: { deep: 0x25383c, crest: 0x3d6a5c, foam: 0xdfe4e4 },
  },
  {
    label: 'Sun break',
    sunIntensity: 1.5,
    sunDir: [-0.55, 0.28, 0.72],
    sunColour: 0xffe4b2,
    skyTop: 0x76848e,
    skyHaze: 0xc7c3b4,
    ambient: 0x98a09f,
    fogDensity: 0.85,
    glare: 0.95,
    exposure: 1.15,
    rain: 0,
    bioluminescence: 0,
    water: { deep: 0x2a3f41, crest: 0x518063, foam: 0xe8e9e2 },
  },
  {
    label: 'Dusk',
    sunIntensity: 0.75,
    sunDir: [-0.8, 0.12, 0.55],
    sunColour: 0xe2a273,
    skyTop: 0x3d4757,
    skyHaze: 0x8b8178,
    ambient: 0x5d6773,
    fogDensity: 1.3,
    glare: 0.55,
    exposure: 0.85,
    rain: 0,
    bioluminescence: 0,
    water: { deep: 0x1a252c, crest: 0x334e4b, foam: 0xb9bfc2 },
  },
  {
    // A moonless Southern Ocean night, and the review's R10: everything the
    // daylight presets are made of, turned down until only the broken water is
    // left. There is a moon somewhere behind the overcast — that is what the
    // cold, nearly spent sun colour is — but nothing that could be called
    // light on the sea. The block hull goes to a silhouette by arithmetic
    // rather than by intent: the scene's only lamps are the sun at an eighth
    // of its strength and a hemisphere the colour of the haze, and the haze is
    // as good as black.
    //
    // What is left to see by is the water itself. Foam is not black here — a
    // grey-blue that reads as pale motion in the dark, and which the spray and
    // the spume take their colour from, so the air over a breaking crest still
    // shows. The rest is sea fire.
    label: 'Night',
    sunIntensity: 0.12,
    sunDir: [-0.45, 0.26, 0.55],
    sunColour: 0x9fb0c8,
    skyTop: 0x080d16,
    skyHaze: 0x141d28,
    ambient: 0x161d26,
    fogDensity: 2.2,
    glare: 0.06,
    exposure: 0.7,
    rain: 0,
    bioluminescence: 1,
    // The glowing wake road. By day the field forgets in 8 s so scars stay
    // lace; the night glow squares the field before painting, so it can hold
    // half a minute of memory without the daylight whitewash.
    foamHalfLife: 30,
    water: { deep: 0x080f14, crest: 0x0d1a18, foam: 0x6b7681, glow: 0x2fd6a8 },
  },
];

// The base fog density handed to createOcean. Kept here rather than inline
// because the panel's visibility slider is the same number seen from the other
// end, and the two conversions must agree about what one unit means.
const BASE_FOG = 1.05e-4;

// The colour of the fire in the water, for the presets that do not say. There
// is a slider for how much of it there is and no picker for what colour it is:
// a bloom is the colour a bloom is, and the library's default is that colour.
const GLOW_COLOUR = 0x2fd6a8;

// How much of the sky cube the water is allowed to believe. One would be a
// mirror; a storm sea is not one, and the shipped procedural ramp is already
// well art-directed, so the cube is a strong flavouring rather than a
// replacement.
const SKY_REFLECT = 0.85;

// Where the custom weather lives between visits.
const STORE_KEY = 'surprise-sea.weather.v1';

// Helm first: it is the point of the exercise, so it is what the page opens on.
const VIEWS = ['helm', 'chase', 'orbit'];

const IS_COARSE = matchMedia('(pointer: coarse)').matches;

const QUALITY = {
  gridN: IS_COARSE ? 240 : 352,
  halfSpan: 16000,
  exponent: 2.2,
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const el = (id) => document.getElementById(id);

// --- Boot --------------------------------------------------------------------

boot().catch(fault);

async function boot() {
  // Imported at run time rather than at parse time so that a half-built
  // library says why it is not running instead of leaving a blank page. The
  // physics half may well land after this file did.
  const lib = await import('../src/index.js').catch((err) => {
    throw new Error(`src/index.js would not load.\n\n${err.message}`);
  });

  const missing = [
    'createSeaState', 'WaveField', 'Hull', 'AirOverSea', 'createOcean', 'createSpray',
  ].filter((name) => typeof lib[name] !== 'function');
  if (missing.length) {
    throw new Error(`src/index.js is missing: ${missing.join(', ')}`);
  }

  const { createSeaState, WaveField, Hull, AirOverSea, createOcean, createSpray } = lib;

  // --- Scene -----------------------------------------------------------------
  const canvas = el('scene');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !IS_COARSE,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.4, 26000);
  // The camera goes into the graph so that things parented to it are drawn —
  // three.js only ever walks the scene. Nothing else here depends on it, and
  // the camera's parent is the identity, so its own matrices are unchanged.
  scene.add(camera);

  // The dome, and the small cube of it the water reflects. Both come out of the
  // library now, so the sea and the sky are drawn with one formula and cannot
  // disagree about what is overhead.
  const sky = createSky({ lighting: LIGHTS[0] });
  scene.add(sky.mesh);

  // The block hull is the only lit object in the scene; the sea and the sky
  // light themselves. Weighted heavily toward the sky, because a hard sun on a
  // grey box makes it read as brown.
  const sunLight = new THREE.DirectionalLight(0xdfe2de, 0.85);
  const ambientLight = new THREE.HemisphereLight(0xa6abab, 0x46525a, 2.2);
  scene.add(sunLight, ambientLight);

  // --- Sea -------------------------------------------------------------------
  let presetName = 'storm';
  let seaState = createSeaState({ preset: presetName, windFromDeg: WIND_FROM_DEG });

  // Sea room: the sea itself is defined everywhere, but world coordinates in
  // the tens of kilometres start costing float precision, so she is quietly
  // walked back to the middle if she ever sails out of it.
  const field = new WaveField(seaState, 40000);
  let air = new AirOverSea(field);

  const ocean = createOcean(field, {
    quality: QUALITY,
    fogDensity: BASE_FOG,
    lighting: LIGHTS[0],
  });
  scene.add(ocean.mesh);

  // What the sea throws into the air. It is handed `air` as a function because
  // the workbench builds a fresh one on every change of weather, and the spray
  // should ride the gusting wind rather than a stale object.
  const spray = createSpray(field, {
    air: () => air,
    lighting: LIGHTS[0],
  });
  scene.add(spray.object3d);

  // Weather. Nought by default, and nought costs nothing: no arithmetic, no
  // instances, no draw call, until the panel's slider says otherwise.
  const rain = createRain(field, {
    windFromDeg: WIND_FROM_DEG,
    lighting: LIGHTS[0],
    rain: 0,
  });
  scene.add(rain.object3d);

  // And what gets past the eye and on to it. Parented to the camera, which is
  // why the camera had to go into the scene: the beads are drawn in clip space
  // and never read that transform, but three.js has to walk to them.
  const lens = createLens();
  camera.add(lens.object3d);

  // The one wire between the two. `spray` reports a face-full at most once a
  // second and only where the deck pass is live; the demo decides that only a
  // man standing on the deck has a face to catch it with, so the chase and
  // orbit cameras — which are nobody — stay dry.
  spray.onCameraHit = (strength) => {
    if (VIEWS[viewIndex] === 'helm') lens.notifySpray(strength);
  };

  // The wind as it lies on the screen, so the beads shear the way the weather
  // is actually running rather than simply falling. View space is the camera's
  // own frame: x right, y up.
  const windScreen = new THREE.Vector3();
  const windWorld = new THREE.Vector3();
  const camInverse = new THREE.Quaternion();

  function lensWind() {
    const rad = THREE.MathUtils.degToRad(WIND_FROM_DEG);
    windWorld.set(-Math.sin(rad), 0, Math.cos(rad));
    camInverse.copy(camera.quaternion).invert();
    return windScreen.copy(windWorld).applyQuaternion(camInverse);
  }

  // --- Ship ------------------------------------------------------------------
  const hull = new Hull({
    length: SHIP.length,
    beam: SHIP.beam,
    draught: SHIP.draught,
    freeboard: SHIP.freeboard,
    mass: 500e3,
    heaveTau: 1.5,
    pitchTau: 1.9,
    rollTau: 2.1,
    maxSpeed: 6,
    rudderPower: 0.25,
    yawDamping: 0.8,
    x: 0,
    z: 0,
    // Running with the sea on the quarter — the heading that gets her into
    // trouble, which is the one worth starting on.
    headingDeg: 105,
  });

  // The two events the seakeeping model fires. Both flash the risk bar, since
  // either one means she is no longer entirely the helmsman's to command.
  hull.onBroach = () => alarm('Broached — she is beam-on to it');
  hull.onPooped = () => alarm('Pooped — the sea is aboard aft');

  const ship = createShipMesh();
  scene.add(ship.group);

  // --- Scars -----------------------------------------------------------------
  // The foam field and the wake stamper belong to the other half of this round
  // and may not have landed yet. Every line here is guarded, so the workbench
  // boots and looks right with any subset of them present — the property that
  // has saved this demo every round so far. `wakeStamper` may hand back either
  // a function to call each frame or an object with an `update`; both are taken.
  let foam = null;
  let wake = null;
  try {
    foam = lib.createFoamField?.(field, {
      size: IS_COARSE ? 512 : 1024,
      extent: 2400,
      windFromDeg: WIND_FROM_DEG,
    }) ?? null;

    if (foam) {
      ocean.setFoamField?.(foam);
      wake = lib.wakeStamper?.(hull, foam) ?? null;
    }
  } catch (err) {
    console.warn('No foam field; the sea will heal the instant a crest passes.', err);
    foam = null;
    wake = null;
  }

  // --- The cascade -----------------------------------------------------------
  // The spectral tile under the near field. Desktop only: it is ten render
  // passes a frame and a phone that is already carrying two wave loops per
  // pixel has no business paying for them. Guarded like every other layer, and
  // guarded twice over — a machine whose GPU will not render into a float
  // target hands back a cascade that says `disabled`, and the sea never hears
  // of it, and the page boots into exactly the water it had before.
  let cascade = null;
  let cascadeOn = false;

  if (!IS_COARSE) {
    try {
      cascade = lib.createDetailCascade?.(field, { renderer }) ?? null;
      if (cascade?.disabled) {
        console.info(
          'No float render targets on this GPU; the spectral cascade stays ashore.'
        );
        cascade.dispose?.();
        cascade = null;
      }
      if (cascade) {
        ocean.setDetailCascade?.(cascade);
        cascadeOn = true;
      }
    } catch (err) {
      console.warn('No spectral cascade; the near water keeps its noise.', err);
      cascade = null;
      cascadeOn = false;
    }
  }

  // --- Controls --------------------------------------------------------------
  const held = new Set();
  let rudder = 0;   // -1 port .. +1 starboard, where the wheel actually is
  let thrust = 0.6; // fraction of maxSpeed the canvas is driving her at

  let viewIndex = 0;
  let lightIndex = 0;

  // Orbit camera state. Yaw is measured from astern, so it opens looking at her
  // from over the quarter.
  const orbit = { yaw: 2.5, pitch: 0.24, dist: 110, dragging: false, px: 0, py: 0 };

  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', (e) => held.delete(e.code));
  addEventListener('blur', () => held.clear());

  canvas.addEventListener('pointerdown', (e) => {
    orbit.dragging = true;
    orbit.px = e.clientX;
    orbit.py = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!orbit.dragging) return;
    orbit.yaw -= (e.clientX - orbit.px) * 0.006;
    orbit.pitch = clamp(orbit.pitch + (e.clientY - orbit.py) * 0.005, -0.25, 1.35);
    orbit.px = e.clientX;
    orbit.py = e.clientY;
  });
  const endDrag = () => { orbit.dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    orbit.dist = clamp(orbit.dist * Math.exp(e.deltaY * 0.0012), 24, 1400);
  }, { passive: false });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  function onKeyDown(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // A slider under the fingers owns the arrow keys; the helm must not also
    // take them, or nudging the sun a degree puts the wheel hard over.
    if (e.target instanceof HTMLElement && e.target.closest('#panel')) return;

    const digit = PRESETS[Number(e.code.replace('Digit', '')) - 1];
    if (e.code.startsWith('Digit') && digit) {
      setPreset(digit);
      e.preventDefault();
      return;
    }

    switch (e.code) {
      case 'KeyC':
        viewIndex = (viewIndex + 1) % VIEWS.length;
        chase.set(NaN, NaN, NaN); // force the chase camera to snap, not swoop
        note(`View: ${VIEWS[viewIndex]}`);
        break;
      case 'KeyL':
        applyPreset((lightIndex + 1) % LIGHTS.length);
        note(`Light: ${LIGHTS[lightIndex].label}`);
        break;
      case 'KeyE':
        panel.hidden = !panel.hidden;
        note(panel.hidden ? 'Weather panel closed' : 'Weather panel — E to close');
        break;
      // The A/B. A uniform rather than a detach, so the two seas can be flipped
      // between at will and the eye can be asked the only question that
      // matters — is the near water better with it than without — without a
      // recompile's hitch in the middle of the comparison. For the other half
      // of the proof, that nought really is the shader that shipped before any
      // of this, the console has `sea.ocean.setDetailCascade(null)`.
      case 'KeyF':
        if (!cascade) {
          note('No spectral cascade on this machine');
          break;
        }
        cascadeOn = !cascadeOn;
        cascade.setGain(cascadeOn ? 1 : 0);
        note(
          cascadeOn
            ? `Cascade on — ${cascade.size}² spectral tile over ${cascade.patch} m`
            : 'Cascade off — the near water is back to noise'
        );
        syncDetail();
        break;
      case 'Space':
        rudder = 0;
        held.delete('ArrowLeft'); held.delete('ArrowRight');
        held.delete('KeyA'); held.delete('KeyD');
        break;
      default:
        held.add(e.code);
        // The arrows would otherwise try to scroll a page that has nowhere to go.
        if (e.code.startsWith('Arrow')) e.preventDefault();
        return;
    }
    e.preventDefault();
  }

  // --- Sea state and light ---------------------------------------------------

  function setPreset(name) {
    if (!PRESETS.includes(name)) return;
    presetName = name;
    seaState = createSeaState({ preset: name, windFromDeg: WIND_FROM_DEG });

    // The field keeps its clock, so the swap happens *within* the same running
    // sea rather than restarting it: one instant it is a breeze, the next a gale.
    field.setSeaState(seaState);
    ocean.setSeaState(seaState);
    spray.setSeaState(seaState);
    // The rain reads the surface and the wind fresh every frame, so it needs
    // only to be told the wind may have changed. Guarded, like everything the
    // other half of the round owns.
    rain.setSeaState?.(seaState);
    foam?.setSeaState?.(seaState);
    // The tile is re-drawn from the new sea's own seed, so a preset swapped
    // away and back comes back with the chop it had rather than a fresh roll.
    cascade?.setSeaState?.(seaState);
    syncDetail();
    // The air takes its wind from the sea state, so it would follow along by
    // itself; building it anew starts the gusts fresh with the new weather.
    air = new AirOverSea(field);

    note(`Sea state: ${name} — Hs ${significantHeight(seaState).toFixed(1)} m`);
  }

  // --- Camera ----------------------------------------------------------------

  const fwd = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const chase = new THREE.Vector3(NaN, NaN, NaN);
  const target = new THREE.Vector3();
  // Turn the camera to look aft along the ship's own axes: 180° about her mast,
  // then a few degrees down so the sea fills the frame rather than the sky.
  const AFT = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-0.05, Math.PI, 0, 'YXZ')
  );

  let warnedAboutFacing = false;

  function updateCamera(dt) {
    const p = hull.position;

    // Her bow, from the quaternion the seakeeping model publishes. The camera
    // rigs are built on it rather than on headingDeg, because the helm view
    // wants the roll and the pitch as well as the yaw.
    fwd.set(0, 0, -1).applyQuaternion(hull.quaternion);

    // If a hull ever arrives with the opposite convention this is the one place
    // it would show, so say so once rather than leaving her sailing stern-first.
    if (!warnedAboutFacing) {
      const rad = THREE.MathUtils.degToRad(hull.headingDeg);
      if (fwd.x * Math.sin(rad) + fwd.z * -Math.cos(rad) < 0.5) {
        console.warn(
          'Hull.quaternion does not put the bow along headingDeg; the demo ' +
          'assumes local -Z is forward.'
        );
      }
      warnedAboutFacing = true;
    }

    const view = VIEWS[viewIndex];

    if (view === 'helm') {
      // Right aft on the quarterdeck, close enough to the taffrail that the
      // deck is a strip along the bottom of the frame rather than a third of
      // it — everything worth watching is in the twenty metres astern of her.
      // Rigidly attached: the horizon rolls, and it should.
      eye.set(0, SHIP.freeboard + SHIP.quarterdeck + SHIP.eye, SHIP.length * 0.32)
        .applyQuaternion(hull.quaternion)
        .add(p);
      camera.position.copy(eye);
      camera.quaternion.copy(hull.quaternion).multiply(AFT);
      return;
    }

    camera.up.set(0, 1, 0);

    if (view === 'chase') {
      // Astern and above, level with the world rather than with her, so the
      // motion reads as *hers*.
      target.set(p.x - fwd.x * 78, p.y + 26, p.z - fwd.z * 78);
      if (Number.isNaN(chase.x)) chase.copy(target);
      chase.lerp(target, 1 - Math.exp(-dt / 0.7));
      camera.position.copy(chase);
      camera.lookAt(p.x + fwd.x * 24, p.y + 5, p.z + fwd.z * 24);
      return;
    }

    // Orbit: a fixed compass bearing on her, so she turns under the camera.
    const cp = Math.cos(orbit.pitch);
    camera.position.set(
      p.x + Math.sin(orbit.yaw) * cp * orbit.dist,
      p.y + Math.sin(orbit.pitch) * orbit.dist + 8,
      p.z + Math.cos(orbit.yaw) * cp * orbit.dist
    );
    camera.lookAt(p.x, p.y + 5, p.z);
  }

  // --- HUD -------------------------------------------------------------------

  const ui = {
    preset: el('vPreset'), wind: el('vWind'), light: el('vLight'), view: el('vView'),
    weather: el('vWeather'), detail: el('vDetail'),
    speed: el('vSpeed'), heading: el('vHeading'), surf: el('vSurf'),
    rudder: el('vRudder'), authority: el('vAuthority'), risk: el('vRisk'),
    helmFill: el('helmFill'), authFill: el('authFill'),
    riskFill: el('riskFill'), riskTrack: el('riskTrack'), log: el('log'),
  };

  let textClock = 0;

  /**
   * The near-field row. Written only when it can have changed — the cascade is
   * either on or off and nothing else moves it — rather than on the text clock,
   * which is the arrangement the light and weather rows already use.
   *
   * It reports the tile's slope RMS as well as its state, because that number
   * is the whole budget of this layer: it falls with the sea state and it is
   * the one figure that says how much of the near water is the cascade's.
   */
  function syncDetail() {
    if (!ui.detail) return;
    if (!cascade) {
      ui.detail.textContent = 'wavelets only';
      return;
    }
    const rms = cascade.table?.slopeRms ?? 0;
    ui.detail.textContent = cascadeOn
      ? `wavelets + ${cascade.size}² @ ${cascade.patch} m · slope ${rms.toFixed(3)}`
      : 'wavelets only (F for the cascade)';
  }

  function note(text) {
    const t = field.time;
    const stamp = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    ui.log.innerHTML = `<b>${stamp}</b> &nbsp;${text}`;
  }

  function alarm(text) {
    note(text);
    // Restarting a CSS animation needs the class off, a reflow, and the class on.
    ui.riskTrack.classList.remove('alarm');
    void ui.riskTrack.offsetWidth;
    ui.riskTrack.classList.add('alarm');
  }

  function updateHud(dt) {
    // Bars every frame: they are the feel of the thing.
    const authority = hull.rudderAuthority ?? 0;
    const risk = clamp(hull.broachRisk ?? 0, 0, 1);

    ui.helmFill.style.width = `${Math.abs(rudder) * 50}%`;
    ui.helmFill.style.left = rudder < 0 ? `${50 - Math.abs(rudder) * 50}%` : '50%';
    ui.authFill.style.width = `${authority * 100}%`;
    ui.authFill.style.background =
      authority < 0.25 ? 'var(--bad)' : authority < 0.55 ? 'var(--warn)' : 'var(--good)';
    ui.riskFill.style.width = `${risk * 100}%`;
    ui.riskFill.style.background =
      risk > 0.8 ? 'var(--bad)' : risk > 0.45 ? 'var(--warn)' : 'var(--good)';

    // Text a few times a second. Numbers that flicker cannot be read.
    textClock += dt;
    if (textClock < 0.1) return;
    textClock = 0;

    const heading = (((hull.headingDeg ?? 0) % 360) + 360) % 360;
    const speed = hull.speed ?? 0;

    ui.preset.textContent = `${presetName} · Hs ${significantHeight(seaState).toFixed(1)} m`;
    ui.wind.textContent = `${WIND_FROM_DEG}° · ${(air.windSpeed ?? 0).toFixed(1)} m/s`;
    // The light and weather rows belong to the panel: it writes them whenever
    // the environment changes, which is the only time they can move.
    ui.view.textContent = VIEWS[viewIndex];
    ui.speed.textContent = `${speed.toFixed(1)} m/s · ${(speed * 1.944).toFixed(1)} kn · thrust ${(thrust * 100) | 0}%`;
    ui.heading.textContent = `${heading.toFixed(0)}° ${COMPASS[Math.round(heading / 22.5) % 16]}`;
    ui.surf.textContent = hull.broached
      ? 'BROACHED'
      : `${((hull.surfFactor ?? 0) * 100) | 0}% surfing`;
    ui.rudder.textContent =
      Math.abs(rudder) < 0.02
        ? 'amidships'
        : `${Math.abs(rudder * 100) | 0}% ${rudder < 0 ? 'port' : 'starboard'}`;
    ui.authority.textContent = `${(authority * 100) | 0}%`;
    ui.risk.textContent = `${(risk * 100) | 0}%`;
  }

  // --- Weather ---------------------------------------------------------------
  //
  // One object holds everything the panel can change, and one function turns it
  // into the single lighting object that the sky, the sea, the spray, the rain
  // and the scene lights all read. That is the whole discipline of this
  // section: the couplings live in `deriveLighting` and nowhere else. No shader
  // knows it is raining — it is handed thicker fog and greyer colours, and it
  // draws them exactly as it would have drawn a duller afternoon.

  const panel = el('panel');

  /** A compass bearing and an altitude, as a direction. North is -Z. */
  function sunVector(azimuthDeg, elevationDeg) {
    const az = THREE.MathUtils.degToRad(azimuthDeg);
    const alt = THREE.MathUtils.degToRad(elevationDeg);
    const flat = Math.cos(alt);
    return [Math.sin(az) * flat, Math.sin(alt), -Math.cos(az) * flat];
  }

  /** The same, backwards, so a preset's hand-written vector can fill sliders. */
  function sunAngles(dir) {
    const v = new THREE.Vector3(...dir).normalize();
    return {
      azimuth: (THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z)) + 360) % 360,
      elevation: THREE.MathUtils.radToDeg(Math.asin(clamp(v.y, -1, 1))),
    };
  }

  // Visibility and fog density are one number seen from opposite ends. The
  // shader fogs a thing out at about `3 / density` metres, and a seaman thinks
  // in miles of visibility rather than in exponents — so the slider is labelled
  // visibility, and this is where it becomes the multiplier on the base density
  // that the lighting object actually carries.
  const fogFromVisibility = (km) => 3 / (Math.max(km, 0.1) * 1000) / BASE_FOG;
  const visibilityFromFog = (mult) => 3 / (Math.max(mult, 1e-4) * BASE_FOG) / 1000;

  /** `0x67737f` and `'#67737f'` are the same colour; the pickers want the latter. */
  const hex = (value) =>
    typeof value === 'number' ? `#${value.toString(16).padStart(6, '0')}` : String(value);

  function weatherFromPreset(light) {
    const { azimuth, elevation } = sunAngles(light.sunDir);
    return {
      label: light.label,
      sunAzimuthDeg: Math.round(azimuth),
      sunElevationDeg: Math.round(elevation * 2) / 2,
      glare: light.glare,
      exposure: light.exposure,
      visibilityKm: Math.round(visibilityFromFog(light.fogDensity) * 2) / 2,
      rain: light.rain ?? 0,
      bioluminescence: light.bioluminescence ?? 0,
      foamHalfLife: light.foamHalfLife ?? 8,
      sunIntensity: light.sunIntensity,
      ambient: hex(light.ambient),
      skyTop: hex(light.skyTop),
      skyHaze: hex(light.skyHaze),
      sunColour: hex(light.sunColour),
      water: {
        deep: hex(light.water.deep),
        crest: hex(light.water.crest),
        foam: hex(light.water.foam),
        glow: hex(light.water.glow ?? GLOW_COLOUR),
      },
    };
  }

  const weather = weatherFromPreset(LIGHTS[0]);

  /**
   * A colour drained toward its own grey: saturation goes, brightness stays.
   * Draining toward black instead would make a squall a lighting change as well
   * as a weather one, and the exposure slider is what that is for.
   */
  function drained(value, amount) {
    const c = new THREE.Color(value);
    if (amount > 0) {
      const luma = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
      c.lerp(new THREE.Color(luma, luma, luma), amount);
    }
    return c;
  }

  /** The panel's numbers, as the lighting object every consumer understands. */
  function deriveLighting() {
    const r = clamp(weather.rain, 0, 1);

    // Rain, coupled, once. The air thickens by up to two and a bit times, and a
    // quarter of the colour goes out of the sky and the water — a squall is
    // grey and it greys everything under it. The sun's own colour is left
    // alone: that is the light being made, not a surface standing in the rain.
    const fogDensity = fogFromVisibility(weather.visibilityKm) * (1 + 1.2 * r);
    const desat = 0.25 * r;

    return {
      label: weather.label,
      sunDir: sunVector(weather.sunAzimuthDeg, weather.sunElevationDeg),
      sunColour: drained(weather.sunColour, 0),
      sunIntensity: weather.sunIntensity,
      ambient: weather.ambient,
      skyTop: drained(weather.skyTop, desat),
      skyHaze: drained(weather.skyHaze, desat),
      glare: weather.glare,
      exposure: weather.exposure,
      fogDensity,
      rain: r,
      bioluminescence: clamp(weather.bioluminescence, 0, 1),
      foamHalfLife: weather.foamHalfLife ?? 8,
      water: {
        deep: drained(weather.water.deep, desat),
        crest: drained(weather.water.crest, desat),
        foam: drained(weather.water.foam, desat),
        // Not drained, alone of the six. The rest of the palette is surfaces
        // standing in a squall and a squall takes the colour out of a surface;
        // this is an emission, and rain falling through a bloom does not turn
        // it grey. Greying it would be the one place in this function where the
        // coupling made the picture worse.
        glow: drained(weather.water.glow, 0),
      },
    };
  }

  let lighting = deriveLighting();

  /**
   * Push the derived environment at everything that draws.
   *
   * The one call that matters for cost is `sky.updateReflection`. The cube is
   * re-rendered here and only here — a change of lighting is the only thing
   * that can make it wrong — and sky.js returns immediately when nothing has
   * moved, so a still frame pays nothing and dragging a slider pays for one
   * small cube per event.
   */
  function applyEnvironment() {
    lighting = deriveLighting();

    sky.setLighting(lighting);
    ocean.setLighting(lighting);
    spray.setLighting(lighting);
    rain.setLighting(lighting);
    rain.setWeather({ rain: lighting.rain });
    // Heavy rain beads on the glass as well; the slider is the same slider.
    lens.setWeather({ rain: lighting.rain });

    sunLight.color.set(lighting.sunColour);
    sunLight.intensity = lighting.sunIntensity;
    sunLight.position.set(...lighting.sunDir).normalize().multiplyScalar(1000);
    ambientLight.color.set(lighting.skyHaze);
    ambientLight.groundColor.set(lighting.water.deep);

    const cube = sky.updateReflection(renderer);
    if (cube) ocean.setReflection?.(cube, SKY_REFLECT);

    // How long the water remembers follows the light: the night preset asks
    // for a long glowing road astern, everything else keeps the daylight 8 s.
    foam?.setHalfLife?.(lighting.foamHalfLife ?? 8);

    syncPanel();
    store();
  }

  function applyPreset(index) {
    lightIndex = index;
    Object.assign(weather, weatherFromPreset(LIGHTS[index]));
    applyEnvironment();
  }

  // --- The panel -------------------------------------------------------------

  const SLIDERS = [
    { key: 'sunAzimuthDeg', input: 'wAzimuth', out: 'wAzimuthV',
      text: (v) => `${v.toFixed(0)}° ${COMPASS[Math.round(v / 22.5) % 16]}` },
    { key: 'sunElevationDeg', input: 'wElevation', out: 'wElevationV',
      text: (v) => `${v.toFixed(1)}°` },
    { key: 'glare', input: 'wGlare', out: 'wGlareV', text: (v) => v.toFixed(2) },
    { key: 'exposure', input: 'wExposure', out: 'wExposureV', text: (v) => v.toFixed(2) },
    { key: 'visibilityKm', input: 'wVisibility', out: 'wVisibilityV',
      text: (v) => `${v.toFixed(1)} km` },
    { key: 'rain', input: 'wRain', out: 'wRainV',
      text: (v) => (v <= 0 ? 'dry' : `${Math.round(v * 100)}%`) },
    // The one control whose answer is not its own. How much fire is in the
    // water is this slider; how much of it can be seen is the sky, and the sea
    // is the only thing that knows — so the readout asks it rather than
    // computing the same clamp a second time and getting it subtly wrong. On a
    // lit preset the slider is honest about doing nothing.
    { key: 'bioluminescence', input: 'wGlow', out: 'wGlowV',
      text: (v) => {
        if (v <= 0) return 'dark';
        const reaching = ocean.uniforms.uGlowAmount?.value ?? v;
        return reaching < v * 0.1
          ? `${Math.round(v * 100)}% · too light`
          : `${Math.round(v * 100)}%`;
      } },
  ];

  // Paths rather than keys, because three of the six live under `water`.
  const SWATCHES = [
    { path: ['skyTop'], input: 'wSkyTop' },
    { path: ['skyHaze'], input: 'wSkyHaze' },
    { path: ['sunColour'], input: 'wSunColour' },
    { path: ['water', 'deep'], input: 'wDeep' },
    { path: ['water', 'crest'], input: 'wCrest' },
    { path: ['water', 'foam'], input: 'wFoam' },
  ];

  const readPath = (path) => path.reduce((o, k) => o[k], weather);
  const writePath = (path, value) => {
    const leaf = path[path.length - 1];
    path.slice(0, -1).reduce((o, k) => o[k], weather)[leaf] = value;
  };

  function syncPanel() {
    el('wState').textContent = weather.label;
    for (const s of SLIDERS) {
      el(s.input).value = String(weather[s.key]);
      el(s.out).textContent = s.text(weather[s.key]);
    }
    for (const s of SWATCHES) el(s.input).value = readPath(s.path);

    ui.light.textContent = weather.label;
    // What the sea is actually burning at, not what was asked for: on any lit
    // preset the second is one and the first is nought, and the row would lie.
    const fire = ocean.uniforms.uGlowAmount?.value ?? 0;
    ui.weather.textContent = `${
      weather.rain > 0 ? `rain ${Math.round(weather.rain * 100)}%` : 'dry'
    } · vis ${weather.visibilityKm.toFixed(0)} km${
      fire > 0.01 ? ` · fire ${Math.round(fire * 100)}%` : ''
    }`;
  }

  for (const s of SLIDERS) {
    el(s.input).addEventListener('input', (e) => {
      weather[s.key] = Number(e.target.value);
      // The moment a control is touched this is nobody's preset any more.
      weather.label = 'Custom';
      applyEnvironment();
    });
  }

  for (const s of SWATCHES) {
    el(s.input).addEventListener('input', (e) => {
      writePath(s.path, e.target.value);
      weather.label = 'Custom';
      applyEnvironment();
    });
  }

  /**
   * The environment, as something that can be pasted back into `LIGHTS` above.
   * Both halves go out: the derived lighting object a game would consume, and
   * the raw panel state that produced it, so a tuning session can be resumed.
   */
  function environmentJson() {
    const env = deriveLighting();
    const asHex = (c) => `#${c.getHexString()}`;
    return JSON.stringify(
      {
        label: weather.label,
        sunIntensity: env.sunIntensity,
        sunDir: env.sunDir.map((v) => Number(v.toFixed(4))),
        sunColour: asHex(env.sunColour),
        skyTop: asHex(env.skyTop),
        skyHaze: asHex(env.skyHaze),
        ambient: env.ambient,
        fogDensity: Number(env.fogDensity.toFixed(4)),
        glare: env.glare,
        exposure: env.exposure,
        rain: env.rain,
        bioluminescence: env.bioluminescence,
        water: {
          deep: asHex(env.water.deep),
          crest: asHex(env.water.crest),
          foam: asHex(env.water.foam),
          glow: asHex(env.water.glow),
        },
        weather: { ...weather, water: { ...weather.water } },
      },
      null,
      2
    );
  }

  el('wCopy').addEventListener('click', async () => {
    const text = environmentJson();
    const box = el('wJson');
    try {
      await navigator.clipboard.writeText(text);
      box.hidden = true;
      note('Environment copied to the clipboard');
      return;
    } catch {
      // No clipboard permission, or an insecure origin. Show the text and
      // select it, which is the oldest fallback there is and still the surest.
    }
    box.value = text;
    box.hidden = false;
    box.focus();
    box.select();
    note('Clipboard refused — the JSON is selected below; copy it by hand');
  });

  // A custom sky survives a reload, because tuning one is half an hour's work
  // and losing it to a stray refresh is the whole reason nobody tunes anything.
  function store() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(weather));
    } catch {
      // A private window, a full quota, storage switched off entirely: none of
      // them is a reason for the workbench not to run.
    }
  }

  function restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    } catch {
      saved = null;
    }
    if (!saved || typeof saved !== 'object') return false;

    // Anything in storage is untrusted: it may be from an older shape of this
    // file, or from a hand that edited it. Every field is checked, and a bad
    // one keeps the preset's value rather than poisoning a uniform.
    const num = (v, lo, hi, fallback) => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
    const col = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(v) ? v : fallback);

    if (typeof saved.label === 'string') weather.label = saved.label.slice(0, 32);
    weather.sunAzimuthDeg = num(saved.sunAzimuthDeg, 0, 360, weather.sunAzimuthDeg);
    weather.sunElevationDeg = num(saved.sunElevationDeg, -5, 60, weather.sunElevationDeg);
    weather.glare = num(saved.glare, 0, 1, weather.glare);
    weather.exposure = num(saved.exposure, 0.4, 2, weather.exposure);
    weather.visibilityKm = num(saved.visibilityKm, 1, 40, weather.visibilityKm);
    weather.rain = num(saved.rain, 0, 1, weather.rain);
    weather.bioluminescence = num(saved.bioluminescence, 0, 1, weather.bioluminescence);
    weather.sunIntensity = num(saved.sunIntensity, 0, 6, weather.sunIntensity);
    weather.ambient = col(saved.ambient, weather.ambient);
    weather.skyTop = col(saved.skyTop, weather.skyTop);
    weather.skyHaze = col(saved.skyHaze, weather.skyHaze);
    weather.sunColour = col(saved.sunColour, weather.sunColour);
    weather.water.deep = col(saved.water?.deep, weather.water.deep);
    weather.water.crest = col(saved.water?.crest, weather.water.crest);
    weather.water.foam = col(saved.water?.foam, weather.water.foam);
    weather.water.glow = col(saved.water?.glow, weather.water.glow);
    return true;
  }

  // Only a *tuned* sky is worth announcing; a preset coming back out of storage
  // is the same preset the page would have opened on anyway.
  const restored = restore() && weather.label === 'Custom';
  applyEnvironment();

  // --- Ship mesh -------------------------------------------------------------

  function createShipMesh() {
    // Local frame: origin at the waterline amidships, bow toward -Z, which is
    // the convention Hull's quaternion is built on.
    const group = new THREE.Group();
    group.name = 'placeholder-hull';

    const paint = (hex) =>
      new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0.02 });

    const hullMat = paint(0x767c80);
    const deckMat = paint(0x9aa0a3);
    const sparMat = paint(0x53585c);

    const depth = SHIP.draught + SHIP.freeboard;
    const midY = SHIP.freeboard - depth / 2;

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(SHIP.beam, depth, SHIP.length * 0.82),
      hullMat
    );
    body.position.y = midY;
    group.add(body);

    // A box turned through 45° gives her a stem to put into the sea, and — more
    // to the point — makes which end is which obvious from any angle.
    const bow = new THREE.Mesh(
      new THREE.BoxGeometry(SHIP.beam * 0.72, depth, SHIP.beam * 0.72),
      hullMat
    );
    bow.position.set(0, midY, -SHIP.length * 0.41);
    bow.rotation.y = Math.PI / 4;
    group.add(bow);

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(SHIP.beam * 0.98, 0.35, SHIP.length * 0.84),
      deckMat
    );
    deck.position.y = SHIP.freeboard + 0.17;
    group.add(deck);

    const quarter = new THREE.Mesh(
      new THREE.BoxGeometry(SHIP.beam * 0.9, SHIP.quarterdeck, SHIP.length * 0.28),
      deckMat
    );
    quarter.position.set(0, SHIP.freeboard + SHIP.quarterdeck / 2, SHIP.length * 0.27);
    group.add(quarter);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.45, 22, 8),
      sparMat
    );
    mast.position.set(0, SHIP.freeboard + 11, -SHIP.length * 0.06);
    group.add(mast);

    // A flag, because heading and roll are much easier to read off something
    // that streams. It hangs from the masthead and lies downwind, which also
    // shows at a glance how she is taking the sea.
    const flagPivot = new THREE.Object3D();
    flagPivot.position.set(0, SHIP.freeboard + 21, -SHIP.length * 0.06);
    const flagGeom = new THREE.PlaneGeometry(5, 2.4);
    flagGeom.translate(2.5, 0, 0); // hinge at the mast, not at the middle
    const flag = new THREE.Mesh(
      flagGeom,
      new THREE.MeshStandardMaterial({ color: 0xb1483f, side: THREE.DoubleSide, roughness: 0.9 })
    );
    flag.rotation.y = -Math.PI / 2; // stream aft along +Z, faces to port and starboard
    flagPivot.add(flag);
    group.add(flagPivot);

    return { group, flagPivot };
  }

  // --- Frame -----------------------------------------------------------------

  function tick(dt) {
    // The sea moves first, so the hull, the camera and the shader all read the
    // same instant of the same sea.
    field.advance(dt);

    // The wheel takes time to come over; a rudder that snapped to the stops
    // would hide most of what the authority model is doing.
    const want =
      (held.has('ArrowLeft') || held.has('KeyA') ? -1 : 0) +
      (held.has('ArrowRight') || held.has('KeyD') ? 1 : 0);
    rudder += clamp(want - rudder, -1.8 * dt, 1.8 * dt);

    if (held.has('KeyW') || held.has('ArrowUp')) thrust = clamp(thrust + 0.35 * dt, 0, 1);
    if (held.has('KeyS') || held.has('ArrowDown')) thrust = clamp(thrust - 0.5 * dt, 0, 1);

    air.update(dt);
    hull.update(dt, field, { rudder, thrust });

    // Sea room. She is only ever moved when there is nothing to compare her
    // against but open water, so the jump is invisible.
    if (!field.contains(hull.position.x, hull.position.z, 1500)) {
      hull.position.x = 0;
      hull.position.z = 0;
      note('Back to the middle of the ocean');
    }

    ship.group.position.copy(hull.position);
    ship.group.quaternion.copy(hull.quaternion);
    // Downwind in her own frame: heading minus wind bearing. Running dead
    // before it, the flag streams forward over the bow, as it should.
    ship.flagPivot.rotation.y =
      THREE.MathUtils.degToRad(hull.headingDeg - WIND_FROM_DEG) +
      Math.sin(field.time * 2.7) * 0.05;

    updateCamera(dt);
    ocean.update(camera.position);
    // Inside tick, so it advances under window.sea.step() like everything else,
    // and after the camera, because where the spray is spawned depends on where
    // the eye is and how far above the water it has got. The rain wants the
    // camera for the same reason: its near layer is a box around the eye.
    spray.update(dt, camera.position);
    rain.update(dt, camera.position);
    // Last of the three, because the spray decides during its own update
    // whether anything has just hit the glass.
    lens.update(dt, lensWind());

    // Scars, last of all and before the draw. The wake is stamped first so that
    // this frame's trail is in this frame's texture, and the field is stepped
    // before `renderer.render` because the ocean shader is about to sample it.
    if (wake) {
      if (typeof wake === 'function') wake(dt);
      else wake.update?.(dt);
    }
    foam?.update?.(renderer, dt, camera.position);
    // And the spectral tile, last of the render-target work and still before
    // the draw: the ocean shader is about to sample it, and it is drawn for
    // this instant of this sea rather than for the last one.
    cascade?.update?.(renderer);

    updateHud(dt);

    renderer.render(scene, camera);
  }

  // --- Go --------------------------------------------------------------------

  syncDetail();

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // Clamped, so a tab that has been in the background does not resume with a
    // step that puts the ship a mile away.
    tick(Math.min(clock.getDelta(), 1 / 20));
  });

  note(
    restored
      ? `${presetName} — your own sky is back. E for the weather panel, C for the view.`
      : `${presetName} — the sea is running from ${WIND_FROM_DEG}°. Helm view; press C to change.`
  );

  // A handle for driving the whole thing from the console — and the only way to
  // watch it at all in a tab the browser has decided not to animate, since
  // step() does everything a frame does, rendering included.
  window.sea = {
    field,
    hull,
    ocean,
    spray,
    sky,
    rain,
    lens,
    foam,
    wake,
    cascade,
    scene,
    camera,
    renderer,
    panel,
    weather,
    applyEnvironment,
    get lighting() { return lighting; },
    get air() { return air; },
    get seaState() { return seaState; },
    setPreset,
    setLighting: applyPreset,
    /** `sea.setWeather({ rain: 0.7 })` — the panel's rain slider, by hand. */
    setWeather(next = {}) {
      Object.assign(weather, next);
      if (Object.keys(next).length) weather.label = 'Custom';
      applyEnvironment();
      return weather;
    },
    step(frames = 1, dt = 1 / 60) {
      for (let i = 0; i < frames; i++) tick(dt);
      return { time: field.time, position: hull.position, headingDeg: hull.headingDeg };
    },
  };
}

// --- Odds and ends -----------------------------------------------------------

/** Significant wave height: four standard deviations of the surface. */
function significantHeight(seaState) {
  let variance = 0;
  for (const w of seaState.waves) variance += w.amp * w.amp * 0.5;
  return 4 * Math.sqrt(variance);
}

/** Something is badly wrong: say so on the page rather than in the console. */
function fault(err) {
  console.error(err);
  const box = el('fault');
  box.innerHTML = `<div><b>The workbench did not start.</b>\n\n${
    (err?.message ?? String(err)).replace(/</g, '&lt;')
  }</div>`;
  box.classList.add('shown');
}
