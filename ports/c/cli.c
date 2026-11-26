/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Tiny CLI for the C11 Prism port. */
#include "prism.h"
#include "prism_secure.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* base64url (no padding) encode/decode for the site's JWK key files */
static void b64u_enc(const uint8_t *in, size_t n, char *out) {
    static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    size_t p = 0;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = in[i] << 16 | (i+1 < n ? in[i+1] << 8 : 0) | (i+2 < n ? in[i+2] : 0);
        out[p++] = A[v >> 18 & 63]; out[p++] = A[v >> 12 & 63];
        if (i+1 < n) out[p++] = A[v >> 6 & 63];
        if (i+2 < n) out[p++] = A[v & 63];
    }
    out[p] = 0;
}
static int b64u_dec(const char *in, uint8_t *out, size_t want) {
    size_t n = strlen(in), p = 0;
    for (size_t i = 0; i < n; i += 4) {
        unsigned v = 0; int cnt = 0;
        for (int j = 0; j < 4 && i + j < n; j++) {
            char c = in[i+j]; int d = -1;
            if (c >= 'A' && c <= 'Z') d = c - 'A';
            else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
            else if (c >= '0' && c <= '9') d = c - '0' + 52;
            else if (c == '-' || c == '+') d = 62;
            else if (c == '_' || c == '/') d = 63;
            if (d < 0) return -1;
            v = v << 6 | (unsigned)d; cnt++;
        }
        v <<= (4 - cnt) * 6;
        if (p < want) out[p++] = (uint8_t)(v >> 16);
        if (cnt > 2 && p < want) out[p++] = (uint8_t)(v >> 8);
        if (cnt > 3 && p < want) out[p++] = (uint8_t)v;
    }
    return p == want ? 0 : -1;
}
/* extract a "name":"value" string from flat JSON */
static int json_str(const char *json, const char *name, char *out, size_t cap) {
    char needle[64]; snprintf(needle, sizeof needle, "\"%s\":\"", name);
    const char *p = strstr(json, needle);
    if (!p) { /* try with a space */
        snprintf(needle, sizeof needle, "\"%s\": \"", name);
        p = strstr(json, needle);
    }
    if (!p) return -1;
    p += strlen(needle);
    const char *q = strchr(p, '"');
    if (!q || (size_t)(q - p) >= cap) return -1;
    memcpy(out, p, (size_t)(q - p)); out[q - p] = 0;
    return 0;
}
/* key file written by secure-genkey: {"publicKeyHex":"...","privateJwk":{...}} */
static int load_key(const char *path, uint8_t priv[32], uint8_t pub[65]) {
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    static char json[2048];
    size_t n = fread(json, 1, sizeof json - 1, f);
    fclose(f); json[n] = 0;
    char hex[131];
    if (json_str(json, "publicKeyHex", hex, sizeof hex) || strlen(hex) != 130) return -1;
    for (int i = 0; i < 65; i++) {
        char t[3] = { hex[2*i], hex[2*i+1], 0 };
        pub[i] = (uint8_t)strtol(t, 0, 16);
    }
    char d[44];
    if (json_str(json, "d", d, sizeof d)) return -1;
    return b64u_dec(d, priv, 32);
}
static int save_key(const char *path, const uint8_t priv[32], const uint8_t pub[65]) {
    char x[44], y[44], d[44];
    b64u_enc(pub + 1, 32, x); b64u_enc(pub + 33, 32, y); b64u_enc(priv, 32, d);
    FILE *f = fopen(path, "wb");
    if (!f) return -1;
    fprintf(f, "{\"publicKeyHex\":\"");
    for (int i = 0; i < 65; i++) fprintf(f, "%02x", pub[i]);
    fprintf(f, "\",\"privateJwk\":{\"crv\":\"P-256\",\"d\":\"%s\",\"kty\":\"EC\",\"x\":\"%s\",\"y\":\"%s\"}}\n", d, x, y);
    fclose(f);
    return 0;
}

