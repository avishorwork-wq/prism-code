/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Crypto primitives for the C port of Prism Secure: SHA-256, HMAC,
 * PBKDF2-SHA256, AES-256-GCM, Blake2b, and Argon2id (RFC 9106). Written from
 * the public specifications; no external libraries. Byte-compatible with the
 * live site (hash-wasm Argon2id, WebCrypto AES-GCM / PBKDF2). */
#include "prism_crypto.h"
#include <stdlib.h>
#include <string.h>

/* ================= SHA-256 ================= */

static const uint32_t K256[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};
#define R32(x,n) (((x) >> (n)) | ((x) << (32 - (n))))

void prism_sha256(const uint8_t *data, size_t len, uint8_t out[32])
{
    uint32_t h[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    size_t total = ((len + 9 + 63) / 64) * 64;
    uint8_t *msg = calloc(total, 1);
    memcpy(msg, data, len);
    msg[len] = 0x80;
    uint64_t bits = (uint64_t)len * 8;
    for (int i = 0; i < 8; i++) msg[total - 1 - i] = (uint8_t)(bits >> (8 * i));
    for (size_t off = 0; off < total; off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; i++)
            w[i] = ((uint32_t)msg[off+i*4] << 24) | ((uint32_t)msg[off+i*4+1] << 16) | ((uint32_t)msg[off+i*4+2] << 8) | msg[off+i*4+3];
        for (int i = 16; i < 64; i++) {
            uint32_t s0 = R32(w[i-15],7) ^ R32(w[i-15],18) ^ (w[i-15] >> 3);
            uint32_t s1 = R32(w[i-2],17) ^ R32(w[i-2],19) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
        for (int i = 0; i < 64; i++) {
            uint32_t S1 = R32(e,6) ^ R32(e,11) ^ R32(e,25);
            uint32_t ch = (e & f) ^ (~e & g);
            uint32_t t1 = hh + S1 + ch + K256[i] + w[i];
            uint32_t S0 = R32(a,2) ^ R32(a,13) ^ R32(a,22);
            uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            uint32_t t2 = S0 + mj;
            hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    free(msg);
    for (int i = 0; i < 8; i++) {
        out[i*4] = (uint8_t)(h[i] >> 24); out[i*4+1] = (uint8_t)(h[i] >> 16);
        out[i*4+2] = (uint8_t)(h[i] >> 8); out[i*4+3] = (uint8_t)h[i];
    }
}

void prism_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[32])
{
    uint8_t k[64]; memset(k, 0, 64);
    if (klen > 64) prism_sha256(key, klen, k);
    else memcpy(k, key, klen);
    uint8_t buf[64 + 1024]; /* small messages only; fall back for large */
    uint8_t *m = buf;
    size_t inner_len = 64 + mlen;
    uint8_t *heap = NULL;
    if (inner_len > sizeof(buf)) { heap = malloc(inner_len); m = heap; }
    for (int i = 0; i < 64; i++) m[i] = k[i] ^ 0x36;
    memcpy(m + 64, msg, mlen);
    uint8_t inner[32]; prism_sha256(m, inner_len, inner);
    for (int i = 0; i < 64; i++) m[i] = k[i] ^ 0x5c;
    memcpy(m + 64, inner, 32);
    prism_sha256(m, 96, out);
    free(heap);
}

void prism_pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen,
                         uint32_t iters, uint8_t *out, size_t outlen)
{
    uint32_t blocks = (uint32_t)((outlen + 31) / 32);
    uint8_t *msg = malloc(slen + 4), u[32], t[32];
    memcpy(msg, salt, slen);
    for (uint32_t b = 1; b <= blocks; b++) {
        msg[slen] = (uint8_t)(b >> 24); msg[slen+1] = (uint8_t)(b >> 16);
        msg[slen+2] = (uint8_t)(b >> 8); msg[slen+3] = (uint8_t)b;
        prism_hmac_sha256(pw, pwlen, msg, slen + 4, u);
        memcpy(t, u, 32);
        for (uint32_t i = 1; i < iters; i++) {
            prism_hmac_sha256(pw, pwlen, u, 32, u);
            for (int j = 0; j < 32; j++) t[j] ^= u[j];
        }
        size_t take = outlen - (b - 1) * 32 < 32 ? outlen - (b - 1) * 32 : 32;
        memcpy(out + (b - 1) * 32, t, take);
    }
    free(msg);
}

/* ================= AES-256 ================= */

static const uint8_t SBOX[256] = {
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
0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16 };
static const uint8_t RCON[11] = {0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36};

static void aes256_expand(const uint8_t key[32], uint8_t rk[240])
{
    memcpy(rk, key, 32);
    int i = 8;
    while (i < 60) {
        uint8_t t[4] = { rk[i*4-4], rk[i*4-3], rk[i*4-2], rk[i*4-1] };
        if (i % 8 == 0) {
            uint8_t x = t[0]; t[0]=t[1]; t[1]=t[2]; t[2]=t[3]; t[3]=x;
            for (int j = 0; j < 4; j++) t[j] = SBOX[t[j]];
            t[0] ^= RCON[i/8];
        } else if (i % 8 == 4) {
            for (int j = 0; j < 4; j++) t[j] = SBOX[t[j]];
        }
        for (int j = 0; j < 4; j++) { rk[i*4+j] = rk[(i-8)*4+j] ^ t[j]; }
        i++;
    }
}

static uint8_t xtime(uint8_t x) { return (uint8_t)((x << 1) ^ ((x >> 7) * 0x1b)); }

static void aes_encrypt_block(const uint8_t rk[240], const uint8_t in[16], uint8_t out[16])
{
    uint8_t s[16];
    for (int i = 0; i < 16; i++) s[i] = in[i] ^ rk[i];
    for (int round = 1; round <= 14; round++) {
        for (int i = 0; i < 16; i++) s[i] = SBOX[s[i]];
        uint8_t t[16];
        /* ShiftRows (column-major state) */
        t[0]=s[0]; t[4]=s[4]; t[8]=s[8];   t[12]=s[12];
        t[1]=s[5]; t[5]=s[9]; t[9]=s[13];  t[13]=s[1];
        t[2]=s[10]; t[6]=s[14]; t[10]=s[2]; t[14]=s[6];
        t[3]=s[15]; t[7]=s[3]; t[11]=s[7];  t[15]=s[11];
        if (round < 14) {
            for (int c = 0; c < 4; c++) {
                uint8_t a0=t[c*4],a1=t[c*4+1],a2=t[c*4+2],a3=t[c*4+3];
                s[c*4]   = xtime(a0) ^ (xtime(a1)^a1) ^ a2 ^ a3;
                s[c*4+1] = a0 ^ xtime(a1) ^ (xtime(a2)^a2) ^ a3;
                s[c*4+2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3)^a3);
                s[c*4+3] = (xtime(a0)^a0) ^ a1 ^ a2 ^ xtime(a3);
            }
        } else memcpy(s, t, 16);
        for (int i = 0; i < 16; i++) s[i] ^= rk[round*16+i];
    }
    memcpy(out, s, 16);
}

