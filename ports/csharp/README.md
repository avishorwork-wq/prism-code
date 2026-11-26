# Prism Code — C# (.NET 8) port

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
- **Prism Secure** (envelope v2, reads v1): AES-256-GCM payload locking with
  Argon2id (128 MiB, 3 passes — implemented from RFC 9106 in Argon2id.cs, no
  packages) or PBKDF2-SHA256 (600,000 rounds, built-in), and ECDSA P-256 /
  SHA-256 signing with the site's raw public key + JWK private key format and
  XXXX-XXXX fingerprints. Password unlock, signing, sign+lock, trusted
  fingerprints, passphrase generator, and the site's password strength meter.
  Byte-compatible with the live JS both directions (below).
- **CLI** and this README.

## Build

Requires the .NET 8 SDK (free).

```
dotnet build -c Release -o bin    # produces bin/prism
```

Free libraries only: .NET standard library only (System.IO.Compression for PNG) — no NuGet packages.

## Use

```
dotnet run -- encode --text "Hello & shalom" -o hello.png
# or the built binary:
bin/prism encode --file data.bin -o data.png --mode color --ecc 1
bin/prism encode --text "big" -o big.png --size 5 --scale 20
bin/prism decode hello.png
bin/prism decode data.png -o data.out
bin/prism capacity
bin/prism secure-genkey -o key.json
bin/prism secure-seal data.bin -o locked.bin --password 'pw' --kdf argon2id --sign-key key.json
bin/prism secure-open locked.bin -o data.out --password 'pw'
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

Prism Secure is verified against the live JS module (the same code the
website runs) on empty, text-with-`&`-and-Unicode, and 1 KB payloads:

- **68/68** C#-side checks: opens every JS-sealed envelope (PBKDF2, Argon2id,
  sign-only, lock+sign), fingerprint match, wrong-password /
  missing-password / tampered-ciphertext / tampered-signature rejection,
  v1-envelope reading, passphrase shape, strength meter.
- **24/24** JS-side checks: the live JS opens and trust-verifies every
  C#-sealed envelope.
- The Argon2id core matches the RFC 9106 test vector and 14 differential
  vectors against the site's own hash-wasm build, including the production
  128 MiB / 3-pass parameters.

## Features: verified issuers, big files in parts, tickets and cards

`PrismIssuers.cs`, `PrismParts.cs` and `PrismCards.cs`, byte-compatible
with prism-issuers.js, prism-parts.js and prism-cards.js (BCL only).
CLI verbs: `issuer IN.png|IN.bin [--list issuers.json]`,
`parts-split IN -o OUTDIR [--name NAME] [--size 2-5]`,
`parts-join PART.bin... [-o OUT]`, `card-build wifi|vcard|ticket ...`,
`card-parse IN.txt`. Part geometry and card payloads match the JS
bit-for-bit; splits and joins interoperate with the C and C++ ports and
with the live JS module.

## Not in this port (yet)

The phone-camera reading pipeline (glare, blur, perspective — that stays on
the website's reader pages) is being ported next.

## License

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
No warranty. See LICENSE.md in the Prism Code repo.
