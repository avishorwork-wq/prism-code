# Prism scalar geometry kernel

The offline SLOW reader embeds this kernel as WebAssembly, with the existing JavaScript implementation retained as fallback. It contains arithmetic only, not header, RS, CRC, UTF-8 or payload acceptance logic. It contains no input photos, reference payloads or lookup answers.

## Build

The release was compiled with the free Zig C compiler, no C standard library or runtime dependency:

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o geometry.wasm prism-geometry.c
```

The JavaScript wrapper supplies `Math.sin` and `Math.cos` as imports, copies float image channels and double geometry data into the module's own memory, and calls `blur`, `analytic`, `residual` and `normal`. Kernel operations preserve addition order and do not use fast-math approximations, parallel reductions or SIMD. The exported heap base supports scratch-buffer allocation; each new fit resets its cache. The binary is base64-embedded in the reader's worker source, so offline operation does not fetch a separate .wasm file. The unminified wrapper is retained in the build backup; the shipped HTML includes the complete embedded worker and JavaScript fallback.

256,368 sampled scalar comparisons against the prior JavaScript residuals, derivatives and blur pixels matched bit for bit. That test is not a proof for every possible floating-point input. Full clean, supplied-photo, corrupted-data, fresh-payload swap, no-WebAssembly fallback and mobile-layout checks are recorded on the progress page.
