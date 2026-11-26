# Prism Code — Rust port

Prism Code by Avi Shor: https://avishorwork-wq.github.io/prism-code/
Source of truth: the live JavaScript in https://github.com/avishorwork-wq/prism-code

A port of the live Prism Code format: the color (and black-and-white) 2D code
that holds up to 4,561 bytes (color) / 1,523 bytes (black-and-white) at the
largest of its six sizes, with Reed-Solomon repair data and a CRC32 payload
checksum. A scan only shows a message when its checksum matches.

## What is in this port

- **Encoder**: payload bytes -> Prism code PNG. Color and black-and-white
  modes, all six sizes (21x24, 29x33, 41x47, 57x66, 81x94, 113x130 cells),
  all four repair levels (10/20/30/40%), automatic size selection, the same
  layout as the live version: fixed border ring, reference (pilot) cells,
  72 header cells, filled corner pattern, deterministic shuffle and padding.
  Byte-exact with the live JS encoder: same symbol grid on every input
  (verified by the cross-language compat suite, 40/40 cases).
- **Decoder**: reads a clean PNG produced by an encoder (this is not the
  robust phone-camera pipeline; on the website that is what the reader pages
  are for), verifies the header checksum, repairs with Reed-Solomon, verifies
  the payload CRC32, and returns the payload. Never shows a wrong result:
  if the checksum does not pass, it reports an error instead.
- **CLI** and this README.

## Build

Requires a recent stable Rust (built with rustc 1.100). One dependency: flate2 with its
pure-Rust backend (miniz_oxide) for PNG zlib - no C libraries, nothing else.

```
cargo build --release   # produces ./target/release/prism
```

## Use

```
./target/release/prism encode --text "Hello & shalom" --out hello.png
./target/release/prism encode --input data.bin --out data.png --mode 0 --ecc 1
./target/release/prism encode --text "big" --out big.png --size 5 --radius 20
./target/release/prism decode hello.png
./target/release/prism decode data.png --out data.out
./target/release/prism capacity
```

Flags: `--size -1..5` (-1 = auto grow to fit), `--ecc 0..3` (10/20/30/40%
repair data), `--mode 0|1` (0 = color, 1 = black & white), `--radius N`
(pixels per cell, default 12), `--type 0|1` (header type flag),
`--logo 0|1` (1 = centre-out data order, logo-friendly),
`--symbols J` (also write the symbol grid JSON, for testing).

## Verification

Verified against the live JavaScript encoder/reader with the cross-language
compat suite (Node oracle + the live fast-reader worker):

- Symbol grids identical to the JS encoder on all 40 cases (empty, 1-byte,
  text, 1 KB, max-size color and B&W payloads; every size; every ECC level;
  color and B&W; radii 8/12/20).
- Cross-decode: PNGs made by the JS, Python and Go encoders all decode
  correctly with the Go decoder, and Go-made PNGs decode correctly with the
  Python decoder and the live fast reader. (The live fast reader cannot read
  the largest perfectly-clean generator PNGs even when the JS encoder made
  them — a documented ceiling of the live reader, not of this port.)

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
See the repository LICENSE.md. No warranty.
