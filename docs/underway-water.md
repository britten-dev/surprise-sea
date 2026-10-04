# Water displaced by a sailing hull — 4 October 2026

The local pressure-wave renderer and the persistent foam history serve different
purposes. `shipWave` displaces the surface and modifies its reflected light;
the wake buffer retains churn at world positions along the course actually
sailed. Neither is a source of thrust or an input to the CPU seakeeping model.

NUS CRISP's [ship-wake research](https://crisp.nus.edu.sg/~research/shipwakes/shipwakes.htm)
distinguishes transverse/divergent gravity waves from turbulent track water,
and describes how their reflected highlights depend on viewing direction.
The [bow-wave experiments by Dong et al.](https://www.cambridge.org/core/journals/journal-of-fluid-mechanics/article/abs/on-the-structure-of-bow-waves-on-a-ship-model/DED99D70A407568AF896AC439FBA187C)
examine the attached liquid sheet, crest and downstream flow. These references
guide the separation of visible effects; they do not provide measured Surprise
amplitudes, foam coverage or spray rates.

The bow pressure crest is capped at 0.55 m before the speed and longitudinal
envelopes. At ten knots it is about 0.35 m at its strongest. Its shallow outer
trough and stern wave affect both vertex displacement and per-pixel normals.
Previously the fragment normal correction stopped at the stern, removing the
trailing wave from the detailed water's lighting. Transverse undulations use
the deep-water length scale `2*pi*speed^2/g` (about 17 m at ten knots), tapering
smoothly out by 90 m. This is a bounded visual approximation for steady sailing,
not a CFD solver or a history-based solution of the turning wave field.

Side wash uses integrated distance through the water, keeping the existing
phase through speed changes. It now has broader broken filaments, more shoulder
foam and mild aeration. Port and starboard use different eddies. All underway
wash fades without way, and its direct hull contribution still goes to zero at
the stern to avoid a bright stationary patch beneath the counter.

The browser host retains wake foam for 8.5 seconds per half-life in a 192 m
field. It uses small, overlapping stamps that develop over 1.5 seconds, rather
than abrupt white splats. A smooth transition across the first nine metres
around the counter keeps the stronger history from forming a broad bright
patch beneath the stern. The phone host now has a 256-square wake-only field;
it continues to omit the large ocean-wide crest history. This also allows
phones to retain the actual curved sailed track. The library's stamper defaults
are unchanged. Fine intermittent bow droplets respond to forward speed as well
as wave encounters; the host retains its existing bounded particle pool.

Compiled-shader checks prove aft advection by integrated metres, speed response,
different port/starboard patterns and zero underway wash at rest. The 30 fps
stern tests retain their visible-flash pixel limits; the average pixel-delta
allowance accounts for the newly visible pressure waves over a larger area.
Production captures compare 0, 5 and 10 knots from bow, side and astern, on
desktop Chromium and phone-sized WebKit. These rendering checks do not claim
physical-phone frame rates or measured hydrodynamic accuracy.
