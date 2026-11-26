/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism big files in parts (PPT1), byte-compatible with prism-parts.js. */
#include "prism_parts.h"
#include "prism.h"
#include "prism_secure.h" /* prism_random */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <time.h>

static uint32_t pp_crc32(const uint8_t *b, size_t n) {
    static uint32_t T[256];
    static int ready = 0;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            T[i] = c;
        }
        ready = 1;
    }
    uint32_t c = 0xFFFFFFFFu;
    for (size_t i = 0; i < n; i++) c = T[(c ^ b[i]) & 255] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
}

static uint16_t pp_u16(const uint8_t *a, size_t i) { return (uint16_t)((a[i] << 8) | a[i + 1]); }
static uint32_t pp_u32(const uint8_t *a, size_t i) {
    return ((uint32_t)a[i] << 24) | ((uint32_t)a[i + 1] << 16) | ((uint32_t)a[i + 2] << 8) | a[i + 3];
}
static void pp_put32(uint8_t *a, size_t i, uint32_t v) {
    a[i] = (uint8_t)(v >> 24); a[i + 1] = (uint8_t)(v >> 16);
    a[i + 2] = (uint8_t)(v >> 8); a[i + 3] = (uint8_t)v;
}

/* cleanName: backslash, slash and control bytes become '_', trimmed to 200 chars. */
static size_t pp_clean_name(const char *name, char *out, size_t cap) {
    const char *n = (name && *name) ? name : "file";
    size_t w = 0;
    for (const unsigned char *p = (const unsigned char *)n; *p && w < 200 && w + 1 < cap; p++)
        out[w++] = (*p == '\\' || *p == '/' || *p < 0x20) ? '_' : (char)*p;
    out[w] = 0;
    return w;
}

/* UTF-8 encode then trim to <= 40 bytes without splitting a character
 * (JS: drop bytes from the end, decode, strip trailing U+FFFD, re-encode).
 * Input here is already UTF-8, so trimming on a lead-byte boundary matches. */
static size_t pp_name_bytes(const char *name, char *out) {
    char clean[201];
    size_t n = pp_clean_name(name, clean, sizeof clean);
    if (n > 40) {
        n = 40;
        while (n > 0 && (clean[n] & 0xC0) == 0x80) n--; /* back off to a lead byte */
        if (n > 0 && (clean[n] & 0x80)) {
            /* lead byte of an incomplete sequence at the end: drop it */
            int need = 0;
            unsigned char c = (unsigned char)clean[n];
            if ((c & 0xE0) == 0xC0) need = 2;
            else if ((c & 0xF0) == 0xE0) need = 3;
            else if ((c & 0xF8) == 0xF0) need = 4;
            if (need && n + (size_t)need > 40 + 1) n--; /* sequence would be cut */
        }
    }
    memcpy(out, clean, n);
    out[n] = 0;
    return n;
}

static int pp_overhead(size_t name_len) { return 4 + 4 + 2 + 2 + 4 + 4 + 1 + (int)name_len + 4; }

int prism_parts_plan_calc(size_t len, const char *name, int code_size, prism_parts_plan *plan) {
    char nb[41];
    size_t nl = pp_name_bytes(name, nb);
    int cap = prism_capacity_payload(code_size, PRISM_PARTS_ECC, 0);
    if (cap < 0) return -1;
    int room = cap - pp_overhead(nl);
    if (room < 64) return -1;
    plan->room = room;
    plan->total = (int)((len + (size_t)room - 1) / (size_t)room);
    if (plan->total < 1) plan->total = 1;
    if (plan->total > 65535) return -2; /* file too big for this part size */
    memcpy(plan->name, nb, nl + 1);
    return 0;
}

int prism_parts_split_file(const uint8_t *bytes, size_t len, const char *name, int code_size,
                           prism_parts_split *out) {
    prism_parts_plan plan;
    int rc = prism_parts_plan_calc(len, name, code_size, &plan);
    if (rc) return rc;
    size_t nl = strlen(plan.name);
    uint8_t id[4];
    if (prism_random(id, 4) != 0) return -3; /* prism_secure.c randomness */
    uint32_t whole = pp_crc32(bytes, len);
    out->total = plan.total;
    out->parts = calloc((size_t)plan.total, sizeof(uint8_t *));
    out->lens = calloc((size_t)plan.total, sizeof(size_t));
    if (!out->parts || !out->lens) return -3;
    for (int n = 0; n < plan.total; n++) {
        size_t off = (size_t)n * (size_t)plan.room;
        size_t clen = len - off;
        if (clen > (size_t)plan.room) clen = (size_t)plan.room;
        size_t plen = (size_t)pp_overhead(nl) + clen;
        uint8_t *p = malloc(plen);
        if (!p) { prism_parts_split_free(out); return -3; }
        size_t o = 0;
        memcpy(p, "PPT1", 4); o += 4;
        memcpy(p + o, id, 4); o += 4;
        p[o++] = (uint8_t)((n + 1) >> 8); p[o++] = (uint8_t)(n + 1);
        p[o++] = (uint8_t)(plan.total >> 8); p[o++] = (uint8_t)plan.total;
        pp_put32(p, o, (uint32_t)len); o += 4;
        pp_put32(p, o, whole); o += 4;
        p[o++] = (uint8_t)nl;
        memcpy(p + o, plan.name, nl); o += nl;
        memcpy(p + o, bytes + off, clen); o += clen;
        pp_put32(p, o, pp_crc32(p, o));
        out->parts[n] = p;
        out->lens[n] = plen;
    }
    return 0;
}

