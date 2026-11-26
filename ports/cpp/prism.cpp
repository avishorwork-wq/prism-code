/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++17 port of the live Prism Code format. A bit-exact port of the encoder and
 * a clean-image decoder, matching the live JavaScript (the self-contained Prism
 * module in prism.html / use.html). PNG I/O uses zlib (free, zlib license). */
#include "prism.hpp"

#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <zlib.h>

namespace prism {

/* ---------------------------------------------------------------- constants */
static const double S3 = 1.7320508075688772; /* sqrt(3) */
static const double PQ = 5.196152422706632;  /* 3*sqrt(3): quiet zone */
static const int SIZES[6][2] = {{21,24},{29,33},{41,47},{57,66},{81,94},{113,130}};
static const uint8_t PALETTE[9][3] = {
    {0x1B,0x1B,0x1B},{0x2E,0x5B,0xFF},{0x00,0xB8,0xD9},{0x2D,0xB3,0x5A},
    {0xF5,0xC5,0x18},{0xF7,0x7F,0x00},{0xD7,0x26,0x3D},{0xB5,0x17,0x9E},
    {0xFF,0xFF,0xFF}};
static const double ECC_T[4] = {0.1, 0.2, 0.3, 0.4};

enum Role { ROLE_DATA, ROLE_RING, ROLE_PILOT, ROLE_GAP, ROLE_HEADER };

/* ------------------------------------------------------- deterministic RNG */
/* Exact port of the JS rng, all arithmetic mod 2^32. */
struct Rng {
    uint32_t s;
    explicit Rng(uint32_t seed) : s(seed) {}
    double next() {
        s += 0x6D2B79F5u;
        uint32_t t = (s ^ (s >> 15)) * (1u | s);
        t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
        return (double)(t ^ (t >> 14)) / 4294967296.0;
    }
};

static uint8_t padk(uint32_t o) {
    uint32_t x = (o + 0x9E3779B9u) * 0x85EBCA6Bu;
    x ^= x >> 13; x *= 0xC2B2AE35u; x ^= x >> 16;
    return (uint8_t)(x & 255);
}

/* ------------------------------------------------------------ GF(256) / RS */
static uint8_t GF_EXP[512], GF_LOG[256];
struct GfInit {
    GfInit() {
        int z = 1;
        for (int i = 0; i < 255; i++) {
            GF_EXP[i] = (uint8_t)z; GF_LOG[z] = (uint8_t)i;
            z <<= 1; if (z & 256) z ^= 0x11d;
        }
        for (int i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    }
};
static GfInit gf_init_once;
static uint8_t gf_mul(int a, int b) { return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0; }
static uint8_t gf_div(int a, int b) { return a ? GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255] : 0; }
static uint8_t gf_peval(const std::vector<uint8_t> &p, int x) {
    uint8_t y = 0;
    for (int i = (int)p.size() - 1; i >= 0; i--) y = gf_mul(y, x) ^ p[i];
    return y;
}
static std::vector<uint8_t> gf_pmul(const std::vector<uint8_t> &a, const std::vector<uint8_t> &b) {
    std::vector<uint8_t> o(a.size() + b.size() - 1, 0);
    for (size_t i = 0; i < a.size(); i++)
        for (size_t j = 0; j < b.size(); j++)
            o[i + j] ^= gf_mul(a[i], b[j]);
    return o;
}
static std::vector<uint8_t> rsEncode(const uint8_t *m, int k, int nsym) {
    std::vector<uint8_t> g(1, 1);
    for (int i = 0; i < nsym; i++) g = gf_pmul(g, {1, GF_EXP[i]});
    std::vector<uint8_t> out(m, m + k);
    out.resize(k + nsym, 0);
    for (int i = 0; i < k; i++) {
        uint8_t c = out[i];
        if (c) for (size_t j = 1; j < g.size(); j++) out[i + j] ^= gf_mul(g[j], c);
    }
    std::memcpy(out.data(), m, (size_t)k);
    return out;
}
static std::vector<uint8_t> rsSyndromes(const std::vector<uint8_t> &r, int nsym) {
    std::vector<uint8_t> s(nsym);
    for (int j = 0; j < nsym; j++) {
        uint8_t y = 0;
        for (uint8_t v : r) y = gf_mul(y, GF_EXP[j]) ^ v;
        s[j] = y;
    }
    return s;
}
/* Berlekamp-Massey */
static std::vector<uint8_t> rsBm(const std::vector<uint8_t> &s) {
    std::vector<uint8_t> c(s.size() + 1, 0), b(s.size() + 1, 0);
    c[0] = b[0] = 1;
    int L = 0, m = 1; uint8_t bb = 1;
    for (size_t n = 0; n < s.size(); n++) {
        uint8_t d = s[n];
        for (int i = 1; i <= L; i++) d ^= gf_mul(c[i], s[n - i]);
        if (!d) { m++; continue; }
        std::vector<uint8_t> t = c;
        uint8_t v = gf_div(d, bb);
        for (size_t i = 0; i + m < c.size(); i++) c[i + m] ^= gf_mul(v, b[i]);
        if (2 * L <= (int)n) { L = (int)n + 1 - L; b = t; bb = d; m = 1; }
        else m++;
    }
    c.resize(L + 1);
    return c;
}
/* Errors-only RS decode; returns corrected count or throws. */
static int rsDecode(std::vector<uint8_t> &r, int nsym) {
    auto s = rsSyndromes(r, nsym);
    bool allzero = true;
    for (auto v : s) if (v) { allzero = false; break; }
    if (allzero) return 0;
    auto loc = rsBm(s);
    int L = (int)loc.size() - 1;
    if (2 * L > nsym) throw Error("RS correction limit");
    std::vector<int> pos;
    for (int p = 0; p < (int)r.size(); p++) {
        int e = (int)r.size() - 1 - p;
        if (gf_peval(loc, GF_EXP[(255 - e) % 255]) == 0) pos.push_back(p);
    }
    if ((int)pos.size() != L) throw Error("RS roots");
    auto omegaFull = gf_pmul(s, loc);
    std::vector<uint8_t> omega(omegaFull.begin(), omegaFull.begin() + nsym);
    std::vector<uint8_t> der(std::max(1, L), 0);
    for (int i = 1; i <= L; i += 2) der[i - 1] = loc[i];
    for (int p : pos) {
        int e = (int)r.size() - 1 - p;
        uint8_t X = GF_EXP[e], xi = GF_EXP[(255 - e) % 255];
        r[p] ^= gf_div(gf_mul(X, gf_peval(omega, xi)), gf_peval(der, xi));
    }
    for (auto v : rsSyndromes(r, nsym)) if (v) throw Error("RS syndrome check");
    return (int)pos.size();
}

/* --------------------------------------------------------------------- CRC */
static uint32_t crc32prism(const uint8_t *bytes, size_t len) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        c ^= bytes[i];
        for (int j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    }
    return c ^ 0xFFFFFFFFu;
}
static int crc4(const std::vector<uint8_t> &bits, int n) {
    int r = 0;
    for (int i = 0; i < n; i++) {
        int f = ((r >> 3) & 1) ^ bits[i];
        r = (r << 1) & 15;
        if (f) r ^= 3;
    }
    return r;
}
static void pushBits(std::vector<uint8_t> &a, uint32_t x, int n) {
    for (int k = n - 1; k >= 0; k--) a.push_back((uint8_t)((x >> k) & 1));
}

