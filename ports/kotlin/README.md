# Prism Code — Kotlin (JVM) port

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
- **Prism Secure**: envelope v2 (reads v1). AES-256-GCM payload locking with
  Argon2id (128 MiB, 3 passes; Bouncy Castle) or PBKDF2-SHA256 (600,000
  rounds), and ECDSA P-256 / SHA-256 signing with RFC 6979 deterministic
  nonces and P1363 r||s signatures, byte-compatible with the live site's
  prism-secure.html JS: deterministic signatures come out byte-identical to
  the C port for the same key and message.
- **Big files in parts** (PPT1): split a file into per-part payloads (each
  its own code at ecc 30%), reassemble with per-part and whole-file CRC-32
  checks, same layout and error messages as prism-parts.js.
- **Tickets and cards**: Wi-Fi, contact card (vCard 3.0) and expiring ticket
  payload builders and parsers (card-build / card-parse), payload-compatible
  with prism-cards.js - builds are byte-identical to the C port.
- **Verified issuers**: identify signed Prism Secure payloads, verify the
  signature and look the signer's fingerprint up in an issuers.json list,
  same semantics as prism-issuers.js.
- **CLI** and this README.

## Build

Requires a JDK 11+, the Kotlin compiler (kotlinc 1.9+), and the Bouncy Castle
provider jar (bcprov-jdk18on, for Argon2id; AES-GCM and HMAC come from the
JDK). Get bcprov from Maven Central:

https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.78.1/bcprov-jdk18on-1.78.1.jar

```
kotlinc -cp bcprov-jdk18on-1.78.1.jar -include-runtime \
  -d prism-kotlin.jar Prism.kt PrismSecure.kt PrismParts.kt PrismCards.kt PrismIssuers.kt Main.kt
```

## Use

```
java -cp "prism-kotlin.jar:bcprov-jdk18on-1.78.1.jar" MainKt encode --text "Hello & shalom" --out hello.png
java -cp "prism-kotlin.jar:bcprov-jdk18on-1.78.1.jar" MainKt decode hello.png
```

Encode flags: `--size -1..5` (-1 = auto grow to fit), `--ecc 0..3`
(10/20/30/40% repair data), `--mode 0|1` (0 = color, 1 = black & white),
`--radius N` (pixels per cell, default 12), `--type 0|1` (header type flag),
`--logo 0|1` (1 = centre-out data order, logo-friendly),
`--symbols J` (also write the symbol grid JSON, for testing).

Everything below is run the same way (`java -cp "...jar:bcprov.jar" MainKt <command>`):

```
secure-genkey -o key.json                       make a P-256 signing key
secure-seal IN --password P [--kdf argon2id|pbkdf2] [--sign-key key.json] -o OUT
secure-open IN [--password P] [-o OUT]          unlock / verify
secure-passphrase                               random 7x4 passphrase
secure-strength [PASSWORD]                      estimate password strength
parts-split IN -o OUTDIR [--name NAME] [--size 0..5]
parts-join PART... [-o OUT]
card-build wifi --ssid S [--sec WPA|WEP|nopass] [--pass P] [--hidden]
card-build vcard --name N [--org O] [--title T] [--phone P] [--email E] [--url U] [--addr A] [--note N]
card-build ticket --expiry-ms MS --text TEXT
card-parse IN
issuer IN.png|IN.bin [--list issuers.json]
capacity
```

## Verification

Verified against the live JavaScript encoder/reader with the cross-language
compat suite (Node oracle + the live fast-reader worker), and feature-for-feature
against the C port as the reference implementation:

- Symbol grids identical to the JS encoder on all 40 cases (empty, 1-byte,
  text, 1 KB, max-size color and B&W payloads; every size; every ECC level;
  color and B&W; radii 8/12/20).
- Cross-decode: PNGs made by the JS, Python, Go, Rust and Kotlin encoders all
  decode correctly with the Kotlin decoder, and Kotlin-made PNGs decode
  correctly with the Python/Go decoders and the live fast reader. (The live
  fast reader cannot read the largest perfectly-clean generator PNGs even
  when the JS encoder made them - a documented ceiling of the live reader,
  not of this port.)
- Prism Secure: lock (Argon2id and PBKDF2) opens byte-identically in both
  directions against the C port; sign verifies in both directions; lock+sign
  works in both directions; deterministic signatures are byte-identical to C
  for the same key and message; wrong passwords fail with an error, never a
  wrong payload.
- Parts: 100 KB file split and reassembled both directions against C
  (121 parts at size 3), whole-file check passing.
- Cards: Wi-Fi (with hidden flag and escaping), vCard and ticket builds are
  byte-identical to C; parses agree.
- Issuers: fingerprint of a signed payload matches C exactly; issuers.json
  lookup (with separator/case-insensitive fingerprint matching) finds the
  issuer name.

These are automated compatibility tests only: nothing here has been exercised
against a live phone-camera reader.

Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
See the repository LICENSE.md. No warranty.
