# Prism scalar geometry scoring kernel

FAST 0.2.5 embeds this C kernel alongside the 0.2.4 distance-field transforms. The original JavaScript scoring remains as fallback. The kernel scores the same known cells and header groups, with the original reduction order, interpolation, clipping, trimmed score and double arithmetic. No expected payload, photograph or lookup is embedded. No search attempt, deadline or acceptance threshold changes.

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o score.wasm prism-distance.c
```

The module imports Math.sin and Math.cos, copies maps and point lists into reusable scratch storage, and is embedded as base64 without runtime network access. The JavaScript wrapper retains one budget operation per known/header cell before calling the scalar score. The final whole-read deadline still rejects late successes. There is no fast math or parallel reduction. 6,000 sampled rank/trimmed scores were bit-exact across 3,000 geometry cases; this is sampled evidence, not a proof for all inputs. Whole-reader results and limits are on progress.html. The source backup contains the builder, wrappers and regression scripts.
