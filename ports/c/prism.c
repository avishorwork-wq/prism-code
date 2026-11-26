/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C11 port of the live Prism Code format. A bit-exact port of the encoder and a
 * clean-image decoder, matching the live JavaScript (prism.html / use.html,
 * the self-contained Prism module). PNG I/O uses zlib (free, zlib license). */
#include "prism.h"

#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

/* ---------------------------------------------------------------- constants */
static const double S3 = 1.7320508075688772; /* sqrt(3) */
static const double PQ = 5.196152422706632;  /* 3*sqrt(3): quiet zone */
static const int PRISM_SIZES[6][2] = {{21,24},{29,33},{41,47},{57,66},{81,94},{113,130}};
static const uint8_t PALETTE[9][3] = {
    {0x1B,0x1B,0x1B},{0x2E,0x5B,0xFF},{0x00,0xB8,0xD9},{0x2D,0xB3,0x5A},
    {0xF5,0xC5,0x18},{0xF7,0x7F,0x00},{0xD7,0x26,0x3D},{0xB5,0x17,0x9E},
    {0xFF,0xFF,0xFF}};
static const double ECC_T[4] = {0.1, 0.2, 0.3, 0.4};

enum { ROLE_DATA, ROLE_RING, ROLE_PILOT, ROLE_GAP, ROLE_HEADER };

/* ------------------------------------------------------------- error helper */
static int fail(char *err, size_t errlen, const char *msg) {
    if (err && errlen) { snprintf(err, errlen, "%s", msg); }
    return -1;
}

/* ------------------------------------------------------- deterministic RNG */
/* Exact port of the JS rng: mulberry-style, all arithmetic mod 2^32. */
typedef struct { uint32_t s; } Rng;
static void rng_init(Rng *r, uint32_t seed) { r->s = seed; }
static double rng_next(Rng *r) {
    r->s += 0x6D2B79F5u;
    uint32_t t = (r->s ^ (r->s >> 15)) * (1u | r->s);
    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
    return (double)(t ^ (t >> 14)) / 4294967296.0;
}

/* Deterministic pad byte at message offset o (port of JS PADK). */
static uint8_t padk(uint32_t o) {
    uint32_t x = (o + 0x9E3779B9u) * 0x85EBCA6Bu;
    x ^= x >> 13; x *= 0xC2B2AE35u; x ^= x >> 16;
    return (uint8_t)(x & 255);
}

/* ------------------------------------------------------------ GF(256) / RS */
static uint8_t GF_EXP[512], GF_LOG[256];
static int gf_ready = 0;
static void gf_init(void) {
    if (gf_ready) return;
    int z = 1;
    for (int i = 0; i < 255; i++) {
        GF_EXP[i] = (uint8_t)z; GF_LOG[z] = (uint8_t)i;
        z <<= 1; if (z & 256) z ^= 0x11d;
    }
    for (int i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
    gf_ready = 1;
}
static uint8_t gf_mul(int a, int b) { return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0; }
static uint8_t gf_div(int a, int b) { return a ? GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255] : 0; }
static uint8_t gf_peval(const uint8_t *p, int plen, int x) {
    uint8_t y = 0;
    for (int i = plen - 1; i >= 0; i--) y = gf_mul(y, x) ^ p[i];
    return y;
}
/* polynomial multiply; out must hold alen+blen-1 bytes */
static void gf_pmul(const uint8_t *a, int alen, const uint8_t *b, int blen, uint8_t *out) {
    memset(out, 0, (size_t)(alen + blen - 1));
    for (int i = 0; i < alen; i++)
        for (int j = 0; j < blen; j++)
            out[i + j] ^= gf_mul(a[i], b[j]);
}
/* RS encode: in k bytes, out n = k+nsym bytes (systematic). */
static void rs_encode(const uint8_t *m, int k, int nsym, uint8_t *out) {
    gf_init();
    uint8_t g[256], tmp[256];
    int glen = 1; g[0] = 1;
    for (int i = 0; i < nsym; i++) {
        uint8_t f[2] = {1, GF_EXP[i]};
        gf_pmul(g, glen, f, 2, tmp);
        glen++; memcpy(g, tmp, (size_t)glen);
    }
    memset(out, 0, (size_t)(k + nsym));
    memcpy(out, m, (size_t)k);
    for (int i = 0; i < k; i++) {
        uint8_t c = out[i];
        if (c) for (int j = 1; j < glen; j++) out[i + j] ^= gf_mul(g[j], c);
    }
    memcpy(out, m, (size_t)k);
}
static void rs_syndromes(const uint8_t *r, int rlen, int nsym, uint8_t *s) {
    for (int j = 0; j < nsym; j++) {
        uint8_t y = 0;
        for (int i = 0; i < rlen; i++) y = gf_mul(y, GF_EXP[j]) ^ r[i];
        s[j] = y;
    }
}
/* Berlekamp-Massey; returns connection poly length L, fills c (len L+1). */
static int rs_bm(const uint8_t *s, int slen, uint8_t *c_out) {
    uint8_t c[256], b[256], t[256];
    memset(c, 0, sizeof(c)); memset(b, 0, sizeof(b));
    c[0] = b[0] = 1;
    int L = 0, m = 1; uint8_t bb = 1;
    for (int n = 0; n < slen; n++) {
        uint8_t d = s[n];
        for (int i = 1; i <= L; i++) d ^= gf_mul(c[i], s[n - i]);
        if (!d) { m++; continue; }
        memcpy(t, c, sizeof(c));
        uint8_t v = gf_div(d, bb);
        for (int i = 0; i + m < 256; i++) c[i + m] ^= gf_mul(v, b[i]);
        if (2 * L <= n) { L = n + 1 - L; memcpy(b, t, sizeof(b)); bb = d; m = 1; }
        else m++;
    }
    memcpy(c_out, c, (size_t)(L + 1));
    return L;
}
/* RS decode (errors only). Returns number of corrected symbols, -1 on failure. */
static int rs_decode(uint8_t *r, int rlen, int nsym) {
    gf_init();
    uint8_t s[256];
    rs_syndromes(r, rlen, nsym, s);
    int allzero = 1;
    for (int j = 0; j < nsym; j++) if (s[j]) { allzero = 0; break; }
    if (allzero) return 0;
    uint8_t loc_in[256];
    int L = rs_bm(s, nsym, loc_in);
    if (2 * L > nsym) return -1;
    /* find roots */
    int pos[256], npos = 0;
    for (int p = 0; p < rlen; p++) {
        int e = rlen - 1 - p;
        if (gf_peval(loc_in, L + 1, GF_EXP[(255 - e) % 255]) == 0) pos[npos++] = p;
    }
    if (npos != L) return -1;
    uint8_t omega[512], der[256];
    gf_pmul(s, nsym, loc_in, L + 1, omega); /* use first nsym coefficients */
    memset(der, 0, sizeof(der));
    int dlen = L > 1 ? L : 1;
    for (int i = 1; i <= L; i += 2) der[i - 1] = loc_in[i];
    for (int pi = 0; pi < npos; pi++) {
        int p = pos[pi];
        int e = rlen - 1 - p;
        uint8_t X = GF_EXP[e], xi = GF_EXP[(255 - e) % 255];
        r[p] ^= gf_div(gf_mul(X, gf_peval(omega, nsym, xi)), gf_peval(der, dlen, xi));
    }
    rs_syndromes(r, rlen, nsym, s);
    for (int j = 0; j < nsym; j++) if (s[j]) return -1;
    return npos;
}