/* GCM: GHASH over GF(2^128), counter mode. iv must be 12 bytes. */
typedef struct { uint8_t rk[240]; uint8_t h[16]; } GcmCtx;

static void ghash_mul(uint8_t x[16], const uint8_t y[16])
{
    uint8_t z[16]; memset(z, 0, 16);
    uint8_t v[16]; memcpy(v, y, 16);
    for (int i = 0; i < 128; i++) {
        int byte = i / 8, bit = 7 - (i % 8);
        if ((x[byte] >> bit) & 1) for (int j = 0; j < 16; j++) z[j] ^= v[j];
        uint8_t lsb = v[15] & 1;
        for (int j = 15; j > 0; j--) v[j] = (uint8_t)((v[j] >> 1) | ((v[j-1] & 1) << 7));
        v[0] >>= 1;
        if (lsb) v[0] ^= 0xe1;
    }
    memcpy(x, z, 16);
}

static void ghash(GcmCtx *c, const uint8_t *data, size_t len, uint8_t x[16])
{
    uint8_t blk[16];
    while (len) {
        size_t n = len < 16 ? len : 16;
        memset(blk, 0, 16); memcpy(blk, data, n);
        for (int j = 0; j < 16; j++) x[j] ^= blk[j];
        ghash_mul(x, c->h);
        data += n; len -= n;
    }
}