void prism_parts_split_free(prism_parts_split *s) {
    if (!s || !s->parts) return;
    for (int i = 0; i < s->total; i++) free(s->parts[i]);
    free(s->parts);
    free(s->lens);
    s->parts = NULL; s->lens = NULL; s->total = 0;
}

int prism_parts_parse(const uint8_t *b, size_t n, prism_part_info *info, const char **bad_msg) {
    if (!b || n < 25 || memcmp(b, "PPT1", 4) != 0) return 0;
    if (pp_crc32(b, n - 4) != pp_u32(b, n - 4)) {
        *bad_msg = "This part failed its own check. Scan it again.";
        return -1;
    }
    for (int i = 0; i < 4; i++) sprintf(info->id + i * 2, "%02x", b[4 + i]);
    info->id[8] = 0;
    info->n = pp_u16(b, 8);
    info->total = pp_u16(b, 10);
    info->len = pp_u32(b, 12);
    info->whole = pp_u32(b, 16);
    size_t nl = b[20];
    if (21 + nl + 4 > n || !info->n || info->n > info->total) {
        *bad_msg = "This part has a broken header.";
        return -1;
    }
    memcpy(info->name, b + 21, nl);
    info->name[nl] = 0;
    info->chunk = b + 21 + nl;
    info->chunk_len = n - 4 - 21 - nl;
    return 1;
}

void prism_assembler_init(prism_assembler *a) {
    memset(a, 0, sizeof *a);
}

void prism_assembler_reset(prism_assembler *a) {
    if (a->chunks) {
        for (int i = 0; i < a->total; i++) free(a->chunks[i]);
        free(a->chunks);
    }
    free(a->chunk_lens);
    memset(a, 0, sizeof *a);
}

int prism_assembler_add(prism_assembler *a, const uint8_t *bytes, size_t n,
                        int *part_n, const char **msg) {
    prism_part_info p;
    const char *bad = NULL;
    int rc = prism_parts_parse(bytes, n, &p, &bad);
    if (rc == 0) return PRISM_PART_NOTPART;
    if (rc < 0) { *msg = bad; return PRISM_PART_BAD; }
    if (!a->started) {
        a->started = 1;
        memcpy(a->id, p.id, 9);
        a->total = p.total;
        a->len = p.len;
        a->whole = p.whole;
        memcpy(a->name, p.name, sizeof a->name);
        a->chunks = calloc((size_t)p.total, sizeof(uint8_t *));
        a->chunk_lens = calloc((size_t)p.total, sizeof(size_t));
        if (!a->chunks || !a->chunk_lens) { *msg = "Out of memory."; return PRISM_PART_BAD; }
    } else if (strcmp(p.id, a->id) != 0) {
        static char buf[128];
        snprintf(buf, sizeof buf, "That part belongs to a different file (%s). Start over to switch.",
                 p.name[0] ? p.name : "unnamed");
        *msg = buf;
        return PRISM_PART_OTHER;
    } else if (p.total != a->total || p.len != a->len || p.whole != a->whole) {
        *msg = "This part does not match the others.";
        return PRISM_PART_BAD;
    }
    *part_n = p.n;
    if (a->chunks[p.n - 1]) return PRISM_PART_DUPLICATE;
    uint8_t *copy = malloc(p.chunk_len ? p.chunk_len : 1);
    if (!copy) { *msg = "Out of memory."; return PRISM_PART_BAD; }
    memcpy(copy, p.chunk, p.chunk_len);
    a->chunks[p.n - 1] = copy;
    a->chunk_lens[p.n - 1] = p.chunk_len;
    a->have++;
    return (a->have == a->total) ? PRISM_PART_COMPLETE : PRISM_PART_NEW;
}

int prism_assembler_finish(prism_assembler *a, uint8_t **out, size_t *out_len,
                           const char **name, const char **reason) {
    static char rbuf[96];
    if (a->have != a->total) { *reason = "Parts are still missing."; return -1; }
    uint8_t *buf = malloc(a->len ? a->len : 1);
    if (!buf) { *reason = "Out of memory."; return -1; }
    size_t o = 0;
    for (int i = 0; i < a->total; i++) {
        size_t c = a->chunk_lens[i];
        if (o + c > a->len) {
            free(buf);
            *reason = "The parts add up to more than the file size.";
            return -1;
        }
        memcpy(buf + o, a->chunks[i], c);
        o += c;
    }
    if (o != a->len) {
        free(buf);
        snprintf(rbuf, sizeof rbuf, "The parts add up to %zu bytes, not %u.", o, a->len);
        *reason = rbuf;
        return -1;
    }
    if (pp_crc32(buf, a->len) != a->whole) {
        free(buf);
        *reason = "The whole-file check failed. Start over and scan the parts again.";
        return -1;
    }
    *out = buf;
    *out_len = a->len;
    *name = a->name[0] ? a->name : "prism-file.bin";
    return 0;
}
