/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism verified issuers, same semantics as prism-issuers.js. */
#include "prism_issuers.h"
#include "prism_secure.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>

static char *dup_range(const char *s, size_t n) {
    char *r = malloc(n + 1);
    if (r) { memcpy(r, s, n); r[n] = 0; }
    return r;
}

/* ECDSA P-256 verify over raw 0x04|X|Y keys and P1363 signatures. */
int prism_p256_verify(const uint8_t pub[65], const uint8_t *msg, size_t mlen, const uint8_t sig[64]);

/* Strict UTF-8: rejects truncation, overlong forms, surrogates, > U+10FFFF. */
static int utf8_valid(const uint8_t *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint8_t c = s[i];
        if (c < 0x80) { i++; continue; }
        int need;
        uint32_t cp, minv;
        if ((c & 0xE0) == 0xC0) { need = 1; cp = c & 0x1F; minv = 0x80; }
        else if ((c & 0xF0) == 0xE0) { need = 2; cp = c & 0x0F; minv = 0x800; }
        else if ((c & 0xF8) == 0xF0) { need = 3; cp = c & 0x07; minv = 0x10000; }
        else return 0;
        if (i + (size_t)need >= n + 1) return 0;
        for (int k = 1; k <= need; k++) {
            if (i + (size_t)k >= n || (s[i + k] & 0xC0) != 0x80) return 0;
            cp = (cp << 6) | (s[i + k] & 0x3F);
        }
        if (cp < minv || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return 0;
        i += (size_t)need + 1;
    }
    return 1;
}

int prism_issuer_identify(const uint8_t *bytes, size_t len, prism_issuer_id *out) {
    memset(out, 0, sizeof *out);
    if (!bytes || len < 5 + 65 + 64) return 0;
    if (memcmp(bytes, "PSC", 3) != 0) return 0;
    if (bytes[3] != 1 && bytes[3] != 2) return 0;
    if (!(bytes[4] & 2)) return 0; /* F_SIG */
    size_t end = len;
    const uint8_t *pub = bytes + end - 129;
    const uint8_t *sig = bytes + end - 64;
    const uint8_t *body = bytes;
    size_t body_len = end - 129;
    out->signature_valid = prism_p256_verify(pub, body, body_len, sig) ? 1 : 0;
    out->encrypted = !!(bytes[4] & 1);
    prism_fingerprint(pub, out->fingerprint);
    if (out->signature_valid && !out->encrypted && body_len >= 5) {
        /* decoded text after the 5-byte envelope header; like the site's
         * TextDecoder(utf-8, fatal): NULL when the bytes are not valid UTF-8 */
        if (utf8_valid(body + 5, body_len - 5)) {
            out->message = malloc(body_len - 5 + 1);
            if (out->message) {
                memcpy(out->message, body + 5, body_len - 5);
                out->message[body_len - 5] = 0;
            }
        }
    }
    return 1;
}

static void norm_fp(const char *in, char *out) {
    size_t w = 0;
    for (const char *p = in; *p && w < 15; p++)
        if (isxdigit((unsigned char)*p)) out[w++] = (char)toupper((unsigned char)*p);
    out[w] = 0;
}

const prism_issuer *prism_issuers_find(const prism_issuer *list, int n, const char *fingerprint) {
    char want[16];
    norm_fp(fingerprint, want);
    for (int i = 0; i < n; i++) {
        char have[16];
        norm_fp(list[i].fingerprint, have);
        if (strcmp(have, want) == 0) return &list[i];
    }
    return NULL;
}

/* Minimal reader for the issuers.json shape the site serves; the list is
 * small and site-controlled, so a targeted scan is enough. */
int prism_issuers_load(const char *path, prism_issuer **list_out) {
    *list_out = NULL;
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 1 << 20) { fclose(f); return 0; }
    char *buf = malloc((size_t)sz + 1);
    if (!buf) { fclose(f); return 0; }
    fread(buf, 1, (size_t)sz, f);
    fclose(f);
    buf[sz] = 0;

    int cap = 8, n = 0;
    prism_issuer *list = calloc((size_t)cap, sizeof(prism_issuer));
    if (!list) { free(buf); return 0; }
    const char *p = buf;
    while ((p = strstr(p, "\"name\"")) != NULL) {
        p += 6;
        while (*p && (*p == ' ' || *p == ':' || *p == '\t')) p++;
        if (*p != '"') continue;
        const char *ns = ++p;
        const char *ne = strchr(ns, '"');
        if (!ne) break;
        const char *q = strstr(ne, "\"fingerprint\"");
        if (!q) break;
        q += 13;
        while (*q && (*q == ' ' || *q == ':' || *q == '\t')) q++;
        if (*q != '"') continue;
        const char *fs = ++q;
        const char *fe = strchr(fs, '"');
        if (!fe) break;
        if (n == cap) {
            cap *= 2;
            prism_issuer *nl = realloc(list, (size_t)cap * sizeof(prism_issuer));
            if (!nl) break;
            list = nl;
        }
        list[n].name = dup_range(ns, (size_t)(ne - ns));
        list[n].fingerprint = dup_range(fs, (size_t)(fe - fs));
        n++;
        p = fe;
    }
    free(buf);
    if (n == 0) { free(list); return 0; }
    *list_out = list;
    return n;
}

void prism_issuers_free(prism_issuer *list, int n) {
    if (!list) return;
    for (int i = 0; i < n; i++) { free(list[i].name); free(list[i].fingerprint); }
    free(list);
}