/* ------------------------------------------------------------------ layout */
struct Cell {
    int i = 0, j = 0;
    double x = 0, y = 0;
    int role = ROLE_DATA, symbol = -1, pi = 0, pj = 0, header = -1, index = 0;
};
struct Layout {
    int size, C, R;
    double W, H;
    std::vector<Cell> cells;
    std::vector<int> headers; /* 72 */
    std::vector<int> data;    /* data cell indices, shuffled (encode order) */
    std::vector<int> known;   /* ring+pilot, row-major */
};

static Layout layoutBuild(int size) {
    if (size < 0 || size > 5) throw Error("Unknown size");
    Layout l;
    l.size = size;
    l.C = SIZES[size][0]; l.R = SIZES[size][1];
    l.cells.resize((size_t)l.C * l.R);
    std::vector<int> M;
    for (int j = 0; j < l.R; j++) for (int i = 0; i < l.C; i++) {
        Cell &c = l.cells[(size_t)j * l.C + i];
        c.i = i; c.j = j; c.index = j * l.C + i;
        c.pi = (i - 2) / 5; c.pj = (j - 2) / 5;
        c.x = S3 * (i + 0.5 + 0.5 * (j & 1));
        c.y = 1 + 1.5 * j;
        if (j <= 2 && i <= 2) { c.role = ROLE_GAP; c.symbol = 8; }
        else if (j == 0 || j == l.R - 1 || i == 0 || i == l.C - 1) { c.role = ROLE_RING; c.symbol = (j * 5 + i * 3) % 8; }
        else if (i % 5 == 2 && j % 5 == 2) { c.role = ROLE_PILOT; c.symbol = (c.pi * 2 + c.pj * 3) % 9; }
        if (c.role == ROLE_DATA) M.push_back(c.index);
        else if (c.role != ROLE_GAP) l.known.push_back(c.index);
    }
    for (int n = 0; n < 72; n++) {
        int mi = (int)((n + 0.5) * (double)M.size() / 72.0);
        Cell &c = l.cells[(size_t)M[mi]];
        c.role = ROLE_HEADER; c.header = n;
        l.headers.push_back(c.index);
    }
    for (int k = 0; k < (int)l.cells.size(); k++)
        if (l.cells[k].role == ROLE_DATA) l.data.push_back(k);
    Rng rand(0x5EEDu ^ (uint32_t)size);
    for (int i = (int)l.data.size() - 1; i > 0; i--) {
        int j = (int)(rand.next() * (i + 1));
        std::swap(l.data[i], l.data[j]);
    }
    l.W = S3 * (l.C + 0.5);
    l.H = 2 + 1.5 * (l.R - 1);
    return l;
}
static int knownSymbol(const Cell &c, int mode) {
    if (mode) {
        if (c.role == ROLE_RING) return 0;
        return (c.pi + c.pj) % 2 == 0 ? 0 : 8;
    }
    return c.symbol;
}

