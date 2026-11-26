// Prism Secure (Swift port) — password lock + maker signatures for Prism Code payloads.
//
// Wire-compatible with the live Prism Secure module (prism-secure.html) at
// https://github.com/avishorwork-wq/prism-code. No CryptoKit (Linux): SHA-256,
// Blake2b (RFC 7693), Argon2id (RFC 9106), AES-256 (FIPS-197), GCM (SP 800-38D),
// PBKDF2 (RFC 2898) and ECDSA P-256 (FIPS 186-5) are implemented here from scratch.
//
// Prism Code by Avi Shor. Free to use, with or without credit. No warranty.

import Foundation

public enum PrismSecureError: Error {
    case damaged, unsupported, wrongPassword, noCredential, badKey
}

let PSC_MAGIC: [UInt8] = [0x50, 0x53, 0x43] // "PSC"
let F_ENC: UInt8 = 1, F_SIG: UInt8 = 2
let PBKDF2_ITER = 600000
let A2_MEM = 131072, A2_T = 3, A2_P = 1
let MAX_MEM = 262144, MAX_T = 12
let HEAD2 = 4 + 1 + 1 + 6 + 16 + 12
let HEAD1 = 4 + 1 + 16 + 12 + 4

func be32(_ n: UInt32) -> [UInt8] { [UInt8(n >> 24), UInt8(n >> 16 & 255), UInt8(n >> 8 & 255), UInt8(n & 255)] }
func rd32(_ b: [UInt8], _ i: Int) -> UInt32 { UInt32(b[i]) << 24 | UInt32(b[i+1]) << 16 | UInt32(b[i+2]) << 8 | UInt32(b[i+3]) }

func nfkc(_ s: String) -> [UInt8] { Array(s.precomposedStringWithCompatibilityMapping.utf8) }

func ctEqual(_ a: [UInt8], _ b: [UInt8]) -> Bool {
    var d = a.count ^ b.count
    for i in 0..<max(a.count, b.count) { d |= Int(i < a.count ? a[i] : 0) ^ Int(i < b.count ? b[i] : 0) }
    return d == 0
}

func randomBytes(_ n: Int) -> [UInt8] {
    var g = SystemRandomNumberGenerator()
    return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
}

// ---------------------------------------------------------------- SHA-256 (FIPS 180-4)

let SHA_K: [UInt32] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]

