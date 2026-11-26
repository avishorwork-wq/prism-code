/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * ECDSA over NIST P-256 (secp256r1) with SHA-256 and RFC 6979 deterministic
 * nonces, matching WebCrypto's ECDSA (P1363 fixed r|s signatures) as used by
 * the live Prism site. Correctness-first generic bignum: no external libs. */
#include "prism_crypto.h"
#include <string.h>
#include <stdlib.h>

typedef struct { uint32_t w[8]; } u256;   /* little-endian words */
typedef struct { uint32_t w[16]; } u512;

/* p = 2^256 - 2^224 + 2^192 + 2^96 - 1 */
static const u256 P256_P = {{ 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0x00000000,
                              0x00000000, 0x00000000, 0x00000001, 0xFFFFFFFF }};
/* n = order of G */
static const u256 P256_N = {{ 0xFC632551, 0xF3B9CAC2, 0xA7179E84, 0xBCE6FAAD,
                              0xFFFFFFFF, 0xFFFFFFFF, 0x00000000, 0xFFFFFFFF }};
/* b = 5AC635D8 AA3A93E7 B3EBBD55 769886BC 651D06B0 CC53B0F6 3BCE3C3E 27D2604B */
static const u256 P256_B = {{ 0x27D2604B, 0x3BCE3C3E, 0xCC53B0F6, 0x651D06B0,
                              0x769886BC, 0xB3EBBD55, 0xAA3A93E7, 0x5AC635D8 }};
static const u256 P256_GX = {{ 0xD898C296, 0xF4A13945, 0x2DEB33A0, 0x77037D81,
                               0x63A440F2, 0xF8BCE6E5, 0xE12C4247, 0x6B17D1F2 }};
static const u256 P256_GY = {{ 0x37BF51F5, 0xCBB64068, 0x6B315ECE, 0x2BCE3357,
                               0x7C0F9E16, 0x8EE7EB4A, 0xFE1A7F9B, 0x4FE342E2 }};