/* ------------------------------------------------------------------- CRC32 */
static uint32_t prism_crc32(const uint8_t *bytes, size_t len) {
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        c ^= bytes[i];
        for (int j = 0; j < 8; j++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
    }
    return c ^ 0xFFFFFFFFu;
}
/* 4-bit header checksum (poly x^4+x+1). */
static int prism_crc4(const uint8_t *bits, int n) {
    int r = 0;
    for (int i = 0; i < n; i++) {
        int f = ((r >> 3) & 1) ^ bits[i];
        r = (r << 1) & 15;
        if (f) r ^= 3;
    }
    return r;
}
static void push_bits(uint8_t *a, int *n, uint32_t x, int count) {
    for (int k = count - 1; k >= 0; k--) a[(*n)++] = (uint8_t)((x >> k) & 1);
}

/* ------------------------------------------------------------------ layout */
typedef struct {
    int i, j;
    double x, y;
    int role, symbol, pi, pj, header, index;
} Cell;
typedef struct {
    int size, C, R;
    double W, H;
    Cell *cells; int ncells;
    int *headers; int nheaders; /* 72 */
    int *data;    int ndata;    /* cell indices, shuffled (encode order) */
    int *known;   int nknown;   /* ring+pilot, row-major */
} Layout;

static void layout_free(Layout *l) {
    if (!l) return;
    free(l->cells); free(l->headers); free(l->data); free(l->known);
    memset(l, 0, sizeof(*l));
}
static int layout_build(int size, Layout *l, char *err, size_t errlen) {
    if (size < 0 || size > 5) return fail(err, errlen, "Unknown size");
    memset(l, 0, sizeof(*l));
    int C = PRISM_SIZES[size][0], R = PRISM_SIZES[size][1];
    l->size = size; l->C = C; l->R = R;
    l->ncells = C * R;
    l->cells = calloc((size_t)l->ncells, sizeof(Cell));
    l->headers = malloc(sizeof(int) * 72);
    l->data = malloc(sizeof(int) * (size_t)l->ncells);
    l->known = malloc(sizeof(int) * (size_t)l->ncells);
    if (!l->cells || !l->headers || !l->data || !l->known)
        return fail(err, errlen, "Out of memory");
    int *M = malloc(sizeof(int) * (size_t)l->ncells); /* data cells, row-major */
    int mlen = 0;
    for (int j = 0; j < R; j++) for (int i = 0; i < C; i++) {
        Cell *c = &l->cells[j * C + i];
        c->i = i; c->j = j; c->role = ROLE_DATA; c->symbol = -1;
        c->pi = (i - 2) / 5; c->pj = (j - 2) / 5; c->header = -1;
        c->index = j * C + i;
        c->x = S3 * (i + 0.5 + 0.5 * (j & 1));
        c->y = 1 + 1.5 * j;
        if (j <= 2 && i <= 2) { c->role = ROLE_GAP; c->symbol = 8; }
        else if (j == 0 || j == R - 1 || i == 0 || i == C - 1) { c->role = ROLE_RING; c->symbol = (j * 5 + i * 3) % 8; }
        else if (i % 5 == 2 && j % 5 == 2) { c->role = ROLE_PILOT; c->symbol = (c->pi * 2 + c->pj * 3) % 9; }
        if (c->role == ROLE_DATA) M[mlen++] = c->index;
        else if (c->role != ROLE_GAP) l->known[l->nknown++] = c->index;
    }
    /* 72 header cells spread evenly through the data cells */
    for (int n = 0; n < 72; n++) {
        int mi = (int)((n + 0.5) * (double)mlen / 72.0);
        Cell *c = &l->cells[M[mi]];
        c->role = ROLE_HEADER; c->header = n;
        l->headers[n] = c->index;
    }
    l->nheaders = 72;
    free(M);
    for (int k = 0; k < l->ncells; k++)
        if (l->cells[k].role == ROLE_DATA) l->data[l->ndata++] = k;
    /* seeded Fisher-Yates shuffle of the data order */
    Rng rand; rng_init(&rand, 0x5EEDu ^ (uint32_t)size);
    for (int i = l->ndata - 1; i > 0; i--) {
        int j = (int)(rng_next(&rand) * (i + 1));
        int t = l->data[i]; l->data[i] = l->data[j]; l->data[j] = t;
    }
    l->W = S3 * (C + 0.5);
    l->H = 2 + 1.5 * (R - 1);
    return 0;
}
static int known_symbol(const Cell *c, int mode) {
    if (mode) {
        if (c->role == ROLE_RING) return 0;
        return (c->pi + c->pj) % 2 == 0 ? 0 : 8;
    }
    return c->symbol;
}

