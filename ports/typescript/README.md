# Prism Code — TypeScript (Node) port

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
- **Prism Secure** (`secure.ts`): AES-256-GCM payload locking with Argon2id
  (128 MiB, 3 passes, a pure-TypeScript implementation since Node ships no
  Argon2) or PBKDF2-SHA256 (600,000 rounds), ECDSA P-256 / SHA-256 signing
  with deterministic RFC 6979 nonces, passphrase generator and
  password-strength meter. Byte-compatible with the C, Go, Kotlin, Rust, PHP
  and Ruby ports (same envelope, byte-identical signatures).
- **Big files in parts** (`parts.ts`): split a file of any size into PPT1
  parts (one Prism code each, ECC 30%) and reassemble them with whole-file
  CRC-32 verification.
- **Tickets and cards** (`cards.ts`): Wi-Fi, vCard 3.0 contact and
  expiring-ticket payload builders and parsers.
- **Verified issuers** (`issuers.ts`): identify a signed payload's signer
  fingerprint and look it up in an issuer list.
- **CLI** and this README. The core encoder/decoder is `prism.ts`; the
  feature commands load the other files from the same directory.

## Build

Requires Node 18+ and the TypeScript compiler. No runtime dependencies: PNG
zlib comes from node:zlib, AES-GCM/PBKDF2/HMAC from node:crypto, and Argon2id
is pure TypeScript (BigInt), so no native modules anywhere. @types/node is a
build-time-only dev dependency. Pre-compiled .js files are included, so
`tsc` is only needed after editing the sources.

```
npm install          # fetches @types/node (build time only)
tsc                  # produces prism.js, secure.js, parts.js, cards.js, issuers.js
```

A note on speed: the pure-TypeScript Argon2id takes about a minute per
128 MiB lock or unlock. That is normal for interpreted BigInt arithmetic;
the other ports use native Argon2 libraries. `--kdf pbkdf2` is instant and
fully compatible.

## Use

```
node prism.js encode --text "Hello & shalom" --out hello.png
node prism.js encode --input data.bin --out data.png --mode 0 --ecc 1
node prism.js encode --text "big" --out big.png --size 5 --radius 20
node prism.js decode hello.png
node prism.js decode data.png --out data.out
node prism.js capacity

# Prism Secure
node prism.js secure-genkey -o key.json
node prism.js secure-seal secret.txt --password "correct horse" -o locked.bin
node prism.js secure-seal note.txt --sign-key key.json -o signed.bin
node prism.js secure-seal doc.pdf --password "pw" --kdf pbkdf2 --sign-key key.json -o both.bin
node prism.js secure-open locked.bin --password "correct horse" -o secret.out
node prism.js secure-passphrase
node prism.js secure-strength "my password"

# Big files in parts
node prism.js parts-split video.mp4 -o parts/ --name "video.mp4" --size 4
# (encode each parts/part-NN.bin with: node prism.js encode --input ... --ecc 2 --mode 0)
node prism.js parts-join parts/part-*.bin -o video.mp4

# Tickets and cards
node prism.js card-build wifi --ssid "My Cafe" --sec WPA --pass "coffee123" -o wifi.txt
node prism.js card-build vcard --name "Ada Lovelace" --email ada@example.com -o card.txt
node prism.js card-build ticket --expiry-ms 1767225600000 --text "Admit one" -o ticket.txt
node prism.js card-parse wifi.txt

# Verified issuers
node prism.js issuer signed.bin --list issuers.json
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
- Cross-decode: PNGs made by the JS, Python, Go, Kotlin, Rust and TypeScript
  encoders all decode correctly with the TypeScript decoder, and
  TypeScript-made PNGs decode correctly with the Python/Go/Kotlin/Rust
  decoders and the live fast reader: 1404/1410 cross-decode checks pass, the
  6 failures all being the documented ceiling where the live fast reader
  cannot read the largest perfectly-clean generator PNGs even when the JS
  encoder made them - not a port bug.
- Prism Secure / parts / cards / issuers: the 51-check cross-language
  feature battery passes against the C reference implementation (envelope
  bytes, deterministic signatures byte-identical with C, Argon2id and
  PBKDF2 locks opened both ways, part splits reassembled across
  implementations, card payload round-trips, issuer fingerprint lookups).
  The pure-TypeScript Argon2id is additionally verified byte-for-byte
  against libargon2 (argon2-cffi) at multiple parameter sets.

These are automated compatibility tests only: nothing here has been exercised
against a live phone-camera reader.

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
See the repository LICENSE.md. No warranty.