static void u256_from_bytes(u256 *a, const uint8_t b[32])
{
    for (int i = 0; i < 8; i++)
        a->w[i] = ((uint32_t)b[28-4*i] << 24) | ((uint32_t)b[29-4*i] << 16) |
                  ((uint32_t)b[30-4*i] << 8) | b[31-4*i];
}
static void u256_to_bytes(const u256 *a, uint8_t b[32])
{
    for (int i = 0; i < 8; i++) {
        b[28-4*i] = (uint8_t)(a->w[i] >> 24); b[29-4*i] = (uint8_t)(a->w[i] >> 16);
        b[30-4*i] = (uint8_t)(a->w[i] >> 8); b[31-4*i] = (uint8_t)a->w[i];
    }
}
static int u256_is_zero(const u256 *a)
{
    uint32_t d = 0;
    for (int i = 0; i < 8; i++) d |= a->w[i];
    return d == 0;
}
static int u256_eq(const u256 *a, const u256 *b)
{
    uint32_t d = 0;
    for (int i = 0; i < 8; i++) d |= a->w[i] ^ b->w[i];
    return d == 0;
}
/* -1 a<b, 0 eq, 1 a>b */
static int u256_cmp(const u256 *a, const u256 *b)
{
    for (int i = 7; i >= 0; i--) {
        if (a->w[i] != b->w[i]) return a->w[i] < b->w[i] ? -1 : 1;
    }
    return 0;
}
/* a + b mod m (a,b < m) */
static void u256_addm(u256 *r, const u256 *a, const u256 *b, const u256 *m)
{
    uint64_t c = 0;
    for (int i = 0; i < 8; i++) {
        c += (uint64_t)a->w[i] + b->w[i];
        r->w[i] = (uint32_t)c; c >>= 32;
    }
    if (c || u256_cmp(r, m) >= 0) {
        uint64_t br = 0;
        for (int i = 0; i < 8; i++) {
            uint64_t d = (uint64_t)r->w[i] - m->w[i] - br;
            r->w[i] = (uint32_t)d; br = (d >> 32) & 1;
        }
    }
}
/* a - b mod m (a,b < m) */
static void u256_subm(u256 *r, const u256 *a, const u256 *b, const u256 *m)
{
    uint64_t br = 0;
    for (int i = 0; i < 8; i++) {
        uint64_t d = (uint64_t)a->w[i] - b->w[i] - br;
        r->w[i] = (uint32_t)d; br = (d >> 32) & 1;
    }
    if (br) {
        uint64_t c = 0;
        for (int i = 0; i < 8; i++) {
            c += (uint64_t)r->w[i] + m->w[i];
            r->w[i] = (uint32_t)c; c >>= 32;
        }
    }
}
static void u512_mul(u512 *r, const u256 *a, const u256 *b)
{
    memset(r, 0, sizeof *r);
    for (int i = 0; i < 8; i++) {
        uint64_t c = 0;
        for (int j = 0; j < 8; j++) {
            c += (uint64_t)a->w[i] * b->w[j] + r->w[i + j];
            r->w[i + j] = (uint32_t)c; c >>= 32;
        }
        r->w[i + 8] = (uint32_t)c;
    }
}
/* Slow but simple bitwise reduction: r = x mod m. */
static void u512_mod(u256 *r, const u512 *x, const u256 *m)
{
    uint32_t rem[9] = {0};
    for (int bit = 511; bit >= 0; bit--) {
        uint32_t carry = (x->w[bit / 32] >> (bit % 32)) & 1;
        for (int i = 8; i > 0; i--) {
            uint32_t nc = rem[i - 1] >> 31;
            rem[i] = (rem[i] << 1) | nc;
        }
        rem[0] = (rem[0] << 1) | carry;
        /* compare rem (9 words) with m (8 words) */
        int ge = rem[8] != 0;
        if (!ge) {
            for (int i = 7; i >= 0; i--) {
                if (rem[i] != m->w[i]) { ge = rem[i] > m->w[i]; break; }
                if (i == 0) ge = 1;
            }
        }
        if (ge) {
            uint64_t br = 0;
            for (int i = 0; i < 8; i++) {
                uint64_t d = (uint64_t)rem[i] - m->w[i] - br;
                rem[i] = (uint32_t)d; br = (d >> 32) & 1;
            }
            rem[8] -= (uint32_t)br;
        }
    }
    for (int i = 0; i < 8; i++) r->w[i] = rem[i];
}
static void u256_mulm(u256 *r, const u256 *a, const u256 *b, const u256 *m)
{
    u512 t; u512_mul(&t, a, b);
    u512_mod(r, &t, m);
}
static void u256_sqrm(u256 *r, const u256 *a, const u256 *m) { u256_mulm(r, a, a, m); }
/* r = a^(m-2) mod m (m prime) */
static void u256_invm(u256 *r, const u256 *a, const u256 *m)
{
    u256 exp = *m, base = *a, acc;
    exp.w[0] -= 2;
    memset(&acc, 0, sizeof acc); acc.w[0] = 1;
    for (int i = 0; i < 256; i++) {
        if ((exp.w[i / 32] >> (i % 32)) & 1) u256_mulm(&acc, &acc, &base, m);
        u256_sqrm(&base, &base, m);
    }
    *r = acc;
}

/* ---- points: Jacobian (X, Y, Z), infinity iff Z == 0 ---- */
typedef struct { u256 x, y, z; } Point;

