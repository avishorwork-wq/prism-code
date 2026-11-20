# Prism scalar geometry and optimizer kernel

SLOW 0.1.9 embeds this arithmetic-only C kernel as WebAssembly, with the previous JavaScript geometry and optimizer kept as fallback. It includes residuals, analytic derivatives, normal-equation sums, Gaussian blur, the existing damped optimizer loop and its 12-by-12 Gaussian elimination solver. It contains no payload acceptance, RS or CRC logic, input photograph, expected payload or answer lookup.

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o geometry.wasm prism-geometry.c
```

The wrapper imports Math.sin and Math.cos, preserves scalar arithmetic and reduction order, and resets its image/point caches for each fit. Residual trigonometric constants are cached within a call. The optimizer runs the same candidate counts, iteration limits, damping changes and stopping conditions without repeated JavaScript copies of internal arrays. The binary is base64-embedded in the offline worker; no runtime fetch or paid dependency is required. If compilation/initialization is unavailable, JavaScript does the work.

Two hundred sampled randomized optimizer fits matched 2,600 parameter/cost values and early-stop iteration results bit for bit. Separate geometry tests matched 256,368 sampled residual/derivative/blur values. This is not a proof for every floating-point input. The build backup includes the wrapper, reproducible builder and paired regression tests. SLOW 0.1.8 distance-scoring source and its build notes remain available separately.
