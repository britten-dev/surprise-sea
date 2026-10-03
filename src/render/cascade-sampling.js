// Reuse the spectral tile without stamping its 36 m period across the sea.
// Phase offsets are fixed to world-space cells, so moving the camera cannot
// swim the detail. All samples keep the spectrum's original wind direction.
export const cascadeSamplingChunk = /* glsl */ `
  vec2 cascadePhase(vec2 cell) {
    // A sine-free hash avoids loss of phase precision far from the origin.
    vec3 p = fract(vec3(cell.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.xx + p.yz) * p.zy) * 17.0;
  }

  vec3 sampleCascade(vec2 p) {
    // Three neighbouring vertices of an equilateral grid. Continuous weights
    // replace hard tile boundaries; squaring limits interference in the blend.
    vec2 q = vec2(p.x - p.y * 0.5773502692, p.y * 1.1547005384) * 1.7;
    vec2 cell = floor(q), f = fract(q);
    vec2 a, b, c;
    vec3 w;
    if (f.x + f.y <= 1.0) {
      a = cell; b = cell + vec2(1, 0); c = cell + vec2(0, 1);
      w = vec3(1.0 - f.x - f.y, f.x, f.y);
    } else {
      a = cell + vec2(1, 1); b = cell + vec2(0, 1); c = cell + vec2(1, 0);
      w = vec3(f.x + f.y - 1.0, 1.0 - f.x, 1.0 - f.y);
    }
    w *= w;
    w /= dot(w, vec3(1));

    // Derivatives belong to the continuous world coordinates, not the random
    // offsets. Implicit derivatives of those offsets would draw mipmap seams.
    vec2 dx = dFdx(p), dy = dFdy(p);
    vec3 sa = texture2DGradEXT(uCascade, p + cascadePhase(a), dx, dy).xyz;
    vec3 sb = texture2DGradEXT(uCascade, p + cascadePhase(b), dx, dy).xyz;
    vec3 sc = texture2DGradEXT(uCascade, p + cascadePhase(c), dx, dy).xyz;
    vec3 result = sa * w.x + sb * w.y + sc * w.z;
    // Averaging independent slopes otherwise flattens the water between cells.
    // Restore variance there; foam coverage keeps ordinary normalized weights.
    result.xy *= 0.9 * inversesqrt(dot(w, w));
    return result;
  }
`;