func sha256(_ data: [UInt8]) -> [UInt8] {
    var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    var msg = data
    let bitLen = UInt64(data.count) * 8
    msg.append(0x80)
    while msg.count % 64 != 56 { msg.append(0) }
    for i in 0..<8 { msg.append(UInt8(bitLen >> (56 - 8 * i) & 255)) }
    for chunkStart in stride(from: 0, to: msg.count, by: 64) {
        var w = [UInt32](repeating: 0, count: 64)
        for i in 0..<16 {
            let j = chunkStart + i * 4
            w[i] = UInt32(msg[j]) << 24 | UInt32(msg[j+1]) << 16 | UInt32(msg[j+2]) << 8 | UInt32(msg[j+3])
        }
        for i in 16..<64 {
            let s0 = w[i-15].rotateRight(7) ^ w[i-15].rotateRight(18) ^ (w[i-15] >> 3)
            let s1 = w[i-2].rotateRight(17) ^ w[i-2].rotateRight(19) ^ (w[i-2] >> 10)
            w[i] = w[i-16] &+ s0 &+ w[i-7] &+ s1
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
        for i in 0..<64 {
            let s1 = e.rotateRight(6) ^ e.rotateRight(11) ^ e.rotateRight(25)
            let ch = (e & f) ^ (~e & g)
            let t1 = hh &+ s1 &+ ch &+ SHA_K[i] &+ w[i]
            let s0 = a.rotateRight(2) ^ a.rotateRight(13) ^ a.rotateRight(22)
            let maj = (a & b) ^ (a & c) ^ (b & c)
            let t2 = s0 &+ maj
            hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
        }
        h[0] &+= a; h[1] &+= b; h[2] &+= c; h[3] &+= d; h[4] &+= e; h[5] &+= f; h[6] &+= g; h[7] &+= hh
    }
    var out = [UInt8]()
    for v in h { out += be32(v) }
    return out
}

extension UInt32 {
    @inline(__always) func rotateRight(_ n: UInt32) -> UInt32 { (self >> n) | (self << (32 - n)) }
}

// ---------------------------------------------------------------- Blake2b (RFC 7693), unkeyed

let B2_IV: [UInt64] = [0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
                       0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179]
let B2_SIGMA: [[Int]] = [
    [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
    [14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3],
    [11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4],
    [7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8],
    [9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13],
    [2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9],
    [12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11],
    [13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10],
    [6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5],
    [10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0]]

func blake2b(_ input: [UInt8], _ outLen: Int) -> [UInt8] {
    var h = B2_IV
    h[0] ^= 0x01010000 ^ UInt64(outLen)
    let blocks = max(1, (input.count + 127) / 128)
    var t: UInt64 = 0
    for blk in 0..<blocks {
        let last = blk == blocks - 1
        let n = min(128, input.count - blk * 128)
        t &+= UInt64(n)
        var m = [UInt64](repeating: 0, count: 16)
        for i in 0..<n { m[i >> 3] |= UInt64(input[blk * 128 + i]) << UInt64(8 * (i & 7)) }
        var v = [UInt64](repeating: 0, count: 16)
        for i in 0..<8 { v[i] = h[i]; v[8 + i] = B2_IV[i] }
        v[12] ^= t
        if last { v[14] = ~v[14] }
        for r in 0..<12 {
            let s = B2_SIGMA[r % 10]
            func g(_ a: Int, _ b: Int, _ c: Int, _ d: Int, _ x: UInt64, _ y: UInt64) {
                v[a] = v[a] &+ v[b] &+ x; v[d] = (v[d] ^ v[a]).rotateRight32
                v[c] = v[c] &+ v[d]; v[b] = (v[b] ^ v[c]).rotateRight24
                v[a] = v[a] &+ v[b] &+ y; v[d] = (v[d] ^ v[a]).rotateRight16
                v[c] = v[c] &+ v[d]; v[b] = (v[b] ^ v[c]).rotateRight63
            }
            g(0,4,8,12,m[s[0]],m[s[1]]); g(1,5,9,13,m[s[2]],m[s[3]])
            g(2,6,10,14,m[s[4]],m[s[5]]); g(3,7,11,15,m[s[6]],m[s[7]])
            g(0,5,10,15,m[s[8]],m[s[9]]); g(1,6,11,12,m[s[10]],m[s[11]])
            g(2,7,8,13,m[s[12]],m[s[13]]); g(3,4,9,14,m[s[14]],m[s[15]])
        }
        for i in 0..<8 { h[i] ^= v[i] ^ v[i + 8] }
    }
    var out = [UInt8]()
    for i in 0..<outLen { out.append(UInt8(h[i >> 3] >> UInt64(8 * (i & 7)) & 255)) }
    return out
}

extension UInt64 {
    @inline(__always) var rotateRight32: UInt64 { (self >> 32) | (self << 32) }
    @inline(__always) var rotateRight24: UInt64 { (self >> 24) | (self << 40) }
    @inline(__always) var rotateRight16: UInt64 { (self >> 16) | (self << 48) }
    @inline(__always) var rotateRight63: UInt64 { (self >> 63) | (self << 1) }
    @inline(__always) func rotr(_ n: UInt64) -> UInt64 { (self >> n) | (self << (64 - n)) }
}

func hPrime(_ input: [UInt8], _ outLen: Int) -> [UInt8] {
    var le = [UInt8]()
    for i in 0..<4 { le.append(UInt8(UInt32(outLen) >> (8 * i) & 255)) }
    if outLen <= 64 { return blake2b(le + input, outLen) }
    var v = blake2b(le + input, 64)
    var out = [UInt8](v[0..<32])
    var rem = outLen - 32
    while rem > 64 {
        v = blake2b(v, 64)
        out += v[0..<32]
        rem -= 32
    }
    out += blake2b(v, rem)
    return out
}

// ---------------------------------------------------------------- Argon2id (RFC 9106), p=1

@inline(__always) func blaMka(_ x: UInt64, _ y: UInt64) -> UInt64 {
    x &+ y &+ 2 &* (x & 0xFFFFFFFF) &* (y & 0xFFFFFFFF)
}

/// Argon2's P: ONE message-less Blake2b round (BLAKE2_ROUND_NOMSG) over 16 words.
func permute16(_ v: inout [UInt64], _ off: Int) {
    for (a, b, c, d) in [(0,4,8,12),(1,5,9,13),(2,6,10,14),(3,7,11,15),(0,5,10,15),(1,6,11,12),(2,7,8,13),(3,4,9,14)] {
        let (ai, bi, ci, di) = (a + off, b + off, c + off, d + off)
        var va = v[ai], vb = v[bi], vc = v[ci], vd = v[di]
        va = blaMka(va, vb); vd = (vd ^ va).rotr(32)
        vc = blaMka(vc, vd); vb = (vb ^ vc).rotr(24)
        va = blaMka(va, vb); vd = (vd ^ va).rotr(16)
        vc = blaMka(vc, vd); vb = (vb ^ vc).rotr(63)
        v[ai] = va; v[bi] = vb; v[ci] = vc; v[di] = vd
    }
}

func argon2G(_ x: [UInt64], _ y: [UInt64], old: [UInt64]? = nil) -> [UInt64] {
    var r = [UInt64](repeating: 0, count: 128)
    for i in 0..<128 { r[i] = x[i] ^ y[i] }
    var z = r
    for row in 0..<8 { permute16(&z, row * 16) }
    var col = [UInt64](repeating: 0, count: 16)
    for c in 0..<8 {
        for row in 0..<8 { col[row * 2] = z[row * 16 + c * 2]; col[row * 2 + 1] = z[row * 16 + c * 2 + 1] }
        permute16(&col, 0)
        for row in 0..<8 { z[row * 16 + c * 2] = col[row * 2]; z[row * 16 + c * 2 + 1] = col[row * 2 + 1] }
    }
    var out = [UInt64](repeating: 0, count: 128)
    for i in 0..<128 { out[i] = z[i] ^ r[i] ^ (old?[i] ?? 0) }
    return out
}

func argon2id(password: [UInt8], salt: [UInt8], memKiB: Int, passes: Int, lanes: Int = 1, outLen: Int = 32) -> [UInt8] {
    precondition(lanes == 1, "only p=1 supported")
    let mPrime = (memKiB / 4) * 4
    let laneLen = mPrime, segLen = laneLen / 4
    var mem = [UInt64](repeating: 0, count: mPrime * 128)
    func le32(_ n: Int) -> [UInt8] { [UInt8(n & 255), UInt8(n >> 8 & 255), UInt8(n >> 16 & 255), UInt8(n >> 24 & 255)] }
    var h0in = [UInt8]()
    h0in += le32(1) + le32(outLen) + le32(memKiB) + le32(passes) + le32(0x13) + le32(2)
    h0in += le32(password.count) + password + le32(salt.count) + salt + le32(0) + le32(0)
    let h0 = blake2b(h0in, 64)
    for i in 0..<2 {
        let blk = hPrime(h0 + le32(i) + le32(0), 1024)
        for w in 0..<128 {
            var v: UInt64 = 0
            for k in 0..<8 { v |= UInt64(blk[w * 8 + k]) << UInt64(8 * k) }
            mem[i * 128 + w] = v
        }
    }
    let zero = [UInt64](repeating: 0, count: 128)
    for ps in 0..<passes {
        for sl in 0..<4 {
            let di = ps == 0 && sl < 2
            var addrIn = [UInt64](repeating: 0, count: 128)
            var addrBlock = [UInt64](repeating: 0, count: 128)
            if di {
                addrIn[0] = UInt64(ps); addrIn[1] = 0; addrIn[2] = UInt64(sl)
                addrIn[3] = UInt64(mPrime); addrIn[4] = UInt64(passes); addrIn[5] = 2
                if sl == 0 { // reference pre-generates the first address block for slice 0
                    addrIn[6] = 1
                    addrBlock = argon2G(zero, argon2G(zero, addrIn))
                }
            }
            let start = (ps == 0 && sl == 0) ? 2 : 0
            for idx in start..<segLen {
                let cur = sl * segLen + idx
                let prev = cur % laneLen != 0 ? cur - 1 : laneLen - 1
                let j1: UInt64
                if di {
                    if idx % 128 == 0 {
                        addrIn[6] &+= 1
                        addrBlock = argon2G(zero, argon2G(zero, addrIn))
                    }
                    j1 = addrBlock[idx % 128] & 0xFFFFFFFF // index is the segment index: blocks 0,1 skip addresses 0,1
                } else {
                    j1 = mem[prev * 128] & 0xFFFFFFFF
                }
                let area: Int
                if ps == 0 { area = sl == 0 ? idx - 1 : sl * segLen + idx - 1 }
                else { area = laneLen - segLen + idx - 1 }
                let x = (j1 &* j1) >> 32
                let rel = UInt64(area) &- 1 &- ((UInt64(area) &* x) >> 32)
                let startPos = ps == 0 ? 0 : (sl == 3 ? 0 : (sl + 1) * segLen)
                let ref = (Int(startPos) + Int(rel)) % laneLen
                let oldBlock = ps != 0 ? Array(mem[cur * 128..<(cur + 1) * 128]) : nil
                let newBlock = argon2G(Array(mem[prev * 128..<(prev + 1) * 128]), Array(mem[ref * 128..<(ref + 1) * 128]), old: oldBlock)
                mem.replaceSubrange(cur * 128..<(cur + 1) * 128, with: newBlock)
            }
        }
    }
    var lastBlock = [UInt8]()
    for w in mem[(laneLen - 1) * 128..<laneLen * 128] {
        for k in 0..<8 { lastBlock.append(UInt8(w >> UInt64(8 * k) & 255)) }
    }
    return hPrime(lastBlock, outLen)
}

// ---------------------------------------------------------------- AES-256 (FIPS-197)

let AES_SBOX: [UInt8] = [
0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16]
let AES_RCON: [UInt8] = [0x01,0x02,0x04,0x08,0x10,0x20,0x40]

@inline(__always) func xtime(_ a: UInt8) -> UInt8 { ((a << 1) ^ (a & 0x80 != 0 ? 0x1b : 0)) }
func gmul(_ a: UInt8, _ b: UInt8) -> UInt8 {
    var r: UInt8 = 0, aa = a, bb = b
    while bb != 0 { if bb & 1 != 0 { r ^= aa }; aa = xtime(aa); bb >>= 1 }
    return r
}

struct Aes256 {
    var rk: [[UInt8]] // 60 words of 4 bytes
    init(_ key: [UInt8]) {
        precondition(key.count == 32)
        var w: [[UInt8]] = []
        for i in 0..<8 { w.append([key[4*i], key[4*i+1], key[4*i+2], key[4*i+3]]) }
        for i in 8..<60 {
            var t = w[i-1]
            if i % 8 == 0 {
                t = [AES_SBOX[Int(t[1])] ^ AES_RCON[i/8 - 1], AES_SBOX[Int(t[2])], AES_SBOX[Int(t[3])], AES_SBOX[Int(t[0])]]
            } else if i % 8 == 4 {
                t = t.map { AES_SBOX[Int($0)] }
            }
            var nw = [UInt8](repeating: 0, count: 4)
            for j in 0..<4 { nw[j] = w[i-8][j] ^ t[j] }
            w.append(nw)
        }
        rk = w
    }
    func encryptBlock(_ block: [UInt8]) -> [UInt8] {
        var s = [[UInt8]](repeating: [UInt8](repeating: 0, count: 4), count: 4) // s[row][col]
        for c in 0..<4 { for r in 0..<4 { s[r][c] = block[c * 4 + r] } }
        func addRk(_ rnd: Int) {
            for c in 0..<4 { for r in 0..<4 { s[r][c] ^= rk[rnd * 4 + c][r] } }
        }
        addRk(0)
        for rnd in 1..<15 {
            for r in 0..<4 { for c in 0..<4 { s[r][c] = AES_SBOX[Int(s[r][c])] } }
            for r in 1..<4 { s[r] = Array(s[r][r...]) + s[r][..<r] }
            if rnd < 14 {
                for c in 0..<4 {
                    let col = [s[0][c], s[1][c], s[2][c], s[3][c]]
                    s[0][c] = gmul(col[0],2) ^ gmul(col[1],3) ^ col[2] ^ col[3]
                    s[1][c] = col[0] ^ gmul(col[1],2) ^ gmul(col[2],3) ^ col[3]
                    s[2][c] = col[0] ^ col[1] ^ gmul(col[2],2) ^ gmul(col[3],3)
                    s[3][c] = gmul(col[0],3) ^ col[1] ^ col[2] ^ gmul(col[3],2)
                }
            }
            addRk(rnd)
        }
        var out = [UInt8]()
        for c in 0..<4 { for r in 0..<4 { out.append(s[r][c]) } }
        return out
    }
}

// GCM (SP 800-38D), 96-bit IV
func gcmMul(_ x: UInt64HiLo, _ y: UInt64HiLo) -> UInt64HiLo {
    // bit-by-bit over 128 bits; R = 0xE1 << 120
    var z = UInt64HiLo(0, 0), v = x
    for i in 0..<128 {
        if y.bit(127 - i) { z = z ^ v }
        v = v.shr1()
        if v.carryOut { v.hi ^= 0xE100000000000000 }
    }
    return z
}

struct UInt64HiLo {
    var hi: UInt64, lo: UInt64
    var carryOut = false
    init(_ hi: UInt64, _ lo: UInt64) { self.hi = hi; self.lo = lo }
    init(bytes b: [UInt8]) {
        var h: UInt64 = 0, l: UInt64 = 0
        for i in 0..<8 { h |= UInt64(b[i]) << UInt64(56 - 8 * i); l |= UInt64(b[8 + i]) << UInt64(56 - 8 * i) }
        hi = h; lo = l
    }
    func bit(_ i: Int) -> Bool { i >= 64 ? (hi >> UInt64(i - 64)) & 1 == 1 : (lo >> UInt64(i)) & 1 == 1 }
    static func ^ (a: UInt64HiLo, b: UInt64HiLo) -> UInt64HiLo { UInt64HiLo(a.hi ^ b.hi, a.lo ^ b.lo) }
    func shr1() -> UInt64HiLo {
        var r = UInt64HiLo(hi >> 1, (lo >> 1) | ((hi & 1) << 63))
        r.carryOut = lo & 1 == 1
        return r
    }
    var bytes: [UInt8] {
        var out = [UInt8]()
        for i in 0..<8 { out.append(UInt8(hi >> UInt64(56 - 8 * i) & 255)) }
        for i in 0..<8 { out.append(UInt8(lo >> UInt64(56 - 8 * i) & 255)) }
        return out
    }
}

func ghash(_ h: UInt64HiLo, _ aad: [UInt8], _ ct: [UInt8]) -> UInt64HiLo {
    var x = UInt64HiLo(0, 0)
    func feed(_ data: [UInt8]) {
        var i = 0
        while i < data.count {
            var b = Array(data[i..<min(i + 16, data.count)])
            while b.count < 16 { b.append(0) }
            x = gcmMul(x ^ UInt64HiLo(bytes: b), h)
            i += 16
        }
    }
    feed(aad); feed(ct)
    var lb = [UInt8]()
    let abit = UInt64(aad.count) * 8, cbit = UInt64(ct.count) * 8
    for i in 0..<8 { lb.append(UInt8(abit >> UInt64(56 - 8 * i) & 255)) }
    for i in 0..<8 { lb.append(UInt8(cbit >> UInt64(56 - 8 * i) & 255)) }
    x = gcmMul(x ^ UInt64HiLo(bytes: lb), h)
    return x
}

func aesGcmCrypt(_ key: [UInt8], _ iv: [UInt8], _ data: [UInt8]) -> [UInt8] {
    let a = Aes256(key)
    var j0 = iv + [0, 0, 0, 1]
    var ctr = UInt32(1)
    var out = [UInt8]()
    var i = 0
    while i < data.count {
        ctr &+= 1
        j0[15] = UInt8(ctr & 255); j0[14] = UInt8(ctr >> 8 & 255); j0[13] = UInt8(ctr >> 16 & 255); j0[12] = UInt8(ctr >> 24 & 255)
        let ks = a.encryptBlock(j0)
        let n = min(16, data.count - i)
        for k in 0..<n { out.append(data[i + k] ^ ks[k]) }
        i += 16
    }
    return out
}

func aesGcmEncrypt(_ key: [UInt8], _ iv: [UInt8], _ data: [UInt8], _ aad: [UInt8]) -> [UInt8] {
    let a = Aes256(key)
    let h = UInt64HiLo(bytes: a.encryptBlock([UInt8](repeating: 0, count: 16)))
    let ct = aesGcmCrypt(key, iv, data)
    let j0 = iv + [0, 0, 0, 1]
    let tag = ghash(h, aad, ct) ^ UInt64HiLo(bytes: a.encryptBlock(j0))
    return ct + tag.bytes
}

func aesGcmDecrypt(_ key: [UInt8], _ iv: [UInt8], _ data: [UInt8], _ aad: [UInt8]) throws -> [UInt8] {
    if data.count < 16 { throw PrismSecureError.damaged }
    let ct = Array(data[..<(data.count - 16)]), tag = Array(data[(data.count - 16)...])
    let pt = aesGcmCrypt(key, iv, ct)
    let a = Aes256(key)
    let h = UInt64HiLo(bytes: a.encryptBlock([UInt8](repeating: 0, count: 16)))
    let j0 = iv + [0, 0, 0, 1]
    let expect = (ghash(h, aad, ct) ^ UInt64HiLo(bytes: a.encryptBlock(j0))).bytes
    if !ctEqual(expect, tag) { throw PrismSecureError.wrongPassword }
    return pt
}

// ---------------------------------------------------------------- PBKDF2-HMAC-SHA256 (RFC 2898)

func pbkdf2Sha256(password: [UInt8], salt: [UInt8], iterations: Int, outLen: Int = 32) -> [UInt8] {
    func hmac(_ key: [UInt8], _ msg: [UInt8]) -> [UInt8] {
        var k = key
        if k.count > 64 { k = sha256(k) }
        while k.count < 64 { k.append(0) }
        let ipad = k.map { $0 ^ 0x36 }, opad = k.map { $0 ^ 0x5c }
        return sha256(opad + sha256(ipad + msg))
    }
    var out = [UInt8]()
    var block: UInt32 = 1
    while out.count < outLen {
        var u = hmac(password, salt + be32(block))
        var t = u
        for _ in 1..<iterations {
            u = hmac(password, u)
            for i in 0..<32 { t[i] ^= u[i] }
        }
        out += t
        block += 1
    }
    return Array(out[..<outLen])
}

// ---------------------------------------------------------------- 256-bit modular arithmetic (P-256 field/group)
// Little-endian 4xUInt64 limbs. Bitwise modmul: simple, constant-shape, correct first.

struct U256: Equatable {
    var l: (UInt64, UInt64, UInt64, UInt64) // little-endian limbs
    static func == (a: U256, b: U256) -> Bool { a.l.0 == b.l.0 && a.l.1 == b.l.1 && a.l.2 == b.l.2 && a.l.3 == b.l.3 }
    init(_ v: (UInt64, UInt64, UInt64, UInt64)) { l = v }
    init(_ bytes: [UInt8]) { // big-endian 32 bytes
        var v = (UInt64(0), UInt64(0), UInt64(0), UInt64(0))
        for i in 0..<32 {
            let limb = 3 - i / 8, shift = UInt64(8 * (7 - i % 8)) // big-endian within each limb
            let cur = limb == 3 ? v.3 : limb == 2 ? v.2 : limb == 1 ? v.1 : v.0
            let nv = cur | (UInt64(bytes[i]) << shift)
            switch limb { case 3: v.3 = nv; case 2: v.2 = nv; case 1: v.1 = nv; default: v.0 = nv }
        }
        l = v
    }
    var bytes: [UInt8] {
        var out = [UInt8](repeating: 0, count: 32)
        for i in 0..<32 {
            let limb = 3 - i / 8, shift = UInt64(8 * (7 - i % 8))
            let cur = limb == 3 ? l.3 : limb == 2 ? l.2 : limb == 1 ? l.1 : l.0
            out[i] = UInt8(cur >> shift & 255)
        }
        return out
    }
    static let zero = U256((0, 0, 0, 0))
    static let one = U256((1, 0, 0, 0))
    var isZero: Bool { l == (0, 0, 0, 0) }
    func bit(_ i: Int) -> Bool {
        let v = i < 64 ? l.0 : i < 128 ? l.1 : i < 192 ? l.2 : l.3
        return (v >> UInt64(i % 64)) & 1 == 1
    }
    static func < (a: U256, b: U256) -> Bool {
        if a.l.3 != b.l.3 { return a.l.3 < b.l.3 }
        if a.l.2 != b.l.2 { return a.l.2 < b.l.2 }
        if a.l.1 != b.l.1 { return a.l.1 < b.l.1 }
        return a.l.0 < b.l.0
    }
    static func >= (a: U256, b: U256) -> Bool { !(a < b) }
    func adding(_ o: U256) -> (U256, Bool) {
        var c = false
        let r0 = l.0.addingReportingOverflow(o.l.0)
        let r0b = r0.partialValue.addingReportingOverflow(c ? 1 : 0)
        c = r0.overflow || r0b.overflow
        let r1 = l.1.addingReportingOverflow(o.l.1)
        let r1b = r1.partialValue.addingReportingOverflow(c ? 1 : 0)
        c = r1.overflow || r1b.overflow
        let r2 = l.2.addingReportingOverflow(o.l.2)
        let r2b = r2.partialValue.addingReportingOverflow(c ? 1 : 0)
        c = r2.overflow || r2b.overflow
        let r3 = l.3.addingReportingOverflow(o.l.3)
        let r3b = r3.partialValue.addingReportingOverflow(c ? 1 : 0)
        c = r3.overflow || r3b.overflow
        return (U256((r0b.partialValue, r1b.partialValue, r2b.partialValue, r3b.partialValue)), c)
    }
    func subtracting(_ o: U256) -> (U256, Bool) {
        var br = false
        let r0 = l.0.subtractingReportingOverflow(o.l.0)
        let r0b = r0.partialValue.subtractingReportingOverflow(br ? 1 : 0)
        br = r0.overflow || r0b.overflow
        let r1 = l.1.subtractingReportingOverflow(o.l.1)
        let r1b = r1.partialValue.subtractingReportingOverflow(br ? 1 : 0)
        br = r1.overflow || r1b.overflow
        let r2 = l.2.subtractingReportingOverflow(o.l.2)
        let r2b = r2.partialValue.subtractingReportingOverflow(br ? 1 : 0)
        br = r2.overflow || r2b.overflow
        let r3 = l.3.subtractingReportingOverflow(o.l.3)
        let r3b = r3.partialValue.subtractingReportingOverflow(br ? 1 : 0)
        br = r3.overflow || r3b.overflow
        return (U256((r0b.partialValue, r1b.partialValue, r2b.partialValue, r3b.partialValue)), br)
    }
}

let P256_P = U256((0xFFFFFFFFFFFFFFFF, 0x00000000FFFFFFFF, 0x0000000000000000, 0xFFFFFFFF00000001))
let P256_A = U256((0xFFFFFFFFFFFFFFFC, 0x00000000FFFFFFFF, 0x0000000000000000, 0xFFFFFFFF00000001))
let P256_B = U256((0x3bce3c3e27d2604b, 0x651d06b0cc53b0f6, 0xb3ebbd55769886bc, 0x5ac635d8aa3a93e7))
let P256_GX = U256((0xf4a13945d898c296, 0x77037d812deb33a0, 0xf8bce6e563a440f2, 0x6b17d1f2e12c4247))
let P256_GY = U256((0xcbb6406837bf51f5, 0x2bce33576b315ece, 0x8ee7eb4a7c0f9e16, 0x4fe342e2fe1a7f9b))
let P256_N = U256((0xf3b9cac2fc632551, 0xbce6faada7179e84, 0xFFFFFFFFFFFFFFFF, 0xFFFFFFFF00000000))

func modAdd(_ a: U256, _ b: U256, _ m: U256) -> U256 {
    let (s, carry) = a.adding(b)
    if carry || s >= m { return s.subtracting(m).0 }
    return s
}
func modSub(_ a: U256, _ b: U256, _ m: U256) -> U256 {
    let (d, borrow) = a.subtracting(b)
    if borrow { return d.adding(m).0 }
    return d
}
func modMul(_ a: U256, _ b: U256, _ m: U256) -> U256 {
    var r = U256.zero, aa = a
    for i in 0..<256 {
        if b.bit(i) { r = modAdd(r, aa, m) }
        aa = modAdd(aa, aa, m)
    }
    return r
}
func modPow(_ base: U256, _ exp: U256, _ m: U256) -> U256 {
    var r = U256.one, b = base
    for i in 0..<256 {
        if exp.bit(i) { r = modMul(r, b, m) }
        b = modMul(b, b, m)
    }
    return r
}
func modInv(_ a: U256, _ m: U256) -> U256 { modPow(a, modSub(m, U256((2,0,0,0)), m), m) }

// P-256 ECDSA, affine coordinates (clarity over speed; ~seconds per op)
typealias ECPoint = (x: U256, y: U256)?

func ecAdd(_ p1: ECPoint, _ p2: ECPoint) -> ECPoint {
    guard let a = p1 else { return p2 }
    guard let b = p2 else { return p1 }
    if a.x == b.x {
        if modAdd(a.y, b.y, P256_P).isZero { return nil }
        let x2 = modMul(a.x, a.x, P256_P)
        let num = modAdd(modAdd(modAdd(x2, x2, P256_P), x2, P256_P), P256_A, P256_P) // 3x^2 + a
        let m = modMul(num, modInv(modAdd(a.y, a.y, P256_P), P256_P), P256_P)
        let m2 = modMul(m, m, P256_P)
        let x3 = modSub(modSub(m2, a.x, P256_P), b.x, P256_P)
        return (x3, modSub(modMul(m, modSub(a.x, x3, P256_P), P256_P), a.y, P256_P))
    }
    let m = modMul(modSub(b.y, a.y, P256_P), modInv(modSub(b.x, a.x, P256_P), P256_P), P256_P)
    let m2 = modMul(m, m, P256_P)
    let x3 = modSub(modSub(m2, a.x, P256_P), b.x, P256_P)
    return (x3, modSub(modMul(m, modSub(a.x, x3, P256_P), P256_P), a.y, P256_P))
}

func ecMul(_ k: U256, _ pt: ECPoint) -> ECPoint {
    var r: ECPoint = nil
    var add = pt
    for i in 0..<256 {
        if k.bit(i) { r = ecAdd(r, add) }
        add = ecAdd(add, add)
    }
    return r
}

func ecdsaSign(_ d: U256, _ msg: [UInt8]) -> [UInt8] {
    let h = U256(sha256(msg))
    while true {
        var k = U256.zero
        while k.isZero || k >= P256_N { k = U256(randomBytes(32)) }
        guard let kg = ecMul(k, (P256_GX, P256_GY)) else { continue }
        let r = kg.x >= P256_N ? kg.x.subtracting(P256_N).0 : kg.x
        if r.isZero { continue }
        let s = modMul(modAdd(h, modMul(r, d, P256_N), P256_N), modInv(k, P256_N), P256_N)
        if s.isZero { continue }
        return r.bytes + s.bytes
    }
}

func ecdsaVerify(_ pubRaw: [UInt8], _ msg: [UInt8], _ sig: [UInt8]) -> Bool {
    guard pubRaw.count == 65, pubRaw[0] == 4, sig.count == 64 else { return false }
    let q: ECPoint = (U256(Array(pubRaw[1...32])), U256(Array(pubRaw[33...64])))
    // on-curve check
    let lhs = modMul(q!.y, q!.y, P256_P)
    let rhs = modAdd(modAdd(modMul(modMul(q!.x, q!.x, P256_P), q!.x, P256_P), modMul(P256_A, q!.x, P256_P), P256_P), P256_B, P256_P)
    guard lhs == rhs else { return false }
    let r = U256(Array(sig[0...31])), s = U256(Array(sig[32...63]))
    guard !r.isZero, r < P256_N, !s.isZero, s < P256_N else { return false }
    let h = U256(sha256(msg))
    let w = modInv(s, P256_N)
    guard let pt = ecAdd(ecMul(modMul(h, w, P256_N), (P256_GX, P256_GY)), ecMul(modMul(r, w, P256_N), q)) else { return false }
    let x = pt.x >= P256_N ? pt.x.subtracting(P256_N).0 : pt.x
    return x == r
}

// ---------------------------------------------------------------- key handling + fingerprints + passphrase + strength

struct SigningKey {
    var publicKey: [UInt8]   // 65 bytes raw 0x04||X||Y
    var d: U256              // private scalar
}

func generateSigningKey() -> SigningKey {
    var d = U256.zero
    while d.isZero || d >= P256_N { d = U256(randomBytes(32)) }
    let g = ecMul(d, (P256_GX, P256_GY))!
    return SigningKey(publicKey: [4] + g.x.bytes + g.y.bytes, d: d)
}

func fingerprint(_ pub: [UInt8]) -> String {
    let h = sha256(pub)
    let hexBytes = h[0..<8].map { String(format: "%02X", $0) }.joined() // 8 bytes = 16 hex chars, like the site
    var parts = [String]()
    for i in stride(from: 0, to: 16, by: 4) { parts.append(String(hexBytes[hexBytes.index(hexBytes.startIndex, offsetBy: i)..<hexBytes.index(hexBytes.startIndex, offsetBy: i + 4)])) }
    return parts.joined(separator: "-")
}

let PASS_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
func generatePassphrase() -> String {
    let r = randomBytes(28), a = Array(PASS_ALPHA)
    return (0..<7).map { g in (0..<4).map { i in String(a[Int(r[g * 4 + i]) & 31]) }.joined() }.joined(separator: "-")
}

let COMMON_WORDS = ["password","passw0rd","qwerty","letmein","welcome","admin","iloveyou","monkey","dragon","football","baseball","shalom","israel","master","login","abc123","prism","secret","hello","test","summer","winter","sunshine","princess","trustno1","whatever","google","avi","1234","asdf","zxcv","love","god","cohen","levi"]

func passwordStrength(_ pw: String) -> [String: Any] {
    var warnings = [String]()
    if pw.isEmpty { return ["bits": 0, "label": "none", "level": 0, "warnings": ["Enter a password"]] }
    let body = pw.replacingOccurrences(of: "-", with: "")
    if pw.split(separator: "-", omittingEmptySubsequences: false).count >= 6,
       pw.range(of: "^[A-HJ-NP-Z2-9-]+$", options: .regularExpression) != nil, body.count >= 24 {
        return ["bits": body.count * 5, "label": "excellent (random)", "level": 4, "warnings": [String]()]
    }
    var pool = 0
    if pw.range(of: "[a-z]", options: .regularExpression) != nil { pool += 26 }
    if pw.range(of: "[A-Z]", options: .regularExpression) != nil { pool += 26 }
    if pw.range(of: "[0-9]", options: .regularExpression) != nil { pool += 10 }
    if pw.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil { pool += 33 }
    let uniq = Set(pw).count
    var bits = Double(min(pw.count, uniq * 2)) * log2(Double(max(pool, 2)))
    let low = pw.lowercased()
    if pw.range(of: "^[a-z ]+$", options: [.regularExpression, .caseInsensitive]) != nil {
        let w = pw.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).filter { $0.count > 2 }.count
        bits = min(bits, w > 1 ? Double(w) * 12 : Double(pw.count) * 2.5)
        if w <= 1 { warnings.append("A single word is easy to guess") }
    }
    if pw.range(of: "(.)\\1\\1", options: .regularExpression) != nil { bits *= 0.7; warnings.append("Repeated characters") }
    if pw.range(of: "(012|123|234|345|456|567|678|789|abc|bcd|cde|def|qwe|wer|asd|sdf|zxc)", options: [.regularExpression, .caseInsensitive]) != nil { bits *= 0.7; warnings.append("Keyboard or number sequence") }
    if pw.range(of: "^[a-z]+$", options: [.regularExpression, .caseInsensitive]) != nil || pw.range(of: "^[0-9]+$", options: .regularExpression) != nil { bits *= 0.8; warnings.append("Only one kind of character") }
    if pw.range(of: "(19|20)[0-9][0-9]\\b", options: .regularExpression) != nil { bits -= 8; warnings.append("Contains a year") }
    for w in COMMON_WORDS where low.contains(w) {
        bits = min(bits, 28) - (low == w ? 8 : 0)
        warnings.append("Contains a common word or pattern")
        break
    }
    if pw.count < 12 { warnings.append("Shorter than 12 characters") }
    let bitsI = max(0, Int(bits))
    let level = bitsI < 40 ? 0 : bitsI < 60 ? 1 : bitsI < 80 ? 2 : bitsI < 100 ? 3 : 4
    if bitsI < 80 { warnings.append("Someone with a photo of the code can guess offline. Use Random for a code that matters.") }
    var seen = [String]()
    for w in warnings where !seen.contains(w) { seen.append(w) }
    return ["bits": bitsI, "level": level, "label": ["weak","weak","fair","good","strong"][level], "warnings": seen]
}

// ---------------------------------------------------------------- seal / open

func deriveKey(_ password: String, _ salt: [UInt8], _ kdf: Int, _ params: [String: Int]) -> [UInt8] {
    let pw = nfkc(password)
    if kdf == 2 {
        return argon2id(password: pw, salt: salt, memKiB: params["mem"]!, passes: params["t"]!, lanes: params["p"] ?? 1, outLen: 32)
    }
    return pbkdf2Sha256(password: pw, salt: salt, iterations: params["iter"]!)
}

func prismSeal(_ data: [UInt8], password: String? = nil, signWith: SigningKey? = nil, kdf: String? = nil) throws -> [UInt8] {
    if password == nil && signWith == nil { throw PrismSecureError.noCredential }
    let flags: UInt8 = (password != nil ? F_ENC : 0) | (signWith != nil ? F_SIG : 0)
    var body: [UInt8]
    if let password {
        let useA = kdf != nil ? kdf == "argon2id" : true
        let salt = randomBytes(16), iv = randomBytes(12)
        let params = useA ? be32(UInt32(A2_MEM)) + [UInt8(A2_T), UInt8(A2_P)] : be32(UInt32(PBKDF2_ITER)) + [0, 0]
        let head = PSC_MAGIC + [2, flags, useA ? 2 : 1] + params + salt + iv
        let key = deriveKey(password, salt, useA ? 2 : 1, useA ? ["mem": A2_MEM, "t": A2_T, "p": A2_P] : ["iter": PBKDF2_ITER])
        body = head + aesGcmEncrypt(key, iv, data, head)
    } else {
        body = PSC_MAGIC + [2, flags] + data
    }
    guard let signWith else { return body }
    let sig = ecdsaSign(signWith.d, body)
    return body + signWith.publicKey + sig
}

struct OpenResult {
    var secure = false, encrypted = false, signed = false
    var version = 0
    var signatureValid: Bool? = nil
    var signerPublicKey: [UInt8]? = nil
    var signerFingerprint: String? = nil
    var trusted = false, needsPassword = false
    var bytes: [UInt8]? = nil
    var error: String? = nil
}

func prismIsSecure(_ b: [UInt8]) -> Bool {
    b.count >= 6 && Array(b[0..<3]) == PSC_MAGIC && (b[3] == 1 || b[3] == 2) && (b[4] & ~3) == 0
}

func prismOpen(_ bytes: [UInt8], password: String? = nil, trustedFingerprints: [String] = []) throws -> OpenResult {
    if !prismIsSecure(bytes) { return OpenResult(secure: false, bytes: bytes) }
    let ver = bytes[3], flags = bytes[4]
    var out = OpenResult()
    out.secure = true; out.version = Int(ver)
    out.encrypted = flags & F_ENC != 0; out.signed = flags & F_SIG != 0
    var end = bytes.count
    if out.signed {
        if bytes.count < 5 + 65 + 64 { throw PrismSecureError.damaged }
        let pub = Array(bytes[(end - 129)..<(end - 64)])
        let sig = Array(bytes[(end - 64)..<end])
        let body = Array(bytes[0..<(end - 129)])
        out.signatureValid = ecdsaVerify(pub, body, sig)
        out.signerPublicKey = pub
        out.signerFingerprint = fingerprint(pub)
        out.trusted = (out.signatureValid ?? false) && trustedFingerprints.contains { ctEqual(Array($0.utf8), Array(out.signerFingerprint!.utf8)) }
        end -= 129
        if out.signatureValid != true {
            out.bytes = nil
            out.error = "Signature is not valid. This code was changed or forged."
            return out
        }
    }
    if !out.encrypted {
        out.bytes = Array(bytes[5..<end])
        return out
    }
    let hl: Int, salt: [UInt8], iv: [UInt8], kdf: Int
    var params = [String: Int]()
    if ver == 1 {
        hl = HEAD1
        if end < hl + 16 { throw PrismSecureError.damaged }
        salt = Array(bytes[5..<21]); iv = Array(bytes[21..<33]); kdf = 1
        params = ["iter": Int(rd32(bytes, 33))]
    } else {
        hl = HEAD2
        if end < hl + 16 { throw PrismSecureError.damaged }
        kdf = Int(bytes[5])
        salt = Array(bytes[12..<28]); iv = Array(bytes[28..<40])
        params = kdf == 2 ? ["mem": Int(rd32(bytes, 6)), "t": Int(bytes[10]), "p": Int(bytes[11])] : ["iter": Int(rd32(bytes, 6))]
    }
    let head = Array(bytes[0..<hl])
    if kdf == 1 {
        guard params["iter"]! >= 100000 && params["iter"]! <= 5000000 else { throw PrismSecureError.unsupported }
    } else if kdf == 2 {
        guard params["mem"]! >= 8192 && params["mem"]! <= MAX_MEM && params["t"]! >= 1 && params["t"]! <= MAX_T && params["p"]! >= 1 && params["p"]! <= 4 else { throw PrismSecureError.unsupported }
    } else { throw PrismSecureError.unsupported }
    guard let password else {
        out.bytes = nil; out.needsPassword = true
        return out
    }
    let key = deriveKey(password, salt, kdf, params)
    do {
        out.bytes = try aesGcmDecrypt(key, iv, Array(bytes[hl..<end]), head)
    } catch {
        out.bytes = nil
        out.error = "Wrong password, or the code was changed."
    }
    return out
}

// ---------------------------------------------------------------- key JSON (site shape)

func signingKeyToJson(_ k: SigningKey) -> String {
    var pub = "{"
    for i in 0..<65 { pub += "\"\(i)\":\(k.publicKey[i])" + (i < 64 ? "," : "") }
    pub += "}"
    func b64u(_ b: [UInt8]) -> String {
        Foundation.Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    let x = Array(k.publicKey[1...32]), y = Array(k.publicKey[33...64])
    return "{\"publicKey\":\(pub),\"privateJwk\":{\"key_ops\":[\"sign\"],\"ext\":true,\"kty\":\"EC\",\"x\":\"\(b64u(x))\",\"y\":\"\(b64u(y))\",\"crv\":\"P-256\",\"d\":\"\(b64u(k.d.bytes))\"}}"
}

func signingKeyFromJson(_ json: String) throws -> SigningKey {
    guard let data = json.data(using: .utf8),
          let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let pubObj = obj["publicKey"] as? [String: Any],
          let jwk = obj["privateJwk"] as? [String: Any],
          let dStr = jwk["d"] as? String else { throw PrismSecureError.badKey }
    var pub = [UInt8]()
    for i in 0..<65 {
        guard let v = pubObj["\(i)"] as? Int else { throw PrismSecureError.badKey }
        pub.append(UInt8(v))
    }
    var b64 = dStr.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let dBytes = Foundation.Data(base64Encoded: b64) else { throw PrismSecureError.badKey }
    return SigningKey(publicKey: pub, d: U256([UInt8](dBytes)))
}
