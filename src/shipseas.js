// The sea coming aboard.
//
// `hull.js` answers how she moves. This answers what that costs: where the
// water lands on her, when, and how hard. It is deliberately the *generic*
// half of ship–sea interaction — numbers and events, no geometry beyond
// points, no GL, nothing that knows what her deck looks like. A game hangs its
// own dressing on these: sheeted water running aft along the waist, the stern
// windows going in, the lee rail buried and everything on it adrift.
//
// The method is the same one the hull uses, for the same reason. A fixed set
// of points is fastened to her in her own frame — the stem head, the taffrail,
// a centre point on each stretch of deck, and a row down each rail — and every
// step they are carried through her position and attitude and asked one
// question: is there water above you, and how fast did it get there?
//
//   Height alone is not an event. Water standing an inch over the covering
//   board is a wet deck; the same inch arriving at four metres a second is a
//   sea, and it takes the boats with it. So the two violent events — the bow
//   plunge and the stern sea — key off *velocity*, and report their strength
//   as velocity squared, because that is what a moving mass of water actually
//   delivers. Stagnation pressure is ½ρv²; the energy carried is ½mv². Both
//   go as the square, so a sea arriving twice as fast does four times the
//   damage, and a payload linear in speed would flatter the small ones.
//
//   Shipping water and having shipped it are different states. The events are
//   edges — the moment she takes it aboard — but a game sheeting water off a
//   deck needs a level that rises when a sea lands and falls while it runs
//   out of the scuppers. That is `seas.water`, one scalar per region, drained
//   at a fixed rate forever, which is why the deck is still awash a couple of
//   seconds after the crest has gone by.
//
// Frames: hull-local, three.js's way round — bow down −Z, starboard +X, up +Y,
// origin at the waterline amidships. Points go through `hull.quaternion` and
// `hull.position` exactly as a mesh vertex would, so what this samples and
// what the eye sees are the same deck.
//
// Nothing here writes to the hull. It reads `position`, `quaternion`, `speed`
// and `headingRad`, and that is all; you can run two of these off one hull
// with different freeboards and neither will notice the other.

import { Vector3, MathUtils } from 'three';

const { clamp } = MathUtils;

// Scratch for the transform. One point is in flight at a time — every use is
// "put it in world space, read it, discard it" — which is the only rule that
// keeps a shared vector honest.
const _p = new Vector3();

/**
 * Every threshold the model uses, in one place, each one meaning something.
 * Anything not passed to `shipSeas` comes from here.
 *
 * The defaults are tuned against the presets, running dead downwind, so that
 * calm and breeze ship nothing whatever, a storm at working canvas buries the
 * bow now and then and is pooped rarely, and greybeards at full thrust keep
 * her decks wet and put a rail under when she broaches.
 */
export const SHIPSEAS_DEFAULTS = {
  // --- The deck -------------------------------------------------------------
  freeboard: 3.2, // deck above the waterline amidships, metres
  sheer: 1.2, // how much higher the deck stands at bow and stern
  railInset: 0.4, // the rail row sits this far inboard of the extreme beam
  railFrom: -0.34, // the row runs from this fraction of length (bow is −0.5)
  railTo: 0.34, // to this one. Not the very ends: those are bow and stern.
  railPoints: 5, // points in the row. Odd, so one of them is amidships.

  // --- Bow plunge -----------------------------------------------------------
  // She drives her stem into the back of the sea ahead. Being immersed at all
  // is already serious — the bow point stands `freeboard + sheer` above her
  // own waterline, so water over it means the forecastle has gone under — and
  // the closing speed is what separates a bow settling into a crest it is
  // riding from a bow meeting one that is coming the other way.
  plungeSpeed: 1.2, // m/s of closing, on top of immersion, before it counts
  plungeEnergyRef: 5, // m/s of closing that saturates `energy` at 1
  plungeCooldown: 1, // s. One plunge to a wave; the contract asks for ~1/s.
  plungeJumpLimit: 25, // m/s: faster than any sea. A hull picked up and put
  // down somewhere else — sea room wrapping in a demo — must not read as the
  // plunge of the century, and no wave in these presets moves half this fast.

  // --- Green water ----------------------------------------------------------
  greenWaterDepth: 0.2, // m of water over a deck point before a sea is shipped
  greenWaterRelease: 0.02, // m it must fall back to before that region can fire again
  greenWaterCooldown: 1.5, // s, so one long immersion is one sea and not thirty
  floodDepth: 1.6, // m of water over the deck that fills a region as fast as it can
  fillRate: 1.5, // units of `water` per second at that depth
  drainRate: 0.4, // units per second, always: the scuppers never stop

  // --- Stern sea ------------------------------------------------------------
  // The pooping event, with a force behind it. See the long note at the gate:
  // the wave has to be gaining on her or nothing comes over the taffrail.
  sternSeaDepth: 0.5, // m over the stern point before it counts
  sternSeaRelease: 0.02, // m the stern must dry back to before the next one
  sternClosing: 1, // m/s the crest must be overhauling her by
  sternForceRef: 22, // m/s of closing that saturates `force` at 1
  sternSeaCooldown: 2, // s

  // --- Rail dip -------------------------------------------------------------
  // Not an impact — a state. She lies over, the rail goes under and stays
  // under while she is down there, and everything on deck goes to leeward.
  railDipDepth: 0.05, // m: a rail point is under at this depth
  railDipFraction: 0.5, // this much of the row under, and the rail is in
  railClearFraction: 0.1, // it must come up this far before that side can fire again
  railDipCooldown: 1, // s
};

