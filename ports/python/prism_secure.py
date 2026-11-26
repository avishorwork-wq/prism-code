# Prism Secure (Python port) — password lock + maker signatures for Prism Code payloads.
#
# Pure Python 3 standard library, zero dependencies. Wire-compatible with the live
# Prism Secure module (prism-secure.html) at https://github.com/avishorwork-wq/prism-code.
#
# - Password lock: AES-256-GCM; key from Argon2id (default 128 MiB, 3 passes)
#   or PBKDF2-SHA256 600,000 iterations (hashlib). Header authenticated as AAD.
# - Signatures: ECDSA P-256/SHA-256, raw 64-byte r||s, maker fingerprints.
# - Opens v2 and legacy v1 codes.
#
# Argon2id (RFC 9106), AES (FIPS-197) and GCM/ECDSA (SP 800-38D / FIPS 186-5) are
# implemented here from scratch. Blake2b and PBKDF2 come from hashlib.
#
# Note: pure-Python Argon2id at the site default (128 MiB, t=3) takes roughly a
# minute per derivation. seal()/open() accept smaller argon2 parameters (the live
# reader accepts mem 8192..262144 KiB, t 1..12), and --kdf pbkdf2 is fast.

import hashlib, json, secrets, struct, unicodedata

MAGIC = b"PSC"
F_ENC, F_SIG = 1, 2
PBKDF2_ITER = 600000
A2 = {"mem": 131072, "t": 3, "p": 1}
MAX_MEM, MAX_T = 262144, 12
HEAD2 = 4 + 1 + 1 + 6 + 16 + 12
HEAD1 = 4 + 1 + 16 + 12 + 4

be32 = lambda n: struct.pack(">I", n)
rd32 = lambda b, i: struct.unpack(">I", b[i:i + 4])[0]

def _nfkc(s):
    return unicodedata.normalize("NFKC", s).encode("utf-8")

def ctEqual(a, b):
    if isinstance(a, str): a = a.encode()
    if isinstance(b, str): b = b.encode()
    d = len(a) ^ len(b)
    for i in range(max(len(a), len(b))):
        d |= (a[i] if i < len(a) else 0) ^ (b[i] if i < len(b) else 0)
    return d == 0

def _in_list(lst, v):
    return any(ctEqual(x, v) for x in lst)

# ---------------------------------------------------------------- Argon2id (RFC 9106)

_MASK = 0xFFFFFFFFFFFFFFFF

def _blake2b(data, n):
    return hashlib.blake2b(data, digest_size=n).digest()

def _hprime(data, outlen):
    le = struct.pack("<I", outlen)
    if outlen <= 64:
        return _blake2b(le + data, outlen)
    v = _blake2b(le + data, 64)
    out = bytearray(v[:32])
    rem = outlen - 32
    while rem > 64:
        v = _blake2b(v, 64)
        out += v[:32]
        rem -= 32
    out += _blake2b(v, rem)
    return bytes(out)

_G_POS = ((0,4,8,12),(1,5,9,13),(2,6,10,14),(3,7,11,15),
          (0,5,10,15),(1,6,11,12),(2,7,8,13),(3,4,9,14))

def _permute16(v, off):
    """Argon2's P: one message-less Blake2b round (BlaMka) over 16 words."""
    M = _MASK
    for a, b, c, d in _G_POS:
        a += off; b += off; c += off; d += off
        va, vb, vc, vd = v[a], v[b], v[c], v[d]
        va = (va + vb + 2 * (va & 0xFFFFFFFF) * (vb & 0xFFFFFFFF)) & M
        vd = ((vd ^ va) >> 32 | ((vd ^ va) << 32)) & M
        vc = (vc + vd + 2 * (vc & 0xFFFFFFFF) * (vd & 0xFFFFFFFF)) & M
        vb = ((vb ^ vc) >> 24 | ((vb ^ vc) << 40)) & M
        va = (va + vb + 2 * (va & 0xFFFFFFFF) * (vb & 0xFFFFFFFF)) & M
        vd = ((vd ^ va) >> 16 | ((vd ^ va) << 48)) & M
        vc = (vc + vd + 2 * (vc & 0xFFFFFFFF) * (vd & 0xFFFFFFFF)) & M
        vb = ((vb ^ vc) >> 63 | ((vb ^ vc) << 1)) & M
        v[a], v[b], v[c], v[d] = va, vb, vc, vd

