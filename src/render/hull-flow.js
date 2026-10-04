// Local water displaced by the hull. Shared between the mesh displacement and
// the close surface normal, so detailed sea normals cannot erase the bow wave.
export const hullWaveChunk = /* glsl */ `
  // A speed-dependent pressure crest, bounded to 55 cm. The offshore wave
  // field remains the authority for seakeeping; this is local displaced water.
  float shipWave(vec3 world) {
    float speed = smoothstep(0.6, 7.0, abs(uHullSpeed));
    if (speed < 0.001) return 0.0;
    vec3 p = (uHullWorldToLocal * vec4(world, 1.0)).xyz;
    float len = uHullBounds.y - uHullBounds.x;
    float along = p.z - uHullBounds.x;
    if (along < 0.0 || along > len + 90.0 || abs(p.x) > 42.0) return 0.0;
    float bow = 0.0;
    if (along < len * 0.48) {
      float s = (0.5 + along / len * (uHullTexels.x - 1.0)) / uHullTexels.x;
      vec3 section = texture2D(uHullProfile, vec2(s, 0.5)).rgb;
      float v = (p.y - section.g) / max(0.01, section.b - section.g);
      if (v > 0.0 && v < 1.0) {
        float t = (0.5 + v * (uHullTexels.y - 1.0)) / uHullTexels.y;
        float gap = abs(p.x) - texture2D(uHullProfile, vec2(s, t)).r;
        // A pressure crest with a shallow outer hollow catches raking light;
        // both broaden with way through the water, independently of white foam.
        float crestWidth = 0.65 + speed * 0.58;
        bow = (exp(-pow((gap - 0.42) / crestWidth, 2.0))
          - 0.24 * exp(-pow((gap - 1.8) / 1.1, 2.0)))
          * smoothstep(0.0, 2.5, along) * (1.0 - smoothstep(len*0.12,len*0.48,along));
      }
    }
    float aft = max(0.0, p.z - uHullBounds.y);
    float spread = 0.9 + aft * 0.34;
    float wake = exp(-pow((abs(p.x)-spread) / (0.9+aft*0.027),2.0))
      * smoothstep(0.0, 5.0, aft) * exp(-aft/48.0);
    // Deep-water gravity-wave scale: lambda = 2*pi*U^2/g. These low,
    // unbroken transverse undulations read through moving reflections; the
    // persistent foam field separately remembers the actual curved track.
    float wavelength = clamp(6.283185 * uHullSpeed*uHullSpeed / 9.81, 4.0, 38.0);
    float transverse = cos(aft*6.283185/wavelength)
      * (1.0-smoothstep(spread*.45,spread,abs(p.x)))
      * smoothstep(2.0,9.0,aft) * exp(-aft/40.0);
    return speed * speed * (bow * 0.55
      + (wake * 0.22 + transverse * 0.075) * (1.0-smoothstep(55.0,90.0,aft)));
  }
`;

// Ship-local stream coordinates, measured in metres. +Z runs aft. Travel is an
// integrated distance, never time multiplied by the current speed: slowing or
// accelerating changes the flow continuously, including after a long voyage.
// Returns surface foam, submerged aeration, and a centimetre-scale ripple.
export const hullWashChunk = /* glsl */ `
  vec3 hullWash(vec3 hp, float gap, float hu, float footprint) {
    float drive = smoothstep(0.6, 6.0, abs(uHullSpeed));
    float ends = smoothstep(0.0, 0.035, hu) * (1.0 - smoothstep(0.78, 1.0, hu));
    float shoulder = exp(-pow((hu - 0.12) / 0.15, 2.0));
    float side = hp.x < 0.0 ? 17.3 : 51.7;
    float stream = hp.z - uHullTravel;
    // Long filaments stretch in the direction of flow, with different eddies
    // on each side. Their displacement shares the same travelling coordinates.
    float curl = noise(vec2(stream * 0.32, side)) - 0.5;
    vec2 q = vec2(gap * 3.0 + curl * 0.85, stream * 0.32 + side);
    float resolved = 1.0 - smoothstep(0.25, 0.85, footprint);
    float lace = mix(0.5, fbm(q), resolved);
    float packets = noise(vec2(stream * 0.21 + side, side * 2.0));
    float broken = smoothstep(0.24, 0.70, packets);
    float threads = smoothstep(0.43, 0.73, lace);
    float edge = 0.28 + shoulder * 1.30 + hu * 0.46 + curl * 0.22;
    float sheet = 1.0 - smoothstep(0.02, edge, max(0.0, gap));
    float fringe = exp(-max(0.0, gap) / (0.42 + hu * 0.90));
    // The shoulder breaks; farther aft there is mostly translucent water and
    // separate streaks, rather than a solid white outline all around the ship.
    float foam = (sheet * shoulder * (0.16 + 0.63 * threads)
      + fringe * threads * 0.60) * (0.22 + 0.78*broken) * drive * ends;
    float bubbles = exp(-max(0.0, gap) / (0.5 + hu * 0.7))
      * (0.22 + 0.78 * lace) * (0.3 + 0.7 * broken) * drive * ends * 0.16;
    float ripple = (lace - 0.5) * sheet * drive * ends * 0.060;
    return vec3(min(foam,0.86), bubbles, ripple);
  }
`;