/* ---------------------------------------------------------------- capacity */
typedef struct { int n, nsym, k; } RBlock;
typedef struct { int n; RBlock blocks[40]; int nblocks; int k; int payload; } Capacity;

static int capacity_of(int size, int ecc, int mode, Capacity *cap, char *err, size_t errlen) {
    Layout l;
    if (layout_build(size, &l, err, errlen)) return -1;
    int n = l.ndata * (mode ? 1 : 3) / 8;
    int B = (n + 254) / 255;
    if (B > 40) { layout_free(&l); return fail(err, errlen, "Internal block overflow"); }
    cap->n = n; cap->nblocks = B; cap->k = 0;
    for (int i = 0; i < B; i++) {
        int len = n / B + (i < n % B ? 1 : 0);
        int nsym = 2 * (int)floor(len * ECC_T[ecc] / 2 + 0.5);
        if (nsym < 4) nsym = 4;
        cap->blocks[i].n = len; cap->blocks[i].nsym = nsym; cap->blocks[i].k = len - nsym;
        cap->k += len - nsym;
    }
    cap->payload = cap->k - 4; if (cap->payload < 0) cap->payload = 0;
    layout_free(&l);
    return 0;
}
int prism_capacity_payload(int size, int ecc, int mode) {
    Capacity cap; char e[64];
    if (capacity_of(size, ecc, mode, &cap, e, sizeof(e))) return -1;
    return cap.payload;
}

static void header_bits(int size, int ecc, int mode, int type, int L, uint8_t *b /*24*/) {
    int n = 0;
    push_bits(b, &n, (uint32_t)size, 3);
    push_bits(b, &n, (uint32_t)ecc, 2);
    push_bits(b, &n, (uint32_t)mode, 1);
    push_bits(b, &n, (uint32_t)type, 1);
    push_bits(b, &n, (uint32_t)L, 13);
    push_bits(b, &n, (uint32_t)prism_crc4(b, 20), 4);
}

/* ------------------------------------------------------------------ encode */
typedef struct {
    int size, ecc, mode, type;
    uint8_t *symbols; /* ncells */
    Layout l;
    Capacity cap;
} Code;