/* ---------------------------------------------------------------- capacity */
struct RBlock { int n, nsym, k; };
struct Capacity { int n; std::vector<RBlock> blocks; int k; int payload; };

static Capacity capacityOf(int size, int ecc, int mode) {
    Layout l = layoutBuild(size);
    int n = (int)l.data.size() * (mode ? 1 : 3) / 8;
    int B = (n + 254) / 255;
    Capacity cap; cap.n = n; cap.k = 0;
    for (int i = 0; i < B; i++) {
        int len = n / B + (i < n % B ? 1 : 0);
        int nsym = 2 * (int)std::floor(len * ECC_T[ecc] / 2 + 0.5);
        if (nsym < 4) nsym = 4;
        cap.blocks.push_back({len, nsym, len - nsym});
        cap.k += len - nsym;
    }
    cap.payload = std::max(0, cap.k - 4);
    return cap;
}
int capacityPayload(int size, int ecc, int mode) { return capacityOf(size, ecc, mode).payload; }

static std::vector<uint8_t> headerBits(int size, int ecc, int mode, int type, int L) {
    std::vector<uint8_t> b;
    pushBits(b, (uint32_t)size, 3);
    pushBits(b, (uint32_t)ecc, 2);
    pushBits(b, (uint32_t)mode, 1);
    pushBits(b, (uint32_t)type, 1);
    pushBits(b, (uint32_t)L, 13);
    pushBits(b, (uint32_t)crc4(b, 20), 4);
    return b;
}

