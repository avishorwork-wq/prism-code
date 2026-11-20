Scalar autocorrelation kernel used by SLOW 0.2.9. No payload data or acceptance logic. Compile with: python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o corr.wasm prism-autocorrelation.c
200,000 sampled values matched JavaScript exactly. JavaScript fallback remains.