static void p_double(Point *r, const Point *p)
{
    if (u256_is_zero(&p->z) || u256_is_zero(&p->y)) { memset(r, 0, sizeof *r); return; }
    u256 delta, gamma, beta, alpha, t1, t2, t3;
    u256_sqrm(&delta, &p->z, &P256_P);            /* Z^2 */
    u256_sqrm(&gamma, &p->y, &P256_P);            /* Y^2 */
    u256_mulm(&beta, &p->x, &gamma, &P256_P);     /* X*gamma */
    u256_subm(&t1, &p->x, &delta, &P256_P);
    u256_addm(&t2, &p->x, &delta, &P256_P);
    u256_mulm(&alpha, &t1, &t2, &P256_P);         /* (X-delta)(X+delta) */
    u256_addm(&t1, &alpha, &alpha, &P256_P);
    u256_addm(&alpha, &alpha, &t1, &P256_P);      /* alpha = 3*(X-d)(X+d) */
    u256_sqrm(&t1, &alpha, &P256_P);
    u256_addm(&t2, &beta, &beta, &P256_P);
    u256_addm(&t2, &t2, &t2, &P256_P);            /* 4beta */
    u256_addm(&t3, &t2, &t2, &P256_P);            /* 8beta */
    u256_subm(&r->x, &t1, &t3, &P256_P);          /* X3 = alpha^2 - 8beta */
    u256_addm(&t1, &p->y, &p->z, &P256_P);
    u256_sqrm(&r->z, &t1, &P256_P);
    u256_subm(&r->z, &r->z, &gamma, &P256_P);
    u256_subm(&r->z, &r->z, &delta, &P256_P);     /* Z3 = (Y+Z)^2 - gamma - delta */
    u256_subm(&t1, &t2, &r->x, &P256_P);          /* 4beta - X3 */
    u256_mulm(&t1, &alpha, &t1, &P256_P);
    u256_sqrm(&t3, &gamma, &P256_P);              /* gamma^2 */
    u256_addm(&t3, &t3, &t3, &P256_P);
    u256_addm(&t3, &t3, &t3, &P256_P);
    u256_addm(&t3, &t3, &t3, &P256_P);            /* 8 gamma^2 */
    u256_subm(&r->y, &t1, &t3, &P256_P);
}

/* mixed add: p Jacobian, q affine (z=1). EFD madd-2007-bl. */
static void p_add_aff(Point *r, const Point *p, const u256 *qx, const u256 *qy)
{
    if (u256_is_zero(&p->z)) {
        r->x = *qx; r->y = *qy;
        memset(&r->z, 0, sizeof r->z); r->z.w[0] = 1;
        return;
    }
    u256 z1z1, u2, s2, h, hh, i4, j, rr, v, t1, t2;
    u256_sqrm(&z1z1, &p->z, &P256_P);
    u256_mulm(&u2, qx, &z1z1, &P256_P);
    u256_mulm(&t1, &z1z1, &p->z, &P256_P);
    u256_mulm(&s2, qy, &t1, &P256_P);
    u256_subm(&h, &u2, &p->x, &P256_P);
    u256_subm(&t1, &s2, &p->y, &P256_P);
    if (u256_is_zero(&h)) {
        if (u256_is_zero(&t1)) { p_double(r, p); return; }
        memset(r, 0, sizeof *r); return; /* infinity */
    }
    u256_addm(&rr, &t1, &t1, &P256_P);            /* r = 2(S2-Y1) */
    u256_sqrm(&hh, &h, &P256_P);
    u256_addm(&i4, &hh, &hh, &P256_P);
    u256_addm(&i4, &i4, &i4, &P256_P);            /* I = 4*HH */
    u256_mulm(&j, &h, &i4, &P256_P);
    u256_mulm(&v, &p->x, &i4, &P256_P);
    u256_sqrm(&t1, &rr, &P256_P);
    u256_subm(&t1, &t1, &j, &P256_P);
    u256_addm(&t2, &v, &v, &P256_P);
    u256_subm(&r->x, &t1, &t2, &P256_P);          /* X3 = r^2 - J - 2V */
    u256_subm(&t1, &v, &r->x, &P256_P);
    u256_mulm(&t1, &rr, &t1, &P256_P);
    u256_mulm(&t2, &p->y, &j, &P256_P);
    u256_addm(&t2, &t2, &t2, &P256_P);
    u256_subm(&r->y, &t1, &t2, &P256_P);          /* Y3 = r(V-X3) - 2Y1J */
    u256_addm(&t1, &p->z, &h, &P256_P);
    u256_sqrm(&t1, &t1, &P256_P);
    u256_subm(&t1, &t1, &z1z1, &P256_P);
    u256_subm(&r->z, &t1, &hh, &P256_P);          /* Z3 = (Z1+H)^2 - Z1Z1 - HH */
}