static int prism_encode(const uint8_t *bytes, size_t len, int size, int ecc, int mode,
                        int type, Code *code, char *err, size_t errlen) {
    char e[128];
    if (len > 8191) return fail(err, errlen, "Payload exceeds 8191 bytes");
    if (size < 0) {
        size = -1;
        for (int s = 0; s < 6; s++) {
            Capacity c0;
            if (capacity_of(s, ecc, mode, &c0, e, sizeof(e))) return fail(err, errlen, e);
            if ((size_t)c0.k >= len + 4) { size = s; break; }
        }
        if (size < 0) return fail(err, errlen, "Payload too large for this mode and ECC");
    }
    if (capacity_of(size, ecc, mode, &code->cap, e, sizeof(e))) return fail(err, errlen, e);
    Capacity cap = code->cap;
    if ((size_t)cap.k < len + 4) {
        snprintf(e, sizeof(e), "Payload does not fit: maximum %d bytes", cap.payload);
        return fail(err, errlen, e);
    }
    if (layout_build(size, &code->l, e, sizeof(e))) return fail(err, errlen, e);
    Layout *l = &code->l;
    code->size = size; code->ecc = ecc; code->mode = mode; code->type = type;
    code->symbols = malloc((size_t)l->ncells);
    if (!code->symbols) return fail(err, errlen, "Out of memory");

    uint8_t *msg = calloc((size_t)cap.k, 1);
    for (size_t i = len + 4; i < (size_t)cap.k; i++) msg[i] = padk((uint32_t)i);
    memcpy(msg, bytes, len);
    uint32_t crc = prism_crc32(bytes, len);
    for (int k = 0; k < 4; k++) msg[len + k] = (uint8_t)(crc >> (24 - 8 * k));

    /* RS blocks */
    int maxn = 0, off = 0;
    uint8_t **blocks = malloc(sizeof(uint8_t *) * (size_t)cap.nblocks);
    for (int b = 0; b < cap.nblocks; b++) {
        RBlock *rb = &cap.blocks[b];
        blocks[b] = malloc((size_t)rb->n);
        rs_encode(msg + off, rb->k, rb->nsym, blocks[b]);
        off += rb->k;
        if (rb->n > maxn) maxn = rb->n;
    }
    free(msg);
    /* interleaved bit stream */
    int streamcap = cap.n * 8;
    uint8_t *stream = malloc((size_t)streamcap);
    int sn = 0;
    for (int p = 0; p < maxn; p++)
        for (int b = 0; b < cap.nblocks; b++)
            if (p < cap.blocks[b].n) push_bits(stream, &sn, blocks[b][p], 8);
    for (int b = 0; b < cap.nblocks; b++) free(blocks[b]);
    free(blocks);

    for (int k = 0; k < l->ncells; k++) code->symbols[k] = 8;
    for (int k = 0; k < l->nknown; k++) {
        Cell *c = &l->cells[l->known[k]];
        code->symbols[c->index] = (uint8_t)known_symbol(c, mode);
    }
    uint8_t hb[24];
    header_bits(size, ecc, mode, type, (int)len, hb);
    for (int k = 0; k < l->nheaders; k++) {
        Cell *c = &l->cells[l->headers[k]];
        code->symbols[c->index] = hb[c->header % 24] ? 0 : 8;
    }
    for (int k = 0; k < l->ncells; k++) {
        Cell *c = &l->cells[k];
        if (c->role == ROLE_GAP)
            code->symbols[c->index] = (uint8_t)(mode ? ((c->i + c->j) % 2 ? 0 : 8) : (c->j * 5 + c->i * 3) % 8);
    }
    Rng rand; rng_init(&rand, 0xBEEFu);
    int at = 0;
    for (int k = 0; k < l->ndata; k++) {
        Cell *c = &l->cells[l->data[k]];
        if (mode) {
            int bit = at < sn ? stream[at++] : (rng_next(&rand) > 0.5 ? 1 : 0);
            code->symbols[c->index] = bit ? 0 : 8;
        } else {
            int b = 0;
            for (int q = 0; q < 3; q++) {
                int bit = at < sn ? stream[at++] : (rng_next(&rand) > 0.5 ? 1 : 0);
                b = (b << 1) | bit;
            }
            int v = b; v ^= v >> 1; v ^= v >> 2;
            code->symbols[c->index] = (uint8_t)v;
        }
    }
    free(stream);
    return 0;
}
static void code_free(Code *c) {
    if (!c) return;
    free(c->symbols);
    layout_free(&c->l);
    memset(c, 0, sizeof(*c));
}

/* ------------------------------------------------------------------ render */
static void render_rgba(const Code *code, int r, uint8_t **out, int *ow, int *oh,
                        char *err, size_t errlen) {
    const Layout *l = &code->l;
    int width = (int)ceil((l->W + 2 * PQ) * r);
    int height = (int)ceil((l->H + 2 * PQ) * r);
    uint8_t *rgba = malloc((size_t)width * height * 4);
    if (!rgba) { fail(err, errlen, "Out of memory"); *out = NULL; return; }
    memset(rgba, 255, (size_t)width * height * 4);
    static const double DEG = 3.141592653589793 / 180.0;
    for (int ci = 0; ci < l->ncells; ci++) {
        const Cell *c = &l->cells[ci];
        int s = code->symbols[c->index];
        if (s == 8) continue;
        double vx[6], vy[6];
        for (int k = 0; k < 6; k++) {
            double a = (30 + 60 * k) * DEG;
            vx[k] = (c->x + PQ + 1.03 * cos(a)) * r;
            vy[k] = (c->y + PQ + 1.03 * sin(a)) * r;
        }
        double ymin = vy[0], ymax = vy[0];
        for (int k = 1; k < 6; k++) { if (vy[k] < ymin) ymin = vy[k]; if (vy[k] > ymax) ymax = vy[k]; }
        int y0 = (int)floor(ymin); if (y0 < 0) y0 = 0;
        int y1 = (int)ceil(ymax); if (y1 > height - 1) y1 = height - 1;
        const uint8_t *col = PALETTE[s];
        for (int y = y0; y <= y1; y++) {
            double yc = y + 0.5, xs[6];
            int nx = 0;
            for (int k = 0; k < 6; k++) {
                int k2 = (k + 1) % 6;
                if ((vy[k] <= yc && vy[k2] > yc) || (vy[k2] <= yc && vy[k] > yc))
                    xs[nx++] = vx[k] + (yc - vy[k]) / (vy[k2] - vy[k]) * (vx[k2] - vx[k]);
            }
            /* insertion sort */
            for (int a = 1; a < nx; a++) {
                double v = xs[a]; int b2 = a - 1;
                while (b2 >= 0 && xs[b2] > v) { xs[b2 + 1] = xs[b2]; b2--; }
                xs[b2 + 1] = v;
            }
            for (int p = 0; p + 1 < nx; p += 2) {
                int xa = (int)ceil(xs[p] - 0.5); if (xa < 0) xa = 0;
                int xb = (int)floor(xs[p + 1] - 0.5); if (xb > width - 1) xb = width - 1;
                for (int x = xa; x <= xb; x++) {
                    size_t o = 4 * ((size_t)y * width + x);
                    rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2]; rgba[o + 3] = 255;
                }
            }
        }
    }
    *out = rgba; *ow = width; *oh = height;
}

