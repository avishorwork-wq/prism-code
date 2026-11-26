# Prism Code — Swift port

A Swift port of the live Prism Code JavaScript encoder/decoder
(source of truth: `prism.html` in https://github.com/avishorwork-wq/prism-code).

Prism Code by Avi Shor. Free to use, with or without credit. See LICENSE.md in the repo above. No warranty.

**No package dependencies** — Swift standard library + Foundation + system zlib
(for PNG compression) only. Built and tested with Swift 6.0.3 on Linux (x86_64).

## What it does

- **Encoder**: payload bytes → Prism Code PNG. Colour mode (8 colours, 3 bits/cell,
  cyclic Gray) and black-and-white mode, all six grid sizes (21x24 to 113x130 cells),
  auto-size, 4 ECC levels (10/20/30/40% repair data), GF(256)/0x11D Reed-Solomon,
  triplicated CRC-4 header, payload CRC-32, seeded cell shuffle, PADK padding,
  filled-corner gap pattern, fixed ring and pilot cells — exactly as the live site.
- **Decoder**: reads a clean/perfect PNG produced by any conforming encoder
  (this port, the Python/Java ports, or the live site's creator) and returns the
  payload bytes with header CRC-4 and payload CRC-32 verification. This is not the
  full robust camera pipeline (no perspective/glare/blur recovery).
- **CLI** for both.

## Build and use

```sh
./build.sh        # or: swiftc -I shim -O -o prism Prism.swift main.swift -lz

./prism encode --text "Hello from Prism & friends" --out code.png
./prism encode --input payload.bin --out code.png --size 3 --ecc 2 --mode 1
./prism decode code.png --out payload.bin
```

Options: `--size -1..5` (-1 = auto grow to fit), `--ecc 0..3`, `--mode 0|1`
(0 = colour, 1 = black & white), `--radius N` (pixels per cell, default 12),
`--type 0|1`, `--logo 0|1`, `--symbols out.json` (dump the symbol grid, for testing).

As a library: `encode(_:size:ecc:mode:type:logo:)` → `Code`,
`render(_:_:)` → `(w, h, rgba)`, `writePNG`/`readPNG`, `decodePNG([UInt8])`,
`capacity(_:_:_:)`, `layout(_:)`.

## Compatibility with the live site (verified)

- The encoder produces **bit-identical symbol grids** to the live JS encoder
  (`Prism.encode`) on every tested case — same RS codewords, same shuffle,
  same padding, same header.
- PNGs written by this port **decode to identical bytes in the live JS reader**
  (`fast-reader.html` worker, run unmodified): verified across all six sizes in
  both colour and black-and-white modes.
- This decoder reads **PNGs created by the live JS creator** back to the exact
  original bytes on the full 40-case test set: empty, 1 byte, text with `&` and
  unicode, ~1 KB, and maximum-size payloads (4,561 bytes colour / 1,523 bytes
  black-and-white at size 5, ECC 0).

## Known limits (honest)

- The decoder expects a clean, axis-aligned PNG straight from an encoder. Photos
  of codes need the site's full reader.
- The live site's own readers currently fail on the largest multi-block clean
  codes (~1 KB+ at size 4-5) **even on PNGs the site's own creator made**; this
  decoder reads those fine. That is a live-reader limitation, not a port
  difference.
- `--logo 1` (centre-out data order) is a dormant upstream flag: the live UI
  never emits it and the live readers reject it. This port encodes and decodes
  it for completeness.