static void p_mul(Point *r, const u256 *k, const u256 *qx, const u256 *qy)
{
    Point acc; memset(&acc, 0, sizeof acc); /* infinity */
    for (int i = 255; i >= 0; i--) {
        p_double(&acc, &acc);
        if ((k->w[i / 32] >> (i % 32)) & 1) p_add_aff(&acc, &acc, qx, qy);
    }
    *r = acc;
}

static void p_to_affine(u256 *x, u256 *y, const Point *p)
{
    u256 zi, zi2;
    u256_invm(&zi, &p->z, &P256_P);
    u256_sqrm(&zi2, &zi, &P256_P);
    u256_mulm(x, &p->x, &zi2, &P256_P);
    u256_mulm(&zi2, &zi2, &zi, &P256_P);
    u256_mulm(y, &p->y, &zi2, &P256_P);
}

static int p_on_curve(const u256 *x, const u256 *y)
{
    u256 lhs, rhs, t;
    u256_sqrm(&lhs, y, &P256_P);
    u256_sqrm(&rhs, x, &P256_P);
    u256_mulm(&rhs, &rhs, x, &P256_P);
    u256_addm(&t, x, x, &P256_P);
    u256_addm(&t, &t, x, &P256_P);
    u256_subm(&rhs, &rhs, &t, &P256_P);
    u256_addm(&rhs, &rhs, &P256_B, &P256_P);
    return u256_eq(&lhs, &rhs);
}

int prism_p256_valid_public(const uint8_t pub[65])
{
    if (pub[0] != 4) return 0;
    u256 x, y;
    u256_from_bytes(&x, pub + 1);
    u256_from_bytes(&y, pub + 33);
    if (u256_cmp(&x, &P256_P) >= 0 || u256_cmp(&y, &P256_P) >= 0) return 0;
    return p_on_curve(&x, &y);
}

void prism_p256_keygen(const uint8_t priv[32], uint8_t pub[65])
{
    u256 d, x, y;
    u256_from_bytes(&d, priv);
    Point r;
    p_mul(&r, &d, &P256_GX, &P256_GY);
    p_to_affine(&x, &y, &r);
    pub[0] = 4;
    u256_to_bytes(&x, pub + 1);
    u256_to_bytes(&y, pub + 33);
}

/* RFC 6979 deterministic nonce with HMAC-SHA256 */
static void rfc6979_k(u256 *k, const uint8_t priv[32], const uint8_t hash[32])
{
    uint8_t v[32], kk[32], bx[64];
    memset(v, 1, 32); memset(kk, 0, 32);
    memcpy(bx, priv, 32); memcpy(bx + 32, hash, 32);
    /* K = HMAC(K, V||0x00||x||h) */
    uint8_t buf[32 + 1 + 64];
    memcpy(buf, v, 32); buf[32] = 0; memcpy(buf + 33, bx, 64);
    prism_hmac_sha256(kk, 32, buf, sizeof buf, kk);
    prism_hmac_sha256(kk, 32, v, 32, v);
    memcpy(buf, v, 32); buf[32] = 1; memcpy(buf + 33, bx, 64);
    prism_hmac_sha256(kk, 32, buf, sizeof buf, kk);
    prism_hmac_sha256(kk, 32, v, 32, v);
    for (;;) {
        prism_hmac_sha256(kk, 32, v, 32, v);
        u256_from_bytes(k, v);
        if (!u256_is_zero(k) && u256_cmp(k, &P256_N) < 0) return;
        memcpy(buf, v, 32); buf[32] = 0;
        prism_hmac_sha256(kk, 32, buf, 33, kk);
        prism_hmac_sha256(kk, 32, v, 32, v);
    }
}

