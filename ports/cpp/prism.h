/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C11 port of the live Prism Code format (encoder + clean-image decoder).
 * Compatible with the live JavaScript implementation at
 * https://avishorwork-wq.github.io/prism-code/ (repo: avishorwork-wq/prism-code). */
#ifndef PRISM_H
#define PRISM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define PRISM_MODE_COLOR 0
#define PRISM_MODE_BW    1
#define PRISM_TYPE_TEXT   0
#define PRISM_TYPE_BINARY 1

/* Encode payload bytes into a Prism code and write a PNG file.
 * size: -1 = automatic (grows to fit), or 0..5. ecc: 0..3 (10/20/30/40% repair data).
 * mode: PRISM_MODE_COLOR or PRISM_MODE_BW. type: PRISM_TYPE_TEXT or PRISM_TYPE_BINARY.
 * scale: pixels per cell unit (live default 12).
 * Returns 0 on success, -1 on error (err filled). */
int prism_encode_png(const uint8_t *data, size_t len, int size, int ecc, int mode,
                     int type, int scale, const char *out_png, char *err, size_t errlen);

/* Encode to an in-memory RGBA image. Caller frees *out_rgba with free().
 * *out_w/*out_h receive pixel dimensions. Returns 0 on success, -1 on error. */
int prism_encode_rgba(const uint8_t *data, size_t len, int size, int ecc, int mode,
                      int type, int scale, uint8_t **out_rgba, int *out_w, int *out_h,
                      char *err, size_t errlen);

/* Decode a Prism code from a clean PNG (one produced by an encoder; this is not
 * the robust camera pipeline). On success returns 0, *out_bytes (caller frees)
 * and *out_len hold the payload, *out_type the payload type (0 text, 1 binary).
 * Returns -1 on error (err filled). */
int prism_decode_png(const char *in_png, uint8_t **out_bytes, size_t *out_len,
                     int *out_type, char *err, size_t errlen);

/* Maximum payload bytes for a given size/ecc/mode (payload excludes the CRC). */
int prism_capacity_payload(int size, int ecc, int mode);

#ifdef __cplusplus
}
#endif

#endif /* PRISM_H */