/* --------------------------------------------------------------- PNG write */
static int png_write_rgba(const char *path, const uint8_t *rgba, int w, int h,
                          char *err, size_t errlen) {
    size_t stride = (size_t)w * 4;
    size_t rawlen = (stride + 1) * (size_t)h;
    uint8_t *raw = malloc(rawlen);
    if (!raw) return fail(err, errlen, "Out of memory");
    for (int y = 0; y < h; y++) {
        raw[y * (stride + 1)] = 0;
        memcpy(raw + y * (stride + 1) + 1, rgba + y * stride, stride);
    }
    uLongf clen = compressBound((uLong)rawlen);
    uint8_t *comp = malloc(clen);
    if (!comp) { free(raw); return fail(err, errlen, "Out of memory"); }
    if (compress2(comp, &clen, raw, (uLong)rawlen, 9) != Z_OK) {
        free(raw); free(comp); return fail(err, errlen, "PNG compression failed");
    }
    free(raw);
    FILE *f = fopen(path, "wb");
    if (!f) { free(comp); return fail(err, errlen, "Cannot open output file"); }
    static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    fwrite(sig, 1, 8, f);
    /* IHDR: RGBA 8-bit */
    uint8_t ihdr[13];
    ihdr[0] = (uint8_t)(w >> 24); ihdr[1] = (uint8_t)(w >> 16); ihdr[2] = (uint8_t)(w >> 8); ihdr[3] = (uint8_t)w;
    ihdr[4] = (uint8_t)(h >> 24); ihdr[5] = (uint8_t)(h >> 16); ihdr[6] = (uint8_t)(h >> 8); ihdr[7] = (uint8_t)h;
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    uint8_t hdr[4] = {0, 0, 0, 13};
    fwrite(hdr, 1, 4, f); fwrite("IHDR", 1, 4, f); fwrite(ihdr, 1, 13, f);
    uLong cc = crc32(0L, Z_NULL, 0);
    cc = crc32(cc, (const Bytef *)"IHDR", 4); cc = crc32(cc, ihdr, 13);
    uint8_t cbuf[4] = {(uint8_t)(cc >> 24), (uint8_t)(cc >> 16), (uint8_t)(cc >> 8), (uint8_t)cc};
    fwrite(cbuf, 1, 4, f);
    /* IDAT */
    hdr[0] = (uint8_t)(clen >> 24); hdr[1] = (uint8_t)(clen >> 16); hdr[2] = (uint8_t)(clen >> 8); hdr[3] = (uint8_t)clen;
    fwrite(hdr, 1, 4, f); fwrite("IDAT", 1, 4, f); fwrite(comp, 1, clen, f);
    cc = crc32(0L, Z_NULL, 0);
    cc = crc32(cc, (const Bytef *)"IDAT", 4); cc = crc32(cc, comp, clen);
    cbuf[0] = (uint8_t)(cc >> 24); cbuf[1] = (uint8_t)(cc >> 16); cbuf[2] = (uint8_t)(cc >> 8); cbuf[3] = (uint8_t)cc;
    fwrite(cbuf, 1, 4, f);
    free(comp);
    /* IEND */
    hdr[0] = hdr[1] = hdr[2] = hdr[3] = 0;
    fwrite(hdr, 1, 4, f); fwrite("IEND", 1, 4, f);
    cc = crc32(0L, Z_NULL, 0); cc = crc32(cc, (const Bytef *)"IEND", 4);
    cbuf[0] = (uint8_t)(cc >> 24); cbuf[1] = (uint8_t)(cc >> 16); cbuf[2] = (uint8_t)(cc >> 8); cbuf[3] = (uint8_t)cc;
    fwrite(cbuf, 1, 4, f);
    if (fclose(f) != 0) return fail(err, errlen, "Cannot write output file");
    return 0;
}

