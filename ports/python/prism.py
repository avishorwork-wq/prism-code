"""Prism Code - Python 3 port of the live JavaScript encoder/decoder.

Source of truth: prism.html (const Prism module) in
https://github.com/avishorwork-wq/prism-code

Pure standard library. PNG writing and reading use zlib + struct only.

Format (as implemented by the live site):
  Pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray coding
  (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to 113x130 cells.
  Filled corner gap pattern, asymmetric ring, pilot cells, triplicated
  CRC-4 header, seeded cell shuffle, GF(256)/0x11D Reed-Solomon blocks,
  payload CRC-32.
"""

import struct
import zlib

S3 = 3 ** 0.5  # math.sqrt(3); matches JS Math.sqrt(3) bit-for-bit
Q = 3 * S3
SIZES = [(21, 24), (29, 33), (41, 47), (57, 66), (81, 94), (113, 130)]
HEX = ['#1B1B1B', '#2E5BFF', '#00B8D9', '#2DB35A', '#F5C518', '#F77F00',
       '#D7263D', '#B5179E', '#FFFFFF']
PAL = [(int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)) for h in HEX]

M32 = 0xFFFFFFFF


# ---------------------------------------------------------------- rng / crc

def _rng(seed):
    """Exact port of the JS mulberry-style rng (returns floats in [0,1))."""
    seed &= M32
    while True:
        seed = (seed + 0x6D2B79F5) & M32
        t = ((seed ^ (seed >> 15)) * (1 | seed)) & M32
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & M32)) & M32) ^ t
        yield ((t ^ (t >> 14)) & M32) / 4294967296.0


def _crc_table():
    t = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (0xEDB88320 ^ (c >> 1)) if (c & 1) else (c >> 1)
        t.append(c & M32)
    return t


_CRC_TABLE = _crc_table()


def crc32(data):
    c = 0xFFFFFFFF
    for b in data:
        c = _CRC_TABLE[(c ^ b) & 255] ^ (c >> 8)
    return (c ^ 0xFFFFFFFF) & M32


def crc4(bits):
    r = 0
    for b in bits:
        f = ((r >> 3) & 1) ^ b
        r = (r << 1) & 15
        if f:
            r ^= 3
    return r


def PADK(o):
    x = ((o + 0x9E3779B9) & M32) * 0x85EBCA6B & M32
    x ^= x >> 13
    x = x * 0xC2B2AE35 & M32
    x ^= x >> 16
    return x & 255


# ---------------------------------------------------------------- GF(256)

EXP = [0] * 512
LOG = [0] * 256
_z = 1
for _i in range(255):
    EXP[_i] = _z
    LOG[_z] = _i
    _z <<= 1
    if _z & 256:
        _z ^= 0x11D
for _i in range(255, 512):
    EXP[_i] = EXP[_i - 255]


def _gmul(a, b):
    return EXP[LOG[a] + LOG[b]] if (a and b) else 0


def _gdiv(a, b):
    if not b:
        raise ValueError('GF division by zero')
    return EXP[(LOG[a] + 255 - LOG[b]) % 255] if a else 0


def _peval(p, x):
    y = 0
    for i in range(len(p) - 1, -1, -1):
        y = _gmul(y, x) ^ p[i]
    return y


def _pmul(a, b):
    o = [0] * (len(a) + len(b) - 1)
    for i in range(len(a)):
        ai = a[i]
        if ai:
            for j in range(len(b)):
                o[i + j] ^= _gmul(ai, b[j])
    return o


_gen_cache = {}


def rsEncode(msg, nsym):
    g = _gen_cache.get(nsym)
    if g is None:
        g = [1]
        for i in range(nsym):
            g = _pmul(g, [1, EXP[i]])
        _gen_cache[nsym] = g
    out = list(msg) + [0] * nsym
    for i in range(len(msg)):
        c = out[i]
        if c:
            for j in range(1, len(g)):
                out[i + j] ^= _gmul(g[j], c)
    out[:len(msg)] = msg
    return out