/* ------------------------------------------------------------------ encode */
struct Code {
    int size, ecc, mode, type;
    std::vector<uint8_t> symbols;
    Layout l;
    Capacity cap;
};

static Code encodeCode(const std::vector<uint8_t> &bytes, int size, int ecc, int mode, int type) {
    if (bytes.size() > 8191) throw Error("Payload exceeds 8191 bytes");
    if (size < 0) {
        size = -1;
        for (int s = 0; s < 6; s++)
            if ((size_t)capacityOf(s, ecc, mode).k >= bytes.size() + 4) { size = s; break; }
        if (size < 0) throw Error("Payload too large for this mode and ECC");
    }
    Code code;
    code.cap = capacityOf(size, ecc, mode);
    if ((size_t)code.cap.k < bytes.size() + 4)
        throw Error("Payload does not fit: maximum " + std::to_string(code.cap.payload) + " bytes");
    code.l = layoutBuild(size);
    code.size = size; code.ecc = ecc; code.mode = mode; code.type = type;
    Layout &l = code.l;
    code.symbols.assign(l.cells.size(), 8);

    std::vector<uint8_t> msg(code.cap.k, 0);
    for (size_t i = bytes.size() + 4; i < msg.size(); i++) msg[i] = padk((uint32_t)i);
    std::memcpy(msg.data(), bytes.data(), bytes.size());
    uint32_t crc = crc32prism(bytes.data(), bytes.size());
    for (int k = 0; k < 4; k++) msg[bytes.size() + k] = (uint8_t)(crc >> (24 - 8 * k));

    std::vector<std::vector<uint8_t>> blocks;
    int maxn = 0, off = 0;
    for (auto &rb : code.cap.blocks) {
        blocks.push_back(rsEncode(msg.data() + off, rb.k, rb.nsym));
        off += rb.k;
        maxn = std::max(maxn, rb.n);
    }
    std::vector<uint8_t> stream;
    stream.reserve(code.cap.n * 8);
    for (int p = 0; p < maxn; p++)
        for (size_t b = 0; b < blocks.size(); b++)
            if (p < (int)blocks[b].size()) pushBits(stream, blocks[b][p], 8);

    for (int idx : l.known) code.symbols[idx] = (uint8_t)knownSymbol(l.cells[idx], mode);
    auto hb = headerBits(size, ecc, mode, type, (int)bytes.size());
    for (int idx : l.headers) code.symbols[idx] = hb[l.cells[idx].header % 24] ? 0 : 8;
    for (auto &c : l.cells)
        if (c.role == ROLE_GAP)
            code.symbols[c.index] = (uint8_t)(mode ? ((c.i + c.j) % 2 ? 0 : 8) : (c.j * 5 + c.i * 3) % 8);
    Rng rand(0xBEEFu);
    size_t at = 0;
    for (int idx : l.data) {
        if (mode) {
            int bit = at < stream.size() ? stream[at++] : (rand.next() > 0.5 ? 1 : 0);
            code.symbols[idx] = bit ? 0 : 8;
        } else {
            int b = 0;
            for (int q = 0; q < 3; q++) {
                int bit = at < stream.size() ? stream[at++] : (rand.next() > 0.5 ? 1 : 0);
                b = (b << 1) | bit;
            }
            int v = b; v ^= v >> 1; v ^= v >> 2;
            code.symbols[idx] = (uint8_t)v;
        }
    }
    return code;
}

