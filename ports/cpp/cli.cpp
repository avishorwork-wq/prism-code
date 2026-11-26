/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Tiny CLI for the C++17 Prism port. */
#include "prism.hpp"

#include <cstdio>
#include <cstring>
#include <string>

static void usage(const char *argv0) {
    std::fprintf(stderr,
        "Prism Code (C++ port) - create and read Prism codes. By Avi Shor.\n"
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
    if (argc < 2) { usage(argv[0]); return 2; }
    try {
        if (!std::strcmp(argv[1], "capacity")) {
            std::printf("size  cells      color-ecc0  bw-ecc0  (max payload bytes; ecc1/2/3 fit less)\n");
            const char *cells[] = {"21x24","29x33","41x47","57x66","81x94","113x130"};
            for (int s = 0; s < 6; s++)
                std::printf("%d     %-10s %-11d %-8d\n", s, cells[s],
                            prism::capacityPayload(s, 0, prism::MODE_COLOR),
                            prism::capacityPayload(s, 0, prism::MODE_BW));
            return 0;
        }
        if (!std::strcmp(argv[1], "encode")) {
            std::string text, file, out;
            bool hasText = false, hasFile = false;
            int size = -1, ecc = 1, mode = prism::MODE_COLOR, type = -1, scale = 12;
            for (int i = 2; i < argc; i++) {
                std::string a = argv[i];
                auto next = [&](const char *name) -> std::string {
                    if (i + 1 >= argc) throw prism::Error(std::string("missing value for ") + name);
                    return argv[++i];
                };
                if (a == "--text") { text = next("--text"); hasText = true; }
                else if (a == "--file") { file = next("--file"); hasFile = true; }
                else if (a == "-o") out = next("-o");
                else if (a == "--size") size = std::stoi(next("--size"));
                else if (a == "--ecc") ecc = std::stoi(next("--ecc"));
                else if (a == "--scale") scale = std::stoi(next("--scale"));
                else if (a == "--mode") mode = next("--mode") == "bw" ? prism::MODE_BW : prism::MODE_COLOR;
                else if (a == "--type") type = next("--type") == "binary" ? prism::TYPE_BINARY : prism::TYPE_TEXT;
                else { usage(argv[0]); return 2; }
            }
            if ((!hasText && !hasFile) || out.empty()) { usage(argv[0]); return 2; }
            std::vector<uint8_t> data;
            if (hasFile) {
                FILE *f = std::fopen(file.c_str(), "rb");
                if (!f) throw prism::Error("cannot open " + file);
                std::fseek(f, 0, SEEK_END);
                long fl = std::ftell(f);
                std::fseek(f, 0, SEEK_SET);
                data.resize((size_t)fl);
                if (fl && std::fread(data.data(), 1, (size_t)fl, f) != (size_t)fl) { std::fclose(f); throw prism::Error("cannot read " + file); }
                std::fclose(f);
                if (type < 0) type = prism::TYPE_BINARY;
            } else {
                data.assign(text.begin(), text.end());
                if (type < 0) type = prism::TYPE_TEXT;
            }
            prism::encodePng(data, out, size, ecc, mode, type, scale);
            std::printf("wrote %s (%zu payload bytes)\n", out.c_str(), data.size());
            return 0;
        }
        if (!std::strcmp(argv[1], "decode")) {
            std::string in, out;
            for (int i = 2; i < argc; i++) {
                std::string a = argv[i];
                if (a == "-o" && i + 1 < argc) out = argv[++i];
                else if (in.empty()) in = a;
                else { usage(argv[0]); return 2; }
            }
            if (in.empty()) { usage(argv[0]); return 2; }
            prism::DecodeResult res = prism::decodePng(in);
            if (!out.empty()) {
                FILE *f = std::fopen(out.c_str(), "wb");
                if (!f) throw prism::Error("cannot open " + out);
                if (!res.bytes.empty() && std::fwrite(res.bytes.data(), 1, res.bytes.size(), f) != res.bytes.size()) {
                    std::fclose(f); throw prism::Error("cannot write " + out);
                }
                std::fclose(f);
                std::printf("wrote %s (%zu payload bytes, %s)\n", out.c_str(), res.bytes.size(),
                            res.type == prism::TYPE_TEXT ? "text" : "binary");
            } else if (res.type == prism::TYPE_TEXT) {
                std::fwrite(res.bytes.data(), 1, res.bytes.size(), stdout);
                std::fputc('\n', stdout);
            } else {
                std::printf("(%zu binary payload bytes; use -o OUT.bin to save)\n", res.bytes.size());
            }
            return 0;
        }
        usage(argv[0]);
        return 2;
    } catch (const prism::Error &e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}