def _syndromes(r, n):
    s = [0] * n
    for j in range(n):
        y = 0
        x = EXP[j]
        for i in range(len(r)):
            y = _gmul(y, x) ^ r[i]
        s[j] = y
    return s


def _bm(s):
    c = [0] * (len(s) + 1)
    b = [0] * (len(s) + 1)
    c[0] = b[0] = 1
    L = 0
    m = 1
    bb = 1
    for n in range(len(s)):
        d = s[n]
        for i in range(1, L + 1):
            d ^= _gmul(c[i], s[n - i])
        if not d:
            m += 1
            continue
        t = c[:]
        v = _gdiv(d, bb)
        for i in range(0, len(c) - m):
            c[i + m] ^= _gmul(v, b[i])
        if 2 * L <= n:
            L = n + 1 - L
            b = t
            bb = d
            m = 1
        else:
            m += 1
    return c[:L + 1]


def rsDecode(data, nsym, erasures=()):
    """Returns (corrected_bytes, num_corrected). Raises on failure."""
    r = list(data)
    s = _syndromes(r, nsym)
    if all(x == 0 for x in s):
        return r, 0
    erasures = list(erasures)
    if len(erasures) > nsym:
        raise ValueError('Too many erasures')
    G = [1]
    T = list(s)
    for p in erasures:
        if p < 0 or p >= len(r):
            raise ValueError('Erasure index')
        X = EXP[len(r) - 1 - p]
        G = _pmul(G, [1, X])
        for j in range(len(T) - 1):
            T[j] = _gmul(T[j], X) ^ T[j + 1]
        T.pop()
    E = _bm(T)
    if 2 * (len(E) - 1) + len(erasures) > nsym:
        raise ValueError('RS correction limit')
    loc = _pmul(G, E)
    pos = []
    for p in range(len(r)):
        e = len(r) - 1 - p
        if _peval(loc, EXP[(255 - e) % 255]) == 0:
            pos.append(p)
    if len(pos) != len(loc) - 1:
        raise ValueError('RS roots')
    omega = _pmul(s, loc)[:nsym]
    der = [0] * max(1, len(loc) - 1)
    for i in range(1, len(loc), 2):
        der[i - 1] = loc[i]
    for p in pos:
        e = len(r) - 1 - p
        X = EXP[e]
        xi = EXP[(255 - e) % 255]
        r[p] ^= _gdiv(_gmul(X, _peval(omega, xi)), _peval(der, xi))
    if not all(x == 0 for x in _syndromes(r, nsym)):
        raise ValueError('RS syndrome check')
    return r, len(pos)


# ---------------------------------------------------------------- layout

class Cell:
    __slots__ = ('i', 'j', 'x', 'y', 'role', 'symbol', 'pi', 'pj', 'index', 'header')

    def __init__(self, i, j, x, y, role, symbol, pi, pj, index):
        self.i, self.j, self.x, self.y = i, j, x, y
        self.role, self.symbol = role, symbol
        self.pi, self.pj = pi, pj
        self.index = index
        self.header = -1


class Layout:
    __slots__ = ('size', 'C', 'R', 'W', 'H', 'cells', 'headers', 'data', 'known', 'cd')


_layout_cache = {}


def layout(size):
    if size in _layout_cache:
        return _layout_cache[size]
    if size < 0 or size >= len(SIZES):
        raise ValueError('Unknown size')
    C, R = SIZES[size]
    cells = []
    M = []
    known = []
    for j in range(R):
        for i in range(C):
            role = 'data'
            symbol = -1
            pi = (i - 2) // 5
            pj = (j - 2) // 5
            if j <= 2 and i <= 2:
                role = 'gap'
                symbol = 8
            elif j == 0 or j == R - 1 or i == 0 or i == C - 1:
                role = 'ring'
                symbol = (j * 5 + i * 3) % 8
            elif i % 5 == 2 and j % 5 == 2:
                role = 'pilot'
                symbol = (pi * 2 + pj * 3) % 9
            c = Cell(i, j, S3 * (i + .5 + .5 * (j & 1)), 1 + 1.5 * j,
                     role, symbol, pi, pj, len(cells))
            cells.append(c)
            if role == 'data':
                M.append(c)
            elif role != 'gap':
                known.append(c)
    headers = []
    for n in range(72):
        c = M[int((n + .5) * len(M) / 72)]
        c.role = 'header'
        c.header = n
        headers.append(c)
    data = [c for c in cells if c.role == 'data']
    rand = _rng(0x5EED ^ size)
    for i in range(len(data) - 1, 0, -1):
        jj = int(next(rand) * (i + 1))
        data[i], data[jj] = data[jj], data[i]
    l = Layout()
    l.size, l.C, l.R = size, C, R
    l.W = S3 * (C + .5)
    l.H = 2 + 1.5 * (R - 1)
    l.cells, l.headers, l.data, l.known = cells, headers, data, known
    l.cd = None
    _layout_cache[size] = l
    return l