static void gcm_crypt(GcmCtx *c, const uint8_t iv[12], const uint8_t *in, size_t len, uint8_t *out, uint8_t s[16])
{
    uint8_t j0[16]; memcpy(j0, iv, 12); j0[12]=0; j0[13]=0; j0[14]=0; j0[15]=1;
    uint8_t ctr[16]; memcpy(ctr, j0, 16);
    aes_encrypt_block(c->rk, j0, s); /* S = E(K, J0) for the tag */
    while (len) {
        for (int i = 15; i >= 12; i--) if (++ctr[i]) break;
        uint8_t ks[16]; aes_encrypt_block(c->rk, ctr, ks);
        size_t n = len < 16 ? len : 16;
        for (size_t i = 0; i < n; i++) out[i] = in[i] ^ ks[i];
        in += n; out += n; len -= n;
    }
}

static void gcm_tag(GcmCtx *c, const uint8_t s[16], const uint8_t *aad, size_t alen,
                    const uint8_t *ct, size_t clen, uint8_t tag[16])
{
    uint8_t x[16]; memset(x, 0, 16);
    ghash(c, aad, alen, x);
    ghash(c, ct, clen, x);
    uint8_t lens[16]; memset(lens, 0, 16);
    uint64_t ab = (uint64_t)alen * 8, cb = (uint64_t)clen * 8;
    for (int i = 0; i < 8; i++) { lens[7-i] = (uint8_t)(ab >> (8*i)); lens[15-i] = (uint8_t)(cb >> (8*i)); }
    for (int j = 0; j < 16; j++) x[j] ^= lens[j];
    ghash_mul(x, c->h);
    for (int j = 0; j < 16; j++) tag[j] = x[j] ^ s[j];
}

void prism_aes256gcm_encrypt(const uint8_t key[32], const uint8_t iv[12],
                             const uint8_t *aad, size_t alen,
                             const uint8_t *pt, size_t ptlen,
                             uint8_t *ct, uint8_t tag[16])
{
    GcmCtx c;
    aes256_expand(key, c.rk);
    memset(c.h, 0, 16);
    aes_encrypt_block(c.rk, c.h, c.h);
    uint8_t s[16];
    gcm_crypt(&c, iv, pt, ptlen, ct, s);
    gcm_tag(&c, s, aad, alen, ct, ptlen, tag);
}

/* returns 1 on tag match, 0 on mismatch (pt not written on mismatch) */
int prism_aes256gcm_decrypt(const uint8_t key[32], const uint8_t iv[12],
                            const uint8_t *aad, size_t alen,
                            const uint8_t *ct, size_t ctlen, const uint8_t tag[16],
                            uint8_t *pt)
{
    GcmCtx c;
    aes256_expand(key, c.rk);
    memset(c.h, 0, 16);
    aes_encrypt_block(c.rk, c.h, c.h);
    uint8_t s[16];
    uint8_t j0[16]; memcpy(j0, iv, 12); j0[12]=0; j0[13]=0; j0[14]=0; j0[15]=1;
    aes_encrypt_block(c.rk, j0, s);
    uint8_t want[16];
    gcm_tag(&c, s, aad, alen, ct, ctlen, want);
    uint8_t d = 0;
    for (int i = 0; i < 16; i++) d |= want[i] ^ tag[i];
    if (d) return 0;
    uint8_t dummy[16];
    gcm_crypt(&c, iv, ct, ctlen, pt, dummy);
    return 1;
}

