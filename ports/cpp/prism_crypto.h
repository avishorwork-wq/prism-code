/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Crypto primitives for Prism Secure (C11, no external libraries). */
#ifndef PRISM_CRYPTO_H
#define PRISM_CRYPTO_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void prism_sha256(const uint8_t *data, size_t len, uint8_t out[32]);
void prism_hmac_sha256(const uint8_t *key, size_t klen, const uint8_t *msg, size_t mlen, uint8_t out[32]);
void prism_pbkdf2_sha256(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen,
                         uint32_t iters, uint8_t *out, size_t outlen);
void prism_blake2b(const uint8_t *data, size_t len, uint8_t *out, size_t outlen);

/* AES-256-GCM, 12-byte IV, 16-byte tag. Decrypt returns 1 on tag match, 0 otherwise. */
void prism_aes256gcm_encrypt(const uint8_t key[32], const uint8_t iv[12],
                             const uint8_t *aad, size_t alen,
                             const uint8_t *pt, size_t ptlen,
                             uint8_t *ct, uint8_t tag[16]);
int prism_aes256gcm_decrypt(const uint8_t key[32], const uint8_t iv[12],
                            const uint8_t *aad, size_t alen,
                            const uint8_t *ct, size_t ctlen, const uint8_t tag[16],
                            uint8_t *pt);

/* Argon2id per RFC 9106. memKiB in KiB. Returns 0 on success. */
int prism_argon2id(const uint8_t *pw, size_t pwlen, const uint8_t *salt, size_t slen,
                   uint32_t memKiB, uint32_t passes, uint32_t lanes,
                   uint8_t *out, size_t outlen);

/* ECDSA over NIST P-256 with SHA-256, P1363 fixed-concatenation signatures.
 * Keys: private = 32-byte scalar; public = 65 bytes 0x04|X|Y.
 * Matches WebCrypto (the live Prism site). */
void prism_p256_keygen(const uint8_t priv[32], uint8_t pub[65]);
int  prism_p256_valid_public(const uint8_t pub[65]);
/* Deterministic per RFC 6979. sig is 64 bytes r|s. */
void prism_p256_sign(const uint8_t priv[32], const uint8_t *msg, size_t mlen, uint8_t sig[64]);
int  prism_p256_verify(const uint8_t pub[65], const uint8_t *msg, size_t mlen, const uint8_t sig[64]);

#ifdef __cplusplus
}
#endif

#endif
