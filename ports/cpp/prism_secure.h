/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism Secure (envelope v2, reads v1): AES-256-GCM payload locking and
 * ECDSA P-256 signing, byte-compatible with the live site. C11, no deps. */
#ifndef PRISM_SECURE_H
#define PRISM_SECURE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PRISM_SECURE_ARGON2_MEM 131072
#define PRISM_SECURE_ARGON2_T 3
#define PRISM_SECURE_ARGON2_P 1
#define PRISM_SECURE_PBKDF2_ITER 600000

typedef struct {
    int secure;                    /* 0 = plain payload (bytes passed through) */
    int version;                   /* 1 or 2 when secure */
    int encrypted, signed_;
    int signature_valid;           /* -1 n/a, 0 invalid, 1 valid */
    char signer_fingerprint[24];   /* "XXXX-XXXX-XXXX-XXXX" when signed */
    int trusted;                   /* valid signature and fingerprint in trusted list */
    uint8_t *bytes;                /* malloc'd; caller frees. NULL on failure */
    size_t bytes_len;
    int needs_password;
    char error[160];               /* set when bytes == NULL */
} prism_secure_result;

/* Cryptographically secure random bytes (getrandom / arc4random / BCrypt). */
int prism_random(uint8_t *out, size_t n);

/* Fingerprint of a 65-byte public key: first 8 bytes of SHA-256, hex upper, XXXX- grouped. */
void prism_fingerprint(const uint8_t pub[65], char out[24]);

/* Generate a P-256 signing key. priv is 32 bytes, pub 65 (0x04|X|Y). Returns 0 ok. */
int prism_secure_generate_signing_key(uint8_t priv[32], uint8_t pub[65]);

/* Seal: password != NULL locks (kdf "argon2id" or "pbkdf2"); priv/pub != NULL signs.
 * At least one of the two. *out is malloc'd. Returns 0 on success. */
int prism_secure_seal(const uint8_t *data, size_t len,
                      const char *password, const char *kdf,
                      const uint8_t priv[32], const uint8_t pub[65],
                      uint8_t **out, size_t *outlen);

int prism_secure_is_secure(const uint8_t *data, size_t len);
/* 0/1 secure, plus encrypted/signed via pointers (any may be NULL). */
void prism_secure_inspect(const uint8_t *data, size_t len, int *encrypted, int *signed_);

/* Open: plain input passes through (secure=0). trusted_fps: NULL or array of
 * "XXXX-..." strings. Errors are reported in res->error with res->bytes NULL
 * (wrong password / tamper / invalid signature), never a wrong payload. */
void prism_secure_open(const uint8_t *data, size_t len,
                       const char *password,
                       const char **trusted_fps, int n_trusted,
                       prism_secure_result *res);

/* Random passphrase: 7 groups of 4, 140 bits. out needs 35 bytes. */
int prism_secure_generate_passphrase(char out[35]);

/* Password strength estimate (same heuristic as the site). bits/level out. */
void prism_secure_strength(const char *pw, int *bits, int *level, const char **label);

#ifdef __cplusplus
}
#endif

#endif