static void usage(const char *argv0) {
    fprintf(stderr,
        "Prism Code (C port) - create and read Prism codes. By Avi Shor.\n"
        "\n"
        "Usage:\n"
        "  %s encode (--text TEXT | --file PATH) -o OUT.png [options]\n"
        "  %s decode IN.png [-o OUT.bin] [--password PW]\n"
        "  %s secure-seal IN -o OUT [--password PW] [--kdf argon2id|pbkdf2] [--sign-key KEY.json]\n"
        "  %s secure-open IN [-o OUT] [--password PW]\n"
        "  %s secure-genkey [-o KEY.json]\n"
        "  %s capacity\n"
        "\n"
        "Encode options:\n"
        "  --size N       0..5, or -1 automatic (default -1)\n"
        "  --ecc N        0..3 = 10/20/30/40%% repair data (default 1 = 20%%)\n"
        "  --mode M       color | bw (default color; bw holds ~1/3)\n"
        "  --type T       text | binary (default: text for --text, binary for --file)\n"
        "  --scale N      PNG pixels per cell unit (default 12; live site uses 8/12/20/32)\n"
        "  --password PW  lock the payload with Prism Secure (AES-256-GCM)\n"
        "  --kdf K        argon2id (default) | pbkdf2\n"
        "  --sign-key KF  sign the payload with a key from secure-genkey\n"
        "\n"
        "Decode prints text payloads to stdout; with -o it writes raw payload bytes.\n",
        argv0, argv0, argv0, argv0, argv0, argv0);
}

