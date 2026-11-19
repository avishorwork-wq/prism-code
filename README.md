# Prism Code

An experimental hexagonal optical-code format, implemented as **one offline HTML file** with a text/raw-byte encoder, PNG export, photo/camera reader, debug overlay, and seeded self-tests. No libraries, CDN, analytics, or runtime network calls.

## Open it

Open `index.html` for the browser app, or download `prism.html` and open it locally. Camera access requires HTTPS or localhost. Photo upload works without camera permission and is the primary tested path. A Prism Code is **not a QR code**, and ordinary QR readers cannot read it.

## Build status, 19 November 2026

**Working preview. Full robustness validation is still in progress.** See `progress.html` for the latest published checkpoint. Do not treat synthetic results as real-print guarantees.

- Reed-Solomon: 3,000/3,000 seeded mixed-error and erasure trials passed within the correction bound.
- Clean images: 24/24 passed, six sizes and both palettes, with known and automatically detected geometry.
- Initial tuning sample only, 20 images per level: geometry/noise 20/20; color cast/lighting 20/20; 10% occlusion plus glare 9/20. These are NOT the required 500-trial final measurements.
- Actual browser file input: exported PNG uploaded to the reader and recovered a multiline Hebrew/English payload exactly.
- Mobile layouts checked at 320 and 390 px, desktop at 1280 px. Camera start/stop tested with a synthetic browser camera, not a physical phone.
- No physical laser/inkjet, glossy/matte, outdoor/indoor, or half-shadow print tests have been performed. Density gain over QR is unmeasured.

## Format

Pointy-top odd-row-offset hexagonal cells; 8-color cyclic Gray coding or 1-bit black/white. Six grids from 21×24 to 113×130 cells. An orientation gap, asymmetric ring, known pilots, triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D Reed-Solomon blocks, and payload CRC-32 follow the supplied design.

The reader uses connected components and a convex hull, total-least-squares edge fits, projective geometry with coordinate-descent refinement, linear-RGB/Lab calibration, pilot mesh refinement, soft bit likelihoods, an erasure ladder, and optional three-second camera-frame fusion. Decoded contents are displayed as text, never executed or automatically opened. CRC-32 checks integrity, not authenticity.

### Implementation notes and tuning

- Detection computes saturation and brightness in sRGB. Applying the saturation threshold to linear RGB rejected tinted paper in early tests.
- A paper-brightness floor and a low-fill fallback allow solid black areas and sparse black/white patterns. The hull simplification threshold is 0.7 detection pixels, not 1.5% of the perimeter, to preserve the orientation-gap edges at large grid sizes.
- Near-white glare threshold is tuned to 0.90 linear RGB rather than 0.97 to handle noisy highlights; near-white contaminated known cells are excluded from the color fit.
- Header paper remains a valid symbol and is not blindly erased as glare. The reader restores specified zero padding using the public header length before RS correction.
- The specified coarse erasure ladder is tried first. On checksum failure a denser ladder and bounded candidate combinations are tried. No result is displayed without a payload CRC pass.
- Camera frames are capped at 1280×720. Uploaded images preserve up to 2048 px on the long side / 2.4 megapixels so the largest codes are not always below the four-pixel cell-radius limit.
- An 8191-byte header length does not mean all 8191 bytes fit. Actual payload capacity is calculated from the cell roles, palette, and ECC setting. Size 1 at color/ECC 1 fits 212 payload bytes; size 5 fits 4071.

## Self-test

Open **Test** and run 500 images per level. The same decoder used by uploaded photos receives only the distorted image, not ground-truth corners. Save the JSON report for seeds, constants, timing, failure stages, and reproduction parameters. The defaults use size 1, color mode, ECC 2, and random 40–100 byte payloads. Separate clean checks cover all six sizes and both palettes.

Each distortion trial includes 0–360° rotation, projective tilt up to 35°, sine curl up to 0.3 cell, 6–10 px cell radius, Gaussian blur sigma 0.5–1.5 px, and Gaussian noise sigma 0.02. The second level adds independent channel gains/offsets and a ±40% lighting-gradient parameter. The third adds a disk covering 10% of the code area and a saturated glare blob. Targets are 99%, 95%, and 90%, not guarantees.

## Files and development

- `prism.html`: standalone app, including all algorithms, UI, and tests.
- `index.html`: identical deployment entry point.
- `progress.html`: dated build and validation status.

Vanilla ES2020 JavaScript and Canvas 2D. No build step is needed to run the app. Source is readable inside `prism.html`.