/* ------------------------------------------------------------------ render */
Image encode(const std::vector<uint8_t> &payload, int size, int ecc, int mode, int type, int scale) {
    Code code = encodeCode(payload, size, ecc, mode, type);
    if (scale <= 0) scale = 12;
    double r = scale;
    const Layout &l = code.l;
    Image img;
    img.width = (int)std::ceil((l.W + 2 * PQ) * r);
    img.height = (int)std::ceil((l.H + 2 * PQ) * r);
    img.rgba.assign((size_t)img.width * img.height * 4, 255);
    static const double DEG = 3.141592653589793 / 180.0;
    for (const Cell &c : l.cells) {
        int s = code.symbols[c.index];
        if (s == 8) continue;
        double vx[6], vy[6];
        for (int k = 0; k < 6; k++) {
            double a = (30 + 60 * k) * DEG;
            vx[k] = (c.x + PQ + 1.03 * std::cos(a)) * r;
            vy[k] = (c.y + PQ + 1.03 * std::sin(a)) * r;
        }
        double ymin = vy[0], ymax = vy[0];
        for (int k = 1; k < 6; k++) { ymin = std::min(ymin, vy[k]); ymax = std::max(ymax, vy[k]); }
        int y0 = std::max(0, (int)std::floor(ymin));
        int y1 = std::min(img.height - 1, (int)std::ceil(ymax));
        const uint8_t *col = PALETTE[s];
        for (int y = y0; y <= y1; y++) {
            double yc = y + 0.5, xs[6];
            int nx = 0;
            for (int k = 0; k < 6; k++) {
                int k2 = (k + 1) % 6;
                if ((vy[k] <= yc && vy[k2] > yc) || (vy[k2] <= yc && vy[k] > yc))
                    xs[nx++] = vx[k] + (yc - vy[k]) / (vy[k2] - vy[k]) * (vx[k2] - vx[k]);
            }
            std::sort(xs, xs + nx);
            for (int p = 0; p + 1 < nx; p += 2) {
                int xa = std::max(0, (int)std::ceil(xs[p] - 0.5));
                int xb = std::min(img.width - 1, (int)std::floor(xs[p + 1] - 0.5));
                for (int x = xa; x <= xb; x++) {
                    size_t o = 4 * ((size_t)y * img.width + x);
                    img.rgba[o] = col[0]; img.rgba[o + 1] = col[1]; img.rgba[o + 2] = col[2]; img.rgba[o + 3] = 255;
                }
            }
        }
    }
    return img;
}

