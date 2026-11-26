# Prism Code — Ruby port

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
- **Prism Secure** (`prism_secure.rb`): AES-256-GCM payload locking with
  Argon2id (128 MiB, 3 passes) or PBKDF2-SHA256 (600,000 rounds), ECDSA
  P-256 / SHA-256 signing with deterministic RFC 6979 nonces, passphrase
  generator and password-strength meter. Byte-compatible with the C, Go,
  Kotlin, Rust and PHP ports (same envelope, byte-identical signatures).
- **Big files in parts** (`prism_parts.rb`): split a file of any size into
  PPT1 parts (one Prism code each, ECC 30%) and reassemble them with
  whole-file CRC-32 verification.
- **Tickets and cards** (`prism_cards.rb`): Wi-Fi, vCard 3.0 contact and
  expiring-ticket payload builders and parsers.
- **Verified issuers** (`prism_issuers.rb`): identify a signed payload's
  signer fingerprint and look it up in an issuer list.
- **CLI** and this README. The core encoder/decoder is `prism.rb`; the
  feature commands load the other files from the same directory.

## Requirements

Ruby 3.0+ with the standard zlib, json and openssl libraries. No gems, no
native build tools, no GD/ImageMagick (the PNG writer/reader is built in,
on top of zlib). For Argon2id locks the system libargon2 is loaded via
fiddle (present by default on most Linux installs); without it,
`--kdf pbkdf2` still works and Argon2id-locked payloads can still be
opened once libargon2 is available.

## Use

```
ruby prism.rb encode --text "Hello & shalom" --out hello.png
ruby prism.rb encode --input data.bin --out data.png --mode 0 --ecc 1
ruby prism.rb encode --text "big" --out big.png --size 5 --radius 20
ruby prism.rb decode hello.png
ruby prism.rb decode hello.png --out data.out
ruby prism.rb capacity

# Prism Secure
ruby prism.rb secure-genkey -o key.json
ruby prism.rb secure-seal secret.txt --password "correct horse" -o locked.bin
ruby prism.rb secure-seal note.txt --sign-key key.json -o signed.bin
ruby prism.rb secure-seal doc.pdf --password "pw" --kdf pbkdf2 --sign-key key.json -o both.bin
ruby prism.rb secure-open locked.bin --password "correct horse" -o secret.out
ruby prism.rb secure-passphrase
ruby prism.rb secure-strength "my password"

# Big files in parts
ruby prism.rb parts-split video.mp4 -o parts/ --name "video.mp4" --size 4
# (encode each parts/part-NN.bin with: ruby prism.rb encode --input ... --ecc 2 --mode 0)
ruby prism.rb parts-join parts/part-*.bin -o video.mp4

# Tickets and cards
ruby prism.rb card-build wifi --ssid "My Cafe" --sec WPA --pass "coffee123" -o wifi.txt
ruby prism.rb card-build vcard --name "Ada Lovelace" --email ada@example.com -o card.txt
ruby prism.rb card-build ticket --expiry-ms 1767225600000 --text "Admit one" -o ticket.txt
ruby prism.rb card-parse wifi.txt

# Verified issuers
ruby prism.rb issuer signed.bin --list issuers.json
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
- Cross-decode: PNGs made by the JS, Python, Go, Kotlin, Rust, TypeScript,
  PHP and Ruby encoders all decode correctly with the Ruby decoder, and
  Ruby-made PNGs decode correctly with the other decoders and the live fast
  reader: 2512/2518 cross-decode checks pass across the whole eight-language
  suite, the 6 failures all being the documented ceiling where the live fast
  reader cannot read the largest perfectly-clean generator PNGs even when
  the JS encoder made them - not a port bug.
- Prism Secure / parts / cards / issuers: the 51-check cross-language
  feature battery passes against the C reference implementation (envelope
  bytes, deterministic signatures, Argon2id and PBKDF2 locks opened both
  ways, part splits reassembled across implementations, card payload
  round-trips, issuer fingerprint lookups).

These are automated compatibility tests only: nothing here has been exercised
against a live phone-camera reader.

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
See the repository LICENSE.md. No warranty.
