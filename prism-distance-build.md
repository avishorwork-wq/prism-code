# Prism scalar distance-scoring kernel

SLOW 0.1.8 embeds this arithmetic-only kernel in its worker. It has no payload input, photo, expected answer, header acceptance, RS or CRC code. It evaluates the same geometric warp and distance-field score as the JavaScript fallback. Compiled scoring is optional: if WebAssembly is unavailable, the existing JavaScript score runs.

## Build

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o distance.wasm prism-distance.c
```

The wrapper imports Math.sin and Math.cos, copies the existing float distance maps and double point/geometry values into module memory, and preserves operation order. It resets its caches for each new distance map. The binary is base64-embedded in the worker; there is no runtime network fetch or paid dependency. The original JavaScript is retained. The complete build backup includes the wrapper, reproducible source-injection script, scalar unit tests, paired reader tests and page packer.

3,000 sampled rank/cost values matched the JavaScript implementation bit for bit. Those sampled tests are not a proof for every floating-point input. The search scheduler separately chooses which existing fallback runs first using the existing image-frequency estimate. A long quick fit can extend the first dense-search allowance from 15 to 30 seconds. Candidate counts, later recovery searches, RS and CRC checks remain.
