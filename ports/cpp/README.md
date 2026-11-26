# Prism Code — C++ (C++17) port

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
  Byte-exact with the live JS encoder: the rendered PNGs are pixel-identical
  to the JS render geometry at the same scale.
- **Decoder**: reads a clean PNG produced by an encoder (this is not the
  robust phone-camera pipeline; on the website that is what the reader pages
  are for), verifies the header checksum, repairs with Reed-Solomon, verifies
  the payload CRC32, and returns the payload. Never shows a wrong result:
  if the checksum does not pass, it reports an error instead.
- **CLI** and this README.

## Build

Requires a C++17 compiler and zlib.

```
make        # produces ./prism
```

Free libraries only: C++ standard library + zlib for PNG compression.

## Use

```
./prism encode --text "Hello & shalom" -o hello.png
./prism encode --file data.bin -o data.png --mode color --ecc 1
./prism encode --text "big" -o big.png --size 5 --scale 20
./prism decode hello.png
./prism decode data.png -o data.out
./prism capacity
```

Encode reads `--text` (UTF-8, stored as a text code) or `--file` (raw bytes,
stored as a binary code). Decode prints text payloads, or writes raw payload
bytes with `-o`.

## Verified compatibility with the live JavaScript

Tested against the live Prism module extracted from the repo (the same code
the website runs), on 16 cases: empty, 1 byte, text with `&` and Unicode,
~1 KB binary, every explicit size 0-4, 40% repair data, and the maximum
payload per mode (4,561 bytes color / 1,523 bytes black-and-white):

- **16/16** codes made by this port are decoded to identical bytes by the live JS reader.
- **16/16** codes made by the JS encoder are decoded to identical bytes by this port.
- **16/16** self round trips (this port encodes, this port decodes).
- PNGs are **pixel-identical** to the JS render (48/48 across all three ports).
- Cross-language: every port decodes every other port's PNGs (18/18).

All tests are simulated/automated on clean images; nothing was tested on a
real phone camera. One note: for the largest black-and-white code the live
reader's full-page auto-detection sometimes needs more than its built-in
processing budget in headless tests; the same PNG decodes through the
reader's guided-geometry path (known size/position), and every other case
passes through the normal page path.

## Not in this port (yet)

The phone-camera reading pipeline (glare, blur, perspective — that stays on
the website's reader pages), Prism Secure (password lock / signing), file
splitting into parts, tickets/cards, and the contact-card input types. Those
are being ported next.

## License

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
No warranty. See LICENSE.md in the Prism Code repo.