int main(int argc, char **argv) {
    char err[256] = {0};
    if (argc < 2) { usage(argv[0]); return 2; }

    if (!strcmp(argv[1], "capacity")) {
        printf("size  cells      color-ecc0  bw-ecc0  (max payload bytes; ecc1/2/3 fit less)\n");
        for (int s = 0; s < 6; s++) {
            const char *cells[] = {"21x24","29x33","41x47","57x66","81x94","113x130"};
            printf("%d     %-10s %-11d %-8d\n", s, cells[s],
                   prism_capacity_payload(s, 0, PRISM_MODE_COLOR),
                   prism_capacity_payload(s, 0, PRISM_MODE_BW));
        }
        return 0;
    }

    if (!strcmp(argv[1], "encode")) {
        const char *text = NULL, *file = NULL, *out = NULL, *password = NULL, *keyf = NULL;
        const char *kdf = "argon2id";
        int size = -1, ecc = 1, mode = PRISM_MODE_COLOR, type = -1, scale = 12;
        for (int i = 2; i < argc; i++) {
            if (!strcmp(argv[i], "--text") && i + 1 < argc) text = argv[++i];
            else if (!strcmp(argv[i], "--file") && i + 1 < argc) file = argv[++i];
            else if (!strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
            else if (!strcmp(argv[i], "--size") && i + 1 < argc) size = atoi(argv[++i]);
            else if (!strcmp(argv[i], "--ecc") && i + 1 < argc) ecc = atoi(argv[++i]);
            else if (!strcmp(argv[i], "--scale") && i + 1 < argc) scale = atoi(argv[++i]);
            else if (!strcmp(argv[i], "--mode") && i + 1 < argc) {
                i++;
                mode = !strcmp(argv[i], "bw") ? PRISM_MODE_BW : PRISM_MODE_COLOR;
            }
            else if (!strcmp(argv[i], "--type") && i + 1 < argc) {
                i++;
                type = !strcmp(argv[i], "binary") ? PRISM_TYPE_BINARY : PRISM_TYPE_TEXT;
            }
            else if (!strcmp(argv[i], "--password") && i + 1 < argc) password = argv[++i];
            else if (!strcmp(argv[i], "--kdf") && i + 1 < argc) kdf = argv[++i];
            else if (!strcmp(argv[i], "--sign-key") && i + 1 < argc) keyf = argv[++i];
            else { usage(argv[0]); return 2; }
        }
        if ((!text && !file) || !out) { usage(argv[0]); return 2; }
        uint8_t *data; size_t len;
        if (file) {
            FILE *f = fopen(file, "rb");
            if (!f) { fprintf(stderr, "error: cannot open %s\n", file); return 1; }
            fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
            data = malloc((size_t)fl ? (size_t)fl : 1);
            if (fl && fread(data, 1, (size_t)fl, f) != (size_t)fl) { fclose(f); free(data); fprintf(stderr, "error: cannot read %s\n", file); return 1; }
            fclose(f);
            len = (size_t)fl;
            if (type < 0) type = PRISM_TYPE_BINARY;
        } else {
            data = (uint8_t *)text; len = strlen(text);
            if (type < 0) type = PRISM_TYPE_TEXT;
        }
        if (password || keyf) {
            uint8_t priv[32], pub[65];
            const uint8_t *pp = NULL, *qq = NULL;
            if (keyf) {
                if (load_key(keyf, priv, pub)) { fprintf(stderr, "error: bad key file %s\n", keyf); return 1; }
                pp = priv; qq = pub;
            }
            uint8_t *sealed; size_t slen;
            if (prism_secure_seal(data, len, password, kdf, pp, qq, &sealed, &slen)) {
                fprintf(stderr, "error: sealing failed\n");
                return 1;
            }
            if (file) free(data);
            data = sealed; len = slen; type = PRISM_TYPE_BINARY; file = (const char *)1; /* owns data */
        }
        if (prism_encode_png(data, len, size, ecc, mode, type, scale, out, err, sizeof(err))) {
            fprintf(stderr, "error: %s\n", err);
            if (file) free(data);
            return 1;
        }
        printf("wrote %s (%zu payload bytes)\n", out, len);
        if (file) free(data);
        return 0;
    }

    if (!strcmp(argv[1], "decode")) {
        const char *in = NULL, *out = NULL, *password = NULL;
        for (int i = 2; i < argc; i++) {
            if (!strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
            else if (!strcmp(argv[i], "--password") && i + 1 < argc) password = argv[++i];
            else if (!in) in = argv[i];
            else { usage(argv[0]); return 2; }
        }
        if (!in) { usage(argv[0]); return 2; }
        uint8_t *bytes = NULL; size_t len = 0; int type = 0;
        if (prism_decode_png(in, &bytes, &len, &type, err, sizeof(err))) {
            fprintf(stderr, "error: %s\n", err);
            return 1;
        }
        if (prism_secure_is_secure(bytes, len)) {
            prism_secure_result r;
            prism_secure_open(bytes, len, password, NULL, 0, &r);
            free(bytes);
            if (r.signature_valid == 0) { fprintf(stderr, "error: %s\n", r.error); return 1; }
            if (!r.bytes) {
                fprintf(stderr, "error: %s\n", r.error[0] ? r.error : (r.needs_password ? "this code is locked; pass --password" : "cannot open"));
                return 1;
            }
            if (r.signed_)
                fprintf(stderr, "signature: valid, signer %s\n", r.signer_fingerprint);
            bytes = r.bytes; len = r.bytes_len; type = PRISM_TYPE_TEXT;
        }
        if (out) {
            FILE *f = fopen(out, "wb");
            if (!f) { fprintf(stderr, "error: cannot open %s\n", out); free(bytes); return 1; }
            if (len && fwrite(bytes, 1, len, f) != len) { fclose(f); free(bytes); fprintf(stderr, "error: cannot write %s\n", out); return 1; }
            fclose(f);
            printf("wrote %s (%zu payload bytes, %s)\n", out, len, type ? "binary" : "text");
        } else {
            if (type == PRISM_TYPE_TEXT) { fwrite(bytes, 1, len, stdout); fputc('\n', stdout); }
            else printf("(%zu binary payload bytes; use -o OUT.bin to save)\n", len);
        }
        free(bytes);
        return 0;
    }

    if (!strcmp(argv[1], "secure-genkey")) {
        const char *out = NULL;
        for (int i = 2; i < argc; i++)
            if (!strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
        uint8_t priv[32], pub[65];
        if (prism_secure_generate_signing_key(priv, pub)) { fprintf(stderr, "error: no randomness source\n"); return 1; }
        char fp[24]; prism_fingerprint(pub, fp);
        printf("fingerprint: %s\n", fp);
        if (out) {
            if (save_key(out, priv, pub)) { fprintf(stderr, "error: cannot write %s\n", out); return 1; }
            printf("wrote %s\n", out);
        }
        memset(priv, 0, 32);
        return 0;
    }

    if (!strcmp(argv[1], "secure-seal") || !strcmp(argv[1], "secure-open")) {
        const char *in = NULL, *out = NULL, *password = NULL, *keyf = NULL;
        const char *kdf = "argon2id";
        for (int i = 2; i < argc; i++) {
            if (!strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
            else if (!strcmp(argv[i], "--password") && i + 1 < argc) password = argv[++i];
            else if (!strcmp(argv[i], "--kdf") && i + 1 < argc) kdf = argv[++i];
            else if (!strcmp(argv[i], "--sign-key") && i + 1 < argc) keyf = argv[++i];
            else if (!in) in = argv[i];
            else { usage(argv[0]); return 2; }
        }
        if (!in) { usage(argv[0]); return 2; }
        FILE *f = fopen(in, "rb");
        if (!f) { fprintf(stderr, "error: cannot open %s\n", in); return 1; }
        fseek(f, 0, SEEK_END); long fl = ftell(f); fseek(f, 0, SEEK_SET);
        uint8_t *data = malloc((size_t)fl ? (size_t)fl : 1);
        if (fl && fread(data, 1, (size_t)fl, f) != (size_t)fl) { fclose(f); free(data); fprintf(stderr, "error: cannot read %s\n", in); return 1; }
        fclose(f);
        if (!strcmp(argv[1], "secure-seal")) {
            uint8_t priv[32], pub[65];
            const uint8_t *pp = NULL, *qq = NULL;
            if (keyf) {
                if (load_key(keyf, priv, pub)) { fprintf(stderr, "error: bad key file %s\n", keyf); free(data); return 1; }
                pp = priv; qq = pub;
            }
            uint8_t *sealed; size_t slen;
            if (prism_secure_seal(data, (size_t)fl, password, kdf, pp, qq, &sealed, &slen)) {
                fprintf(stderr, "error: sealing failed (need --password and/or --sign-key)\n"); free(data); return 1;
            }
            memset(priv, 0, 32);
            if (out) {
                FILE *o = fopen(out, "wb");
                if (!o) { fprintf(stderr, "error: cannot write %s\n", out); return 1; }
                fwrite(sealed, 1, slen, o); fclose(o);
                printf("wrote %s (%ld -> %zu bytes)\n", out, fl, slen);
            } else { fwrite(sealed, 1, slen, stdout); }
            free(sealed); free(data);
            return 0;
        }
        prism_secure_result r;
        prism_secure_open(data, (size_t)fl, password, NULL, 0, &r);
        free(data);
        if (r.signature_valid == 0) { fprintf(stderr, "error: %s\n", r.error); return 1; }
        if (!r.bytes) {
            fprintf(stderr, "error: %s\n", r.error[0] ? r.error : (r.needs_password ? "needs a password" : "cannot open"));
            return 1;
        }
        if (r.signed_) fprintf(stderr, "signature: valid, signer %s\n", r.signer_fingerprint);
        if (out) {
            FILE *o = fopen(out, "wb");
            if (!o) { fprintf(stderr, "error: cannot write %s\n", out); free(r.bytes); return 1; }
            if (r.bytes_len && fwrite(r.bytes, 1, r.bytes_len, o) != r.bytes_len) { fclose(o); free(r.bytes); fprintf(stderr, "error: write failed\n"); return 1; }
            fclose(o);
            printf("wrote %s (%zu bytes)\n", out, r.bytes_len);
        } else { fwrite(r.bytes, 1, r.bytes_len, stdout); fputc('\n', stdout); }
        free(r.bytes);
        return 0;
    }

    usage(argv[0]);
    return 2;
}
