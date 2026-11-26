#!/usr/bin/env python3
# Prism Secure CLI (Python port): seal / open / keygen / passphrase / strength.
# Mirrors the live site's prism-secure module semantics. Zero dependencies.
import argparse, json, sys
import prism_secure as ps

def main():
    ap = argparse.ArgumentParser(prog="prism_secure_cli")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("seal", "open"):
        p = sub.add_parser(name)
        p.add_argument("--in", dest="inp", required=True)
        p.add_argument("--out", dest="out", required=True)
        p.add_argument("--password")
        if name == "seal":
            p.add_argument("--kdf", choices=["argon2id", "pbkdf2"])
            p.add_argument("--argon-mem", type=int, help="Argon2id memory in KiB (site default 131072)")
            p.add_argument("--argon-t", type=int, help="Argon2id passes (site default 3)")
            p.add_argument("--signkey")
        else:
            p.add_argument("--trusted", help="comma-separated trusted fingerprints")
    p = sub.add_parser("keygen"); p.add_argument("--out", dest="out", required=True)
    sub.add_parser("passphrase")
    p = sub.add_parser("strength"); p.add_argument("--password", required=True)
    a = ap.parse_args()

    if a.cmd == "seal":
        data = open(a.inp, "rb").read()
        key = json.load(open(a.signkey)) if a.signkey else None
        out = ps.seal(data, password=a.password, sign_with=key, kdf=a.kdf,
                      argon_mem=a.argon_mem, argon_t=a.argon_t)
        open(a.out, "wb").write(out)
        print(json.dumps({"ok": True, "inBytes": len(data), "outBytes": len(out)}))
    elif a.cmd == "open":
        data = open(a.inp, "rb").read()
        trusted = a.trusted.split(",") if a.trusted else []
        r = ps.open(data, password=a.password, trusted_fingerprints=trusted)
        if r.get("bytes") is not None:
            open(a.out, "wb").write(r["bytes"])
        res = {"ok": r.get("bytes") is not None, "secure": r.get("secure"),
               "encrypted": r.get("encrypted"), "signed": r.get("signed"),
               "signatureValid": r.get("signatureValid"), "trusted": r.get("trusted", False),
               "needsPassword": r.get("needsPassword", False)}
        if r.get("signerFingerprint"): res["fingerprint"] = r["signerFingerprint"]
        if r.get("error"): res["error"] = r["error"]
        print(json.dumps(res))
        if r.get("bytes") is None: sys.exit(1)
    elif a.cmd == "keygen":
        k = ps.generate_signing_key()
        json.dump(k, open(a.out, "w"))
        print(json.dumps({"ok": True, "fingerprint": ps.fingerprint(bytes(k["publicKey"][str(i)] for i in range(65)))}))
    elif a.cmd == "passphrase":
        print(ps.generate_passphrase())
    elif a.cmd == "strength":
        print(json.dumps(ps.strength(a.password)))

if __name__ == "__main__":
    main()
