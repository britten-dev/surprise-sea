// The mesh the sea is drawn on.
//
// One draw call has to serve two jobs that pull in opposite directions: resolve
// the wave under the ship to a couple of metres, and still reach the horizon
// sixteen kilometres away. An even grid can do one or the other.
//
// So the grid is warped. Vertices are laid out evenly on [-1,1]² and then
// pushed out through |t|^exponent, which packs them at the centre and stretches
// them toward the rim. With the mesh kept centred on the camera, the dense part
// is always underfoot and the coarse part is always too far away for anyone to
// count the triangles. The wave shader samples in *world* space, so the mesh may
// slide about underneath the camera as much as it likes: the surface it
// describes stays exactly where it was, and the sliding is invisible.

import * as THREE from 'three';

/**
 * A square grid on [-1,1]² pushed through |t|^exponent, so spacing grows from
 * fine at the centre to coarse at the rim.
 *
 * @param n         vertices per side
 * @param halfSpan  metres from the centre to the rim
 * @param exponent  1 is an even grid; 2.2 is the shipped storm sea
 */
export function warpedGrid(n, halfSpan, exponent = 2.2) {
  const positions = new Float32Array(n * n * 3);
  const warp = (t) => Math.sign(t) * Math.pow(Math.abs(t), exponent) * halfSpan;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3;
      positions[o] = warp((i / (n - 1)) * 2 - 1);
      positions[o + 1] = 0;
      positions[o + 2] = warp((j / (n - 1)) * 2 - 1);
    }
  }

  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));

  // Generous, and deliberately not computed: every vertex moves in the shader,
  // so a fitted sphere would be a lie. The mesh is drawn unculled anyway.
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), halfSpan * 2);
  return geom;
}