def PLcd(l):
    """Centre-out cell order used when a logo sits in the middle (logo=1)."""
    if l.cd is not None:
        return l.cd
    cx, cy = l.W / 2, l.H / 2
    a = []
    for k, c in enumerate(l.data):
        dx, dy = c.x - cx, c.y - cy
        b = int((dx * dx + dy * dy) ** 0.5 / 3)
        a.append((c, k, b))
    a.sort(key=lambda t: (-t[2], t[1]))
    l.cd = [t[0] for t in a]
    return l.cd


class Capacity:
    __slots__ = ('n', 'blocks', 'k', 'payload')


def _jsround(x):
    import math
    return math.floor(x + 0.5)


def capacity(size, ecc=1, mode=0):
    l = layout(size)
    n = (len(l.data) * (1 if mode else 3)) // 8
    B = -(-n // 255)
    blocks = []
    for i in range(B):
        ln = n // B + (1 if i < n % B else 0)
        nsym = max(4, 2 * _jsround(ln * [.1, .2, .3, .4][ecc] / 2))
        blocks.append({'n': ln, 'nsym': nsym, 'k': ln - nsym})
    cap = Capacity()
    cap.n = n
    cap.blocks = blocks
    cap.k = sum(b['k'] for b in blocks)
    cap.payload = max(0, cap.k - 4)
    return cap


def _push_bits(a, x, n):
    for k in range(n - 1, -1, -1):
        a.append((x >> k) & 1)


def headerBits(size, ecc, mode, type_, L):
    b = []
    _push_bits(b, size, 3)
    _push_bits(b, ecc, 2)
    _push_bits(b, mode, 1)
    _push_bits(b, type_, 1)
    _push_bits(b, L, 13)
    _push_bits(b, crc4(b), 4)
    return b


def knownSymbol(c, mode):
    if mode:
        if c.role == 'ring':
            return 0
        return 0 if (c.pi + c.pj) % 2 == 0 else 8
    return c.symbol


# ---------------------------------------------------------------- encode

class Code:
    __slots__ = ('size', 'ecc', 'mode', 'type', 'bytes', 'symbols', 'layout', 'capacity')


def encode(payload, size=-1, ecc=1, mode=0, type_=0, logo=0):
    payload = bytes(payload)
    if len(payload) > 8191:
        raise ValueError('Payload exceeds 8191 bytes')
    if size < 0:
        size = -1
        for i in range(len(SIZES)):
            if capacity(i, ecc, mode).k >= len(payload) + 4:
                size = i
                break
        if size < 0:
            raise ValueError('Payload too large for this mode and ECC')
    cap = capacity(size, ecc, mode)
    if cap.k < len(payload) + 4:
        raise ValueError('Payload does not fit: maximum %d bytes' % cap.payload)
    msg = bytearray(cap.k)
    for i in range(len(payload) + 4, cap.k):
        msg[i] = PADK(i)
    msg[:len(payload)] = payload
    crc = crc32(payload)
    for k in range(4):
        msg[len(payload) + k] = (crc >> (24 - 8 * k)) & 255
    off = 0
    blocks = []
    for b in cap.blocks:
        blocks.append(rsEncode(msg[off:off + b['k']], b['nsym']))
        off += b['k']
    stream = []
    for p in range(max(len(x) for x in blocks)):
        for b in blocks:
            if p < len(b):
                _push_bits(stream, b[p], 8)
    rand = _rng(0xBEEF)
    l = layout(size)
    symbols = [8] * len(l.cells)
    for c in l.known:
        symbols[c.index] = knownSymbol(c, mode)
    hb = headerBits(size, ecc, mode, type_, len(payload))
    for c in l.headers:
        symbols[c.index] = 0 if hb[c.header % 24] else 8
    for c in l.cells:
        if c.role == 'gap':
            symbols[c.index] = (0 if (c.i + c.j) % 2 else 8) if mode else (c.j * 5 + c.i * 3) % 8
    at = 0
    order = PLcd(l) if logo else l.data
    for c in order:
        if mode:
            bit = stream[at] if at < len(stream) else (1 if next(rand) > .5 else 0)
            at += 1
            symbols[c.index] = 0 if bit else 8
        else:
            b = 0
            for _ in range(3):
                bit = stream[at] if at < len(stream) else (1 if next(rand) > .5 else 0)
                at += 1
                b = (b << 1) | bit
            v = b
            v ^= v >> 1
            v ^= v >> 2
            symbols[c.index] = v
    code = Code()
    code.size, code.ecc, code.mode, code.type = size, ecc, mode, type_
    code.bytes = payload
    code.symbols = symbols
    code.layout = l
    code.capacity = cap
    return code


# ---------------------------------------------------------------- render

def _fill_poly(img, w, h, pts, rgb):
    miny = min(p[1] for p in pts)
    maxy = max(p[1] for p in pts)
    y0 = max(0, int(miny))
    y1 = min(h - 1, int(-(-maxy // 1)) if maxy == int(maxy) else int(maxy) + 1)
    import math
    y0 = max(0, math.floor(miny))
    y1 = min(h - 1, math.ceil(maxy))
    for y in range(y0, y1 + 1):
        yc = y + 0.5
        xs = []
        for k in range(len(pts)):
            x1, a = pts[k]
            x2, b2 = pts[(k + 1) % len(pts)]
            if (a <= yc < b2) or (b2 <= yc < a):
                xs.append(x1 + (yc - a) / (b2 - a) * (x2 - x1))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(xs[k] - 0.5 + 1)) if False else max(0, round(xs[k] - 0.5))
            xb = min(w - 1, round(xs[k + 1] - 0.5) - 1)
            for x in range(xa, xb + 1):
                o = (y * w + x) * 4
                img[o] = rgb[0]
                img[o + 1] = rgb[1]
                img[o + 2] = rgb[2]
                img[o + 3] = 255


def render(code, r=12):
    """Returns (width, height, bytearray RGBA). Same geometry as Prism.render."""
    import math
    l = code.layout
    w = math.ceil((l.W + 2 * Q) * r)
    h = math.ceil((l.H + 2 * Q) * r)
    img = bytearray(b'\xff') * (w * h * 4)
    for c in l.cells:
        s = code.symbols[c.index]
        if s == 8:
            continue
        pts = []
        for k in range(6):
            a = math.radians(30 + 60 * k)
            pts.append(((c.x + Q + 1.03 * math.cos(a)) * r,
                        (c.y + Q + 1.03 * math.sin(a)) * r))
        _fill_poly(img, w, h, pts, PAL[s])
    return w, h, img


def _png_chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & M32)


def writePNG(width, height, rgba):
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + _png_chunk(b'IHDR', ihdr) +
            _png_chunk(b'IDAT', zlib.compress(bytes(raw), 9)) +
            _png_chunk(b'IEND', b''))


def encodePNG(payload, r=12, **kw):
    code = encode(payload, **kw)
    w, h, img = render(code, r)
    return writePNG(w, h, img), code


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)