def _fill_block(mem, prev_i, ref_i, cur_i, with_xor):
    """mem is a flat list of 128-word blocks; indices are block indices."""
    po, ro, co = prev_i * 128, ref_i * 128, cur_i * 128
    r = [mem[po + i] ^ mem[ro + i] for i in range(128)]
    z = r[:]
    for row in range(8):
        _permute16(z, row * 16)
    col = [0] * 16
    for c in range(8):
        c2 = c * 2
        for row in range(8):
            col[row * 2] = z[row * 16 + c2]
            col[row * 2 + 1] = z[row * 16 + c2 + 1]
        _permute16(col, 0)
        for row in range(8):
            z[row * 16 + c2] = col[row * 2]
            z[row * 16 + c2 + 1] = col[row * 2 + 1]
    if with_xor:
        for i in range(128):
            mem[co + i] ^= z[i] ^ r[i]
    else:
        for i in range(128):
            mem[co + i] = z[i] ^ r[i]

def argon2id(password, salt, mem_kib, passes, lanes=1, outlen=32):
    if lanes != 1:
        raise ValueError("only p=1 supported")
    m_prime = (mem_kib // 4) * 4
    lane_len = m_prime
    seg_len = lane_len // 4
    mem = [0] * (m_prime * 128)
    h0in = (struct.pack("<6I", 1, outlen, mem_kib, passes, 0x13, 2)
            + struct.pack("<I", len(password)) + password
            + struct.pack("<I", len(salt)) + salt + struct.pack("<II", 0, 0))
    h0 = _blake2b(h0in, 64)
    for i in range(2):
        blk = _hprime(h0 + struct.pack("<II", i, 0), 1024)
        mem[i * 128:(i + 1) * 128] = struct.unpack("<128Q", blk)
    zero = [0] * 128
    for ps in range(passes):
        for sl in range(4):
            di = ps == 0 and sl < 2
            addr_block = None
            if di:
                addr_in = [ps, 0, sl, m_prime, passes, 2, 0] + [0] * 121
                if sl == 0:  # reference pre-generates the first address block for slice 0
                    addr_in[6] = 1
                    addr_block = _g_address(zero, addr_in)
            start = 2 if (ps == 0 and sl == 0) else 0
            for idx in range(start, seg_len):
                cur = sl * seg_len + idx
                prev = cur - 1 if cur % lane_len != 0 else lane_len - 1
                if di:
                    if idx % 128 == 0:
                        addr_in[6] += 1
                        addr_block = _g_address(zero, addr_in)
                    w = addr_block[idx % 128]
                    j1 = w & 0xFFFFFFFF
                else:
                    j1 = mem[prev * 128] & 0xFFFFFFFF
                if ps == 0:
                    area = idx - 1 if sl == 0 else sl * seg_len + idx - 1
                else:
                    area = lane_len - seg_len + idx - 1
                x = (j1 * j1) >> 32
                rel = area - 1 - ((area * x) >> 32)
                startpos = 0 if ps == 0 else (0 if sl == 3 else (sl + 1) * seg_len)
                ref = (startpos + rel) % lane_len
                _fill_block(mem, prev, ref, cur, ps != 0)
    last = struct.pack("<128Q", *mem[(lane_len - 1) * 128:lane_len * 128])
    return _hprime(last, outlen)

def _g_address(zero, addr_in):
    """G(G(zero, input)) without xor, as in data-independent addressing."""
    def G(x, y):
        r = [a ^ b for a, b in zip(x, y)]
        z = r[:]
        for row in range(8):
            _permute16(z, row * 16)
        col = [0] * 16
        for c in range(8):
            c2 = c * 2
            for row in range(8):
                col[row * 2] = z[row * 16 + c2]
                col[row * 2 + 1] = z[row * 16 + c2 + 1]
            _permute16(col, 0)
            for row in range(8):
                z[row * 16 + c2] = col[row * 2]
                z[row * 16 + c2 + 1] = col[row * 2 + 1]
        return [zz ^ rr for zz, rr in zip(z, r)]
    return G(zero, G(zero, addr_in))

# ---------------------------------------------------------------- AES-256 (FIPS-197) + GCM (SP 800-38D)

_SBOX = (
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
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16)
_RCON = (0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36)

def _xtime(a):
    return ((a << 1) ^ (0x1b if a & 0x80 else 0)) & 0xFF

def _mul(a, b):
    r = 0
    while b:
        if b & 1: r ^= a
        a = _xtime(a); b >>= 1
    return r

class _Aes256:
    __slots__ = ("rk",)
    def __init__(self, key):
        assert len(key) == 32
        w = [list(key[4*i:4*i+4]) for i in range(8)]
        for i in range(8, 60):
            t = w[i-1][:]
            if i % 8 == 0:
                t = [_SBOX[t[1]] ^ _RCON[i//8 - 1], _SBOX[t[2]], _SBOX[t[3]], _SBOX[t[0]]]
            elif i % 8 == 4:
                t = [_SBOX[c] for c in t]
            w.append([w[i-8][j] ^ t[j] for j in range(4)])
        self.rk = w  # 60 words
    def encrypt_block(self, block):
        s = [list(block[r::4]) for r in range(4)]  # state[row][col] = block[col*4+row]
        s = [[s[r][c] for c in range(4)] for r in range(4)]
        def add_rk(rnd):
            for c in range(4):
                for r in range(4):
                    s[r][c] ^= self.rk[rnd*4 + c][r]
        add_rk(0)
        for rnd in range(1, 15):
            for r in range(4):
                for c in range(4):
                    s[r][c] = _SBOX[s[r][c]]
            for r in range(1, 4):
                s[r] = s[r][r:] + s[r][:r]
            if rnd < 14:
                for c in range(4):
                    col = [s[r][c] for r in range(4)]
                    s[0][c] = _mul(col[0],2) ^ _mul(col[1],3) ^ col[2] ^ col[3]
                    s[1][c] = col[0] ^ _mul(col[1],2) ^ _mul(col[2],3) ^ col[3]
                    s[2][c] = col[0] ^ col[1] ^ _mul(col[2],2) ^ _mul(col[3],3)
                    s[3][c] = _mul(col[0],3) ^ col[1] ^ col[2] ^ _mul(col[3],2)
            add_rk(rnd)
        return bytes(s[r][c] for c in range(4) for r in range(4))

def _gcm_mul(x, y):
    """Multiply in GF(2^128) with the GCM polynomial."""
    R = 0xE1000000000000000000000000000000
    z = 0
    v = x
    for i in range(128):
        if (y >> (127 - i)) & 1:
            z ^= v
        v = (v >> 1) ^ (R if v & 1 else 0)
    return z

def _ghash(h, aad, ct):
    x = 0
    def blocks(data):
        for i in range(0, len(data), 16):
            b = data[i:i+16]
            yield b + b"\0" * (16 - len(b))
    for b in blocks(aad):
        x = _gcm_mul(x ^ int.from_bytes(b, "big"), h)
    for b in blocks(ct):
        x = _gcm_mul(x ^ int.from_bytes(b, "big"), h)
    lb = (len(aad) * 8).to_bytes(8, "big") + (len(ct) * 8).to_bytes(8, "big")
    x = _gcm_mul(x ^ int.from_bytes(lb, "big"), h)
    return x

def aes_gcm_encrypt(key, iv, data, aad):
    a = _Aes256(key)
    h = int.from_bytes(a.encrypt_block(b"\0" * 16), "big")
    j0 = iv + b"\0\0\0\1"
    ctr = int.from_bytes(j0, "big")
    out = bytearray()
    for i in range(0, len(data), 16):
        ctr = (ctr & ~0xFFFFFFFF) | ((ctr + 1) & 0xFFFFFFFF)
        ks = a.encrypt_block(ctr.to_bytes(16, "big"))
        blk = data[i:i+16]
        out += bytes(x ^ y for x, y in zip(blk, ks))
    tag = _ghash(h, aad, bytes(out)) ^ int.from_bytes(a.encrypt_block(j0), "big")
    return bytes(out) + tag.to_bytes(16, "big")

def aes_gcm_decrypt(key, iv, data, aad):
    if len(data) < 16:
        raise ValueError("Code is damaged")
    ct, tag = data[:-16], data[-16:]
    pt = aes_gcm_encrypt(key, iv, ct, aad)[:-16]
    a = _Aes256(key)
    h = int.from_bytes(a.encrypt_block(b"\0" * 16), "big")
    j0 = iv + b"\0\0\0\1"
    expect = (_ghash(h, aad, ct) ^ int.from_bytes(a.encrypt_block(j0), "big")).to_bytes(16, "big")
    if not ctEqual(expect, tag):
        raise ValueError("Wrong password, or the code was changed.")
    return pt

# ---------------------------------------------------------------- ECDSA P-256 (FIPS 186-5)

_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff
_A = _P - 3
_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
_GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296
_GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5
_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551

def _pt_add(p1, p2):
    if p1 is None: return p2
    if p2 is None: return p1
    x1, y1 = p1; x2, y2 = p2
    if x1 == x2:
        if (y1 + y2) % _P == 0: return None
        m = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        m = (y2 - y1) * pow((x2 - x1) % _P, -1, _P) % _P
    x3 = (m * m - x1 - x2) % _P
    return x3, (m * (x1 - x3) - y1) % _P

def _pt_mul(k, pt):
    r = None
    add = pt
    while k:
        if k & 1: r = _pt_add(r, add)
        add = _pt_add(add, add)
        k >>= 1
    return r

def _b64u(b):
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()

def _b64u_dec(s):
    import base64
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def generate_signing_key():
    d = secrets.randbelow(_N - 1) + 1
    x, y = _pt_mul(d, (_GX, _GY))
    pub = b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big")
    jwk = {"key_ops": ["sign"], "ext": True, "kty": "EC",
           "x": _b64u(x.to_bytes(32, "big")), "y": _b64u(y.to_bytes(32, "big")),
           "crv": "P-256", "d": _b64u(d.to_bytes(32, "big"))}
    return {"publicKey": {str(i): pub[i] for i in range(65)}, "privateJwk": jwk}

def _pub_bytes(key):
    pk = key["publicKey"]
    if isinstance(pk, dict):
        return bytes(pk[str(i)] for i in range(65))
    return bytes(pk)

def _priv_scalar(key):
    return int.from_bytes(_b64u_dec(key["privateJwk"]["d"]), "big")

def _pub_from_raw(raw):
    if len(raw) != 65 or raw[0] != 4:
        raise ValueError("bad public key")
    return int.from_bytes(raw[1:33], "big"), int.from_bytes(raw[33:], "big")

def ecdsa_sign(d, msg):
    h = int.from_bytes(hashlib.sha256(msg).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        x, _ = _pt_mul(k, (_GX, _GY))
        r = x % _N
        if r == 0: continue
        s = ((h + r * d) * pow(k, -1, _N)) % _N
        if s == 0: continue
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

def ecdsa_verify(pub_raw, msg, sig):
    if len(sig) != 64: return False
    try:
        q = _pub_from_raw(pub_raw)
        # on-curve check
        if (q[1] * q[1] - (q[0] ** 3 + _A * q[0] + _B)) % _P != 0: return False
        r = int.from_bytes(sig[:32], "big"); s = int.from_bytes(sig[32:], "big")
        if not (1 <= r < _N and 1 <= s < _N): return False
        h = int.from_bytes(hashlib.sha256(msg).digest(), "big")
        w = pow(s, -1, _N)
        pt = _pt_add(_pt_mul((h * w) % _N, (_GX, _GY)), _pt_mul((r * w) % _N, q))
        return pt is not None and pt[0] % _N == r
    except Exception:
        return False

def fingerprint(pub):
    h = hashlib.sha256(bytes(pub)).hexdigest().upper()[:16]  # first 8 bytes = 16 hex chars, like the site
    return "-".join(h[i:i+4] for i in range(0, 16, 4))

# ---------------------------------------------------------------- passphrase + strength

_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

def generate_passphrase():
    r = secrets.token_bytes(28)
    return "-".join("".join(_ALPHA[r[g*4+i] & 31] for i in range(4)) for g in range(7))

_COMMON = ['password','passw0rd','qwerty','letmein','welcome','admin','iloveyou','monkey','dragon','football','baseball','shalom','israel','master','login','abc123','prism','secret','hello','test','summer','winter','sunshine','princess','trustno1','whatever','google','avi','1234','asdf','zxcv','love','god','cohen','levi']

def strength(pw):
    import re, math
    warnings = []
    if not pw:
        return {"bits": 0, "label": "none", "level": 0, "warnings": ["Enter a password"]}
    body = pw.replace("-", "")
    if len(pw.split("-")) >= 6 and re.fullmatch(r"[A-HJ-NP-Z2-9-]+", pw) and len(body) >= 24:
        return {"bits": len(body) * 5, "label": "excellent (random)", "level": 4, "warnings": []}
    pool = 0
    if re.search(r"[a-z]", pw): pool += 26
    if re.search(r"[A-Z]", pw): pool += 26
    if re.search(r"[0-9]", pw): pool += 10
    if re.search(r"[^A-Za-z0-9]", pw): pool += 33
    uniq = len(set(pw))
    bits = min(len(pw), uniq * 2) * math.log2(max(pool, 2))
    low = pw.lower()
    if re.fullmatch(r"[a-z ]+", pw, re.I):
        w = len([x for x in pw.strip().split() if len(x) > 2])
        bits = min(bits, w * 12 if w > 1 else len(pw) * 2.5)
        if w <= 1: warnings.append("A single word is easy to guess")
    if re.search(r"(.)\1\1", pw):
        bits *= 0.7; warnings.append("Repeated characters")
    if re.search(r"(012|123|234|345|456|567|678|789|abc|bcd|cde|def|qwe|wer|asd|sdf|zxc)", pw, re.I):
        bits *= 0.7; warnings.append("Keyboard or number sequence")
    if re.fullmatch(r"[a-z]+", pw, re.I) or re.fullmatch(r"[0-9]+", pw):
        bits *= 0.8; warnings.append("Only one kind of character")
    if re.search(r"(19|20)\d\d\b", pw):
        bits -= 8; warnings.append("Contains a year")
    for w in _COMMON:
        if w in low:
            bits = min(bits, 28) - (8 if low == w else 0)
            warnings.append("Contains a common word or pattern")
            break
    if len(pw) < 12: warnings.append("Shorter than 12 characters")
    bits = max(0, int(bits // 1))
    level = 0 if bits < 40 else 1 if bits < 60 else 2 if bits < 80 else 3 if bits < 100 else 4
    if bits < 80:
        warnings.append("Someone with a photo of the code can guess offline. Use Random for a code that matters.")
    seen = []
    for w in warnings:
        if w not in seen: seen.append(w)
    return {"bits": bits, "level": level,
            "label": ["weak","weak","fair","good","strong"][level], "warnings": seen}

# ---------------------------------------------------------------- seal / open

def _derive_key(password, salt, kdf, params, argon_params=None):
    pw = _nfkc(password)
    if kdf == 2:
        raw = argon2id(pw, salt, params["mem"], params["t"], params.get("p", 1), 32)
    else:
        raw = hashlib.pbkdf2_hmac("sha256", pw, salt, params["iter"], 32)
    return raw

def seal(data, password=None, sign_with=None, kdf=None, argon_mem=None, argon_t=None):
    data = bytes(data)
    if not password and not sign_with:
        raise ValueError("Give a password, a signing key, or both")
    flags = (F_ENC if password else 0) | (F_SIG if sign_with else 0)
    if password:
        use_a = (kdf == "argon2id") if kdf else True
        a2 = {"mem": argon_mem or A2["mem"], "t": argon_t or A2["t"], "p": 1}
        salt = secrets.token_bytes(16)
        iv = secrets.token_bytes(12)
        params = (be32(a2["mem"]) + bytes([a2["t"], a2["p"]])) if use_a else (be32(PBKDF2_ITER) + b"\0\0")
        head = MAGIC + b"\x02" + bytes([flags, 2 if use_a else 1]) + params + salt + iv
        key = _derive_key(password, salt, 2 if use_a else 1, a2 if use_a else {"iter": PBKDF2_ITER})
        body = head + aes_gcm_encrypt(key, iv, data, head)
    else:
        body = MAGIC + b"\x02" + bytes([flags]) + data
    if not sign_with:
        return body
    sig = ecdsa_sign(_priv_scalar(sign_with), body)
    return body + _pub_bytes(sign_with) + sig

def is_secure(b):
    return (len(b) >= 6 and b[:3] == MAGIC and b[3] in (1, 2) and (b[4] & ~3) == 0)

def inspect(b):
    if not is_secure(b):
        return {"secure": False}
    return {"secure": True, "version": b[3], "encrypted": bool(b[4] & F_ENC), "signed": bool(b[4] & F_SIG)}

def open(data, password=None, trusted_fingerprints=()):
    bytes_in = bytes(data)
    if not is_secure(bytes_in):
        return {"secure": False, "bytes": bytes_in}
    ver, flags = bytes_in[3], bytes_in[4]
    encrypted, signed = bool(flags & F_ENC), bool(flags & F_SIG)
    end = len(bytes_in)
    out = {"secure": True, "version": ver, "encrypted": encrypted, "signed": signed, "signatureValid": None}
    if signed:
        if len(bytes_in) < 5 + 65 + 64:
            raise ValueError("Code is damaged")
        pub = bytes_in[end-129:end-64]
        sig = bytes_in[end-64:end]
        body = bytes_in[:end-129]
        out["signatureValid"] = ecdsa_verify(pub, body, sig)
        out["signerPublicKey"] = pub
        out["signerFingerprint"] = fingerprint(pub)
        out["trusted"] = bool(out["signatureValid"]) and _in_list(list(trusted_fingerprints), out["signerFingerprint"])
        end -= 129
        if not out["signatureValid"]:
            out["bytes"] = None
            out["error"] = "Signature is not valid. This code was changed or forged."
            return out
    if not encrypted:
        out["bytes"] = bytes_in[5:end]
        return out
    if ver == 1:
        hl = HEAD1
        if end < hl + 16: raise ValueError("Code is damaged")
        salt, iv, kdf = bytes_in[5:21], bytes_in[21:33], 1
        p = {"iter": rd32(bytes_in, 33)}
    else:
        hl = HEAD2
        if end < hl + 16: raise ValueError("Code is damaged")
        kdf = bytes_in[5]
        salt, iv = bytes_in[12:28], bytes_in[28:40]
        p = {"mem": rd32(bytes_in, 6), "t": bytes_in[10], "p": bytes_in[11]} if kdf == 2 else {"iter": rd32(bytes_in, 6)}
    head = bytes_in[:hl]
    if kdf == 1:
        if not (100000 <= p["iter"] <= 5000000): raise ValueError("Code is damaged or unsupported")
    elif kdf == 2:
        if not (8192 <= p["mem"] <= MAX_MEM and 1 <= p["t"] <= MAX_T and 1 <= p["p"] <= 4):
            raise ValueError("Code is damaged or unsupported")
    else:
        raise ValueError("Code is damaged or unsupported")
    if not password:
        out["bytes"] = None
        out["needsPassword"] = True
        return out
    key = _derive_key(password, salt, kdf, p)
    try:
        out["bytes"] = aes_gcm_decrypt(key, iv, bytes_in[hl:end], head)
    except ValueError:
        out["bytes"] = None
        out["error"] = "Wrong password, or the code was changed."
    return out
