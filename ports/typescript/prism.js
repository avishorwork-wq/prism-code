"use strict";
// Prism Code - TypeScript (Node) port of the live JavaScript encoder/decoder.
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// No npm dependencies: PNG zlib via node:zlib. Compile with tsc (or run the
// compiled prism.js with any Node 18+).
//
// Format: pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray
// coding (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to
// 113x130 cells. Filled corner gap pattern, asymmetric ring, pilot cells,
// triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D
// Reed-Solomon blocks, payload CRC-32.
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
exports.crc32 = crc32;
exports.capacity = capacity;
exports.encode = encode;
exports.render = render;
exports.writePng = writePng;
exports.readPng = readPng;
exports.decodeImage = decodeImage;
exports.decodePng = decodePng;
const fs = __importStar(require("fs"));
const zlib = __importStar(require("zlib"));
const S3 = Math.sqrt(3); // matches the other ports bit-for-bit
const Q = 3 * S3;
const SIZES = [[21, 24], [29, 33], [41, 47], [57, 66], [81, 94], [113, 130]];
const PAL = [
    [0x1b, 0x1b, 0x1b], [0x2e, 0x5b, 0xff], [0x00, 0xb8, 0xd9],
    [0x2d, 0xb3, 0x5a], [0xf5, 0xc5, 0x18], [0xf7, 0x7f, 0x00],
    [0xd7, 0x26, 0x3d], [0xb5, 0x17, 0x9e], [0xff, 0xff, 0xff],
];
// ---------------------------------------------------------------- rng / crc
class Rng {
    constructor(seed) { this.seed = seed >>> 0; }
    // Exact port of the JS mulberry-style rng (returns floats in [0,1)).
    next() {
        this.seed = (this.seed + 0x6d2b79f5) >>> 0;
        let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed) >>> 0;
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}
const CRC32T = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(data) {
    let c = 0xffffffff;
    for (const b of data)
        c = (CRC32T[(c ^ b) & 255] ^ (c >>> 8)) >>> 0;
    return (c ^ 0xffffffff) >>> 0;
}
function crc4(bits) {
    let r = 0;
    for (const b of bits) {
        const f = ((r >> 3) & 1) ^ b;
        r = (r << 1) & 15;
        if (f)
            r ^= 3;
    }
    return r;
}
function padk(o) {
    let x = Math.imul((o + 0x9e3779b9) >>> 0, 0x85ebca6b) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    x ^= x >>> 16;
    return x & 255;
}
// ---------------------------------------------------------------- GF(256)
const GF = (() => {
    const exp = new Uint8Array(512);
    const log = new Uint8Array(256);
    let z = 1;
    for (let i = 0; i < 255; i++) {
        exp[i] = z;
        log[z] = i;
        z <<= 1;
        if (z & 256)
            z ^= 0x11d;
    }
    for (let i = 255; i < 512; i++)
        exp[i] = exp[i - 255];
    return { exp, log };
})();
function gmul(a, b) {
    return a && b ? GF.exp[GF.log[a] + GF.log[b]] : 0;
}
function gdiv(a, b) {
    if (!b)
        throw new Error("GF division by zero");
    return a ? GF.exp[(GF.log[a] + 255 - GF.log[b]) % 255] : 0;
}
function peval(p, x) {
    let y = 0;
    for (let i = p.length - 1; i >= 0; i--)
        y = gmul(y, x) ^ p[i];
    return y;
}
function pmul(a, b) {
    const o = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
        if (a[i])
            for (let j = 0; j < b.length; j++)
                o[i + j] ^= gmul(a[i], b[j]);
    }
    return o;
}
function rsEncode(msg, nsym) {
    let g = [1];
    for (let i = 0; i < nsym; i++)
        g = pmul(g, [1, GF.exp[i]]);
    const out = Array.from(msg).concat(new Array(nsym).fill(0));
    for (let i = 0; i < msg.length; i++) {
        const c = out[i];
        if (c)
            for (let j = 1; j < g.length; j++)
                out[i + j] ^= gmul(g[j], c);
    }
    for (let i = 0; i < msg.length; i++)
        out[i] = msg[i];
    return Uint8Array.from(out);
}
function syndromes(r, n) {
    const s = new Array(n).fill(0);
    for (let j = 0; j < n; j++) {
        let y = 0;
        const x = GF.exp[j];
        for (const ri of r)
            y = gmul(y, x) ^ ri;
        s[j] = y;
    }
    return s;
}
function bm(s) {
    const c = new Array(s.length + 1).fill(0);
    const b = new Array(s.length + 1).fill(0);
    c[0] = 1;
    b[0] = 1;
    let l = 0, m = 1, bb = 1;
    for (let n = 0; n < s.length; n++) {
        let d = s[n];
        for (let i = 1; i <= l; i++)
            d ^= gmul(c[i], s[n - i]);
        if (d === 0) {
            m++;
            continue;
        }
        const t = c.slice();
        const v = gdiv(d, bb);
        for (let i = 0; i < c.length - m; i++)
            c[i + m] ^= gmul(v, b[i]);
        if (2 * l <= n) {
            l = n + 1 - l;
            b.splice(0, b.length, ...t);
            bb = d;
            m = 1;
        }
        else
            m++;
    }
    return c.slice(0, l + 1);
}
function rsDecode(data, nsym) {
    const r = Array.from(data);
    const s = syndromes(r, nsym);
    if (s.every((x) => x === 0))
        return Uint8Array.from(r);
    const loc = bm(s);
    if (2 * (loc.length - 1) > nsym)
        throw new Error("RS correction limit");
    const pos = [];
    for (let p = 0; p < r.length; p++) {
        const e = r.length - 1 - p;
        if (peval(loc, GF.exp[(255 - e) % 255]) === 0)
            pos.push(p);
    }
    if (pos.length !== loc.length - 1)
        throw new Error("RS roots");
    let omega = pmul(s, loc).slice(0, nsym);
    const derLen = Math.max(loc.length - 1, 1);
    const der = new Array(derLen).fill(0);
    for (let i = 1; i < loc.length; i += 2)
        der[i - 1] = loc[i];
    for (const p of pos) {
        const e = r.length - 1 - p;
        const x = GF.exp[e];
        const xi = GF.exp[(255 - e) % 255];
        r[p] ^= gdiv(gmul(x, peval(omega, xi)), peval(der, xi));
    }
    if (syndromes(r, nsym).some((x) => x !== 0))
        throw new Error("RS syndrome check");
    return Uint8Array.from(r);
}
// ---------------------------------------------------------------- layout
const ROLE = { Data: 0, Gap: 1, Ring: 2, Pilot: 3, Header: 4 };
function floorDiv(a, b) {
    const q = Math.trunc(a / b);
    return (a % b !== 0) && ((a < 0) !== (b < 0)) ? q - 1 : q;
}
function makeLayout(size) {
    const [c, r] = SIZES[size];
    const cells = [];
    const mIdx = [];
    const known = [];
    for (let j = 0; j < r; j++) {
        for (let i = 0; i < c; i++) {
            let role = ROLE.Data;
            let symbol = -1;
            const pi = floorDiv(i - 2, 5);
            const pj = floorDiv(j - 2, 5);
            if (j <= 2 && i <= 2) {
                role = ROLE.Gap;
                symbol = 8;
            }
            else if (j === 0 || j === r - 1 || i === 0 || i === c - 1) {
                role = ROLE.Ring;
                symbol = (j * 5 + i * 3) % 8;
            }
            else if (i % 5 === 2 && j % 5 === 2) {
                role = ROLE.Pilot;
                symbol = (pi * 2 + pj * 3) % 9;
            }
            cells.push({
                i, j,
                x: S3 * (i + 0.5 + 0.5 * (j & 1)),
                y: 1 + 1.5 * j,
                role, symbol, pi, pj, index: cells.length, header: -1,
            });
            if (role === ROLE.Data)
                mIdx.push(cells.length - 1);
            else if (role !== ROLE.Gap)
                known.push(cells.length - 1);
        }
    }
    const headers = [];
    for (let n = 0; n < 72; n++) {
        const ci = mIdx[Math.floor((n + 0.5) * mIdx.length / 72)];
        cells[ci].role = ROLE.Header;
        cells[ci].header = n;
        headers.push(ci);
    }
    let data = cells.map((c, i) => i).filter((i) => cells[i].role === ROLE.Data);
    const rand = new Rng((0x5eed ^ size) >>> 0);
    for (let i = data.length - 1; i >= 1; i--) {
        const jj = Math.floor(rand.next() * (i + 1));
        [data[i], data[jj]] = [data[jj], data[i]];
    }
    return {
        size, c, r,
        w: S3 * (c + 0.5),
        h: 2 + 1.5 * (r - 1),
        cells, headers, data, known,
    };
}
// Centre-out data order used when a logo sits in the middle (logo=1).
function plcd(l) {
    const cx = l.w / 2, cy = l.h / 2;
    const ent = l.data.map((ci, k) => {
        const c = l.cells[ci];
        const dx = c.x - cx, dy = c.y - cy;
        return { k, b: Math.floor(Math.sqrt(dx * dx + dy * dy) / 3) };
    });
    ent.sort((a, b2) => b2.b - a.b || a.k - b2.k);
    return ent.map((e) => l.data[e.k]);
}
function jsround(x) { return Math.floor(x + 0.5); }
function capacity(size, ecc, mode) {
    const l = makeLayout(size);
    const bpc = mode !== 0 ? 1 : 3;
    const n = Math.floor(l.data.length * bpc / 8);
    const nb = Math.floor((n + 254) / 255);
    const pcts = [0.1, 0.2, 0.3, 0.4];
    const blocks = [];
    for (let i = 0; i < nb; i++) {
        const ln = Math.floor(n / nb) + (i < n % nb ? 1 : 0);
        const nsym = Math.max(4, 2 * jsround(ln * pcts[ecc] / 2));
        blocks.push({ n: ln, nsym, k: ln - nsym });
    }
    const k = blocks.reduce((s, b) => s + b.k, 0);
    return { n, blocks, k, payload: Math.max(0, k - 4) };
}
function pushBits(a, x, n) {
    for (let k = n - 1; k >= 0; k--)
        a.push((x >> k) & 1);
}
function headerBits(size, ecc, mode, typ, len) {
    const b = [];
    pushBits(b, size, 3);
    pushBits(b, ecc, 2);
    pushBits(b, mode, 1);
    pushBits(b, typ, 1);
    pushBits(b, len, 13);
    const c = crc4(b);
    pushBits(b, c, 4);
    return b;
}
function knownSymbol(c, mode) {
    if (mode !== 0) {
        if (c.role === ROLE.Ring)
            return 0;
        return (c.pi + c.pj) % 2 === 0 ? 0 : 8;
    }
    return c.symbol;
}
function encode(payload, sizeIn, ecc, mode, typ, logo) {
    if (payload.length > 8191)
        throw new Error("payload exceeds 8191 bytes");
    let size = sizeIn;
    if (size < 0) {
        size = -1;
        for (let i = 0; i < SIZES.length; i++) {
            if (capacity(i, ecc, mode).k >= payload.length + 4) {
                size = i;
                break;
            }
        }
        if (size < 0)
            throw new Error("payload too large for this mode and ECC");
    }
    const cap = capacity(size, ecc, mode);
    if (cap.k < payload.length + 4) {
        throw new Error(`payload does not fit: maximum ${cap.payload} bytes`);
    }
    const msg = new Uint8Array(cap.k);
    for (let i = payload.length + 4; i < cap.k; i++)
        msg[i] = padk(i);
    msg.set(payload, 0);
    const crc = crc32(payload);
    for (let k = 0; k < 4; k++)
        msg[payload.length + k] = (crc >>> (24 - 8 * k)) & 255;
    let off = 0;
    const blocks = [];
    for (const b of cap.blocks) {
        blocks.push(rsEncode(msg.subarray(off, off + b.k), b.nsym));
        off += b.k;
    }
    const maxlen = Math.max(...blocks.map((x) => x.length));
    const stream = [];
    for (let p = 0; p < maxlen; p++) {
        for (const b of blocks) {
            if (p < b.length)
                pushBits(stream, b[p], 8);
        }
    }
    const rand = new Rng(0xbeef);
    const l = makeLayout(size);
    const symbols = new Int32Array(l.cells.length).fill(8);
    for (const ci of l.known)
        symbols[ci] = knownSymbol(l.cells[ci], mode);
    const hb = headerBits(size, ecc, mode, typ, payload.length);
    for (const ci of l.headers) {
        const h = l.cells[ci].header;
        symbols[ci] = hb[h % 24] ? 0 : 8;
    }
    for (const c of l.cells) {
        if (c.role === ROLE.Gap) {
            symbols[c.index] = mode !== 0
                ? ((c.i + c.j) % 2 !== 0 ? 0 : 8)
                : (c.j * 5 + c.i * 3) % 8;
        }
    }
    let at = 0;
    const order = logo !== 0 ? plcd(l) : l.data;
    for (const ci of order) {
        if (mode !== 0) {
            const bit = at < stream.length ? stream[at] : (rand.next() > 0.5 ? 1 : 0);
            at++;
            symbols[ci] = bit ? 0 : 8;
        }
        else {
            let b = 0;
            for (let k = 0; k < 3; k++) {
                const bit = at < stream.length ? stream[at] : (rand.next() > 0.5 ? 1 : 0);
                at++;
                b = (b << 1) | bit;
            }
            let v = b;
            v ^= v >> 1;
            v ^= v >> 2;
            symbols[ci] = v;
        }
    }
    return { size, ecc, mode, typ, bytes: payload, symbols, layout: l, order, capPayload: cap.payload };
}
// ---------------------------------------------------------------- render / PNG
function fillPoly(img, w, h, pts, rgb) {
    let miny = Infinity, maxy = -Infinity;
    for (const p of pts) {
        miny = Math.min(miny, p[1]);
        maxy = Math.max(maxy, p[1]);
    }
    const y0 = Math.max(0, Math.floor(miny));
    const y1 = Math.min(h - 1, Math.ceil(maxy));
    if (y1 < y0)
        return;
    for (let y = y0; y <= y1; y++) {
        const yc = y + 0.5;
        const xs = [];
        for (let k = 0; k < pts.length; k++) {
            const [x1, a] = pts[k];
            const [x2, b] = pts[(k + 1) % pts.length];
            if ((a <= yc && yc < b) || (b <= yc && yc < a)) {
                xs.push(x1 + (yc - a) / (b - a) * (x2 - x1));
            }
        }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
            const xa = Math.max(0, Math.round(xs[k] - 0.5));
            const xb = Math.min(w - 1, Math.round(xs[k + 1] - 0.5) - 1);
            for (let x = xa; x <= xb; x++) {
                const o = (y * w + x) * 4;
                img[o] = rgb[0];
                img[o + 1] = rgb[1];
                img[o + 2] = rgb[2];
                img[o + 3] = 255;
            }
        }
    }
}
// Same geometry as Prism.render: hard-edged hexagons on white.
function render(code, r) {
    const l = code.layout;
    const w = Math.ceil((l.w + 2 * Q) * r);
    const h = Math.ceil((l.h + 2 * Q) * r);
    const img = new Uint8Array(w * h * 4).fill(255);
    for (const c of l.cells) {
        const s = code.symbols[c.index];
        if (s === 8)
            continue;
        const pts = [];
        for (let k = 0; k < 6; k++) {
            const a = (30 + 60 * k) * Math.PI / 180;
            pts.push([(c.x + Q + 1.03 * Math.cos(a)) * r, (c.y + Q + 1.03 * Math.sin(a)) * r]);
        }
        fillPoly(img, w, h, pts, PAL[s]);
    }
    return { w, h, img };
}
function pngChunk(tag, data, out) {
    const tb = Buffer.from(tag, "ascii");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    for (const b of len)
        out.push(b);
    for (const b of tb)
        out.push(b);
    for (const b of data)
        out.push(b);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Uint8Array.from([...tb, ...data])));
    for (const b of crc)
        out.push(b);
}
function writePng(w, h, rgba) {
    const stride = w * 4;
    const raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
    const idat = zlib.deflateSync(Buffer.from(raw), { level: 9 });
    const out = [137, 80, 78, 71, 13, 10, 26, 10];
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    pngChunk("IHDR", ihdr, out);
    pngChunk("IDAT", idat, out);
    pngChunk("IEND", new Uint8Array(0), out);
    return Buffer.from(out);
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function readPng(buf) {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (buf.length < 8 || !sig.every((b, i) => buf[i] === b))
        throw new Error("not a png");
    let pos = 8;
    let ihdr = null;
    const idats = [];
    let plte = null;
    while (pos + 12 <= buf.length) {
        const ln = buf.readUInt32BE(pos);
        const tag = buf.toString("ascii", pos + 4, pos + 8);
        if (pos + 12 + ln > buf.length)
            break;
        const data = buf.subarray(pos + 8, pos + 8 + ln);
        if (tag === "IHDR")
            ihdr = Buffer.from(data);
        else if (tag === "IDAT")
            idats.push(Buffer.from(data));
        else if (tag === "PLTE")
            plte = Buffer.from(data);
        else if (tag === "IEND")
            break;
        pos += 12 + ln;
    }
    if (!ihdr)
        throw new Error("no IHDR");
    const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
    const depth = ihdr[8], ctype = ihdr[9];
    if (depth !== 8)
        throw new Error(`unsupported bit depth ${depth}`);
    const ch = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : ctype === 6 ? 4 : -1;
    if (ch < 0)
        throw new Error(`unsupported colour type ${ctype}`);
    const raw = zlib.inflateSync(Buffer.concat(idats));
    const stride = w * ch;
    const out = new Uint8Array(w * h * 4);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        const line = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        if (f !== 0) {
            for (let x = 0; x < stride; x++) {
                const a = x >= ch ? line[x - ch] : 0;
                const b = prev[x];
                const c = x >= ch ? prev[x - ch] : 0;
                let v;
                if (f === 1)
                    v = line[x] + a;
                else if (f === 2)
                    v = line[x] + b;
                else if (f === 3)
                    v = line[x] + ((a + b) >> 1);
                else if (f === 4)
                    v = line[x] + paeth(a, b, c);
                else
                    throw new Error(`bad filter ${f}`);
                line[x] = v & 255;
            }
        }
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (ctype === 6) {
                out[o] = line[x * 4];
                out[o + 1] = line[x * 4 + 1];
                out[o + 2] = line[x * 4 + 2];
                out[o + 3] = line[x * 4 + 3];
            }
            else if (ctype === 2) {
                out[o] = line[x * 3];
                out[o + 1] = line[x * 3 + 1];
                out[o + 2] = line[x * 3 + 2];
                out[o + 3] = 255;
            }
            else if (ctype === 0) {
                out[o] = line[x];
                out[o + 1] = line[x];
                out[o + 2] = line[x];
                out[o + 3] = 255;
            }
            else if (ctype === 4) {
                out[o] = line[x * 2];
                out[o + 1] = line[x * 2];
                out[o + 2] = line[x * 2];
                out[o + 3] = line[x * 2 + 1];
            }
            else {
                if (!plte)
                    throw new Error("palette missing");
                const pi = line[x] * 3;
                out[o] = plte[pi];
                out[o + 1] = plte[pi + 1];
                out[o + 2] = plte[pi + 2];
                out[o + 3] = 255;
            }
        }
        prev = line;
    }
    return { w, h, rgba: out };
}
function symbolBits(sym, mode) {
    if (mode !== 0)
        return [sym === 0 ? 1 : 0];
    const t = sym ^ (sym >> 1);
    return [(t >> 2) & 1, (t >> 1) & 1, t & 1];
}
function nearestSymbol(r, g, b) {
    let best = 0, bestd = Infinity;
    for (let i = 0; i < PAL.length; i++) {
        const dr = r - PAL[i][0], dg = g - PAL[i][1], db = b - PAL[i][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestd) {
            bestd = d;
            best = i;
        }
    }
    return best;
}
function decodeSymbols(symbols, l, order) {
    const hb = new Array(24).fill(0);
    for (let n = 0; n < 24; n++) {
        let votes = 0;
        for (let rep = 0; rep < 3; rep++) {
            if (symbols[l.headers[n + 24 * rep]] === 0)
                votes++;
        }
        hb[n] = votes >= 2 ? 1 : 0;
    }
    let at = 0;
    const rd = (n) => {
        let v = 0;
        for (let i = 0; i < n; i++) {
            v = (v << 1) | hb[at];
            at++;
        }
        return v;
    };
    const size = rd(3);
    const ecc = rd(2);
    const mode = rd(1);
    const typ = rd(1);
    const len = rd(13);
    const hcrc = rd(4);
    if (crc4(hb.slice(0, 20)) !== hcrc || size > 5 || size !== l.size) {
        throw new Error("header checksum failed");
    }
    const cap = capacity(size, ecc, mode);
    if (len > cap.payload)
        throw new Error("invalid length");
    const cellsOrder = order !== null ? order : l.data;
    const stream = [];
    for (const ci of cellsOrder)
        stream.push(...symbolBits(symbols[ci], mode));
    const nbytes = cap.n;
    const bts = new Uint8Array(nbytes);
    for (let i = 0; i < nbytes; i++) {
        let v = 0;
        for (let k = 0; k < 8; k++)
            v = (v << 1) | stream[8 * i + k];
        bts[i] = v;
    }
    const blocks = cap.blocks.map((b) => new Uint8Array(b.n));
    let at2 = 0;
    const maxn = Math.max(...cap.blocks.map((b) => b.n));
    for (let p = 0; p < maxn; p++) {
        for (let bi = 0; bi < cap.blocks.length; bi++) {
            if (p < cap.blocks[bi].n) {
                blocks[bi][p] = bts[at2];
                at2++;
            }
        }
    }
    const msg = [];
    for (let bi = 0; bi < cap.blocks.length; bi++) {
        const dec = rsDecode(blocks[bi], cap.blocks[bi].nsym);
        for (let i = 0; i < cap.blocks[bi].k; i++)
            msg.push(dec[i]);
    }
    const payload = Uint8Array.from(msg.slice(0, len));
    const got = ((msg[len] << 24) | (msg[len + 1] << 16) | (msg[len + 2] << 8) | msg[len + 3]) >>> 0;
    if (crc32(payload) !== got)
        throw new Error("payload CRC-32 failed");
    return { payload, hdr: { size, ecc, mode, typ, length: len } };
}
// Decode a clean/perfect encoder image (any radius).
function decodeImage(w, h, rgba) {
    let xmin = w, ymin = h, xmax = -1, ymax = -1;
    for (let y = 0; y < h; y++) {
        let rowWhite = true;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250) {
                rowWhite = false;
                break;
            }
        }
        if (rowWhite)
            continue;
        for (let x = 0; x < w; x++) {
            const o = (y * w + x) * 4;
            if (rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250) {
                if (x < xmin)
                    xmin = x;
                if (x > xmax)
                    xmax = x;
                if (y < ymin)
                    ymin = y;
                if (y > ymax)
                    ymax = y;
            }
        }
    }
    if (xmax < 0)
        throw new Error("no code found");
    const HEXHW = 1.03 * 0.8660254037844386;
    const HEXHH = 1.03;
    let lastErr = "unknown";
    for (let size = 0; size < 6; size++) {
        const l = makeLayout(size);
        let mincx = Infinity, maxcx = -Infinity, mincy = Infinity, maxcy = -Infinity;
        for (const ci of l.known) {
            const c = l.cells[ci];
            if (c.role === ROLE.Ring) {
                mincx = Math.min(mincx, c.x);
                maxcx = Math.max(maxcx, c.x);
                mincy = Math.min(mincy, c.y);
                maxcy = Math.max(maxcy, c.y);
            }
        }
        mincx -= HEXHW;
        maxcx += HEXHW;
        mincy -= HEXHH;
        maxcy += HEXHH;
        const rx = (xmax - xmin + 1) / (maxcx - mincx);
        const ry = (ymax - ymin + 1) / (maxcy - mincy);
        if (Math.abs(rx - ry) / Math.max(rx, ry) > 0.05)
            continue;
        const symbols = new Int32Array(l.cells.length).fill(8);
        for (const c of l.cells) {
            const px = xmin + (c.x - mincx) * rx;
            const py = ymin + (c.y - mincy) * ry;
            let sr = 0, sg = 0, sb = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = Math.min(w - 1, Math.max(0, Math.trunc(px + dx * rx * 0.15)));
                    const yy = Math.min(h - 1, Math.max(0, Math.trunc(py + dy * ry * 0.15)));
                    const o = (yy * w + xx) * 4;
                    sr += rgba[o];
                    sg += rgba[o + 1];
                    sb += rgba[o + 2];
                    n++;
                }
            }
            symbols[c.index] = nearestSymbol(sr / n, sg / n, sb / n);
        }
        try {
            return decodeSymbols(symbols, l, null);
        }
        catch {
            const cd = plcd(l);
            try {
                return decodeSymbols(symbols, l, cd);
            }
            catch (e) {
                lastErr = e instanceof Error ? e.message : String(e);
            }
        }
    }
    throw new Error(`decode failed: ${lastErr}`);
}
function decodePng(buf) {
    const { w, h, rgba } = readPng(buf);
    return decodeImage(w, h, rgba);
}
// ---------------------------------------------------------------- CLI
function arg(a, name, dflt) {
    for (let i = 0; i < a.length - 1; i++) {
        if (a[i] === `--${name}` || a[i] === `-${name}`)
            return a[i + 1];
    }
    return dflt;
}
function positional(a) {
    for (let i = 1; i < a.length; i++) {
        if (!a[i].startsWith("-"))
            return a[i];
    }
    return null;
}
function modeName(m) { return m === 0 ? "color" : "bw"; }
function fail(msg) {
    console.error("error: " + msg);
    process.exit(1);
}
function usage() {
    console.error("usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n" +
        "       prism decode I.png [--out O]\n" +
        "       prism capacity\n" +
        "       prism secure-genkey [-o key.json]\n" +
        "       prism secure-seal IN [--password P] [--kdf argon2id|pbkdf2] [--sign-key key.json] [-o OUT]\n" +
        "       prism secure-open IN [--password P] [-o OUT]\n" +
        "       prism secure-passphrase\n" +
        "       prism secure-strength [PW]\n" +
        "       prism parts-split IN -o DIR [--name N] [--size 0..5]\n" +
        "       prism parts-join PART... [-o OUT]\n" +
        "       prism card-build wifi|vcard|ticket [flags] [-o OUT]\n" +
        "       prism card-parse IN\n" +
        "       prism issuer IN [--list issuers.json]");
    process.exit(2);
}
function main() {
    const a = process.argv.slice(2);
    if (a.length === 0)
        usage();
    switch (a[0]) {
        case "encode": {
            const text = arg(a, "text", null);
            const input = arg(a, "input", null);
            if (text === null && input === null)
                fail("need --text or --input");
            const payload = text !== null ? Buffer.from(text, "utf8") : fs.readFileSync(input);
            const size = parseInt(arg(a, "size", "-1"));
            const ecc = parseInt(arg(a, "ecc", "1"));
            const modeS = arg(a, "mode", "0");
            const mode = modeS === "1" || modeS === "bw" ? 1 : 0;
            const radius = parseInt(arg(a, "radius", "12"));
            const typ = parseInt(arg(a, "type", "0"));
            const logo = parseInt(arg(a, "logo", "0"));
            const out = arg(a, "out", null);
            if (out === null)
                fail("need --out");
            let code;
            try {
                code = encode(new Uint8Array(payload), size, ecc, mode, typ, logo);
            }
            catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            const { w, h, img } = render(code, radius);
            fs.writeFileSync(out, writePng(w, h, img));
            const sj = arg(a, "symbols", null);
            if (sj !== null) {
                const sym = Array.from(code.symbols);
                fs.writeFileSync(sj, JSON.stringify({
                    size: code.size, ecc: code.ecc, mode: code.mode,
                    C: code.layout.c, R: code.layout.r, symbols: sym,
                }));
            }
            console.log(`wrote ${out} (${w}x${h} px, grid ${code.layout.c}x${code.layout.r} cells, size ${code.size}, ${modeName(mode)}, ecc ${ecc}, ${payload.length} payload bytes)`);
            console.log(`capacity at these settings: ${code.capPayload} payload bytes`);
            break;
        }
        case "decode": {
            if (a.length < 2)
                fail("need png path");
            const buf = fs.readFileSync(a[1]);
            let d;
            try {
                d = decodePng(buf);
            }
            catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            const out = arg(a, "out", null);
            if (out !== null) {
                fs.writeFileSync(out, Buffer.from(d.payload));
                console.log(`wrote ${out} (${d.payload.length} bytes)`);
            }
            else {
                process.stdout.write(Buffer.from(d.payload));
                if (d.payload.length > 0)
                    process.stdout.write("\n");
            }
            console.error(`header: size ${d.hdr.size}, ecc ${d.hdr.ecc}, mode ${modeName(d.hdr.mode)}, type ${d.hdr.typ}, ${d.hdr.length} payload bytes, CRC-32 OK`);
            break;
        }
        case "capacity": {
            for (let s = 0; s < 6; s++) {
                for (let ecc = 0; ecc < 4; ecc++) {
                    for (let mode = 0; mode < 2; mode++) {
                        const cap = capacity(s, ecc, mode);
                        console.log(`size ${s} (${SIZES[s][0]}x${SIZES[s][1]}) ecc ${ecc} ${modeName(mode)}: ${cap.payload} payload bytes`);
                    }
                }
            }
            break;
        }
        case "secure-genkey": {
            const S = require("./secure");
            const [priv, pub] = S.genkey();
            console.log(`fingerprint: ${S.fingerprint(pub)}`);
            const out = arg(a, "o", null);
            if (out !== null) {
                S.saveKey(out, priv, pub);
                console.log(`wrote ${out}`);
            }
            break;
        }
        case "secure-seal": {
            const S = require("./secure");
            const inp = positional(a);
            if (inp === null)
                usage();
            let data;
            try {
                data = fs.readFileSync(inp);
            }
            catch {
                fail(`cannot read ${inp}`);
            }
            let priv = null;
            let pub = null;
            const keyf = arg(a, "sign-key", null);
            if (keyf !== null) {
                try {
                    [priv, pub] = S.loadKey(keyf);
                }
                catch {
                    fail(`bad key file ${keyf}`);
                }
            }
            let sealed;
            try {
                sealed = S.seal(data, Buffer.from(arg(a, "password", ""), "utf8"), arg(a, "kdf", "argon2id"), priv, pub);
            }
            catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            const out = arg(a, "o", null);
            if (out !== null) {
                fs.writeFileSync(out, sealed);
                console.log(`wrote ${out} (${data.length} -> ${sealed.length} bytes)`);
            }
            else {
                process.stdout.write(sealed);
            }
            break;
        }
        case "secure-open": {
            const S = require("./secure");
            const inp = positional(a);
            if (inp === null)
                usage();
            let data;
            try {
                data = fs.readFileSync(inp);
            }
            catch {
                fail(`cannot read ${inp}`);
            }
            const r = S.open(data, Buffer.from(arg(a, "password", ""), "utf8"));
            if (r.signatureValid === 0)
                fail(r.error || "bad signature");
            if (r.bytes === null)
                fail(r.error || "needs a password");
            if (r.signed)
                console.error(`signature: valid, signer ${r.fingerprint}`);
            const out = arg(a, "o", null);
            if (out !== null) {
                fs.writeFileSync(out, r.bytes);
                console.log(`wrote ${out} (${r.bytes.length} bytes)`);
            }
            else {
                process.stdout.write(r.bytes);
                process.stdout.write("\n");
            }
            break;
        }
        case "secure-passphrase": {
            const S = require("./secure");
            console.log(S.passphrase());
            break;
        }
        case "secure-strength": {
            const S = require("./secure");
            const pw = arg(a, "password", null) || positional(a) || "";
            const [bits, level, label] = S.strength(pw);
            console.log(`${bits} bits, level ${level} (${label})`);
            break;
        }
        case "parts-split": {
            const PP = require("./parts");
            const inp = positional(a);
            const outdir = arg(a, "o", null);
            if (inp === null || outdir === null)
                usage();
            const name = arg(a, "name", "file");
            const size = parseInt(arg(a, "size", "3"));
            let data;
            try {
                data = fs.readFileSync(inp);
            }
            catch {
                fail(`cannot read ${inp}`);
            }
            let parts;
            try {
                parts = PP.split(data, name, size);
            }
            catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            fs.mkdirSync(outdir, { recursive: true });
            parts.forEach((p, i) => {
                fs.writeFileSync(`${outdir}/part-${String(i + 1).padStart(2, "0")}.bin`, p);
            });
            console.log(`${parts.length} parts written to ${outdir} (encode each at --ecc 2, color mode)`);
            break;
        }
        case "parts-join": {
            const PP = require("./parts");
            const asm = new PP.Assembler();
            let out = arg(a, "o", null);
            let nfiles = 0;
            let i = 1;
            while (i < a.length) {
                if (a[i] === "-o" || a[i] === "--o") {
                    i += 2;
                    continue;
                }
                if (a[i].startsWith("-")) {
                    i += 2;
                    continue;
                }
                let data;
                try {
                    data = fs.readFileSync(a[i]);
                }
                catch {
                    fail(`cannot read ${a[i]}`);
                }
                nfiles += 1;
                const [st, pn, msg] = asm.add(data);
                if (st === PP.NOT_PART)
                    fail(`${a[i]} is not a part`);
                else if (st === PP.BAD || st === PP.OTHER)
                    fail(msg);
                else if (st === PP.DUPLICATE) { /* skip */ }
                else
                    console.log(`part ${pn} of ${asm.total} added (${asm.have}/${asm.total})`);
                i += 1;
            }
            if (nfiles === 0)
                usage();
            let res, name;
            try {
                [res, name] = asm.finish();
            }
            catch (e) {
                fail(e instanceof Error ? e.message : String(e));
            }
            if (out === null)
                out = name;
            fs.writeFileSync(out, res);
            console.log(`wrote ${out} (${res.length} bytes, whole-file check passed)`);
            break;
        }
        case "card-build": {
            const C = require("./cards");
            if (a.length < 2)
                usage();
            const kind = a[1];
            const hidden = a.includes("--hidden") || a.includes("-hidden");
            let payload;
            if (kind === "wifi") {
                payload = C.wifiBuild(arg(a, "ssid", ""), arg(a, "sec", "WPA"), arg(a, "pass", ""), hidden);
            }
            else if (kind === "vcard") {
                payload = C.vcardBuild(arg(a, "name", ""), arg(a, "org", ""), arg(a, "title", ""), arg(a, "phone", ""), arg(a, "email", ""), arg(a, "url", ""), arg(a, "addr", ""), arg(a, "note", ""));
            }
            else if (kind === "ticket") {
                payload = C.ticketBuild(parseInt(arg(a, "expiry-ms", "0")), arg(a, "text", ""));
            }
            else {
                usage();
            }
            const out = arg(a, "o", null);
            if (out !== null) {
                fs.writeFileSync(out, Buffer.from(payload, "utf8"));
                console.log(`wrote ${out} (${Buffer.from(payload, "utf8").length} bytes)`);
            }
            else {
                console.log(payload);
            }
            break;
        }
        case "card-parse": {
            const C = require("./cards");
            if (a.length < 2)
                fail("need card file");
            let text;
            try {
                text = fs.readFileSync(a[1], "utf8");
            }
            catch {
                fail(`cannot read ${a[1]}`);
            }
            const t = C.ticketParse(text);
            const w = t ? null : C.wifiParse(text);
            const v = t || w ? null : C.vcardParse(text);
            if (t) {
                console.log(`ticket: expires ${t.expiryMs}, body:\n${t.body}`);
            }
            else if (w) {
                console.log(`wifi: ssid "${w.ssid}" security ${w.sec} password "${w.pass}"${w.hidden ? " hidden" : ""}`);
            }
            else if (v) {
                let line = `contact: ${v.name}`;
                if (v.org.length > 0)
                    line += `, ${v.org}`;
                if (v.title.length > 0)
                    line += ` (${v.title})`;
                console.log(line);
                v.phones.forEach((p) => console.log(`  phone: ${p}`));
                v.emails.forEach((e) => console.log(`  email: ${e}`));
                v.urls.forEach((u) => console.log(`  url: ${u}`));
                if (v.addr.length > 0)
                    console.log(`  address: ${v.addr}`);
                if (v.note.length > 0)
                    console.log(`  note: ${v.note}`);
            }
            else {
                console.log("not a card payload");
            }
            break;
        }
        case "issuer": {
            const I = require("./issuers");
            const inp = positional(a);
            if (inp === null)
                usage();
            let data;
            try {
                data = fs.readFileSync(inp);
            }
            catch {
                fail(`cannot read ${inp}`);
            }
            if (data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
                try {
                    data = Buffer.from(decodePng(data).payload);
                }
                catch (e) {
                    fail(e instanceof Error ? e.message : String(e));
                }
            }
            const id = I.identify(data);
            if (id === null) {
                console.log("not a signed Prism Secure payload");
            }
            else if (!id.signatureValid) {
                console.log("Signature check failed. This code was changed after it was signed, or was not signed by the key it names.");
            }
            else {
                let line = `signature: valid, signer ${id.fingerprint}`;
                const lp = arg(a, "list", null);
                if (lp !== null) {
                    const list = I.load(lp);
                    const idx = I.findIndex(list, id.fingerprint);
                    line += idx >= 0 ? `, issuer: ${list[idx].name}` : " (not on the issuer list)";
                }
                console.log(line);
                if (id.hasMessage)
                    console.log(`message: ${id.message}`);
                else if (id.encrypted)
                    console.log("the content is locked with a password");
            }
            break;
        }
        default:
            fail(`unknown command ${a[0]}`);
    }
}
if (require.main === module)
    main();