def readPNG(buf):
    """Returns (width, height, bytearray RGBA). 8-bit PNG, colour types 0/2/3/4/6."""
    if buf[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('not a png')
    pos = 8
    ihdr = None
    idats = []
    plte = None
    while pos < len(buf):
        ln = struct.unpack('>I', buf[pos:pos + 4])[0]
        tag = buf[pos + 4:pos + 8]
        data = buf[pos + 8:pos + 8 + ln]
        if tag == b'IHDR':
            ihdr = data
        elif tag == b'IDAT':
            idats.append(data)
        elif tag == b'PLTE':
            plte = data
        elif tag == b'IEND':
            break
        pos += 12 + ln
    w, h, depth, ctype = struct.unpack('>IIBB', ihdr[:10])[:4]
    if depth != 8:
        raise ValueError('unsupported bit depth %d' % depth)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(ctype)
    if ch is None:
        raise ValueError('unsupported colour type %d' % ctype)
    raw = zlib.decompress(b''.join(idats))
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f:
            for x in range(stride):
                a = line[x - ch] if x >= ch else 0
                b = prev[x]
                c = prev[x - ch] if x >= ch else 0
                if f == 1:
                    line[x] = (line[x] + a) & 255
                elif f == 2:
                    line[x] = (line[x] + b) & 255
                elif f == 3:
                    line[x] = (line[x] + ((a + b) >> 1)) & 255
                elif f == 4:
                    line[x] = (line[x] + _paeth(a, b, c)) & 255
                else:
                    raise ValueError('bad filter %d' % f)
        for x in range(w):
            o = (y * w + x) * 4
            if ctype == 6:
                out[o:o + 4] = line[x * 4:x * 4 + 4]
            elif ctype == 2:
                out[o:o + 4] = line[x * 3:x * 3 + 3] + b'\xff'
            elif ctype == 0:
                out[o] = out[o + 1] = out[o + 2] = line[x]
                out[o + 3] = 255
            elif ctype == 4:
                out[o] = out[o + 1] = out[o + 2] = line[x * 2]
                out[o + 3] = line[x * 2 + 1]
            else:
                pi = line[x] * 3
                out[o:o + 4] = plte[pi:pi + 3] + b'\xff'
        prev = line
    return w, h, out


def _read_png_fast(buf):
    """Fast path: 8-bit RGBA/RGB, all filter-0 rows."""
    pos = 8
    ihdr = None
    idats = []
    while pos < len(buf):
        ln = struct.unpack('>I', buf[pos:pos + 4])[0]
        tag = buf[pos + 4:pos + 8]
        if tag == b'IHDR':
            ihdr = buf[pos + 8:pos + 8 + ln]
        elif tag == b'IDAT':
            idats.append(buf[pos + 8:pos + 8 + ln])
        elif tag == b'IEND':
            break
        pos += 12 + ln
    w, h, depth, ctype = struct.unpack('>IIBB', ihdr[:10])[:4]
    if depth != 8 or ctype not in (2, 6):
        return None
    ch = 4 if ctype == 6 else 3
    raw = zlib.decompress(b''.join(idats))
    stride = w * ch
    if any(raw[y * (stride + 1)] for y in range(h)):
        return None
    out = bytearray(w * h * 4)
    if ctype == 6:
        for y in range(h):
            out[y * stride:(y + 1) * stride] = raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
    else:
        for y in range(h):
            line = raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)]
            o = y * w * 4
            for x in range(w):
                out[o + 4 * x:o + 4 * x + 3] = line[3 * x:3 * x + 3]
                out[o + 4 * x + 3] = 255
    return w, h, out


