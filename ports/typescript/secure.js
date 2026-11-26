"use strict";
// Prism Secure (envelope v2, reads v1) for the TypeScript port: AES-256-GCM
// payload locking with Argon2id (128 MiB, 3 passes, pure TypeScript) or
// PBKDF2-SHA256 (600,000 rounds), and ECDSA P-256 / SHA-256 signing with
// RFC 6979 deterministic nonces and P1363 r||s signatures, byte-compatible
// with the live site's prism-secure.html JS and the C/Go/Kotlin/Rust/PHP/Ruby
// ports.
//
// Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
// normalization first; this port does not ship a Unicode normalizer, so
// non-ASCII passwords should already be in composed (NFC) form. ASCII
// passwords are unaffected.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PBKDF2_ITER = exports.ARGON2_P = exports.ARGON2_T = exports.ARGON2_MEM = void 0;
exports.sha256 = sha256;
exports.pbkdf2 = pbkdf2;
exports.blake2b = blake2b;
exports.hPrime = hPrime;
exports.argon2id = argon2id;
exports.rfc6979K = rfc6979K;
exports.p256Sign = p256Sign;
exports.p256Verify = p256Verify;
exports.p256Keygen = p256Keygen;
exports.fingerprint = fingerprint;
exports.genkey = genkey;
exports.deriveKey = deriveKey;
exports.seal = seal;
exports.isSecure = isSecure;
exports.open = open;
exports.passphrase = passphrase;
exports.strength = strength;
exports.b64url = b64url;
exports.b64urlDec = b64urlDec;
exports.saveKey = saveKey;
exports.loadKey = loadKey;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
exports.ARGON2_MEM = 131072;
exports.ARGON2_T = 3;
exports.ARGON2_P = 1;
exports.PBKDF2_ITER = 600000;
const FLAG_ENC = 1;
const FLAG_SIG = 2;
const HEAD2 = 4 + 1 + 1 + 6 + 16 + 12;
const HEAD1 = 4 + 1 + 16 + 12 + 4;
const MAGIC = Buffer.from("PSC", "latin1");
function sha256(d) {
    return crypto.createHash("sha256").update(d).digest();
}
function pbkdf2(pw, salt, iter, keyLen) {
    return crypto.pbkdf2Sync(pw, salt, iter, keyLen, "sha256");
}
// ------------------------------------------------------------- blake2b (pure TS)
// Needed for Argon2's variable-length hash H' (node only ships blake2b-512).
const BMASK = (1n << 64n) - 1n;
const M32 = (1n << 32n) - 1n;
const B2_IV = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const B2_SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];
function rotr64(x, n) {
    return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & BMASK;
}
// blake2b hash, digest 1..64 bytes, no key.
function blake2b(data, outLen) {
    const h = B2_IV.slice();
    h[0] ^= 0x01010000n ^ BigInt(outLen);
    const bytes = new Uint8Array(data);
    const blocks = Math.max(1, Math.ceil(bytes.length / 128));
    let t = 0;
    for (let b = 0; b < blocks; b++) {
        const last = b === blocks - 1;
        const chunk = new Uint8Array(128);
        const off = b * 128;
        const n = Math.min(128, bytes.length - off);
        if (n > 0)
            chunk.set(bytes.subarray(off, off + n));
        t += n;
        const m = new Array(16);
        for (let i = 0; i < 16; i++) {
            let w = 0n;
            for (let j = 7; j >= 0; j--)
                w = (w << 8n) | BigInt(chunk[i * 8 + j]);
            m[i] = w;
        }
        const v = h.concat(B2_IV.slice());
        v[12] ^= BigInt(t) & BMASK;
        if (last)
            v[14] ^= BMASK;
        const G = (a, bb, c, d, x, y) => {
            v[a] = (v[a] + v[bb] + x) & BMASK;
            v[d] = rotr64(v[d] ^ v[a], 32);
            v[c] = (v[c] + v[d]) & BMASK;
            v[bb] = rotr64(v[bb] ^ v[c], 24);
            v[a] = (v[a] + v[bb] + y) & BMASK;
            v[d] = rotr64(v[d] ^ v[a], 16);
            v[c] = (v[c] + v[d]) & BMASK;
            v[bb] = rotr64(v[bb] ^ v[c], 63);
        };
        for (let r = 0; r < 12; r++) {
            const s = B2_SIGMA[r];
            G(0, 4, 8, 12, m[s[0]], m[s[1]]);
            G(1, 5, 9, 13, m[s[2]], m[s[3]]);
            G(2, 6, 10, 14, m[s[4]], m[s[5]]);
            G(3, 7, 11, 15, m[s[6]], m[s[7]]);
            G(0, 5, 10, 15, m[s[8]], m[s[9]]);
            G(1, 6, 11, 12, m[s[10]], m[s[11]]);
            G(2, 7, 8, 13, m[s[12]], m[s[13]]);
            G(3, 4, 9, 14, m[s[14]], m[s[15]]);
        }
        for (let i = 0; i < 8; i++)
            h[i] = (h[i] ^ v[i] ^ v[i + 8]) & BMASK;
    }
    const out = Buffer.alloc(64);
    for (let i = 0; i < 8; i++) {
        let w = h[i];
        for (let j = 0; j < 8; j++) {
            out[i * 8 + j] = Number(w & 255n);
            w >>= 8n;
        }
    }
    return out.subarray(0, outLen);
}
function blake2b512(data) {
    return crypto.createHash("blake2b512").update(data).digest();
}
function le32(x) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(x >>> 0);
    return b;
}
// Argon2's variable-length hash H'.
function hPrime(outLen, x) {
    const le = le32(outLen);
    if (outLen <= 64)
        return blake2b(Buffer.concat([le, x]), outLen);
    let v = blake2b512(Buffer.concat([le, x]));
    const out = [v.subarray(0, 32)];
    const r = Math.ceil(outLen / 32) - 2;
    for (let i = 2; i <= r; i++) {
        v = blake2b512(v);
        out.push(v.subarray(0, 32));
    }
    v = blake2b512(v); // V_{r+1}
    out.push(v.subarray(0, outLen - 32 * r));
    return Buffer.concat(out);
}
// ------------------------------------------------------------- argon2id (pure TS)
// Reference-compatible Argon2id v1.3 (RFC 9106), p=1..4 lanes, m in KiB.
const SYNC_POINTS = 4;
// blamka G: a = a + b + 2*lo32(a)*lo32(b) (mod 2^64)
function blamkaG(v, a, b, c, d) {
    v[a] = (v[a] + v[b] + 2n * (v[a] & M32) * (v[b] & M32)) & BMASK;
    v[d] = rotr64(v[d] ^ v[a], 32);
    v[c] = (v[c] + v[d] + 2n * (v[c] & M32) * (v[d] & M32)) & BMASK;
    v[b] = rotr64(v[b] ^ v[c], 24);
    v[a] = (v[a] + v[b] + 2n * (v[a] & M32) * (v[b] & M32)) & BMASK;
    v[d] = rotr64(v[d] ^ v[a], 16);
    v[c] = (v[c] + v[d] + 2n * (v[c] & M32) * (v[d] & M32)) & BMASK;
    v[b] = rotr64(v[b] ^ v[c], 63);
}
// one blamka round on a 16-word vector
function blamkaRound16(v, o) {
    blamkaG(v, o + 0, o + 4, o + 8, o + 12);
    blamkaG(v, o + 1, o + 5, o + 9, o + 13);
    blamkaG(v, o + 2, o + 6, o + 10, o + 14);
    blamkaG(v, o + 3, o + 7, o + 11, o + 15);
    blamkaG(v, o + 0, o + 5, o + 10, o + 15);
    blamkaG(v, o + 1, o + 6, o + 11, o + 12);
    blamkaG(v, o + 2, o + 7, o + 8, o + 13);
    blamkaG(v, o + 3, o + 4, o + 9, o + 14);
}
// blamka permutation P on a 1024-byte block: rows then column pairs.
function blamkaP(w) {
    for (let i = 0; i < 8; i++)
        blamkaRound16(w, 16 * i);
    const col = new Array(16);
    for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
            col[2 * j] = w[16 * j + 2 * i];
            col[2 * j + 1] = w[16 * j + 2 * i + 1];
        }
        blamkaRound16(col, 0);
        for (let j = 0; j < 8; j++) {
            w[16 * j + 2 * i] = col[2 * j];
            w[16 * j + 2 * i + 1] = col[2 * j + 1];
        }
    }
}
function bytesToWords(b, off) {
    const w = new Array(128);
    for (let i = 0; i < 128; i++) {
        let x = 0n;
        const p = off + i * 8;
        for (let j = 7; j >= 0; j--)
            x = (x << 8n) | BigInt(b[p + j]);
        w[i] = x;
    }
    return w;
}
function wordsToBytes(w, out, off) {
    for (let i = 0; i < 128; i++) {
        let x = w[i];
        const p = off + i * 8;
        for (let j = 0; j < 8; j++) {
            out[p + j] = Number(x & 255n);
            x >>= 8n;
        }
    }
}
// fill_block: next = P(prev ^ ref) ^ (prev ^ ref), optionally ^= old next.
function fillBlock(mem, prevOff, refOff, nextOff, withXor) {
    const r = bytesToWords(mem, prevOff);
    const rw = bytesToWords(mem, refOff);
    for (let i = 0; i < 128; i++)
        r[i] ^= rw[i];
    const z = r.slice();
    blamkaP(z);
    for (let i = 0; i < 128; i++)
        z[i] = (z[i] ^ r[i]) & BMASK;
    if (withXor) {
        const old = bytesToWords(mem, nextOff);
        for (let i = 0; i < 128; i++)
            z[i] ^= old[i];
    }
    wordsToBytes(z, mem, nextOff);
}
function indexAlpha(pass, slice, index, sameLane, laneLength, segLen, pseudoRand) {
    let refArea;
    if (pass === 0) {
        if (slice === 0) {
            refArea = index - 1;
        }
        else {
            refArea = sameLane ? slice * segLen + index - 1
                : slice * segLen + (index === 0 ? -1 : 0);
        }
    }
    else {
        refArea = sameLane ? laneLength - segLen + index - 1
            : laneLength - segLen + (index === 0 ? -1 : 0);
    }
    const rp32 = pseudoRand & M32;
    let rel = (rp32 * rp32) >> 32n;
    rel = BigInt(refArea - 1) - ((BigInt(refArea) * rel) >> 32n);
    let startPos = 0;
    if (pass !== 0) {
        startPos = slice === SYNC_POINTS - 1 ? 0 : (slice + 1) * segLen;
    }
    return Number((BigInt(startPos) + rel) % BigInt(laneLength));
}
function argon2id(pw, salt, memKiB, t, lanes, keyLen) {
    if (memKiB < 8192 || memKiB > 262144 || t < 1 || t > 12 || lanes < 1 || lanes > 4) {
        throw new Error("argon2id parameters out of range");
    }
    const p = lanes;
    const memBlocks = 4 * p * Math.floor(memKiB / (4 * p));
    const laneLength = Math.floor(memBlocks / p);
    const segLen = Math.floor(laneLength / SYNC_POINTS);
    const mem = new Uint8Array(memBlocks * 1024);
    const h0 = blake2b512(Buffer.concat([
        le32(p), le32(keyLen), le32(memKiB), le32(t), le32(0x13), le32(2),
        le32(pw.length), pw, le32(salt.length), salt, le32(0), le32(0),
    ]));
    for (let l = 0; l < p; l++) {
        const b0 = hPrime(1024, Buffer.concat([h0, le32(0), le32(l)]));
        const b1 = hPrime(1024, Buffer.concat([h0, le32(1), le32(l)]));
        mem.set(b0, l * laneLength * 1024);
        mem.set(b1, (l * laneLength + 1) * 1024);
    }
    const zeroBlock = new Uint8Array(1024);
    for (let pass = 0; pass < t; pass++) {
        for (let slice = 0; slice < SYNC_POINTS; slice++) {
            for (let lane = 0; lane < p; lane++) {
                const independent = pass === 0 && slice < SYNC_POINTS / 2;
                let addrBlock = new Uint8Array(1024);
                let inputBlock = new Uint8Array(1024);
                if (independent) {
                    const iv = new DataView(inputBlock.buffer);
                    iv.setUint32(0, pass, true);
                    iv.setUint32(8, lane, true);
                    iv.setUint32(16, slice, true);
                    iv.setUint32(24, memBlocks, true);
                    iv.setUint32(32, t, true);
                    iv.setUint32(40, 2, true); // argon2id type in address generation
                }
                const startIdx = pass === 0 && slice === 0 ? 2 : 0;
                // Reference: the first address block of pass 0 slice 0 is generated
                // before the loop; later generations happen inside at i % 128 == 0.
                if (independent && pass === 0 && slice === 0) {
                    const dv0 = new DataView(inputBlock.buffer);
                    dv0.setUint32(48, dv0.getUint32(48, true) + 1, true);
                    const ib0 = bytesToWords(inputBlock, 0);
                    const z1a = ib0.slice();
                    blamkaP(z1a);
                    for (let j = 0; j < 128; j++)
                        z1a[j] = (z1a[j] ^ ib0[j]) & BMASK;
                    const z2a = z1a.slice();
                    blamkaP(z2a);
                    addrBlock = new Uint8Array(1024);
                    wordsToBytes(z2a.map((x, j) => (x ^ z1a[j]) & BMASK), addrBlock, 0);
                }
                let prevOff = 0;
                for (let i = startIdx; i < segLen; i++) {
                    const currIndex = slice * segLen + i;
                    const currOff = (lane * laneLength + currIndex) * 1024;
                    prevOff = currIndex === 0
                        ? (lane * laneLength + laneLength - 1) * 1024
                        : currOff - 1024;
                    let rand;
                    if (independent) {
                        if (i % 128 === 0) {
                            const dv = new DataView(inputBlock.buffer);
                            dv.setUint32(48, dv.getUint32(48, true) + 1, true);
                            // addr = fill(zero, input) then fill(zero, tmp), no xor
                            const ib = bytesToWords(inputBlock, 0);
                            const zb = bytesToWords(zeroBlock, 0);
                            const r1 = ib.map((x, j) => x ^ zb[j]);
                            const z1 = r1.slice();
                            blamkaP(z1);
                            for (let j = 0; j < 128; j++)
                                z1[j] = (z1[j] ^ r1[j]) & BMASK;
                            const z2 = z1.slice();
                            blamkaP(z2);
                            addrBlock = new Uint8Array(1024);
                            wordsToBytes(z2.map((x, j) => (x ^ z1[j]) & BMASK), addrBlock, 0);
                        }
                        const woff = (i % 128) * 8;
                        let v = 0n;
                        for (let j = 7; j >= 0; j--)
                            v = (v << 8n) | BigInt(addrBlock[woff + j]);
                        rand = v;
                    }
                    else {
                        let v = 0n;
                        for (let j = 7; j >= 0; j--)
                            v = (v << 8n) | BigInt(mem[prevOff + j]);
                        rand = v;
                    }
                    let refLane = Number((rand >> 32n) & M32) % p;
                    if (pass === 0 && slice === 0)
                        refLane = lane;
                    const refIndex = indexAlpha(pass, slice, i, refLane === lane, laneLength, segLen, rand);
                    const refOff = (refLane * laneLength + refIndex) * 1024;
                    fillBlock(mem, prevOff, refOff, currOff, pass !== 0);
                }
            }
        }
    }
    const finalBlock = Buffer.from(mem.subarray((laneLength - 1) * 1024, laneLength * 1024));
    for (let l = 1; l < p; l++) {
        const off = (l * laneLength + laneLength - 1) * 1024;
        for (let i = 0; i < 1024; i++)
            finalBlock[i] ^= mem[off + i];
    }
    return hPrime(keyLen, finalBlock);
}
// ------------------------------------------------------------- P-256 / RFC 6979
const FP = BigInt("0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF");
const FN = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");
const FA = FP - 3n;
const FB_ = BigInt("0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B");
const GX = BigInt("0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296");
const GY = BigInt("0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5");
// BigInt % keeps the dividend's sign in JS; normalize.
function modp(x) {
    x %= FP;
    return x < 0n ? x + FP : x;
}
function modn(x) {
    x %= FN;
    return x < 0n ? x + FN : x;
}
function modInv(a, m) {
    let lm = 1n, hm = 0n, low = modn2(a, m), high = m;
    while (low > 1n) {
        const r = high / low;
        const nm = hm - lm * r;
        const nw = high - low * r;
        hm = lm;
        high = low;
        lm = nm;
        low = nw;
    }
    return modn2(lm, m);
}
function modn2(x, m) {
    x %= m;
    return x < 0n ? x + m : x;
}
function ptAdd(p, q) {
    if (p === null)
        return q;
    if (q === null)
        return p;
    const [px, py] = p, [qx, qy] = q;
    if (px === qx) {
        if (py !== qy || py === 0n)
            return null;
        const m = modp(modp(px * px * 3n + FA) * modInv(modp(py * 2n), FP));
        const x = modp(m * m - px * 2n);
        const y = modp(m * modp(px - x) - py);
        return [x, y];
    }
    const m = modp(modp(qy - py) * modInv(modp(qx - px), FP));
    const x = modp(m * m - px - qx);
    const y = modp(m * modp(px - x) - py);
    return [x, y];
}
function ptMul(k, p) {
    let r = null;
    while (k > 0n) {
        if (k & 1n)
            r = ptAdd(r, p);
        p = ptAdd(p, p);
        k >>= 1n;
    }
    return r;
}
function onCurve(pt) {
    const l = modp(pt[1] * pt[1]);
    const r = modp((pt[0] * pt[0] + FA) * pt[0] + FB_);
    return l === r;
}
function bytesToBig(b) {
    return BigInt("0x" + (b.length ? b.toString("hex") : "0"));
}
function pad32b(x) {
    let h = x.toString(16);
    if (h.length > 64)
        h = h.slice(h.length - 64);
    return Buffer.from(h.padStart(64, "0"), "hex");
}
function hmac256(key, data) {
    return crypto.createHmac("sha256", key).update(data).digest();
}
// rfc6979_k derives the deterministic nonce exactly like the C reference:
// HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
function rfc6979K(priv, hash) {
    let v = Buffer.alloc(32, 1);
    let k = Buffer.alloc(32, 0);
    const bx = Buffer.concat([priv, hash]);
    k = hmac256(k, Buffer.concat([v, Buffer.from([0]), bx]));
    v = hmac256(k, v);
    k = hmac256(k, Buffer.concat([v, Buffer.from([1]), bx]));
    v = hmac256(k, v);
    for (;;) {
        v = hmac256(k, v);
        const kk = bytesToBig(v);
        if (kk > 0n && kk < FN)
            return kk;
        k = hmac256(k, Buffer.concat([v, Buffer.from([0])]));
        v = hmac256(k, v);
    }
}
// p256_sign produces a deterministic P1363 r||s signature, low-s normalized.
function p256Sign(priv, msg) {
    const half = FN >> 1n;
    const hash = sha256(msg);
    const d = bytesToBig(priv);
    let e = bytesToBig(hash);
    if (e >= FN)
        e -= FN;
    for (;;) {
        const k = rfc6979K(priv, hash);
        const pt = ptMul(k, [GX, GY]);
        if (pt === null)
            continue;
        const r = pt[0] % FN;
        if (r === 0n)
            continue;
        const kinv = modInv(k, FN);
        let s = modn(kinv * (e + d * r));
        if (s === 0n)
            continue;
        if (s > half)
            s = FN - s;
        return Buffer.concat([pad32b(r), pad32b(s)]);
    }
}
function p256Verify(pub, msg, sig) {
    try {
        if (pub.length !== 65 || pub[0] !== 4 || sig.length !== 64)
            return false;
        const q = [bytesToBig(pub.subarray(1, 33)), bytesToBig(pub.subarray(33, 65))];
        if (!onCurve(q))
            return false;
        const hash = sha256(msg);
        let e = bytesToBig(hash);
        if (e >= FN)
            e -= FN;
        const r = bytesToBig(sig.subarray(0, 32));
        const s = bytesToBig(sig.subarray(32, 64));
        if (r === 0n || r >= FN || s === 0n || s >= FN)
            return false;
        const w = modInv(s, FN);
        const u1 = modn(e * w);
        const u2 = modn(r * w);
        const pt = ptAdd(ptMul(u1, [GX, GY]), ptMul(u2, q));
        if (pt === null)
            return false;
        return pt[0] % FN === r;
    }
    catch {
        return false;
    }
}
function p256Keygen(priv) {
    const pt = ptMul(bytesToBig(priv), [GX, GY]);
    return Buffer.concat([Buffer.from([4]), pad32b(pt[0]), pad32b(pt[1])]);
}
// fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
function fingerprint(pub) {
    const h = sha256(pub);
    let s = "";
    for (let i = 0; i < 8; i++) {
        s += h[i].toString(16).padStart(2, "0").toUpperCase();
        if (i % 2 === 1 && i < 7)
            s += "-";
    }
    return s;
}
function genkey() {
    for (;;) {
        const priv = crypto.randomBytes(32);
        if (priv.some((b) => b !== 0))
            return [priv, p256Keygen(priv)];
    }
}
// ------------------------------------------------------------- secure envelope
function aesEncrypt(key, iv, aad, pt) {
    const c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(aad);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    return [ct, c.getAuthTag()];
}
function aesDecrypt(key, iv, aad, ct, tag) {
    try {
        const c = crypto.createDecipheriv("aes-256-gcm", key, iv);
        c.setAuthTag(tag);
        c.setAAD(aad);
        return Buffer.concat([c.update(ct), c.final()]);
    }
    catch {
        return null;
    }
}
function deriveKey(password, salt, kdf, iter, mem, t, lanes) {
    if (kdf === 2)
        return argon2id(password, salt, mem, t, lanes, 32);
    return pbkdf2(password, salt, iter, 32);
}
// seal locks (password non-empty, kdf 'argon2id'|'pbkdf2') and/or signs
// (priv present) data. At least one of the two.
function seal(data, password, kdf, priv, pub) {
    if (password.length === 0 && priv === null)
        throw new Error("need a password, a signing key, or both");
    const useA = kdf === "" || kdf === "argon2id";
    let flags = 0;
    if (password.length > 0)
        flags |= FLAG_ENC;
    if (priv !== null)
        flags |= FLAG_SIG;
    let body;
    if (password.length > 0) {
        const salt = crypto.randomBytes(16);
        const iv = crypto.randomBytes(12);
        const head = Buffer.concat([MAGIC, Buffer.from([2, flags])]);
        let h;
        if (useA) {
            const mb = Buffer.alloc(4);
            mb.writeUInt32BE(exports.ARGON2_MEM);
            h = Buffer.concat([head, Buffer.from([2]), mb, Buffer.from([exports.ARGON2_T, exports.ARGON2_P])]);
        }
        else {
            const ib = Buffer.alloc(4);
            ib.writeUInt32BE(exports.PBKDF2_ITER);
            h = Buffer.concat([head, Buffer.from([1]), ib, Buffer.from([0, 0])]);
        }
        h = Buffer.concat([h, salt, iv]);
        const key = deriveKey(password, salt, useA ? 2 : 1, exports.PBKDF2_ITER, exports.ARGON2_MEM, exports.ARGON2_T, exports.ARGON2_P);
        const [ct, tag] = aesEncrypt(key, iv, h, data);
        body = Buffer.concat([h, ct, tag]);
    }
    else {
        body = Buffer.concat([MAGIC, Buffer.from([2, flags]), data]);
    }
    if (priv === null)
        return body;
    return Buffer.concat([body, pub, p256Sign(priv, body)]);
}
function isSecure(b) {
    return b.length >= 6 && b[0] === 0x50 && b[1] === 0x53 && b[2] === 0x43 &&
        (b[3] === 1 || b[3] === 2) && (b[4] & ~3) === 0;
}
// open returns a result object; never returns a wrong payload.
function open(b, password, trustedFps = null) {
    const res = {
        secure: false, version: 0, encrypted: false, signed: false,
        signatureValid: -1, fingerprint: "", trusted: false,
        bytes: null, needsPassword: false, error: null,
    };
    if (!isSecure(b)) {
        res.bytes = b;
        return res;
    }
    const len = b.length;
    const ver = b[3];
    const flags = b[4];
    const encrypted = (flags & FLAG_ENC) !== 0;
    const sgn = (flags & FLAG_SIG) !== 0;
    res.secure = true;
    res.version = ver;
    res.encrypted = encrypted;
    res.signed = sgn;
    let finish = len;
    if (sgn) {
        if (len < 5 + 65 + 64) {
            res.error = "Code is damaged";
            return res;
        }
        const pub = b.subarray(finish - 129, finish - 64);
        const sig = b.subarray(finish - 64, finish);
        res.signatureValid = p256Verify(Buffer.from(pub), b.subarray(0, finish - 129), Buffer.from(sig)) ? 1 : 0;
        res.fingerprint = fingerprint(Buffer.from(pub));
        if (res.signatureValid === 1 && trustedFps && trustedFps.includes(res.fingerprint)) {
            res.trusted = true;
        }
        finish -= 129;
        if (res.signatureValid !== 1) {
            res.error = "Signature is not valid. This code was changed or forged.";
            return res;
        }
    }
    if (!encrypted) {
        res.bytes = Buffer.from(b.subarray(5, finish));
        return res;
    }
    let hl, kdf, salt, iv, iter, mem = 0, t = 0, lanes = 0;
    if (ver === 1) {
        hl = HEAD1;
        if (finish < hl + 16) {
            res.error = "Code is damaged";
            return res;
        }
        salt = Buffer.from(b.subarray(5, 21));
        iv = Buffer.from(b.subarray(21, 33));
        kdf = 1;
        iter = b.readUInt32BE(33);
    }
    else {
        hl = HEAD2;
        if (finish < hl + 16) {
            res.error = "Code is damaged";
            return res;
        }
        kdf = b[5];
        salt = Buffer.from(b.subarray(12, 28));
        iv = Buffer.from(b.subarray(28, 40));
        if (kdf === 2) {
            mem = b.readUInt32BE(6);
            t = b[10];
            lanes = b[11];
            iter = 0;
        }
        else {
            iter = b.readUInt32BE(6);
        }
    }
    if ((kdf === 1 && (iter < 100000 || iter > 5000000)) ||
        (kdf === 2 && (mem < 8192 || mem > 262144 || t < 1 || t > 12 || lanes < 1 || lanes > 4)) ||
        (kdf !== 1 && kdf !== 2)) {
        res.error = "Code is damaged or unsupported";
        return res;
    }
    if (password.length === 0) {
        res.needsPassword = true;
        return res;
    }
    let key;
    try {
        key = deriveKey(password, salt, kdf, iter, mem, t, lanes);
    }
    catch {
        res.error = "Key derivation failed";
        return res;
    }
    const pt = aesDecrypt(key, iv, b.subarray(0, hl), b.subarray(hl, finish - 16), b.subarray(finish - 16, finish));
    if (pt === null) {
        res.error = "Wrong password, or the code was changed.";
    }
    else {
        res.bytes = pt;
    }
    return res;
}
// generate_passphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
function passphrase() {
    const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const r = crypto.randomBytes(28);
    let s = "";
    for (let g = 0; g < 7; g++) {
        if (g > 0)
            s += "-";
        for (let i = 0; i < 4; i++)
            s += alpha[r[g * 4 + i] & 31];
    }
    return s;
}
// strength estimates password strength; same heuristic as the site.
// Returns [bits, level 0-4, label].
function strength(pw) {
    const labels = ["weak", "weak", "fair", "good", "strong"];
    const pb = Array.from(Buffer.from(pw, "utf8"));
    const n = pb.length;
    if (n === 0)
        return [0, 0, "none"];
    let groups = 1;
    let okk = true;
    let body = 0;
    for (const c of pb) {
        if (c === 0x2d) {
            groups += 1;
            continue;
        }
        const isUp = c >= 65 && c <= 90 && c !== 73 && c !== 79;
        const isDig = c >= 50 && c <= 57;
        if (!isUp && !isDig) {
            okk = false;
            break;
        }
        body += 1;
    }
    if (groups >= 6 && okk && body >= 24)
        return [body * 5, 4, "excellent (random)"];
    let lo = false, up = false, dig = false, sym = false;
    for (const c of pb) {
        if (c >= 97 && c <= 122)
            lo = true;
        else if (c >= 65 && c <= 90)
            up = true;
        else if (c >= 48 && c <= 57)
            dig = true;
        else
            sym = true;
    }
    let pool = 0;
    if (lo)
        pool += 26;
    if (up)
        pool += 26;
    if (dig)
        pool += 10;
    if (sym)
        pool += 33;
    if (pool < 2)
        pool = 2;
    let lp = 0.0;
    let p = pool;
    while (p > 1) {
        lp += 1.0;
        p >>= 1;
    }
    const base = 1 << Math.floor(lp);
    lp += (pool - base) / base;
    let uniq = 0;
    for (let i = 0; i < n; i++) {
        let seen = false;
        for (let j = 0; j < i; j++)
            if (pb[j] === pb[i])
                seen = true;
        if (!seen)
            uniq += 1;
    }
    let capN = n;
    if (uniq * 2 < n)
        capN = uniq * 2;
    let bits = capN * lp;
    for (let i = 0; i < n - 2; i++) {
        if (pb[i] === pb[i + 1] && pb[i] === pb[i + 2]) {
            bits *= 0.7;
            break;
        }
    }
    const seqs = ["012", "123", "234", "345", "456", "567", "678", "789", "abc", "bcd", "cde", "def", "qwe", "wer", "asd", "sdf", "zxc"];
    for (const sq of seqs) {
        let hit = false;
        const sb = Array.from(Buffer.from(sq, "latin1"));
        for (let i = 0; i < n - 2; i++) {
            if ((pb[i] | 32) === sb[0] && (pb[i + 1] | 32) === sb[1] && (pb[i + 2] | 32) === sb[2]) {
                bits *= 0.7;
                hit = true;
                break;
            }
        }
        if (hit)
            break;
    }
    if ((lo && !up && !dig && !sym) || (dig && !lo && !up && !sym))
        bits *= 0.8;
    for (let i = 0; i < n - 3; i++) {
        if ((pb[i] === 49 && pb[i + 1] === 57) || (pb[i] === 50 && pb[i + 1] === 48)) {
            if (pb[i + 2] >= 48 && pb[i + 2] <= 57 && pb[i + 3] >= 48 && pb[i + 3] <= 57) {
                bits -= 8.0;
                break;
            }
        }
    }
    const common = ["password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon",
        "football", "baseball", "shalom", "israel", "master", "login", "abc123", "prism", "secret", "hello",
        "test", "summer", "winter", "sunshine", "princess", "trustno1", "whatever", "google", "avi", "1234",
        "asdf", "zxcv", "love", "god", "cohen", "levi"];
    const low = pw.toLowerCase();
    for (const w of common) {
        if (low.includes(w)) {
            if (bits > 28.0)
                bits = 28.0;
            if (low === w)
                bits -= 8.0;
            break;
        }
    }
    let ibits = Math.floor(bits);
    if (ibits < 0)
        ibits = 0;
    const level = ibits < 40 ? 0 : ibits < 60 ? 1 : ibits < 80 ? 2 : ibits < 100 ? 3 : 4;
    return [ibits, level, labels[level]];
}
// ------------------------------------------------------------- key file
function b64url(b) {
    return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDec(s) {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4 !== 0)
        t += "=";
    return Buffer.from(t, "base64");
}
function saveKey(path, priv, pub) {
    const json = '{"publicKeyHex":"' + pub.toString("hex") + '","privateJwk":{"crv":"P-256","d":"' +
        b64url(priv) + '","kty":"EC","x":"' + b64url(pub.subarray(1, 33)) +
        '","y":"' + b64url(pub.subarray(33, 65)) + '"}}';
    fs.writeFileSync(path, json);
    try {
        fs.chmodSync(path, 0o600);
    }
    catch { /* best effort */ }
}
function loadKey(path) {
    try {
        const kf = JSON.parse(fs.readFileSync(path, "utf8"));
        const pub = Buffer.from(kf.publicKeyHex, "hex");
        if (pub.length !== 65)
            throw new Error("bad public key");
        const priv = b64urlDec(String(kf.privateJwk.d ?? ""));
        if (priv.length !== 32)
            throw new Error("bad private key");
        return [priv, pub];
    }
    catch (e) {
        throw new Error(`bad key file ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
}
