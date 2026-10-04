# Sunset and photographic skies

`createSky` and `createOcean` accept `lighting.sunset: 1` for a low-sun sky with
layered procedural clouds and a half-degree solar disc. Set it to `0` when
returning to an ordinary lighting profile. `setLighting` merges partial updates.

Both objects also expose:

```js
sky.setPanorama(texture, { sunU, sunElevation, intensity });
ocean.setPanorama(texture, { sunU, sunElevation, intensity });
```

The texture is a **linear HDR equirectangular panorama** with the same row
orientation as Three.js HDRLoader. `sunU` locates the photographed sun horizontally
(0..1); `sunElevation` is its elevation in radians. The shader aligns that point
with `lighting.sunDir`, without rolling the horizon. The evening grade and
`lighting.skyRain` (0..1, desaturation/dimming) are applied before tone mapping.
This texture is used only in the sunset profile; the caller retains ownership.
Passing `null` restores the procedural fallback and removes the panorama sampler
from the ocean shader. Rebuild the sky reflection after changing the panorama.

The visible sky, raw HDR reflection cube and water fallback use identical sampling
and grading. The cube remains linear and is tone-mapped only when finally drawn.
With a full-strength reflection cube the ocean skips the per-pixel procedural
cloud calculation. Existing profiles and callers need no panorama or new options.

Panoramas are static; this feature does not simulate moving cloud volumes, an
astronomical location, or a day/night cycle. Source selection, download, lifetime
and device resolution are the host application's responsibilities.

## Moonlight

`lighting.moon` enables a procedural full moon (0..1 visibility, default 0).
The existing `sunDir` and `sunColour` describe the dominant celestial light,
so they are used for the moon in this mode as well. The disc, halo and cloud
attenuation are identical in the visible sky, raw reflection cube and water
fallback. `glare` controls the existing surface glint. Set `moon: 0` explicitly
when switching back to another profile; partial updates keep the current value.
The default directional gradient API remains backward compatible.
