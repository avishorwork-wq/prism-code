# Native SLOW geometry and error-correction helpers

SLOW 0.2.35 keeps the original code layout, search order, payload checksum and JavaScript fallback. FAST 0.2.13 is unchanged.

`prism-spatial.c` implements the nearest-neighbor lookup used by SLOW. The JavaScript caller constructs the same KD tree, preserves point IDs and exclusions, and retains weighted interpolation in JavaScript. Compile for wasm32 with Zig cc, `-O3 -ffp-contract=off -fno-fast-math -nostdlib`, no entry point, exported memory and `__heap_base`, and a 16384-byte stack. The file has exported entry points in its source. The caller falls back to JavaScript if the module cannot be used.

`prism-rs-slow.c` performs independent Reed-Solomon arithmetic side by side. Compile for wasm32 with Zig cc, `-O3 -nostdlib`, no entry point, exported memory and `__heap_base`, and a 65536-byte stack. It does not weaken payload acceptance.

The reader and simulator embed their worker code and WebAssembly bytes. They need no runtime downloads. Their small unpacking wrapper includes fflate 0.8.2 under the MIT license, which is retained in each HTML file. The complete source package includes the vendored fflate source, its license and a reproducible esbuild 0.25.12 build.

Original 288-image set: both versions recover 278 exactly; shared-success median 147.45 to 139.3 ms. Independent 144-image set: both recover 140 exactly; median 157.95 to 143.4 ms. No lost or wrong payloads in those sets. Green supplied photo is slightly slower, 659.3 to 670.35 ms. Measurements are desktop tests, not phone-camera guarantees. See progress.html for tests and limits.