/* --------------------------------------------------------------------- PNG */
static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void putBe32(std::vector<uint8_t> &v, uint32_t x) {
    v.push_back((uint8_t)(x >> 24)); v.push_back((uint8_t)(x >> 16));
    v.push_back((uint8_t)(x >> 8)); v.push_back((uint8_t)x);
}
void writePng(const std::string &path, const Image &img) {
    size_t stride = (size_t)img.width * 4;
    std::vector<uint8_t> raw((stride + 1) * img.height);
    for (int y = 0; y < img.height; y++) {
        raw[(size_t)y * (stride + 1)] = 0;
        std::memcpy(raw.data() + (size_t)y * (stride + 1) + 1, img.rgba.data() + (size_t)y * stride, stride);
    }
    uLongf clen = compressBound((uLong)raw.size());
    std::vector<uint8_t> comp(clen);
    if (compress2(comp.data(), &clen, raw.data(), (uLong)raw.size(), 9) != Z_OK)
        throw Error("PNG compression failed");
    std::vector<uint8_t> png;
    const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    png.insert(png.end(), sig, sig + 8);
    auto chunk = [&](const char *type, const uint8_t *data, size_t len) {
        putBe32(png, (uint32_t)len);
        size_t at = png.size();
        png.insert(png.end(), type, type + 4);
        png.insert(png.end(), data, data + len);
        uLong cc = crc32(0L, Z_NULL, 0);
        cc = crc32(cc, png.data() + at, (uInt)(4 + len));
        putBe32(png, (uint32_t)cc);
    };
    uint8_t ihdr[13];
    ihdr[0] = (uint8_t)(img.width >> 24); ihdr[1] = (uint8_t)(img.width >> 16);
    ihdr[2] = (uint8_t)(img.width >> 8); ihdr[3] = (uint8_t)img.width;
    ihdr[4] = (uint8_t)(img.height >> 24); ihdr[5] = (uint8_t)(img.height >> 16);
    ihdr[6] = (uint8_t)(img.height >> 8); ihdr[7] = (uint8_t)img.height;
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    chunk("IHDR", ihdr, 13);
    chunk("IDAT", comp.data(), clen);
    chunk("IEND", nullptr, 0);
    FILE *f = std::fopen(path.c_str(), "wb");
    if (!f) throw Error("Cannot open output file: " + path);
    size_t wrote = std::fwrite(png.data(), 1, png.size(), f);
    bool closed = std::fclose(f) == 0;
    if (wrote != png.size() || !closed) throw Error("Cannot write output file: " + path);
}
Image readPng(const std::string &path) {
    FILE *f = std::fopen(path.c_str(), "rb");
    if (!f) throw Error("Cannot open input file: " + path);
    std::fseek(f, 0, SEEK_END);
    long flen = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (flen < 8) { std::fclose(f); throw Error("Not a PNG file"); }
    std::vector<uint8_t> buf((size_t)flen);
    if (std::fread(buf.data(), 1, (size_t)flen, f) != (size_t)flen) { std::fclose(f); throw Error("Cannot read input file"); }
    std::fclose(f);
    const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (std::memcmp(buf.data(), sig, 8)) throw Error("Not a PNG file");
    int w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    std::vector<uint8_t> idat;
    size_t pos = 8;
    while (pos + 12 <= buf.size()) {
        uint32_t clen = be32(buf.data() + pos);
        if (pos + 12 + clen > buf.size()) break;
        const uint8_t *type = buf.data() + pos + 4;
        const uint8_t *data = buf.data() + pos + 8;
        if (!std::memcmp(type, "IHDR", 4)) {
            w = (int)be32(data); h = (int)be32(data + 4);
            depth = data[8]; ctype = data[9]; interlace = data[12];
        } else if (!std::memcmp(type, "IDAT", 4)) {
            idat.insert(idat.end(), data, data + clen);
        } else if (!std::memcmp(type, "IEND", 4)) break;
        pos += 12 + clen;
    }
    int ch = ctype == 6 ? 4 : ctype == 2 ? 3 : ctype == 0 ? 1 : 0;
    if (w <= 0 || h <= 0 || depth != 8 || !ch || interlace != 0 || idat.empty())
        throw Error("Unsupported PNG (need 8-bit gray/RGB/RGBA, non-interlaced)");
    size_t stride = (size_t)w * ch, rawlen = (stride + 1) * (size_t)h;
    std::vector<uint8_t> raw(rawlen);
    uLongf destlen = (uLongf)rawlen;
    if (uncompress(raw.data(), &destlen, idat.data(), (uLong)idat.size()) != Z_OK || destlen != rawlen)
        throw Error("PNG decompression failed");
    std::vector<uint8_t> out(stride * (size_t)h);
    size_t p = 0;
    for (int y = 0; y < h; y++) {
        int filter = raw[p++];
        const uint8_t *row = raw.data() + p; p += stride;
        uint8_t *cur = out.data() + (size_t)y * stride;
        const uint8_t *prev = y ? out.data() + (size_t)(y - 1) * stride : nullptr;
        for (size_t x = 0; x < stride; x++) {
            int a = x >= (size_t)ch ? cur[x - ch] : 0;
            int b = prev ? prev[x] : 0;
            int c = (prev && x >= (size_t)ch) ? prev[x - ch] : 0;
            int v = row[x];
            if (filter == 1) v += a;
            else if (filter == 2) v += b;
            else if (filter == 3) v += (a + b) >> 1;
            else if (filter == 4) {
                int pp = a + b - c, pa = std::abs(pp - a), pb = std::abs(pp - b), pc = std::abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            } else if (filter != 0) throw Error("Bad PNG filter");
            cur[x] = (uint8_t)v;
        }
    }
    Image img;
    img.width = w; img.height = h;
    img.rgba.resize((size_t)w * h * 4);
    for (size_t i = 0; i < (size_t)w * h; i++) {
        img.rgba[4 * i] = out[ch * i];
        img.rgba[4 * i + 1] = ch > 1 ? out[ch * i + 1] : out[ch * i];
        img.rgba[4 * i + 2] = ch > 1 ? out[ch * i + 2] : out[ch * i];
        img.rgba[4 * i + 3] = ch == 4 ? out[4 * i + 3] : 255;
    }
    return img;
}
void encodePng(const std::vector<uint8_t> &payload, const std::string &path,
               int size, int ecc, int mode, int type, int scale) {
    writePng(path, encode(payload, size, ecc, mode, type, scale));
}