# ---------------------------------------------------------------- decode (clean images)

def _symbol_bits(sym, mode):
    if mode:
        return [1 if sym == 0 else 0]
    t = sym ^ (sym >> 1)
    return [(t >> 2) & 1, (t >> 1) & 1, t & 1]


def _nearest_symbol(r, g, b):
    best = 0
    bestd = 1 << 62
    for i, (pr, pg, pb) in enumerate(PAL):
        d = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb)
        if d < bestd:
            bestd = d
            best = i
    return best


def _decode_symbols(symbols, l, order=None):
    """symbols: per-cell symbol indices; returns payload bytes. Raises on failure."""
    headers = l.headers
    hb = []
    for n in range(24):
        votes = 0
        for rep in range(3):
            c = headers[n + 24 * rep]
            if symbols[c.index] == 0:
                votes += 1
        hb.append(1 if votes >= 2 else 0)
    at = 0

    def rd(n):
        nonlocal at
        v = 0
        for _ in range(n):
            v = (v << 1) | hb[at]
            at += 1
        return v

    size = rd(3)
    ecc = rd(2)
    mode = rd(1)
    type_ = rd(1)
    L = rd(13)
    hcrc = rd(4)
    if crc4(hb[:20]) != hcrc or size > 5 or size != l.size:
        raise ValueError('header checksum failed')
    cap = capacity(size, ecc, mode)
    if L > cap.payload:
        raise ValueError('invalid length')
    cells = order if order is not None else l.data
    stream = []
    for c in cells:
        stream += _symbol_bits(symbols[c.index], mode)
    nbytes = cap.n
    bts = bytearray(nbytes)
    for i in range(nbytes):
        v = 0
        for k in range(8):
            v = (v << 1) | stream[8 * i + k]
        bts[i] = v
    blocks = [bytearray(b['n']) for b in cap.blocks]
    at = 0
    maxn = max(b['n'] for b in cap.blocks)
    for p in range(maxn):
        for bi, b in enumerate(cap.blocks):
            if p < b['n']:
                blocks[bi][p] = bts[at]
                at += 1
    msg = bytearray()
    for bi, b in enumerate(cap.blocks):
        dec, _ = rsDecode(blocks[bi], b['nsym'])
        msg += bytearray(dec[:b['k']])
    payload = bytes(msg[:L])
    got = struct.unpack('>I', bytes(msg[L:L + 4]))[0]
    if crc32(payload) != got:
        raise ValueError('payload CRC-32 failed')
    return payload, {'size': size, 'ecc': ecc, 'mode': mode, 'type': type_, 'length': L}


