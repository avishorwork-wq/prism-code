/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism big files in parts (PPT1), byte-compatible with prism-parts.js. */
#ifndef PRISM_PARTS_H
#define PRISM_PARTS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
 * total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
 * name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
 * byte before it). Parts are encoded at ecc level 2 (30%) in color mode. */
#define PRISM_PARTS_ECC 2

typedef struct {
    int room;      /* chunk bytes per part */
    int total;     /* number of parts */
    char name[41]; /* cleaned, <= 40 UTF-8 bytes */
} prism_parts_plan;

/* Plans a split for a code size (2..5 like the site; any valid size works).
 * Returns 0 on success, -1 if the part size leaves < 64 bytes of room. */
int prism_parts_plan_calc(size_t len, const char *name, int code_size, prism_parts_plan *plan);

typedef struct {
    uint8_t **parts;   /* array of total buffers, caller frees each + array */
    size_t *lens;
    int total;
} prism_parts_split;

/* Splits bytes into PPT1 part payloads. Returns 0 on success. */
int prism_parts_split_file(const uint8_t *bytes, size_t len, const char *name, int code_size,
                           prism_parts_split *out);
void prism_parts_split_free(prism_parts_split *s);

typedef struct {
    char id[9];        /* 4-byte file id, hex */
    int n, total;
    uint32_t len;      /* whole file length */
    uint32_t whole;    /* whole file CRC-32 */
    char name[41];
    const uint8_t *chunk; /* points into the parsed buffer */
    size_t chunk_len;
} prism_part_info;

/* Parses one part payload. Returns 1 if it is a valid part, 0 if it is not a
 * part at all, -1 if it is a damaged part (bad_msg set, like the site's
 * {bad: ...}). */
int prism_parts_parse(const uint8_t *b, size_t n, prism_part_info *info, const char **bad_msg);

typedef struct {
    char id[9];
    int total;
    uint32_t len, whole;
    char name[41];
    uint8_t **chunks;  /* [total], NULL until that part arrives */
    size_t *chunk_lens;
    int have;
    int started;
} prism_assembler;

void prism_assembler_init(prism_assembler *a);
void prism_assembler_reset(prism_assembler *a); /* frees stored chunks */

/* Return status like the site: */
enum {
    PRISM_PART_NOTPART = 0, /* payload is not a part */
    PRISM_PART_BAD,         /* damaged/mismatched part (msg set) */
    PRISM_PART_OTHER,       /* belongs to a different file (msg set) */
    PRISM_PART_DUPLICATE,
    PRISM_PART_NEW,
    PRISM_PART_COMPLETE     /* last part; assembler holds all chunks */
};
int prism_assembler_add(prism_assembler *a, const uint8_t *bytes, size_t n,
                        int *part_n, const char **msg);

/* After PRISM_PART_COMPLETE: rebuild + verify. Returns 0 on success and a
 * malloc'd buffer in *out (caller frees), -1 with *reason on failure. */
int prism_assembler_finish(prism_assembler *a, uint8_t **out, size_t *out_len,
                           const char **name, const char **reason);

#ifdef __cplusplus
}
#endif

#endif