/* ================= Blake2b ================= */

static const uint64_t B2B_IV[8] = {
    0x6A09E667F3BCC908, 0xBB67AE8584CAA73B, 0x3C6EF372FE94F82B, 0xA54FF53A5F1D36F1,
    0x510E527FADE682D1, 0x9B05688C2B3E6C1F, 0x1F83D9ABFB41BD6B, 0x5BE0CD19137E2179 };
static const uint8_t B2B_SIGMA[12][16] = {
    {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
    {14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3},
    {11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4},
    {7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8},
    {9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13},
    {2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9},
    {12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11},
    {13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10},
    {6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5},
    {10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0},
    {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
    {14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3} };
#define R64(x,n) (((x) >> (n)) | ((x) << (64 - (n))))

typedef struct {
    uint64_t h[8], t[2], f[2];
    uint8_t buf[128];
    size_t buflen, outlen;
} B2b;

static void b2b_init(B2b *c, size_t outlen)
{
    memcpy(c->h, B2B_IV, sizeof c->h);
    c->h[0] ^= 0x01010000 ^ (uint64_t)outlen;
    c->t[0] = c->t[1] = 0; c->f[0] = c->f[1] = 0;
    c->buflen = 0; c->outlen = outlen;
}

static void b2b_compress(B2b *c, const uint8_t block[128])
{
    uint64_t m[16], v[16];
    for (int i = 0; i < 16; i++) {
        m[i] = 0;
        for (int j = 0; j < 8; j++) m[i] |= (uint64_t)block[i*8+j] << (8*j);
    }
    memcpy(v, c->h, 64); memcpy(v + 8, B2B_IV, 64);
    v[12] ^= c->t[0]; v[13] ^= c->t[1]; v[14] ^= c->f[0]; v[15] ^= c->f[1];
    #define G(a,b,cc,d,x,y) do { \
        v[a]=v[a]+v[b]+x;  v[d]=R64(v[d]^v[a],32); \
        v[cc]=v[cc]+v[d];  v[b]=R64(v[b]^v[cc],24); \
        v[a]=v[a]+v[b]+y;  v[d]=R64(v[d]^v[a],16); \
        v[cc]=v[cc]+v[d];  v[b]=R64(v[b]^v[cc],63); } while (0)
    for (int r = 0; r < 12; r++) {
        const uint8_t *s = B2B_SIGMA[r];
        G(0,4, 8,12, m[s[0]], m[s[1]]);
        G(1,5, 9,13, m[s[2]], m[s[3]]);
        G(2,6,10,14, m[s[4]], m[s[5]]);
        G(3,7,11,15, m[s[6]], m[s[7]]);
        G(0,5,10,15, m[s[8]], m[s[9]]);
        G(1,6,11,12, m[s[10]], m[s[11]]);
        G(2,7, 8,13, m[s[12]], m[s[13]]);
        G(3,4, 9,14, m[s[14]], m[s[15]]);
    }
    #undef G
    for (int i = 0; i < 8; i++) c->h[i] ^= v[i] ^ v[i+8];
}

static void b2b_update(B2b *c, const uint8_t *in, size_t len)
{
    while (len) {
        size_t left = c->buflen, fill = 128 - left;
        if (len > fill) {
            memcpy(c->buf + left, in, fill);
            c->buflen = 0;
            c->t[0] += 128; if (c->t[0] < 128) c->t[1]++;
            b2b_compress(c, c->buf);
            in += fill; len -= fill;
        } else {
            memcpy(c->buf + left, in, len);
            c->buflen = left + len;
            return;
        }
    }
}

static void b2b_final(B2b *c, uint8_t *out)
{
    c->t[0] += c->buflen; if (c->t[0] < c->buflen) c->t[1]++;
    c->f[0] = ~0ULL;
    memset(c->buf + c->buflen, 0, 128 - c->buflen);
    b2b_compress(c, c->buf);
    uint8_t full[64];
    for (int i = 0; i < 8; i++)
        for (int j = 0; j < 8; j++) full[i*8+j] = (uint8_t)(c->h[i] >> (8*j));
    memcpy(out, full, c->outlen);
}

void prism_blake2b(const uint8_t *data, size_t len, uint8_t *out, size_t outlen)
{
    B2b c; b2b_init(&c, outlen);
    b2b_update(&c, data, len);
    b2b_final(&c, out);
}

/* Blake2b Long: H' from the Argon2 spec */
static void b2b_long(const uint8_t *in, size_t inlen, uint8_t *out, size_t outlen)
{
    if (outlen <= 64) {
        uint8_t le[4] = { (uint8_t)outlen, (uint8_t)(outlen>>8), (uint8_t)(outlen>>16), (uint8_t)(outlen>>24) };
        B2b c; b2b_init(&c, outlen);
        b2b_update(&c, le, 4); b2b_update(&c, in, inlen);
        b2b_final(&c, out);
        return;
    }
    uint8_t le[4] = { (uint8_t)outlen, (uint8_t)(outlen>>8), (uint8_t)(outlen>>16), (uint8_t)(outlen>>24) };
    size_t r = (outlen + 31) / 32 - 2;
    uint8_t v[64];
    B2b c; b2b_init(&c, 64);
    b2b_update(&c, le, 4); b2b_update(&c, in, inlen);
    b2b_final(&c, v); /* V_1 */
    size_t at = 0;
    for (size_t i = 0; i < r; i++) {
        memcpy(out + at, v, 32); at += 32;
        if (i < r - 1) prism_blake2b(v, 64, v, 64); /* V_{i+2}; loop leaves v = V_r */
    }
    prism_blake2b(v, 64, v, outlen - 32 * r); /* V_{r+2} */
    memcpy(out + at, v, outlen - 32 * r);
}

/* ================= Argon2id (RFC 9106) ================= */

#define A2_SYNC 4
#define A2_QLEN 128

static uint64_t blamka(uint64_t x, uint64_t y)
{
    uint64_t m = (uint64_t)(uint32_t)x * (uint64_t)(uint32_t)y;
    return x + y + 2 * m;
}

static void a2_round(uint64_t v[16])
{
    #define GR(a,b,c,d) do { \
        v[a]=blamka(v[a],v[b]); v[d]=R64(v[d]^v[a],32); \
        v[c]=blamka(v[c],v[d]); v[b]=R64(v[b]^v[c],24); \
        v[a]=blamka(v[a],v[b]); v[d]=R64(v[d]^v[a],16); \
        v[c]=blamka(v[c],v[d]); v[b]=R64(v[b]^v[c],63); } while (0)
    GR(0,4,8,12); GR(1,5,9,13); GR(2,6,10,14); GR(3,7,11,15);
    GR(0,5,10,15); GR(1,6,11,12); GR(2,7,8,13); GR(3,4,9,14);
    #undef GR
}

