# Prism Code — Go port

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
- **Prism Secure** (envelope v2, reads v1): AES-256-GCM payload locking with
  Argon2id (128 MiB, 3 passes) or PBKDF2-SHA256 (600,000 rounds), and
  ECDSA P-256 / SHA-256 signing with RFC 6979 deterministic nonces and the
  site's raw public key + JWK private key format and XXXX-XXXX fingerprints.
  Password unlock, signing, sign+lock, trusted fingerprints, passphrase
  generator, and the site's password strength meter. Byte-compatible with
  the live JS and the C port both directions; deterministic signatures are
  byte-identical to the C port's. Password note: passwords are used as
  their UTF-8 bytes; the website normalizes Unicode (NFKC) first, so
  non-ASCII passwords should be in composed (NFC) form - what keyboards
  produce. ASCII passwords are unaffected.
- **Big files in parts** (PPT1): split a file across several codes and reassemble
  with whole-file CRC-32 verification, byte-compatible with prism-parts.js
  and the C port (joins each other's parts both ways).
- **Tickets and cards**: Wi-Fi, contact card (vCard 3.0) and expiring ticket
  payload builders and parsers (card-build / card-parse), payload-compatible
  with prism-cards.js - builds are byte-identical to the C port.
- **Verified issuers**: identify signed Prism Secure payloads, verify the
  signature and look the signer's fingerprint up in an issuers.json list,
  same semantics as prism-issuers.js.
- **CLI** and this README.

## Build

Requires Go 1.21+. Dependencies: golang.org/x/crypto (argon2, pbkdf2) only;
AES-GCM, SHA-256, HMAC and the P-256 curve use the standard library.

```
go build -o prism-go .
```

## Use

```
./prism-go encode --text "Hello & shalom" --out hello.png
./prism-go encode --input data.bin --out data.png --mode 0 --ecc 1
./prism-go encode --text "big" --out big.png --size 5 --radius 20
./prism-go decode hello.png
./prism-go decode data.png --out data.out
./prism-go capacity
./prism-go secure-genkey -o key.json
./prism-go secure-seal data.bin -o locked.bin --password 'pw' --kdf argon2id --sign-key key.json
./prism-go secure-open locked.bin -o data.out --password 'pw'
./prism-go secure-passphrase
./prism-go secure-strength --password 'pw'
./prism-go parts-split big.bin -o parts/ --name big.bin --size 3
./prism-go parts-join parts/part-*.bin -o big.out
./prism-go card-build wifi --ssid 'Home Net' --pass 'pw' --hidden
./prism-go card-build vcard --name 'Avi Shor' --phone +972500000000
./prism-go card-build ticket --expiry-ms 1893456000000 --text 'Front row'
./prism-go card-parse card.txt
./prism-go issuer signed.bin --list issuers.json
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
