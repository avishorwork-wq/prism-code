# Prism Code — Python 3 port

A Python port of the live Prism Code JavaScript encoder/decoder
(source of truth: `prism.html` in https://github.com/avishorwork-wq/prism-code).

Prism Code by Avi Shor. Free to use, with or without credit. See LICENSE.md in the repo above. No warranty.

**Pure standard library** — no dependencies, no network. Python 3.8+.

## What it does

- **Encoder**: payload bytes → Prism Code PNG. Colour mode (8 colours, 3 bits/cell,
  cyclic Gray) and black-and-white mode, all six grid sizes (21x24 to 113x130 cells),
  auto-size, 4 ECC levels (10/20/30/40% repair data), GF(256)/0x11D Reed-Solomon,
  triplicated CRC-4 header, payload CRC-32, seeded cell shuffle, PADK padding,
  filled-corner gap pattern, fixed ring and pilot cells — exactly as the live site.
- **Decoder**: reads a clean/perfect PNG produced by any conforming encoder
  (this port, the Java port, or the live site's creator) and returns the payload
  bytes with header CRC-4 and payload CRC-32 verification. This is not the full
  robust camera pipeline (no perspective/glare/blur recovery).
- **CLI** for both.

## Usage

```bash
# make a code (auto size, 20% repair data, colour)
python3 prism.py encode --text "Hello from Prism & friends ☕" --out code.png

# raw bytes, fixed size, black & white, 30% repair data
python3 prism.py encode --input payload.bin --out code.png --size 3 --ecc 2 --mode bw

# decode back to bytes (writes to stdout or --out)
python3 prism.py decode code.png --out payload.bin
```

Options: `--size -1..5` (-1 = auto grow to fit), `--ecc 0..3` (10/20/30/40% repair),
`--mode color|bw`, `--radius N` (pixels per cell, default 12), `--type 0|1`,
`--logo 0|1`, `--symbols out.json` (dump the symbol grid, for testing).

As a library: `import prism` → `prism.encode(payload, size=-1, ecc=1, mode=0)`,
`prism.encodePNG(payload, r=12, ...)`, `prism.decodePNG(png_bytes)`,
`prism.capacity(size, ecc, mode)`, `prism.layout(size)`.

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

## Prism Secure (password lock + maker signatures)

`prism_secure.py` + `prism_secure_cli.py` port the live site's Prism Secure module
(`prism-secure.html`). **Zero dependencies** — Argon2id (RFC 9106), AES-256
(FIPS-197), GCM (SP 800-38D) and ECDSA P-256 (FIPS 186-5) are implemented from
scratch; Blake2b/PBKDF2 use `hashlib`. Wire-compatible v2 and legacy v1.

```bash
python3 prism_secure_cli.py keygen --out maker.json
python3 prism_secure_cli.py seal --in file --out file.psc --password 'S3cret' [--kdf argon2id|pbkdf2] [--argon-mem KiB --argon-t N] [--signkey maker.json]
python3 prism_secure_cli.py open --in file.psc --out file --password 'S3cret' [--trusted FING-ERPR-INTS,...]
python3 prism_secure_cli.py passphrase          # 140-bit random passphrase
python3 prism_secure_cli.py strength --password '...'
```

Defaults mirror the site (Argon2id 128 MiB / 3 passes). Pure-Python Argon2id at
those parameters takes ~80 s per derivation; pass `--argon-mem 8192 --argon-t 1`
(lowest parameters the live reader accepts) or `--kdf pbkdf2` when speed matters.
Key files accept this port's JSON and the live site's `{"publicKey":{...},"privateJwk":{...}}`.

### Compatibility with the live JS module (verified)

- 18/18 cross-compat checks, both directions against the unmodified JS module:
  Argon2id, PBKDF2, sign-only, encrypt+sign, wrong-password/tamper/forgery
  rejection, keygen interchange both ways, empty payload, v1 legacy, passphrase
  format, non-ASCII passwords (NFKC parity).
- Full site parameters proven both directions: JS-sealed (128 MiB/t=3) opens in
  Python; Python-sealed (128 MiB/t=3) opens in JS.
- AES-GCM matches NIST vectors; Argon2id matches hash-wasm byte for byte;
  `strength()` matches the JS heuristic exactly on the tested set.