/* G compression: R = X xor Y; out = (with_xor ? out xor : 0) xor permute(R) xor R */
static void a2_g(uint64_t *out, const uint64_t *x, const uint64_t *y, int with_xor)
{
    uint64_t r[A2_QLEN], z[A2_QLEN];
    for (int i = 0; i < A2_QLEN; i++) r[i] = x[i] ^ y[i];
    for (int i = 0; i < 8; i++) { /* rows */
        uint64_t tmp[16];
        memcpy(tmp, r + i*16, sizeof tmp);
        a2_round(tmp);
        memcpy(z + i*16, tmp, sizeof tmp);
    }
    /* Column step: z is 8 rows of 16 registers; column c takes z[rr][2c], z[rr][2c+1]. */
    uint64_t z2[A2_QLEN];
    for (int c = 0; c < 8; c++) {
        uint64_t tmp[16];
        for (int rr = 0; rr < 8; rr++) { tmp[2*rr] = z[rr*16 + 2*c]; tmp[2*rr+1] = z[rr*16 + 2*c + 1]; }
        a2_round(tmp);
        for (int rr = 0; rr < 8; rr++) { z2[rr*16 + 2*c] = tmp[2*rr]; z2[rr*16 + 2*c + 1] = tmp[2*rr+1]; }
    }
    for (int i = 0; i < A2_QLEN; i++) {
        uint64_t val = z2[i] ^ r[i];
        out[i] = (with_xor ? out[i] : 0) ^ val;
    }
}

