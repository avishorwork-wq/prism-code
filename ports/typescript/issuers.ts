// Prism verified issuers for the TypeScript port: identify signed Prism
// Secure payloads and look the signer up in an issuer list, same semantics
// as prism-issuers.js and the C/Go/Kotlin/Rust/PHP/Ruby ports.

import * as fs from "fs";
import { p256Verify, fingerprint } from "./secure";

export interface IssuerId {
  signatureValid: boolean; fingerprint: string; encrypted: boolean;
  message: string; hasMessage: boolean;
}

// identify inspects decoded payload bytes. Returns null for plain or
// unsigned payloads. Never decrypts.
export function identify(b: Buffer): IssuerId | null {
  if (b.length < 5 + 65 + 64) return null;
  if (b[0] !== 0x50 || b[1] !== 0x53 || b[2] !== 0x43) return null; // "PSC"
  const v = b[3];
  if (v !== 1 && v !== 2) return null;
  if ((b[4] & 2) === 0) return null;
  const finish = b.length;
  const pub = Buffer.from(b.subarray(finish - 129, finish - 64));
  const sig = Buffer.from(b.subarray(finish - 64, finish));
  const body = b.subarray(0, finish - 129);
  const out: IssuerId = {
    signatureValid: p256Verify(pub, body, sig),
    fingerprint: fingerprint(pub),
    encrypted: (b[4] & 1) !== 0,
    message: "",
    hasMessage: false,
  };
  if (out.signatureValid && !out.encrypted && body.length >= 5) {
    const m = body.subarray(5);
    const s = m.toString("utf8");
    // valid UTF-8 round-trip check
    if (Buffer.from(s, "utf8").equals(Buffer.from(m))) {
      out.message = s;
      out.hasMessage = true;
    }
  }
  return out;
}

export interface Issuer { name: string; fingerprint: string }

// load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
export function load(path: string): Issuer[] {
  try {
    const data = fs.readFileSync(path);
    if (data.length > 1 << 20) return [];
    const doc = JSON.parse(data.toString("utf8"));
    if (typeof doc !== "object" || doc === null || !Array.isArray(doc.issuers)) return [];
    const out: Issuer[] = [];
    for (const it of doc.issuers) {
      if (typeof it === "object" && it !== null && it.name && it.fingerprint) {
        out.push({ name: String(it.name), fingerprint: String(it.fingerprint) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function normFp(fp: string): string {
  let b = "";
  for (const c of fp) {
    if (b.length >= 15) break;
    if (/[0-9a-fA-F]/.test(c)) b += c.toUpperCase();
  }
  return b;
}

// findIndex: normalized fingerprint match (case-insensitive, separators ignored).
export function findIndex(list: Issuer[], fingerprint_: string): number {
  const want = normFp(fingerprint_);
  for (let i = 0; i < list.length; i++) {
    if (normFp(list[i].fingerprint) === want) return i;
  }
  return -1;
}
