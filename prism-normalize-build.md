# Prism illumination normalization kernel

FAST 0.2.6 embeds this scalar C/WebAssembly image module, retaining the original JavaScript normalization when WebAssembly is unavailable. It computes the same channel histograms, 2-percent cutoff, separable maximum filter with edge replication, contrast scaling, and ties-to-even clamped byte output. The original search, deadlines, geometry scoring, header, RS and CRC acceptance remain. No image or expected payload is embedded.

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o image.wasm prism-normalize.c
```

The combined image module retains the 0.2.4 distance fields. Morphology and smoothing exports are included in its source, but only normalization and distance fields are used by this release. The wrapper grows and reuses scratch memory, copies RGBA input, and returns a separate output image. The standalone HTML embeds the binary without runtime fetch. There is no SIMD, fast math or parallel reduction. Tests matched 72,556,716 sampled normalized bytes exactly, including random, blank, alternating and gradient images and dimensions up to 2048x1024. Samples are not proofs for every possible input. Whole-read paired results and limits are on progress.html. The backup contains the builder, wrappers and tests.