/**
 * Where the decks are, as fractions of her length measured from amidships:
 * −0.5 is the stem, +0.5 the sternpost. Three of them, end to end, spanning
 * the whole ship, because water that comes aboard has to come aboard
 * *somewhere* and a gap between regions would swallow it.
 */
export const DEFAULT_REGIONS = [
  { name: 'foredeck', from: -0.5, to: -1 / 6 },
  { name: 'waist', from: -1 / 6, to: 1 / 6 },
  { name: 'quarterdeck', from: 1 / 6, to: 0.5 },
];

/**
 * The sheer line: how much of the `sheer` allowance a station gets. Zero
 * amidships and one at either end, quadratically, which is close enough to the
 * curve a shipwright would strike and means the bow and stern points stand
 * highest — which is why she does not ship it over the middle of the waist
 * first.
 *
 * @param f  station as a fraction of length from amidships, −0.5..0.5.
 */
const sheerFactor = (f) => 4 * f * f;

/** −π..π, so "how far off the wave's heading" is a real difference. */
function wrapPi(a) {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/**
 * Bind a set of deck sample points to a hull and report what the sea does to
 * them.
 *
 * @param hull       a Hull, already updated for this frame. Read, never written.
 * @param waveField  the WaveField the hull was updated against, same instant.
 * @param options    SHIPSEAS_DEFAULTS overrides, plus:
 *                   `regions` — [{ name, from, to }] as fractions of length
 *                   from amidships (−0.5 bow … +0.5 stern). Default: the
 *                   foredeck / waist / quarterdeck of DEFAULT_REGIONS, which
 *                   span her from stem to sternpost.
 *                   `onBowPlunge`, `onGreenWater`, `onSternSea`, `onRailDip` —
 *                   the callbacks, also assignable on the returned object.
 * @returns the seas object: `update(dt)`, `water`, `depth`, `stats`,
 *          `regions`, `options`, `time`, `reset()`, and the four callbacks.
 */
export function shipSeas(hull, waveField, options = {}) {
  const o = { ...SHIPSEAS_DEFAULTS, ...options };

  // Her dimensions belong to the hull; taking them from anywhere else is how
  // the sample points and the mesh end up on different ships.
  const ship = hull?.options ?? {};
  const length = ship.length ?? 39;
  const beam = ship.beam ?? 9.9;

  const deckY = (f) => o.freeboard + o.sheer * sheerFactor(f);
  const station = (f, x = 0) => ({ x, y: deckY(f), z: f * length });

  // --- The points, laid out once ---------------------------------------------
  // They are fastened to her, so they never change in her own frame. All the
  // per-step work is the transform and the height query, and the height query
  // is the expensive half: `heightAt` inverts the Gerstner displacement, so
  // each point costs four passes over the wave table. Fifteen points is about
  // the most a frame should carry, which is why the rail rows are five and not
  // fifty — a rail is a straight line and five points read its immersion as
  // well as five hundred would.
  const bow = station(-0.5);
  const stern = station(0.5);

  const regionSpec = options.regions ?? DEFAULT_REGIONS;
  const regions = regionSpec.map((r) => {
    const centre = (r.from + r.to) / 2;
    return {
      name: r.name,
      from: r.from,
      to: r.to,
      centre,
      point: station(centre),
    };
  });

  const railN = Math.max(1, Math.round(o.railPoints));
  const railX = Math.max(0, beam / 2 - o.railInset);
  const railRow = (sign) => {
    const row = [];
    for (let i = 0; i < railN; i++) {
      const f =
        railN === 1
          ? (o.railFrom + o.railTo) / 2
          : o.railFrom + ((o.railTo - o.railFrom) * i) / (railN - 1);
      row.push(station(f, sign * railX));
    }
    return row;
  };
  const rails = { port: railRow(-1), starboard: railRow(1) };

  // --- What the caller sees ---------------------------------------------------
  // `water` is the continuous one: the level standing on each region, 0..1,
  // the scalar a game sheets water with. `depth` is the raw metres of water
  // above each point this instant, negative when it is dry, which is what a
  // HUD or a tuning session wants to look at; the rails report the deepest
  // point of their row. Regions share that map with `bow`, `stern`,
  // `portRail` and `starboardRail`, so a custom region should not take one of
  // those four names.
  const water = {};
  const depth = { bow: 0, stern: 0 };
  for (const r of regions) {
    water[r.name] = 0;
    depth[r.name] = 0;
  }
  depth.portRail = 0;
  depth.starboardRail = 0;

  const stats = { bowPlunge: 0, greenWater: 0, sternSea: 0, railDip: 0 };

  // --- Latches ---------------------------------------------------------------
  // Every event is an edge, and every edge needs two things: a latch that says
  // "this immersion has already been reported", released only when the point
  // dries out again, and a cooldown in seconds so a point hovering on its
  // threshold cannot chatter. The clock is our own accumulation of dt — no
  // Date, no frame counter — so a replay of the same steps is the same voyage.
  let time = 0;
  let prevBowDepth = null;
  let plungeAt = -Infinity;
  const greenArmed = {};
  const greenAt = {};
  for (const r of regions) {
    greenArmed[r.name] = true;
    greenAt[r.name] = -Infinity;
  }
  let sternArmed = true;
  let sternAt = -Infinity;
  const railArmed = { port: true, starboard: true };
  const railAt = { port: -Infinity, starboard: -Infinity };

  /**
   * Local point → world, through exactly the transform a mesh vertex gets:
   * her attitude, then her position. Nothing else in the library is allowed
   * to guess at this — if the deck the sea is compared against is not the
   * deck the eye sees, every number here is a lie.
   */
  function worldInto(local, out) {
    out.set(local.x, local.y, local.z);
    out.applyQuaternion(hull.quaternion);
    out.add(hull.position);
    return out;
  }

  /**
   * Metres of water above a point: positive is under, negative is dry
   * freeboard. `_p` is left holding the world position, so a caller wanting
   * the place as well as the depth can read it straight after.
   */
  function depthOf(local) {
    const w = worldInto(local, _p);
    return waveField.heightAt(w.x, w.z) - w.y;
  }

  const seas = {
    options: o,
    regions,
    water,
    depth,
    stats,

    /** The sample points in her own frame, for anything that wants to draw them. */
    points: { bow, stern, rails, regions: regions.map((r) => r.point) },

    /**
     * Any of those points in world space. A game putting a splash where the
     * sea came aboard wants the place as well as the event, and it must be the
     * *same* place this decided from — so it is handed out rather than
     * recomputed by eye.
     */
    toWorld(local, out = new Vector3()) {
      return worldInto(local, out);
    },

    onBowPlunge: options.onBowPlunge ?? null,
    onGreenWater: options.onGreenWater ?? null,
    onSternSea: options.onSternSea ?? null,
    onRailDip: options.onRailDip ?? null,

    get time() {
      return time;
    },

    /** Dry her out and forget everything — a change of weather, or a new run. */
    reset() {
      time = 0;
      prevBowDepth = null;
      plungeAt = -Infinity;
      sternArmed = true;
      sternAt = -Infinity;
      for (const r of regions) {
        water[r.name] = 0;
        depth[r.name] = 0;
        greenArmed[r.name] = true;
        greenAt[r.name] = -Infinity;
      }
      for (const side of ['port', 'starboard']) {
        railArmed[side] = true;
        railAt[side] = -Infinity;
      }
      depth.bow = 0;
      depth.stern = 0;
      depth.portRail = 0;
      depth.starboardRail = 0;
      for (const k of Object.keys(stats)) stats[k] = 0;
      return seas;
    },

    /**
     * One step, after `hull.update` and against the same advanced field, so
     * the deck and the water it is being compared with are the same instant.
     */
    update(dt) {
      if (!(dt > 0) || !hull || !waveField) return seas;
      time += dt;

      // --- The bow ----------------------------------------------------------
      // The gate is closing speed, and the closing speed is the plain rate of
      // change of the gap between the stem head and the water beneath it. That
      // one difference carries everything that matters: her own fall as she
      // comes off a crest, the face of the next sea rising, and the fact that
      // she is driving forward into a surface that is not flat. A bow that
      // pitches down into a trough it is running away from closes slowly and
      // gets wet; a bow that falls into a sea coming the other way closes at
      // the sum of both speeds, and that is the one that breaks things.
      const bowDepth = depthOf(bow);
      const bowX = _p.x;
      const bowZ = _p.z;
      depth.bow = bowDepth;
      const closing = prevBowDepth === null ? 0 : (bowDepth - prevBowDepth) / dt;
      prevBowDepth = bowDepth;

      if (
        bowDepth > 0 &&
        closing > o.plungeSpeed &&
        closing < o.plungeJumpLimit &&
        time - plungeAt >= o.plungeCooldown
      ) {
        plungeAt = time;
        stats.bowPlunge++;
        // Squared, because what arrives on the forecastle is a stagnation
        // pressure and a kinetic energy, and both of those go as v².
        const energy = clamp((closing / o.plungeEnergyRef) ** 2, 0, 1);
        if (seas.onBowPlunge) seas.onBowPlunge({ energy, x: bowX, z: bowZ });
      }

      // --- The stern --------------------------------------------------------
      // Water only comes aboard over a transom when the sea is overhauling
      // her. A ship running at wave speed sits in the crest and the crest goes
      // with her; a ship outrunning the sea has the water falling astern and
      // merely lifts to it. It is the *difference* between the wave's speed
      // along her course and her own that climbs the transom, so that
      // difference is both the gate and, squared, the force behind it — which
      // is also why a broach ends the pooping: beam-on, the wave's speed along
      // her heading is nothing at all.
      const sternDepth = depthOf(stern);
      depth.stern = sternDepth;

      const sea = waveField.sea;
      const off = wrapPi(hull.headingRad - sea.dominantTravelRad);
      const overhauling = sea.dominantSpeed * Math.cos(off) - (hull.speed ?? 0);

      if (
        sternArmed &&
        sternDepth > o.sternSeaDepth &&
        overhauling > o.sternClosing &&
        time - sternAt >= o.sternSeaCooldown
      ) {
        sternArmed = false;
        sternAt = time;
        stats.sternSea++;
        const force = clamp((overhauling / o.sternForceRef) ** 2, 0, 1);
        if (seas.onSternSea) seas.onSternSea({ force });
      } else if (sternDepth < o.sternSeaRelease) {
        sternArmed = true;
      }

      // --- The decks --------------------------------------------------------
      // The event is the rising edge — the sea coming aboard — and the scalar
      // is what it leaves behind. Filling is capped: past `floodDepth` the
      // deck is as full as a deck gets, and a deeper burial does not make it
      // fuller, only wetter for longer. Draining runs the whole time, so a
      // region under a long crest reaches a steady level rather than pinning
      // at one, and the instant the crest passes it starts running out.
      for (const r of regions) {
        const d = depthOf(r.point);
        depth[r.name] = d;

        if (
          greenArmed[r.name] &&
          d > o.greenWaterDepth &&
          time - greenAt[r.name] >= o.greenWaterCooldown
        ) {
          greenArmed[r.name] = false;
          greenAt[r.name] = time;
          stats.greenWater++;
          if (seas.onGreenWater) seas.onGreenWater({ region: r.name, depth: d });
        } else if (d < o.greenWaterRelease) {
          greenArmed[r.name] = true;
        }

        const fill =
          d > 0 ? clamp(d / o.floodDepth, 0, 1) * o.fillRate * dt : 0;
        water[r.name] = clamp(water[r.name] + fill - o.drainRate * dt, 0, 1);
      }

      // --- The rails --------------------------------------------------------
      // A rail dip is a length of rail under water, not a point: she can dig a
      // corner of the quarter into a passing crest all day without burying the
      // side. So the row votes, and the side is in when enough of it is under.
      // Per side, because a broach puts one rail down and lifts the other, and
      // a game hanging spray or lost gear off this wants to know which.
      for (const side of ['port', 'starboard']) {
        const row = rails[side];
        let under = 0;
        let deepest = -Infinity;
        for (const p of row) {
          const d = depthOf(p);
          if (d > deepest) deepest = d;
          if (d > o.railDipDepth) under++;
        }
        const fraction = under / row.length;
        depth[side === 'port' ? 'portRail' : 'starboardRail'] = deepest;

        if (
          railArmed[side] &&
          fraction >= o.railDipFraction &&
          time - railAt[side] >= o.railDipCooldown
        ) {
          railArmed[side] = false;
          railAt[side] = time;
          stats.railDip++;
          if (seas.onRailDip) seas.onRailDip({ side });
        } else if (fraction <= o.railClearFraction) {
          railArmed[side] = true;
        }
      }

      return seas;
    },
  };

  return seas;
}
