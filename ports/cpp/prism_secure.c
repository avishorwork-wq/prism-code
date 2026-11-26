/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C port of Prism Secure (envelope v2, reads v1). Byte-compatible with the
 * live site's prism-secure.html JS. See that file for the format spec.
 *
 * Note on passwords: they are used as their UTF-8 bytes. The website applies
 * Unicode NFKC normalization first; this port does not ship a Unicode
 * normalizer, so non-ASCII passwords should already be in composed (NFC)
 * form — which is what keyboards and terminals produce. ASCII passwords are
 * unaffected. */
#include "prism_secure.h"
#include "prism_crypto.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#if defined(_WIN32)
#include <windows.h>
#include <bcrypt.h>
#else
#include <unistd.h>
#include <fcntl.h>
#if defined(__linux__)
#include <sys/random.h>
#endif
#endif

int prism_random(uint8_t *out, size_t n)
{
#if defined(_WIN32)
    return BCryptGenRandom(NULL, out, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 0 : -1;
#elif defined(__linux__)
    size_t got = 0;
    while (got < n) {
        ssize_t r = getrandom(out + got, n - got, 0);
        if (r <= 0) break;
        got += (size_t)r;
    }
    if (got == n) return 0;
    /* fall through to /dev/urandom */
#endif
#if !defined(_WIN32)
    {
        int fd = open("/dev/urandom", O_RDONLY);
        if (fd < 0) return -1;
        size_t got = 0;
        while (got < n) {
            ssize_t r = read(fd, out + got, n - got);
            if (r <= 0) { close(fd); return -1; }
            got += (size_t)r;
        }
        close(fd);
        return 0;
    }
#endif
}

static const uint8_t MAGIC[3] = { 0x50, 0x53, 0x43 }; /* "PSC" */
#define F_ENC 1
#define F_SIG 2
#define HEAD2 (4 + 1 + 1 + 6 + 16 + 12)
#define HEAD1 (4 + 1 + 16 + 12 + 4)
#define MAX_MEM 262144
#define MAX_T 12

static void be32w(uint8_t *b, uint32_t n)
{
    b[0] = (uint8_t)(n >> 24); b[1] = (uint8_t)(n >> 16); b[2] = (uint8_t)(n >> 8); b[3] = (uint8_t)n;
}
static uint32_t be32r(const uint8_t *b)
{
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
}

void prism_fingerprint(const uint8_t pub[65], char out[24])
{
    uint8_t h[32];
    prism_sha256(pub, 65, h);
    int p = 0;
    for (int i = 0; i < 8; i++) {
        sprintf(out + p, "%02X", h[i]);
        p += 2;
        if (i % 2 == 1 && i < 7) out[p++] = '-';
    }
    out[p] = 0;
}

int prism_secure_generate_signing_key(uint8_t priv[32], uint8_t pub[65])
{
    /* rejection-sample a scalar in [1, n-1]; n is close enough to 2^256 that
     * accepting any non-zero 32-byte value is fine modulo n's top bit pattern,
     * but the sign path reduces mod n anyway. Draw until non-zero. */
    for (;;) {
        if (prism_random(priv, 32) != 0) return -1;
        int nz = 0;
        for (int i = 0; i < 32; i++) nz |= priv[i];
        if (nz) break;
    }
    prism_p256_keygen(priv, pub);
    return 0;
}

static int derive_key(const char *password, const uint8_t *salt, int kdf,
                      uint32_t iter, uint32_t mem, int t, int lanes, uint8_t key[32])
{
    size_t pwlen = strlen(password);
    if (kdf == 2)
        return prism_argon2id((const uint8_t *)password, pwlen, salt, 16, mem, (uint32_t)t, (uint32_t)lanes, key, 32);
    prism_pbkdf2_sha256((const uint8_t *)password, pwlen, salt, 16, iter, key, 32);
    return 0;
}

int prism_secure_seal(const uint8_t *data, size_t len,
                      const char *password, const char *kdf,
                      const uint8_t priv[32], const uint8_t pub[65],
                      uint8_t **out, size_t *outlen)
{
    if (!password && !priv) return -1;
    int useA = !kdf || strcmp(kdf, "argon2id") == 0;
    int flags = (password ? F_ENC : 0) | (priv ? F_SIG : 0);
    size_t body_len = password ? (size_t)HEAD2 + len + 16 : 5 + len;
    uint8_t *body = malloc(body_len);
    if (!body) return -2;
    if (password) {
        uint8_t salt[16], iv[12];
        if (prism_random(salt, 16) || prism_random(iv, 12)) { free(body); return -3; }
        uint8_t *h = body;
        memcpy(h, MAGIC, 3); h[3] = 2; h[4] = (uint8_t)flags; h[5] = (uint8_t)(useA ? 2 : 1);
        be32w(h + 6, useA ? PRISM_SECURE_ARGON2_MEM : PRISM_SECURE_PBKDF2_ITER);
        h[10] = (uint8_t)(useA ? PRISM_SECURE_ARGON2_T : 0);
        h[11] = (uint8_t)(useA ? PRISM_SECURE_ARGON2_P : 0);
        memcpy(h + 12, salt, 16); memcpy(h + 28, iv, 12);
        uint8_t key[32];
        if (derive_key(password, salt, useA ? 2 : 1, PRISM_SECURE_PBKDF2_ITER,
                       PRISM_SECURE_ARGON2_MEM, PRISM_SECURE_ARGON2_T, PRISM_SECURE_ARGON2_P, key)) {
            free(body); return -4;
        }
        prism_aes256gcm_encrypt(key, iv, body, HEAD2, data, len, body + HEAD2, body + HEAD2 + len);
        memset(key, 0, 32);
    } else {
        memcpy(body, MAGIC, 3); body[3] = 2; body[4] = (uint8_t)flags;
        memcpy(body + 5, data, len);
    }
    if (!priv) { *out = body; *outlen = body_len; return 0; }
    uint8_t sig[64];
    prism_p256_sign(priv, body, body_len, sig);
    uint8_t *full = malloc(body_len + 129);
    if (!full) { free(body); return -2; }
    memcpy(full, body, body_len);
    memcpy(full + body_len, pub, 65);
    memcpy(full + body_len + 65, sig, 64);
    free(body);
    *out = full; *outlen = body_len + 129;
    return 0;
}

int prism_secure_is_secure(const uint8_t *b, size_t len)
{
    return len >= 6 && b[0] == MAGIC[0] && b[1] == MAGIC[1] && b[2] == MAGIC[2] &&
           (b[3] == 1 || b[3] == 2) && (b[4] & ~3) == 0;
}

void prism_secure_inspect(const uint8_t *b, size_t len, int *encrypted, int *signed_)
{
    if (encrypted) *encrypted = prism_secure_is_secure(b, len) && (b[4] & F_ENC);
    if (signed_) *signed_ = prism_secure_is_secure(b, len) && (b[4] & F_SIG);
}

static void res_error(prism_secure_result *res, const char *msg)
{
    res->bytes = NULL;
    snprintf(res->error, sizeof res->error, "%s", msg);
}

void prism_secure_open(const uint8_t *b, size_t len,
                       const char *password,
                       const char **trusted_fps, int n_trusted,
                       prism_secure_result *res)
{
    memset(res, 0, sizeof *res);
    res->signature_valid = -1;
    if (!prism_secure_is_secure(b, len)) {
        res->secure = 0;
        res->bytes = malloc(len ? len : 1);
        if (len) memcpy(res->bytes, b, len);
        res->bytes_len = len;
        return;
    }
    int ver = b[3], flags = b[4];
    int encrypted = flags & F_ENC, sgn = flags & F_SIG;
    res->secure = 1; res->version = ver; res->encrypted = encrypted; res->signed_ = sgn;
    size_t end = len;
    if (sgn) {
        if (len < 5 + 65 + 64) { res_error(res, "Code is damaged"); return; }
        const uint8_t *pub = b + end - 129, *sig = b + end - 64;
        res->signature_valid = prism_p256_verify(pub, b, end - 129, sig) ? 1 : 0;
        prism_fingerprint(pub, res->signer_fingerprint);
        if (res->signature_valid && trusted_fps)
            for (int i = 0; i < n_trusted; i++)
                if (trusted_fps[i] && strcmp(trusted_fps[i], res->signer_fingerprint) == 0) res->trusted = 1;
        end -= 129;
        if (!res->signature_valid) {
            res_error(res, "Signature is not valid. This code was changed or forged.");
            return;
        }
    }
    if (!encrypted) {
        res->bytes = malloc(end - 5 ? end - 5 : 1);
        memcpy(res->bytes, b + 5, end - 5);
        res->bytes_len = end - 5;
        return;
    }
    size_t hl; const uint8_t *salt, *iv; int kdf;
    uint32_t iter = 0, mem = 0; int t = 0, lanes = 0;
    if (ver == 1) {
        hl = HEAD1;
        if (end < hl + 16) { res_error(res, "Code is damaged"); return; }
        salt = b + 5; iv = b + 21; kdf = 1; iter = be32r(b + 33);
    } else {
        hl = HEAD2;
        if (end < hl + 16) { res_error(res, "Code is damaged"); return; }
        kdf = b[5];
        salt = b + 12; iv = b + 28;
        if (kdf == 2) { mem = be32r(b + 6); t = b[10]; lanes = b[11]; }
        else iter = be32r(b + 6);
    }
    if (kdf == 1 ? (iter < 100000 || iter > 5000000)
        : kdf == 2 ? (mem < 8192 || mem > MAX_MEM || t < 1 || t > MAX_T || lanes < 1 || lanes > 4)
        : 1) { res_error(res, "Code is damaged or unsupported"); return; }
    if (!password) { res->bytes = NULL; res->needs_password = 1; return; }
    uint8_t key[32];
    if (derive_key(password, salt, kdf, iter, mem, t, lanes, key)) {
        res_error(res, "Key derivation failed"); return;
    }
    res->bytes = malloc(end - hl - 16 ? end - hl - 16 : 1);
    res->bytes_len = end - hl - 16;
    if (!prism_aes256gcm_decrypt(key, iv, b, hl, b + hl, end - hl - 16, b + end - 16, res->bytes)) {
        free(res->bytes); res->bytes = NULL;
        res_error(res, "Wrong password, or the code was changed.");
    }
    memset(key, 0, 32);
}

int prism_secure_generate_passphrase(char out[35])
{
    static const char ALPHA[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    uint8_t r[28];
    if (prism_random(r, 28)) return -1;
    int p = 0;
    for (int g = 0; g < 7; g++) {
        if (g) out[p++] = '-';
        for (int i = 0; i < 4; i++) out[p++] = ALPHA[r[g * 4 + i] & 31];
    }
    out[p] = 0;
    memset(r, 0, sizeof r);
    return 0;
}

void prism_secure_strength(const char *pw, int *bits_out, int *level, const char **label)
{
    /* Same cautious heuristic as the site (ASCII-oriented pool counting). */
    static const char *labels[] = { "weak", "weak", "fair", "good", "strong" };
    size_t n = strlen(pw);
    if (n == 0) { *bits_out = 0; *level = 0; *label = "none"; return; }
    /* generated-passphrase shape: 6+ dash groups of 4 from the 32-symbol alphabet */
    {
        int groups = 1, ok = 1;
        size_t body = 0;
        for (size_t i = 0; i < n; i++) {
            char c = pw[i];
            if (c == '-') { groups++; continue; }
            if (!(c >= 'A' && c <= 'Z' && c != 'I' && c != 'O') && !(c >= '2' && c <= '9')) { ok = 0; break; }
            body++;
        }
        if (groups >= 6 && ok && body >= 24) {
            *bits_out = (int)body * 5; *level = 4; *label = "excellent (random)"; return;
        }
    }
    int pool = 0, lo = 0, up = 0, dig = 0, sym = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)pw[i];
        if (c >= 'a' && c <= 'z') lo = 1; else if (c >= 'A' && c <= 'Z') up = 1;
        else if (c >= '0' && c <= '9') dig = 1; else sym = 1;
    }
    pool = (lo ? 26 : 0) + (up ? 26 : 0) + (dig ? 10 : 0) + (sym ? 33 : 0);
    if (pool < 2) pool = 2;
    /* log2(pool) via table-free approximation */
    double lp = 0; { int p = pool; while (p > 1) { lp += 1; p >>= 1; } lp += (pool - (1 << (int)lp)) / (double)(1 << (int)lp); }
    /* unique chars */
    int uniq = 0;
    for (size_t i = 0; i < n; i++) { int seen = 0; for (size_t j = 0; j < i; j++) if (pw[j] == pw[i]) seen = 1; uniq += !seen; }
    size_t cap = (size_t)uniq * 2 < n ? (size_t)uniq * 2 : n;
    double bits = (double)cap * lp;
    /* repeated chars */
    for (size_t i = 0; i + 2 < n; i++) if (pw[i] == pw[i+1] && pw[i] == pw[i+2]) { bits *= 0.7; break; }
    /* sequences */
    static const char *seq[] = { "012","123","234","345","456","567","678","789","abc","bcd","cde","def","qwe","wer","asd","sdf","zxc", 0 };
    for (int s = 0; seq[s]; s++)
        for (size_t i = 0; i + 2 < n; i++)
            if ((pw[i] | 32) == seq[s][0] && (pw[i+1] | 32) == seq[s][1] && (pw[i+2] | 32) == seq[s][2]) { bits *= 0.7; goto seqdone; }
    seqdone:;
    if ((lo && !up && !dig && !sym) || (dig && !lo && !up && !sym)) bits *= 0.8;
    /* year */
    for (size_t i = 0; i + 3 < n; i++)
        if (((pw[i] == '1' && pw[i+1] == '9') || (pw[i] == '2' && pw[i+1] == '0')) &&
            pw[i+2] >= '0' && pw[i+2] <= '9' && pw[i+3] >= '0' && pw[i+3] <= '9') { bits -= 8; break; }
    /* common words (lowercase substring) */
    static const char *common[] = { "password","passw0rd","qwerty","letmein","welcome","admin","iloveyou","monkey","dragon","football","baseball","shalom","israel","master","login","abc123","prism","secret","hello","test","summer","winter","sunshine","princess","trustno1","whatever","google","avi","1234","asdf","zxcv","love","god","cohen","levi", 0 };
    char *low = malloc(n + 1);
    for (size_t i = 0; i < n; i++) { char c = pw[i]; low[i] = (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
    low[n] = 0;
    for (int w = 0; common[w]; w++)
        if (strstr(low, common[w])) {
            double b2 = bits < 28 ? bits : 28;
            if (strcmp(low, common[w]) == 0) b2 -= 8;
            bits = b2;
            break;
        }
    free(low);
    int ibits = bits < 0 ? 0 : (int)bits;
    *bits_out = ibits;
    *level = ibits < 40 ? 0 : ibits < 60 ? 1 : ibits < 80 ? 2 : ibits < 100 ? 3 : 4;
    *label = labels[*level];
}