/* out must hold outlen bytes. memKiB is in KiB. Returns 0 on success. */
int prism_argon2id(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen,
                   uint32_t memKiB, uint32_t passes, uint32_t lanes,
                   uint8_t *out, size_t outlen)
{
    uint32_t laneLen = memKiB / (lanes * A2_SYNC) * A2_SYNC;
    uint32_t mPrime = laneLen * lanes;
    uint32_t segLen = laneLen / A2_SYNC;
    if (laneLen < 2 * A2_SYNC || lanes < 1 || lanes > 4 || memKiB < 8 * lanes) return -1;

    /* H0 */
    uint8_t h0[64];
    {
        B2b c; b2b_init(&c, 64);
        uint32_t fields[6] = { lanes, (uint32_t)outlen, memKiB, passes, 0x13, 2 };
        for (int i = 0; i < 6; i++) {
            uint8_t le[4] = { (uint8_t)fields[i], (uint8_t)(fields[i]>>8), (uint8_t)(fields[i]>>16), (uint8_t)(fields[i]>>24) };
            b2b_update(&c, le, 4);
        }
        uint8_t le[4];
        le[0]=(uint8_t)pwlen; le[1]=(uint8_t)(pwlen>>8); le[2]=(uint8_t)(pwlen>>16); le[3]=(uint8_t)(pwlen>>24);
        b2b_update(&c, le, 4); b2b_update(&c, pw, pwlen);
        le[0]=(uint8_t)slen; le[1]=(uint8_t)(slen>>8); le[2]=(uint8_t)(slen>>16); le[3]=(uint8_t)(slen>>24);
        b2b_update(&c, le, 4); b2b_update(&c, salt, slen);
        memset(le, 0, 4); b2b_update(&c, le, 4); b2b_update(&c, le, 4); /* no K, no X */
        b2b_final(&c, h0);
    }

    uint64_t *mem = calloc((size_t)mPrime * A2_QLEN, sizeof(uint64_t));
    if (!mem) return -2;
    for (uint32_t l = 0; l < lanes; l++) {
        for (uint32_t b = 0; b < 2; b++) {
            uint8_t inp[72];
            memcpy(inp, h0, 64);
            inp[64]=(uint8_t)b; inp[65]=(uint8_t)(b>>8); inp[66]=0; inp[67]=0;
            inp[68]=(uint8_t)l; inp[69]=(uint8_t)(l>>8); inp[70]=0; inp[71]=0;
            uint8_t blk[1024];
            b2b_long(inp, 72, blk, 1024);
            for (int i = 0; i < A2_QLEN; i++) {
                uint64_t w = 0;
                for (int j = 0; j < 8; j++) w |= (uint64_t)blk[i*8+j] << (8*j);
                mem[((size_t)l * laneLen + b) * A2_QLEN + i] = w;
            }
        }
    }

    uint64_t zero[A2_QLEN]; memset(zero, 0, sizeof zero);
    uint64_t addressBlock[A2_QLEN], inputBlock[A2_QLEN], tmpBlock[A2_QLEN];

    for (uint32_t pass = 0; pass < passes; pass++) {
        for (uint32_t slice = 0; slice < A2_SYNC; slice++) {
            for (uint32_t lane = 0; lane < lanes; lane++) {
                int dataIndep = pass == 0 && slice < A2_SYNC / 2;
                uint32_t startIdx = (pass == 0 && slice == 0) ? 2 : 0;
                memset(addressBlock, 0, sizeof addressBlock);
                memset(inputBlock, 0, sizeof inputBlock);
                inputBlock[0] = pass; inputBlock[1] = lane; inputBlock[2] = slice;
                inputBlock[3] = mPrime; inputBlock[4] = passes; inputBlock[5] = 2;
                if (pass == 0 && slice == 0) {
                    inputBlock[6]++;
                    a2_g(tmpBlock, zero, inputBlock, 0);
                    a2_g(addressBlock, zero, tmpBlock, 0);
                }
                for (uint32_t idx = startIdx; idx < segLen; idx++) {
                    size_t curOff = ((size_t)lane * laneLen + slice * segLen + idx) * A2_QLEN;
                    uint32_t prevIdx = (slice * segLen + idx) == 0 ? laneLen - 1 : slice * segLen + idx - 1;
                    size_t prevOff = ((size_t)lane * laneLen + prevIdx) * A2_QLEN;
                    uint64_t j1, j2;
                    if (dataIndep) {
                        if (idx % A2_QLEN == 0) {
                            inputBlock[6]++;
                            a2_g(tmpBlock, zero, inputBlock, 0);
                            a2_g(addressBlock, zero, tmpBlock, 0);
                        }
                        uint64_t pr = addressBlock[idx % A2_QLEN];
                        j1 = pr & 0xFFFFFFFF; j2 = (pr >> 32) & 0xFFFFFFFF;
                    } else {
                        j1 = mem[prevOff] & 0xFFFFFFFF;
                        j2 = (mem[prevOff] >> 32) & 0xFFFFFFFF;
                    }
                    uint32_t refLane = (uint32_t)(j2 % lanes);
                    if (pass == 0 && slice == 0) refLane = lane;
                    int sameLane = refLane == lane;
                    long refAreaSize;
                    if (pass == 0) {
                        if (slice == 0) refAreaSize = (long)idx - 1;
                        else refAreaSize = (long)slice * segLen + (sameLane ? (long)idx - 1 : (idx == 0 ? -1 : 0));
                    } else {
                        refAreaSize = (long)laneLen - segLen + (sameLane ? (long)idx - 1 : (idx == 0 ? -1 : 0));
                    }
                    uint64_t rel = j1;
                    rel = rel * rel >> 32;
                    rel = (uint64_t)refAreaSize - 1 - (((uint64_t)refAreaSize * rel) >> 32);
                    long startPos = pass == 0 ? 0 : (slice == A2_SYNC - 1 ? 0 : (long)(slice + 1) * segLen);
                    long absPos = (startPos + (long)rel) % laneLen;
                    size_t refOff = ((size_t)refLane * laneLen + (uint32_t)absPos) * A2_QLEN;
                    a2_g(mem + curOff, mem + prevOff, mem + refOff, pass != 0);
                }
            }
        }
    }

    uint64_t final[A2_QLEN]; memset(final, 0, sizeof final);
    for (uint32_t l = 0; l < lanes; l++) {
        size_t off = ((size_t)l * laneLen + laneLen - 1) * A2_QLEN;
        for (int i = 0; i < A2_QLEN; i++) final[i] ^= mem[off + i];
    }
    free(mem);
    uint8_t finalBytes[1024];
    for (int i = 0; i < A2_QLEN; i++)
        for (int j = 0; j < 8; j++) finalBytes[i*8+j] = (uint8_t)(final[i] >> (8*j));
    b2b_long(finalBytes, 1024, out, outlen);
    memset(finalBytes, 0, sizeof finalBytes);
    memset(final, 0, sizeof final);
    return 0;
}
