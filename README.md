# Prism Code

An experimental hexagonal optical-code format, implemented as **one offline HTML file** with a text/raw-byte encoder, PNG export, photo/camera reader, debug overlay, and seeded self-tests. No libraries, CDN, analytics, or runtime network calls.

## Stress simulator

Open [the simulator](simulator.html) for true cylindrical/bent-sheet 3D projection, yaw/pitch/rotation, backgrounds and foreground, glare, lighting/tint, blur/noise and lens distortion. Original hex-cell look and corner notch only, no added finder markers. All effects run locally. Download PNGs, settings and seeded batch reports.

Random scenes default to an ideal-geometry readability check: actual rendered pixels are rectified with the true simulator mesh, then the ordinary ECC/CRC decoder must recover the original bytes. Excluded samples are counted. Hand-adjusted scenes can fail the check. A failed check means unverified, not proven unreadable; a pass is not physical-camera validation. The normal reader gets pixels only, not scene parameters.

## Open it

Open `index.html` for the browser app, or download `prism.html` and open it locally. Camera access requires HTTPS or localhost. Photo upload works without camera permission and is the primary tested path. A Prism Code is **not a QR code**, and ordinary QR readers cannot read it.

## Experimental 0.1.3 reader update

The original marker-free encoder and notch are unchanged. A fallback now tries channel-normalized detection, alternate hull quadrilaterals, fitted nonlinear geometry and internal-cell mesh refinement after the legacy reader fails. The reader does not receive simulator geometry. Recovery hypotheses with an empty payload are not accepted by this fallback. It has a bounded processing budget.

Paired two-seed samples,60 varied-text scenes per category: perspective + cast improved from40/60 to59/60; cylinder from6/60 to27/60. Earlier30-scene busy-background checks stayed30/30; mixed severe stress stayed0/30. These small research samples are not oracle-filtered and are not substitutes for500-case or real-camera validation.75 negative images were rejected; this is not proof of zero false positives. All12 distinct clean size/palette checks and the exact supplied green photo still pass. Further work is ongoing.

## Build 0.1.2 update, 19 November 2026

The exact green-tinted, blurred, curved supplied JPEG now reads automatically as `Hello from Prism!` (17 bytes, size 0, ECC 3, payload CRC pass). The reader detects the supplied generator's seeded bit-whitening variant, fits its row-wise curve/skew model from known cells, and checks the payload. The export fallback is for the full exported canvas only; cropped photos and arbitrary curved camera views are not covered.

A 60-export generator matrix initially passed 15/15 clean, 15/15 light effects, 15/15 medium effects, and 12/15 strongest effects. The updated 500-image-per-level rerun is complete: geometry/noise500/500; cast/lighting491/500;10% occlusion/glare243/500; independent hard-color/perspective194/500; independent cylinder14/500. These baseline numbers are not oracle-filtered. No general curved-surface reliability claim is made.

Empty-payload guesses now need a direct high-confidence header and strong pattern match; zero padding is not restored for empty payloads. Random-image tests reject all 20 checked negatives. A per-image processing bound limits expensive failed hypotheses.

## Previous build 0.1.1 measured baseline, 19 November 2026

**Experimental working build. The synthetic run is finished; the damage target is not met.** See `progress.html` for the latest published checkpoint. Do not treat synthetic results as real-print guarantees.

- Reed-Solomon: 5,000/5,000 seeded mixed-error and erasure trials passed within the correction bound in the final run (plus 3,000 earlier unit trials).
- Clean images: all 24 distinct checks passed in each of five batches, 120/120 total. Six sizes and both palettes, with known and automatically detected geometry.
- Full 500-image measurements per level: geometry/noise **500/500 (100%)**; color cast/lighting **491/500 (98.2%)**; 10% occlusion plus glare **243/500 (48.6%)**. The first two targets were reached on these synthetic inputs. The 90% occlusion target was **not** reached. See `test-report.json` for measured failures and seeds.
- Actual browser file input: exported PNG uploaded to the reader and recovered a multiline Hebrew/English payload exactly. The Android-emulated test taps the native file control, waits for a file chooser, selects a PNG, and verifies the result.
- Mobile layouts checked at 320 and 390 px, desktop at 1280 px. Camera start/stop tested with a synthetic browser camera, not a physical phone.
- No physical laser/inkjet, glossy/matte, outdoor/indoor, or half-shadow print tests have been performed. Density gain over QR is unmeasured.

## Format

Pointy-top odd-row-offset hexagonal cells; 8-color cyclic Gray coding or 1-bit black/white. Six grids from 21×24 to 113×130 cells. An orientation gap, asymmetric ring, known pilots, triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D Reed-Solomon blocks, and payload CRC-32 follow the supplied design.

The reader uses connected components and a convex hull, total-least-squares edge fits, projective geometry with coordinate-descent refinement, linear-RGB/Lab calibration, pilot mesh refinement, soft bit likelihoods, an erasure ladder, and optional three-second camera-frame fusion. Decoded contents are displayed as text, never executed or automatically opened. CRC-32 checks integrity, not authenticity.

### Android photo-picker fix (build 0.1.1)

The normal Choose file input no longer forces `capture=environment`. Android camera capture is a separate option, so saved photo/file selection is not routed directly to the camera. Native file-button touch targets are larger; selected filename and loading status are visible; an in-flight camera scan or self-test no longer silently drops a selected photo. The exact cause on the reporting physical Android device is still unconfirmed. Emulated Android Chrome picker-click and decoding tests pass.

### Implementation notes and tuning

- Detection computes saturation and brightness in sRGB. Applying the saturation threshold to linear RGB rejected tinted paper in early tests.
- A paper-brightness floor and a low-fill fallback allow solid black areas and sparse black/white patterns. The hull simplification threshold is 0.7 detection pixels, not 1.5% of the perimeter, to preserve the orientation-gap edges at large grid sizes.
- Near-white glare threshold is tuned to 0.90 linear RGB rather than 0.97 to handle noisy highlights; near-white contaminated known cells are excluded from the color fit.
- Header paper remains a valid symbol and is not blindly erased as glare. The reader restores specified zero padding using the public header length before RS correction.
- A bounded soft-header candidate search uses the repeated header likelihoods; every candidate still requires header CRC-4, valid geometry fields, capacity bounds, and final payload CRC-32.
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
- `test-report.json`: final measured synthetic results and failure seeds.

Vanilla ES2020 JavaScript and Canvas 2D. No build step is needed to run the app. Source is readable inside `prism.html`.