/* ------------------------------------------------------------------ decode */
static int nearestSymbol(int r, int g, int b) {
    int best = 8; long bd = LONG_MAX;
    for (int i = 0; i < 9; i++) {
        long dr = r - PALETTE[i][0], dg = g - PALETTE[i][1], db = b - PALETTE[i][2];
        long d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}
static bool utf8Valid(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint8_t c = s[i];
        int need; uint32_t cp;
        if (c < 0x80) { i++; continue; }
        else if ((c & 0xE0) == 0xC0) { need = 1; cp = c & 0x1F; if (cp < 2) return false; }
        else if ((c & 0xF0) == 0xE0) { need = 2; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { need = 3; cp = c & 0x07; if (cp > 4) return false; }
        else return false;
        if (n - i < (size_t)need + 1) return false;
        for (int k = 1; k <= need; k++) {
            if ((s[i + k] & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (s[i + k] & 0x3F);
        }
        if ((need == 1 && cp < 0x80) || (need == 2 && cp < 0x800) || (need == 3 && cp < 0x10000)) return false;
        if (cp >= 0xD800 && cp <= 0xDFFF) return false;
        if (cp > 0x10FFFF) return false;
        i += (size_t)need + 1;
    }
    return true;
}

static DecodeResult decodeSized(const Image &img, int size, double r) {
    Layout l = layoutBuild(size);
    std::vector<uint8_t> sym(l.cells.size());
    for (size_t k = 0; k < l.cells.size(); k++) {
        const Cell &c = l.cells[k];
        int x = (int)((c.x + PQ) * r), y = (int)((c.y + PQ) * r);
        x = std::max(0, std::min(img.width - 1, x));
        y = std::max(0, std::min(img.height - 1, y));
        const uint8_t *px = img.rgba.data() + 4 * ((size_t)y * img.width + x);
        sym[k] = (uint8_t)nearestSymbol(px[0], px[1], px[2]);
    }
    /* header: 3 voted copies of each of 24 bits */
    std::vector<uint8_t> hb(24, 0);
    for (int b = 0; b < 24; b++) {
        int vote = 0;
        for (int idx : l.headers) {
            const Cell &c = l.cells[idx];
            if (c.header % 24 != b) continue;
            vote += sym[idx] == 0 ? 1 : (sym[idx] == 8 ? -1 : 0);
        }
        hb[b] = vote > 0 ? 1 : 0;
    }
    int at = 0;
    auto readBits = [&](int n) { int v = 0; while (n--) v = (v << 1) | hb[at++]; return v; };
    int hsize = readBits(3), hecc = readBits(2), hmode = readBits(1), htype = readBits(1);
    int hlen = readBits(13), hcrc = readBits(4);
    if (crc4(hb, 20) != hcrc || hsize > 5 || hsize != size)
        throw Error("Header checksum did not pass");
    Capacity cap = capacityOf(hsize, hecc, hmode);
    if (hlen > cap.payload) throw Error("Invalid length");

    int bitsPer = hmode ? 1 : 3;
    static const int INV_GRAY[8] = {0, 1, 3, 2, 6, 7, 5, 4};
    std::vector<uint8_t> stream;
    stream.reserve(l.data.size() * bitsPer);
    for (int idx : l.data) {
        int s = sym[idx];
        if (hmode) {
            if (s != 0 && s != 8) throw Error("Unexpected cell colors");
            stream.push_back(s == 0 ? 1 : 0);
        } else {
            if (s > 7) throw Error("Unexpected cell colors");
            int b = INV_GRAY[s];
            stream.push_back((uint8_t)((b >> 2) & 1));
            stream.push_back((uint8_t)((b >> 1) & 1));
            stream.push_back((uint8_t)(b & 1));
        }
    }
    std::vector<uint8_t> bytes(cap.n);
    for (int i = 0; i < cap.n; i++) {
        int v = 0;
        for (int k = 0; k < 8; k++) v = (v << 1) | stream[8 * i + k];
        bytes[i] = (uint8_t)v;
    }
    std::vector<std::vector<uint8_t>> bb(cap.blocks.size());
    int maxn = 0;
    for (size_t b = 0; b < cap.blocks.size(); b++) {
        bb[b].resize(cap.blocks[b].n);
        maxn = std::max(maxn, cap.blocks[b].n);
    }
    at = 0;
    for (int p = 0; p < maxn; p++)
        for (size_t b = 0; b < cap.blocks.size(); b++)
            if (p < (int)bb[b].size()) bb[b][p] = bytes[at++];
    /* restore encoder-written deterministic padding */
    int moff = 0;
    for (size_t b = 0; b < cap.blocks.size(); b++) {
        for (int p = 0; p < cap.blocks[b].k; p++)
            if (hlen > 0 && moff + p >= hlen + 4) bb[b][p] = padk((uint32_t)(moff + p));
        moff += cap.blocks[b].k;
    }
    std::vector<uint8_t> msg;
    msg.reserve(cap.k);
    for (size_t b = 0; b < cap.blocks.size(); b++) {
        if (rsDecode(bb[b], cap.blocks[b].nsym) < 0)
            throw Error("Error correction could not recover this image");
        msg.insert(msg.end(), bb[b].begin(), bb[b].begin() + cap.blocks[b].k);
    }
    uint32_t want = 0;
    for (int k = 0; k < 4; k++) want = (want << 8) | msg[hlen + k];
    if (crc32prism(msg.data(), (size_t)hlen) != want)
        throw Error("Payload checksum did not pass");
    DecodeResult res;
    res.bytes.assign(msg.begin(), msg.begin() + hlen);
    res.type = htype; res.size = hsize; res.ecc = hecc; res.mode = hmode;
    return res;
}

DecodeResult decodePng(const std::string &path) {
    Image img = readPng(path);
    std::string lasterr = "No Prism code found";
    for (int size = 0; size < 6; size++) {
        Layout probe = layoutBuild(size);
        double Wt = probe.W + 2 * PQ, Ht = probe.H + 2 * PQ;
        double r = ((double)img.width / Wt + (double)img.height / Ht) / 2;
        if (r < 3.9) continue;
        if (std::fabs(Wt * r - img.width) > 2.0 || std::fabs(Ht * r - img.height) > 2.0) continue;
        try {
            DecodeResult res = decodeSized(img, size, r);
            if (res.type == TYPE_TEXT && !utf8Valid(res.bytes.data(), res.bytes.size()))
                throw Error("Payload is not valid UTF-8 text");
            return res;
        } catch (const Error &e) {
            lasterr = e.what();
        }
    }
    throw Error(lasterr);
}

} // namespace prism
