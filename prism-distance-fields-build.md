# Prism scalar distance-map kernel

FAST and SLOW 0.2.4 embed this C kernel as WebAssembly. It implements the original forward/backward chamfer transforms and inverse-field adjustment. It contains no image identification, payload, header, RS/CRC, expected answer, photograph or lookup logic. The original JavaScript implementation remains as fallback.

```sh
python -m ziglang cc -target wasm32-freestanding -O3 -ffp-contract=off -fno-fast-math -nostdlib -Wl,--no-entry -Wl,--export=__heap_base -Wl,--export-memory -Wl,--strip-all -o distance.wasm prism-distance-fields.c
```

The wrapper copies nine float maps into scratch memory, calls the transform, and copies the maps back. Storage grows only when needed and is reused on later calls. Pixel classification and palette conversion stay in JavaScript. No fast math, SIMD or parallel reduction is used. The constants, scan order, intermediate double arithmetic and float storage remain the same. The module is base64-embedded; the HTML has no runtime dependency or network fetch.

17,737,686 sampled map values matched the original exactly, including random, white, black and checker images, small or awkward shapes and large SLOW resolutions. These sampled checks do not prove equality for all inputs. Whole-reader paired tests, failures, timeouts and limits are recorded on the progress page. Faster field construction is not a new recovery claim. The backup includes builders, source templates, wrappers and tests.
