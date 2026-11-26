# Prism Code — Java 17 port

A Java port of the live Prism Code JavaScript encoder/decoder
(source of truth: `prism.html` in https://github.com/avishorwork-wq/prism-code).

Prism Code by Avi Shor. Free to use, with or without credit. See LICENSE.md in the repo above. No warranty.

**Standard library only** (`javax.imageio` for PNG) — no dependencies. Java 17+.

## What it does

- **Encoder**: payload bytes → Prism Code PNG. Colour mode (8 colours, 3 bits/cell,
  cyclic Gray) and black-and-white mode, all six grid sizes (21x24 to 113x130 cells),
  auto-size, 4 ECC levels (10/20/30/40% repair data), GF(256)/0x11D Reed-Solomon,
  triplicated CRC-4 header, payload CRC-32, seeded cell shuffle, PADK padding,
  filled-corner gap pattern, fixed ring and pilot cells — exactly as the live site.
- **Decoder**: reads a clean/perfect PNG produced by any conforming encoder
  (this port, the Python port, or the live site's creator) and returns the payload
  bytes with header CRC-4 and payload CRC-32 verification. This is not the full
  robust camera pipeline (no perspective/glare/blur recovery).
- **CLI** for both.

## Build and use

```bash
javac -d out src/Prism.java src/PrismCli.java

# make a code (auto size, 20% repair data, colour)
java -cp out PrismCli encode --text "Hello from Prism & friends" --out code.png

# raw bytes, fixed size, black & white (mode 1), 30% repair data
java -cp out PrismCli encode --input payload.bin --out code.png --size 3 --ecc 2 --mode 1

# decode back to bytes
java -cp out PrismCli decode code.png --out payload.bin
```

Options: `--size -1..5` (-1 = auto grow to fit), `--ecc 0..3`, `--mode 0|1`
(0 = colour, 1 = black & white), `--radius N` (pixels per cell, default 12),
`--type 0|1`, `--logo 0|1`, `--symbols out.json` (dump the symbol grid, for testing).

As a library: `Prism.encode(byte[], size, ecc, mode, type, logo)`,
`Prism.render(code, radius)` → `BufferedImage`, `Prism.decodeImage(BufferedImage)`,
`Prism.capacity(size, ecc, mode)`, `Prism.layout(size)`.

## Compatibility with the live site (verified)

- The encoder produces **bit-identical symbol grids** to the live JS encoder
  (`Prism.encode`) on every tested case — same RS codewords, same shuffle,
  same padding, same header.
- PNGs written by this port **decode to identical bytes in the live JS reader**
  (`fast-reader.html` worker, run unmodified) on every case the live reader can
  handle (see limits below).
- This decoder reads **PNGs created by the live JS creator** back to the exact
  original bytes, on the full test set: empty, 1 byte, text with `&` and
  unicode, ~1 KB, and maximum-size payloads (4,561 bytes colour / 1,523 bytes
  black-and-white at size 5, ECC 0).

## Known limits (honest)

- The decoder expects a clean, axis-aligned PNG straight from an encoder. Photos
  of codes need the site's full reader.
- The live site's own readers currently fail on the largest multi-block clean
  codes (e.g. ~1 KB+ at size 4-5) **even on PNGs the site's own creator made**;
  this decoder reads those fine. That is a live-reader limitation, not a port
  difference.
- `--logo 1` (centre-out data order) is a dormant upstream flag: the live UI
  never emits it and the live readers reject it. This port encodes and decodes
  it for completeness.
- CLI `--text` with non-ASCII needs a UTF-8 locale (`LANG=C.UTF-8`); `--input`
  files are always raw bytes.
