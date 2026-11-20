# Prism monochrome scalar geometry kernel

SLOW 0.2.2 embeds this C kernel as WebAssembly. It contains scalar grayscale residuals, Gaussian blur, the original finite-difference damped optimizer, an added analytic-derivative optimizer and the same 12-by-12 solver. It contains no payload acceptance, RS/CRC logic, photograph, expected payload or answer lookup.

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o mono.wasm prism-mono.c
```

The wrapper imports Math.sin, Math.cos and a deadline predicate. Images and point arrays are cached within a fit, and caches reset for each new fit. The original finite-difference fit runs first with the previous four-second budget. The analytic fit is a separate additional attempt with a three-second budget. Existing later searches remain. If module initialization fails, the original JavaScript implementation runs and the added attempt is skipped. The offline HTML embeds the binary and needs no runtime fetch.

Sampled tests matched 205,439 optimizer/blur values and the optimizer costs and early-stop iterations against the original JavaScript. A separate 72,000 sampled analytic-derivative check against central differences had maximum absolute difference below 1e-7. These are sampled checks, not proofs for all floating-point inputs. Analytic derivatives intentionally change the search trajectory and are not bit-identical to finite differences. Added unsuccessful fits can make difficult inputs slower. The build backup includes the wrapper, builders, source templates and tests.