def decodeImage(w, h, rgba):
    """Decode a clean/perfect encoder PNG (any radius). Returns (payload, header)."""
    # bounding box of non-white pixels (the ring is always drawn)
    xmin, ymin = w, h
    xmax = ymax = -1
    white = b'\xff' * 4
    for y in range(h):
        row = rgba[y * w * 4:(y + 1) * w * 4]
        if min(row[0::4]) >= 250 and min(row[1::4]) >= 250 and min(row[2::4]) >= 250:
            continue
        for x in range(w):
            o = x * 4
            if row[o] < 250 or row[o + 1] < 250 or row[o + 2] < 250:
                if x < xmin:
                    xmin = x
                if x > xmax:
                    xmax = x
                if y < ymin:
                    ymin = y
                if y > ymax:
                    ymax = y
    if xmax < 0:
        raise ValueError('no code found')
    HEXHW = 1.03 * 0.8660254037844386  # 1.03*cos(30deg)
    HEXHH = 1.03
    last_err = None
    for size in range(6):
        try:
            l = layout(size)
            ring = [c for c in l.known if c.role == 'ring']
            mincx = min(c.x for c in ring) - HEXHW
            maxcx = max(c.x for c in ring) + HEXHW
            mincy = min(c.y for c in ring) - HEXHH
            maxcy = max(c.y for c in ring) + HEXHH
            rx = (xmax - xmin + 1) / (maxcx - mincx)
            ry = (ymax - ymin + 1) / (maxcy - mincy)
            if abs(rx - ry) / max(rx, ry) > 0.05:
                continue
            symbols = [8] * len(l.cells)
            for c in l.cells:
                px = xmin + (c.x - mincx) * rx
                py = ymin + (c.y - mincy) * ry
                # small average around the centre
                sr = sg = sb = n = 0
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        xx = min(w - 1, max(0, int(px + dx * rx * 0.15)))
                        yy = min(h - 1, max(0, int(py + dy * ry * 0.15)))
                        o = (yy * w + xx) * 4
                        sr += rgba[o]
                        sg += rgba[o + 1]
                        sb += rgba[o + 2]
                        n += 1
                symbols[c.index] = _nearest_symbol(sr // n, sg // n, sb // n)
            try:
                return _decode_symbols(symbols, l)
            except ValueError:
                # logo-encoded codes store the stream centre-out
                return _decode_symbols(symbols, l, PLcd(l))
        except Exception as e:
            last_err = e
            continue
    raise ValueError('decode failed: %s' % (last_err,))


def decodePNG(buf):
    got = _read_png_fast(buf)
    w, h, rgba = got if got is not None else readPNG(buf)
    return decodeImage(w, h, rgba)


# ---------------------------------------------------------------- CLI

def main(argv=None):
    import argparse
    import json
    import sys

    p = argparse.ArgumentParser(
        prog='prism',
        description='Prism Code encoder/decoder (Python port of the live JavaScript).')
    sub = p.add_subparsers(dest='cmd', required=True)

    pe = sub.add_parser('encode', help='make a Prism Code PNG from a payload')
    src = pe.add_mutually_exclusive_group(required=True)
    src.add_argument('--text', help='payload text (UTF-8)')
    src.add_argument('--input', help='payload file (raw bytes)')
    pe.add_argument('--out', required=True, help='output PNG path')
    pe.add_argument('--size', type=int, default=-1, help='0-5, or -1 = auto grow to fit (default)')
    pe.add_argument('--ecc', type=int, default=1, choices=[0, 1, 2, 3],
                    help='repair data: 0=10%%, 1=20%% (default), 2=30%%, 3=40%%')
    pe.add_argument('--mode', default='color', choices=['color', 'bw'],
                    help='color (default) holds 3x more; bw is black & white')
    pe.add_argument('--radius', type=int, default=12, help='pixels per cell (default 12)')
    pe.add_argument('--type', type=int, default=0, choices=[0, 1], help='header type flag')
    pe.add_argument('--logo', type=int, default=0, choices=[0, 1],
                    help='1 = centre-out data order (logo-friendly)')
    pe.add_argument('--symbols', help='also write the symbol grid JSON here (for testing)')

    pd = sub.add_parser('decode', help='read a clean Prism Code PNG back to bytes')
    pd.add_argument('png', help='input PNG path')
    pd.add_argument('--out', help='write payload bytes here (default: stdout)')

    args = p.parse_args(argv)

    if args.cmd == 'encode':
        payload = args.text.encode('utf-8') if args.text is not None else open(args.input, 'rb').read()
        mode = 0 if args.mode == 'color' else 1
        png, code = encodePNG(payload, r=args.radius, size=args.size, ecc=args.ecc,
                              mode=mode, type_=args.type, logo=args.logo)
        with open(args.out, 'wb') as f:
            f.write(png)
        if args.symbols:
            with open(args.symbols, 'w') as f:
                json.dump({'size': code.size, 'ecc': code.ecc, 'mode': code.mode,
                           'C': code.layout.C, 'R': code.layout.R,
                           'symbols': code.symbols}, f)
        print('wrote %s (%dx%d px, grid %dx%d cells, size %d, %s, ecc %d, %d payload bytes)'
              % (args.out, *readPNG(png)[:2], code.layout.C, code.layout.R, code.size,
                 args.mode, args.ecc, len(payload)))
        print('capacity at these settings: %d payload bytes' % code.capacity.payload)
    else:
        payload, hdr = decodePNG(open(args.png, 'rb').read())
        if args.out:
            with open(args.out, 'wb') as f:
                f.write(payload)
            print('wrote %s (%d bytes)' % (args.out, len(payload)))
        else:
            sys.stdout.buffer.write(payload)
            if payload:
                sys.stdout.buffer.write(b'\n')
        print('header: size %d, ecc %d, mode %s, type %d, %d payload bytes, CRC-32 OK'
              % (hdr['size'], hdr['ecc'], 'color' if hdr['mode'] == 0 else 'bw',
                 hdr['type'], hdr['length']), file=sys.stderr)


if __name__ == '__main__':
    main()
