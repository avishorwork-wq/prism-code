/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Tiny CLI for the C11 Prism port. */
#include "prism.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void usage(const char *argv0) {
    fprintf(stderr,
        "Prism Code (C port) - create and read Prism codes. By Avi Shor.\n"
        "\n"
        "Usage:\n"
        "  %s encode (--text TEXT | --file PATH) -o OUT.png [options]\n"
        "  %s decode IN.png [-o OUT.bin]\n"
        "  %s capacity\n"
        "\n"
        "Encode options:\n"
        "  --size N       0..5, or -1 automatic (default -1)\n"
        "  --ecc N        0..3 = 10/20/30/40%% repair data (default 1 = 20%%)\n"
        "  --mode M       color | bw (default color; bw holds ~1/3)\n"
        "  --type T       text | binary (default: text for --text, binary for --file)\n"
        "  --scale N      PNG pixels per cell unit (default 12; live site uses 8/12/20/32)\n"
        "\n"
        "Decode prints text payloads to stdout; with -o it writes raw payload bytes.\n",
        argv0, argv0, argv0);
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
        const char *text = NULL, *file = NULL, *out = NULL;
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
        const char *in = NULL, *out = NULL;
        for (int i = 2; i < argc; i++) {
            if (!strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
            else if (!in) in = argv[i];
            else { usage(argv[0]); return 2; }
        }
        if (!in) { usage(argv[0]); return 2; }
        uint8_t *bytes = NULL; size_t len = 0; int type = 0;
        if (prism_decode_png(in, &bytes, &len, &type, err, sizeof(err))) {
            fprintf(stderr, "error: %s\n", err);
            return 1;
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

    usage(argv[0]);
    return 2;
}
