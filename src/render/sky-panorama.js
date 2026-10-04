import { Vector4 } from 'three';

// The caller owns the texture. The dome, reflection cube and ocean all sample it
// in linear light, rotated so the photographed sun agrees with the scene light.
export function skyPanoramaUniforms() {
  return {
    uSkyPhoto: { value: null },
    uSkyPhotoAmount: { value: 0 },
    uSkyPhotoConfig: { value: new Vector4(0.5, 0, 1, 0) },
  };
}

export function setSkyPanorama(uniforms, texture, { sunU = 0.5, sunElevation = 0, intensity = 1 } = {}) {
  uniforms.uSkyPhoto.value = texture ?? null;
  uniforms.uSkyPhotoAmount.value = texture ? 1 : 0;
  uniforms.uSkyPhotoConfig.value.set(sunU, sunElevation, intensity, uniforms.uSkyPhotoConfig.value.w);
}
