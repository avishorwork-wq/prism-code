/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism verified issuers: identify signed Prism Secure payloads and look the
 * signer up in an issuer list, same semantics as prism-issuers.js. */
#ifndef PRISM_ISSUERS_H
#define PRISM_ISSUERS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int signature_valid;      /* 0/1 */
    char fingerprint[24];     /* "XXXX-XXXX-XXXX-XXXX" */
    int encrypted;
    char *message;            /* malloc'd decoded text for valid, unencrypted
                                 signed payloads; else NULL. Caller frees. */
} prism_issuer_id;

/* Inspect decoded payload bytes. Returns 1 and fills *out when the payload is
 * a signed Prism Secure envelope (v1 or v2, encrypted or not); returns 0 for
 * plain or unsigned payloads. Never decrypts. */
int prism_issuer_identify(const uint8_t *bytes, size_t len, prism_issuer_id *out);

typedef struct {
    char *name;
    char *fingerprint;
} prism_issuer;

/* Loads an issuers.json file ({"issuers":[{"name":..., "fingerprint":...}]}).
 * Returns the count (0 when the file is missing or damaged). */
int prism_issuers_load(const char *path, prism_issuer **list_out);
void prism_issuers_free(prism_issuer *list, int n);

/* Normalized fingerprint match (case-insensitive, separators ignored). */
const prism_issuer *prism_issuers_find(const prism_issuer *list, int n, const char *fingerprint);

#ifdef __cplusplus
}
#endif

#endif