/* ---------------------------------------------------------------- PNG read */
typedef struct { int w, h; uint8_t *rgba; } Image;

static uint32_t be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static int png_read(const char *path, Image *img, char *err, size_t errlen) {
    FILE *f = fopen(path, "rb");
    if (!f) return fail(err, errlen, "Cannot open input file");
    fseek(f, 0, SEEK_END); long flen = ftell(f); fseek(f, 0, SEEK_SET);
    if (flen < 8) { fclose(f); return fail(err, errlen, "Not a PNG file"); }
    uint8_t *buf = malloc((size_t)flen);
    if (!buf || fread(buf, 1, (size_t)flen, f) != (size_t)flen) {
        fclose(f); free(buf); return fail(err, errlen, "Cannot read input file");
    }
    fclose(f);
    static const uint8_t sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
    if (memcmp(buf, sig, 8)) { free(buf); return fail(err, errlen, "Not a PNG file"); }
    int w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
    uint8_t *idat = NULL; size_t idatlen = 0;
    size_t pos = 8;
    while (pos + 12 <= (size_t)flen) {
        uint32_t clen = be32(buf + pos);
        if (pos + 12 + clen > (size_t)flen) break;
        const uint8_t *type = buf + pos + 4;
        const uint8_t *data = buf + pos + 8;
        if (!memcmp(type, "IHDR", 4)) {
            w = (int)be32(data); h = (int)be32(data + 4);
            depth = data[8]; ctype = data[9]; interlace = data[12];
        } else if (!memcmp(type, "IDAT", 4)) {
            uint8_t *ni = realloc(idat, idatlen + clen);
            if (!ni) { free(idat); free(buf); return fail(err, errlen, "Out of memory"); }
            idat = ni; memcpy(idat + idatlen, data, clen); idatlen += clen;
        } else if (!memcmp(type, "IEND", 4)) break;
        pos += 12 + clen;
    }
    free(buf);
    int ch = ctype == 6 ? 4 : ctype == 2 ? 3 : ctype == 0 ? 1 : 0;
    if (w <= 0 || h <= 0 || depth != 8 || !ch || interlace != 0 || !idat) {
        free(idat);
        return fail(err, errlen, "Unsupported PNG (need 8-bit gray/RGB/RGBA, non-interlaced)");
    }
    size_t stride = (size_t)w * ch, rawlen = (stride + 1) * (size_t)h;
    uint8_t *raw = malloc(rawlen);
    if (!raw) { free(idat); return fail(err, errlen, "Out of memory"); }
    uLongf destlen = (uLongf)rawlen;
    if (uncompress(raw, &destlen, idat, (uLong)idatlen) != Z_OK || destlen != rawlen) {
        free(idat); free(raw); return fail(err, errlen, "PNG decompression failed");
    }
    free(idat);
    uint8_t *out = malloc(stride * (size_t)h);
    if (!out) { free(raw); return fail(err, errlen, "Out of memory"); }
    size_t p = 0;
    for (int y = 0; y < h; y++) {
        int filter = raw[p++];
        const uint8_t *row = raw + p; p += stride;
        uint8_t *cur = out + (size_t)y * stride;
        const uint8_t *prev = y ? out + (size_t)(y - 1) * stride : NULL;
        for (size_t x = 0; x < stride; x++) {
            int a = x >= (size_t)ch ? cur[x - ch] : 0;
            int b = prev ? prev[x] : 0;
            int c = (prev && x >= (size_t)ch) ? prev[x - ch] : 0;
            int v = row[x];
            if (filter == 1) v += a;
            else if (filter == 2) v += b;
            else if (filter == 3) v += (a + b) >> 1;
            else if (filter == 4) {
                int pp = a + b - c, pa = abs(pp - a), pb = abs(pp - b), pc = abs(pp - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            } else if (filter != 0) { free(raw); free(out); return fail(err, errlen, "Bad PNG filter"); }
            cur[x] = (uint8_t)v;
        }
    }
    free(raw);
    uint8_t *rgba = malloc((size_t)w * h * 4);
    if (!rgba) { free(out); return fail(err, errlen, "Out of memory"); }
    for (size_t i = 0; i < (size_t)w * h; i++) {
        rgba[4 * i] = out[ch * i];
        rgba[4 * i + 1] = ch > 1 ? out[ch * i + 1] : out[ch * i];
        rgba[4 * i + 2] = ch > 1 ? out[ch * i + 2] : out[ch * i];
        rgba[4 * i + 3] = ch == 4 ? out[4 * i + 3] : 255;
    }
    free(out);
    img->w = w; img->h = h; img->rgba = rgba;
    return 0;
}

/* ------------------------------------------------------------------ decode */
static int nearest_symbol(int r, int g, int b) {
    int best = 8; long bd = LONG_MAX;
    for (int i = 0; i < 9; i++) {
        long dr = r - PALETTE[i][0], dg = g - PALETTE[i][1], db = b - PALETTE[i][2];
        long d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

/* decode with known size and scale; returns 0 on success */
static int decode_sized(const Image *img, int size, double r, Code *res,
                        uint8_t **out_bytes, size_t *out_len, char *err, size_t errlen) {
    char e[128];
    Layout l;
    if (layout_build(size, &l, e, sizeof(e))) return fail(err, errlen, e);
    uint8_t *sym = malloc((size_t)l.ncells);
    if (!sym) { layout_free(&l); return fail(err, errlen, "Out of memory"); }
    for (int k = 0; k < l.ncells; k++) {
        const Cell *c = &l.cells[k];
        int x = (int)((c->x + PQ) * r), y = (int)((c->y + PQ) * r);
        if (x < 0) x = 0; if (x >= img->w) x = img->w - 1;
        if (y < 0) y = 0; if (y >= img->h) y = img->h - 1;
        const uint8_t *px = img->rgba + 4 * ((size_t)y * img->w + x);
        sym[k] = (uint8_t)nearest_symbol(px[0], px[1], px[2]);
    }
    /* header: 3 majority-voted copies of each of 24 bits */
    uint8_t hb[24];
    for (int b = 0; b < 24; b++) {
        int vote = 0;
        for (int k = 0; k < l.nheaders; k++) {
            const Cell *c = &l.cells[l.headers[k]];
            if (c->header % 24 != b) continue;
            int s = sym[c->index];
            vote += s == 0 ? 1 : (s == 8 ? -1 : 0);
        }
        hb[b] = vote > 0 ? 1 : 0;
    }
    int at = 0;
    int hsize = 0, hecc = 0, hmode = 0, htype = 0, hlen = 0, hcrc = 0;
    for (int k = 0; k < 3; k++) hsize = (hsize << 1) | hb[at++];
    for (int k = 0; k < 2; k++) hecc = (hecc << 1) | hb[at++];
    hmode = hb[at++]; htype = hb[at++];
    for (int k = 0; k < 13; k++) hlen = (hlen << 1) | hb[at++];
    for (int k = 0; k < 4; k++) hcrc = (hcrc << 1) | hb[at++];
    if (prism_crc4(hb, 20) != hcrc || hsize > 5 || hsize != size) {
        free(sym); layout_free(&l);
        return fail(err, errlen, "Header checksum did not pass");
    }
    Capacity cap;
    if (capacity_of(hsize, hecc, hmode, &cap, e, sizeof(e))) {
        free(sym); layout_free(&l); return fail(err, errlen, e);
    }
    if (hlen > cap.payload) {
        free(sym); layout_free(&l);
        return fail(err, errlen, "Invalid length");
    }
    /* data bit stream */
    int bits_per = hmode ? 1 : 3;
    int streamlen = l.ndata * bits_per;
    uint8_t *stream = malloc((size_t)streamlen);
    if (!stream) { free(sym); layout_free(&l); return fail(err, errlen, "Out of memory"); }
    static const int INV_GRAY[8] = {0, 1, 3, 2, 6, 7, 5, 4}; /* v -> original bits */
    int sn = 0, bad = 0;
    for (int k = 0; k < l.ndata; k++) {
        int s = sym[l.data[k]];
        if (hmode) {
            if (s != 0 && s != 8) bad++;
            stream[sn++] = s == 0 ? 1 : 0;
        } else {
            if (s > 7) { bad++; s = 0; }
            int b = INV_GRAY[s];
            stream[sn++] = (uint8_t)((b >> 2) & 1);
            stream[sn++] = (uint8_t)((b >> 1) & 1);
            stream[sn++] = (uint8_t)(b & 1);
        }
    }
    free(sym);
    if (bad) { free(stream); layout_free(&l); return fail(err, errlen, "Unexpected cell colors"); }
    uint8_t *bytes = malloc((size_t)cap.n);
    for (int i = 0; i < cap.n; i++) {
        int v = 0;
        for (int k = 0; k < 8; k++) v = (v << 1) | stream[8 * i + k];
        bytes[i] = (uint8_t)v;
    }
    free(stream);
    /* de-interleave into blocks */
    uint8_t **bb = malloc(sizeof(uint8_t *) * (size_t)cap.nblocks);
    int maxn = 0;
    for (int b = 0; b < cap.nblocks; b++) {
        bb[b] = malloc((size_t)cap.blocks[b].n);
        if (cap.blocks[b].n > maxn) maxn = cap.blocks[b].n;
    }
    at = 0;
    for (int p = 0; p < maxn; p++)
        for (int b = 0; b < cap.nblocks; b++)
            if (p < cap.blocks[b].n) bb[b][p] = bytes[at++];
    free(bytes);
    /* known padding positions were written by the encoder: restore them */
    int moff = 0;
    for (int b = 0; b < cap.nblocks; b++) {
        for (int p = 0; p < cap.blocks[b].k; p++)
            if (hlen > 0 && moff + p >= hlen + 4) bb[b][p] = padk((uint32_t)(moff + p));
        moff += cap.blocks[b].k;
    }
    uint8_t *msg = malloc((size_t)cap.k);
    int mo = 0, rc = 0;
    for (int b = 0; b < cap.nblocks; b++) {
        rc = rs_decode(bb[b], cap.blocks[b].n, cap.blocks[b].nsym);
        if (rc < 0) {
            for (int q = 0; q < cap.nblocks; q++) free(bb[q]);
            free(bb); free(msg); layout_free(&l);
            return fail(err, errlen, "Error correction could not recover this image");
        }
        memcpy(msg + mo, bb[b], (size_t)cap.blocks[b].k);
        mo += cap.blocks[b].k;
    }
    for (int b = 0; b < cap.nblocks; b++) free(bb[b]);
    free(bb);
    uint32_t want = 0;
    for (int k = 0; k < 4; k++) want = (want << 8) | msg[hlen + k];
    if (prism_crc32(msg, (size_t)hlen) != want) {
        free(msg); layout_free(&l);
        return fail(err, errlen, "Payload checksum did not pass");
    }
    uint8_t *payload = malloc((size_t)(hlen ? hlen : 1));
    memcpy(payload, msg, (size_t)hlen);
    free(msg);
    res->size = hsize; res->ecc = hecc; res->mode = hmode; res->type = htype;
    res->symbols = NULL; memset(&res->l, 0, sizeof(Layout));
    layout_free(&l);
    *out_bytes = payload; *out_len = (size_t)hlen;
    return 0;
}

/* UTF-8 validation (text payloads must be valid UTF-8, as in the live reader) */
static int utf8_valid(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint8_t c = s[i];
        int need;
        uint32_t cp;
        if (c < 0x80) { i++; continue; }
        else if ((c & 0xE0) == 0xC0) { need = 1; cp = c & 0x1F; if (cp < 2) return 0; }
        else if ((c & 0xF0) == 0xE0) { need = 2; cp = c & 0x0F; }
        else if ((c & 0xF8) == 0xF0) { need = 3; cp = c & 0x07; if (cp > 4) return 0; }
        else return 0;
        if (n - i < (size_t)need + 1) return 0;
        for (int k = 1; k <= need; k++) {
            if ((s[i + k] & 0xC0) != 0x80) return 0;
            cp = (cp << 6) | (s[i + k] & 0x3F);
        }
        if ((need == 1 && cp < 0x80) || (need == 2 && cp < 0x800) || (need == 3 && cp < 0x10000)) return 0;
        if (cp >= 0xD800 && cp <= 0xDFFF) return 0;
        if (cp > 0x10FFFF) return 0;
        i += (size_t)need + 1;
    }
    return 1;
}

int prism_decode_png(const char *in_png, uint8_t **out_bytes, size_t *out_len,
                     int *out_type, char *err, size_t errlen) {
    Image img;
    if (png_read(in_png, &img, err, errlen)) return -1;
    char lasterr[160] = "No Prism code found";
    int ok = -1;
    Code res; memset(&res, 0, sizeof(res));
    for (int size = 0; size < 6 && ok; size++) {
        Layout probe;
        if (layout_build(size, &probe, lasterr, sizeof(lasterr))) continue;
        double Wt = (probe.W + 2 * PQ), Ht = (probe.H + 2 * PQ);
        double r = ((double)img.w / Wt + (double)img.h / Ht) / 2;
        layout_free(&probe);
        if (r < 3.9) continue;
        if (fabs(Wt * r - img.w) > 2.0 || fabs(Ht * r - img.h) > 2.0) continue;
        Code tmp; memset(&tmp, 0, sizeof(tmp));
        char e[160];
        if (decode_sized(&img, size, r, &tmp, out_bytes, out_len, e, sizeof(e)) == 0) {
            res = tmp; ok = 0;
        } else {
            snprintf(lasterr, sizeof(lasterr), "%s", e);
        }
    }
    free(img.rgba);
    if (ok) return fail(err, errlen, lasterr);
    if (res.type == PRISM_TYPE_TEXT && !utf8_valid(*out_bytes, *out_len)) {
        free(*out_bytes); *out_bytes = NULL; *out_len = 0;
        return fail(err, errlen, "Payload is not valid UTF-8 text");
    }
    if (out_type) *out_type = res.type;
    return 0;
}

/* ------------------------------------------------------------- encode API */
int prism_encode_rgba(const uint8_t *data, size_t len, int size, int ecc, int mode,
                      int type, int scale, uint8_t **out_rgba, int *out_w, int *out_h,
                      char *err, size_t errlen) {
    Code code; memset(&code, 0, sizeof(code));
    if (prism_encode(data, len, size, ecc, mode, type, &code, err, errlen)) return -1;
    render_rgba(&code, scale > 0 ? scale : 12, out_rgba, out_w, out_h, err, errlen);
    code_free(&code);
    return *out_rgba ? 0 : -1;
}
int prism_encode_png(const uint8_t *data, size_t len, int size, int ecc, int mode,
                     int type, int scale, const char *out_png, char *err, size_t errlen) {
    uint8_t *rgba = NULL; int w = 0, h = 0;
    if (prism_encode_rgba(data, len, size, ecc, mode, type, scale, &rgba, &w, &h, err, errlen))
        return -1;
    int rc = png_write_rgba(out_png, rgba, w, h, err, errlen);
    free(rgba);
    return rc;
}