/* hash reduced mod n (ECDSA bits2int; SHA-256 and n are both 256 bits) */
static void hash_mod_n(u256 *e, const uint8_t hash[32])
{
    u256_from_bytes(e, hash);
    if (u256_cmp(e, &P256_N) >= 0) u256_subm(e, e, &P256_N, &P256_N);
}

void prism_p256_sign(const uint8_t priv[32], const uint8_t *msg, size_t mlen, uint8_t sig[64])
{
    uint8_t hash[32];
    prism_sha256(msg, mlen, hash);
    u256 d, e, k, x, y, r, s, t;
    u256_from_bytes(&d, priv);
    hash_mod_n(&e, hash);
    for (;;) {
        rfc6979_k(&k, priv, hash);
        Point p;
        p_mul(&p, &k, &P256_GX, &P256_GY);
        p_to_affine(&x, &y, &p);
        if (u256_cmp(&x, &P256_N) >= 0) u256_subm(&r, &x, &P256_N, &P256_N);
        else r = x;
        if (u256_is_zero(&r)) continue;
        u256_invm(&t, &k, &P256_N);
        u256_mulm(&s, &d, &r, &P256_N);
        u256_addm(&s, &s, &e, &P256_N);
        u256_mulm(&s, &t, &s, &P256_N);
        if (u256_is_zero(&s)) continue;
        /* low-s normalization (accepted everywhere, avoids malleability) */
        u256 half = P256_N;
        uint32_t carry = 0;
        for (int i = 7; i >= 0; i--) {
            uint32_t nc = half.w[i] & 1;
            half.w[i] = (half.w[i] >> 1) | (carry << 31);
            carry = nc;
        }
        if (u256_cmp(&s, &half) > 0) u256_subm(&s, &P256_N, &s, &P256_N);
        u256_to_bytes(&r, sig);
        u256_to_bytes(&s, sig + 32);
        return;
    }
}

int prism_p256_verify(const uint8_t pub[65], const uint8_t *msg, size_t mlen, const uint8_t sig[64])
{
    if (!prism_p256_valid_public(pub)) return 0;
    u256 r, s, e, w, u1, u2, qx, qy;
    u256_from_bytes(&r, sig);
    u256_from_bytes(&s, sig + 32);
    if (u256_is_zero(&r) || u256_is_zero(&s)) return 0;
    if (u256_cmp(&r, &P256_N) >= 0 || u256_cmp(&s, &P256_N) >= 0) return 0;
    uint8_t hash[32];
    prism_sha256(msg, mlen, hash);
    hash_mod_n(&e, hash);
    u256_invm(&w, &s, &P256_N);
    u256_mulm(&u1, &e, &w, &P256_N);
    u256_mulm(&u2, &r, &w, &P256_N);
    u256_from_bytes(&qx, pub + 1);
    u256_from_bytes(&qy, pub + 33);
    Point p1, p2, sum;
    p_mul(&p1, &u1, &P256_GX, &P256_GY);
    p_mul(&p2, &u2, &qx, &qy);
    /* add p1 + p2 in Jacobian: convert p2 to affine, then mixed add */
    u256 x2, y2;
    p_to_affine(&x2, &y2, &p2);
    p_add_aff(&sum, &p1, &x2, &y2);
    if (u256_is_zero(&sum.z)) return 0;
    u256 x, y;
    p_to_affine(&x, &y, &sum);
    if (u256_cmp(&x, &P256_N) >= 0) u256_subm(&x, &x, &P256_N, &P256_N);
    return u256_eq(&x, &r);
}
