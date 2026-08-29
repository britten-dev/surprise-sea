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
// The sky must tone-map exactly as the water does, or the horizon carries a
// faint step where the two gradings meet.
import { agxToneMapChunk } from '../src/render/ocean.js';

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

// Three ways to light the same sea, lifted from the reference game's Southern
// Ocean moods. `sunIntensity` and `ambient` are for the scene lights the block
// hull needs; createOcean reads only the keys it knows.
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
    water: { deep: 0x1a252c, crest: 0x334e4b, foam: 0xb9bfc2 },
  },
];

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

  const sky = createSky();
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
    fogDensity: 1.05e-4,
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
        applyLighting((lightIndex + 1) % LIGHTS.length);
        note(`Light: ${LIGHTS[lightIndex].label}`);
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
    // The air takes its wind from the sea state, so it would follow along by
    // itself; building it anew starts the gusts fresh with the new weather.
    air = new AirOverSea(field);

    note(`Sea state: ${name} — Hs ${significantHeight(seaState).toFixed(1)} m`);
  }

  function applyLighting(index) {
    lightIndex = index;
    const light = LIGHTS[index];
    ocean.setLighting(light);
    spray.setLighting(light);
    sky.set(light);
    sunLight.color.setHex(light.sunColour);
    sunLight.intensity = light.sunIntensity;
    sunLight.position.set(...light.sunDir).normalize().multiplyScalar(1000);
    ambientLight.color.setHex(light.skyHaze);
    ambientLight.groundColor.setHex(light.water.deep);
  }

  applyLighting(0);

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
    speed: el('vSpeed'), heading: el('vHeading'), surf: el('vSurf'),
    rudder: el('vRudder'), authority: el('vAuthority'), risk: el('vRisk'),
    helmFill: el('helmFill'), authFill: el('authFill'),
    riskFill: el('riskFill'), riskTrack: el('riskTrack'), log: el('log'),
  };

  let textClock = 0;

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
    ui.light.textContent = LIGHTS[lightIndex].label;
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
    // the eye is and how far above the water it has got.
    spray.update(dt, camera.position);
    updateHud(dt);

    renderer.render(scene, camera);
  }

  // --- Go --------------------------------------------------------------------

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // Clamped, so a tab that has been in the background does not resume with a
    // step that puts the ship a mile away.
    tick(Math.min(clock.getDelta(), 1 / 20));
  });

  note(`${presetName} — the sea is running from ${WIND_FROM_DEG}°. Helm view; press C to change.`);

  // A handle for driving the whole thing from the console — and the only way to
  // watch it at all in a tab the browser has decided not to animate, since
  // step() does everything a frame does, rendering included.
  window.sea = {
    field,
    hull,
    ocean,
    spray,
    scene,
    camera,
    renderer,
    get air() { return air; },
    get seaState() { return seaState; },
    setPreset,
    setLighting: applyLighting,
    step(frames = 1, dt = 1 / 60) {
      for (let i = 0; i < frames; i++) tick(dt);
      return { time: field.time, position: hull.position, headingDeg: hull.headingDeg };
    },
  };
}

// --- Odds and ends -----------------------------------------------------------

/**
 * A gradient dome, adapted from the reference game's sky: two overlapping
 * ramps rather than one, because a single smoothstep leaves a visible seam
 * across the sky exactly where the eye is already looking. Its haze colour is
 * the colour the ocean fogs to, so the sea dissolves into the sky instead of
 * ending at a line.
 */
function createSky() {
  const uniforms = {
    uTop: { value: new THREE.Color(0x67737f) },
    uHaze: { value: new THREE.Color(0xa6abab) },
    uSunDir: { value: new THREE.Vector3(0.35, 0.3, 0.65) },
    uSunColour: { value: new THREE.Color(0xdfe2de) },
    uGlare: { value: 0.3 },
    uExposure: { value: 1.0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        // Strip translation from the view matrix so the dome never moves
        // relative to the camera, then force depth to the far plane.
        mat4 rotOnly = mat4(mat3(viewMatrix));
        vec4 pos = projectionMatrix * rotOnly * vec4(position, 1.0);
        gl_Position = pos.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHaze;
      uniform vec3 uSunDir;
      uniform vec3 uSunColour;
      uniform float uGlare;
      uniform float uExposure;

      varying vec3 vDir;

      ${agxToneMapChunk}

      void main() {
        vec3 d = normalize(vDir);

        float t = smoothstep(-0.16, 0.55, d.y);
        float t2 = smoothstep(-0.02, 0.16, d.y);
        vec3 col = mix(uHaze, uTop, t * 0.72 + t2 * 0.28);

        // A broad, gentle glow rather than a disc — calmer, and it never glares.
        float sun = max(0.0, dot(d, normalize(uSunDir)));
        col += uSunColour * pow(sun, 16.0) * 0.16 * uGlare;
        col += uSunColour * pow(sun, 220.0) * 0.40 * uGlare;

        gl_FragColor = vec4(agxToneMap(col, uExposure), 1.0);

        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';

  return {
    mesh,
    set(light) {
      uniforms.uTop.value.setHex(light.skyTop);
      uniforms.uHaze.value.setHex(light.skyHaze);
      uniforms.uSunDir.value.set(...light.sunDir).normalize();
      uniforms.uSunColour.value.setHex(light.sunColour);
      uniforms.uGlare.value = light.glare ?? 0.4;
      uniforms.uExposure.value = light.exposure ?? 1.0;
    },
  };
}

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
