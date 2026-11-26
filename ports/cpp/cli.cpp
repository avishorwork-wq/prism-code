/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Tiny CLI for the C++17 Prism port. */
#include "prism.hpp"
#include "prism_secure.hpp"

#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

/* base64url (no padding) for the site's JWK key files */
static std::string b64u_enc(const uint8_t *in, size_t n) {
    static const char A[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string out;
    for (size_t i = 0; i < n; i += 3) {
        unsigned v = in[i] << 16 | (i+1 < n ? in[i+1] << 8 : 0) | (i+2 < n ? in[i+2] : 0);
        out += A[v >> 18 & 63]; out += A[v >> 12 & 63];
        if (i+1 < n) out += A[v >> 6 & 63];
        if (i+2 < n) out += A[v & 63];
    }
    return out;
}
static bool b64u_dec(const std::string &in, uint8_t *out, size_t want) {
    size_t p = 0;
    for (size_t i = 0; i < in.size(); i += 4) {
        unsigned v = 0; int cnt = 0;
        for (int j = 0; j < 4 && i + j < in.size(); j++) {
            char c = in[i+j]; int d = -1;
            if (c >= 'A' && c <= 'Z') d = c - 'A';
            else if (c >= 'a' && c <= 'z') d = c - 'a' + 26;
            else if (c >= '0' && c <= '9') d = c - '0' + 52;
            else if (c == '-' || c == '+') d = 62;
            else if (c == '_' || c == '/') d = 63;
            if (d < 0) return false;
            v = v << 6 | (unsigned)d; cnt++;
        }
        v <<= (4 - cnt) * 6;
        if (p < want) out[p++] = (uint8_t)(v >> 16);
        if (cnt > 2 && p < want) out[p++] = (uint8_t)(v >> 8);
        if (cnt > 3 && p < want) out[p++] = (uint8_t)v;
    }
    return p == want;
}
static std::string json_str(const std::string &json, const std::string &name) {
    for (const char *sep : { "\":\"", "\": \"" }) {
        std::string needle = "\"" + name + sep;
        size_t i = json.find(needle);
        if (i == std::string::npos) continue;
        i += needle.size();
        size_t j = json.find('"', i);
        if (j != std::string::npos) return json.substr(i, j - i);
    }
    throw prism::Error("bad key file");
}
static std::string read_all(const std::string &path) {
    FILE *f = std::fopen(path.c_str(), "rb");
    if (!f) throw prism::Error("cannot open " + path);
    std::string s;
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
    std::fclose(f);
    return s;
}
static prism::SigningKey load_key(const std::string &path) {
    std::string json = read_all(path);
    std::string hex = json_str(json, "publicKeyHex");
    if (hex.size() != 130) throw prism::Error("bad key file");
    prism::SigningKey k;
    for (int i = 0; i < 65; i++)
        k.pub[i] = (uint8_t)std::stoul(hex.substr((size_t)i * 2, 2), nullptr, 16);
    if (!b64u_dec(json_str(json, "d"), k.priv.data(), 32)) throw prism::Error("bad key file");
    return k;
}
static void save_key(const std::string &path, const prism::SigningKey &k) {
    FILE *f = std::fopen(path.c_str(), "wb");
    if (!f) throw prism::Error("cannot write " + path);
    std::fprintf(f, "{\"publicKeyHex\":\"");
    for (int i = 0; i < 65; i++) std::fprintf(f, "%02x", k.pub[i]);
    std::fprintf(f, "\",\"privateJwk\":{\"crv\":\"P-256\",\"d\":\"%s\",\"kty\":\"EC\",\"x\":\"%s\",\"y\":\"%s\"}}\n",
                 b64u_enc(k.priv.data(), 32).c_str(),
                 b64u_enc(k.pub.data() + 1, 32).c_str(),
                 b64u_enc(k.pub.data() + 33, 32).c_str());
    std::fclose(f);
}

static void usage(const char *argv0) {
    std::fprintf(stderr,
        "Prism Code (C++ port) - create and read Prism codes. By Avi Shor.\n"
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
            std::string text, file, out, password, keyf;
            std::string kdf = "argon2id";
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
                else if (a == "--password") password = next("--password");
                else if (a == "--kdf") kdf = next("--kdf");
                else if (a == "--sign-key") keyf = next("--sign-key");
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
            if (!password.empty() || !keyf.empty()) {
                prism::SigningKey key;
                prism::SigningKey *kp = nullptr;
                if (!keyf.empty()) { key = load_key(keyf); kp = &key; }
                data = prism::secureSeal(data, password, kdf, kp);
                type = prism::TYPE_BINARY;
            }
            prism::encodePng(data, out, size, ecc, mode, type, scale);
            std::printf("wrote %s (%zu payload bytes)\n", out.c_str(), data.size());
            return 0;
        }
        if (!std::strcmp(argv[1], "decode")) {
            std::string in, out, password;
            for (int i = 2; i < argc; i++) {
                std::string a = argv[i];
                if (a == "-o" && i + 1 < argc) out = argv[++i];
                else if (a == "--password" && i + 1 < argc) password = argv[++i];
                else if (in.empty()) in = a;
                else { usage(argv[0]); return 2; }
            }
            if (in.empty()) { usage(argv[0]); return 2; }
            prism::DecodeResult res = prism::decodePng(in);
            if (prism::secureIsSecure(res.bytes)) {
                prism::SecureResult opened = prism::secureOpen(res.bytes, password);
                if (opened.signatureValid == 0) throw prism::Error(opened.error);
                if (opened.bytes.empty() && (opened.error.size() || opened.needsPassword))
                    throw prism::Error(opened.error.size() ? opened.error : "this code is locked; pass --password");
                if (opened.signed_)
                    std::fprintf(stderr, "signature: valid, signer %s\n", opened.signerFingerprint.c_str());
                res.bytes = opened.bytes;
                res.type = prism::TYPE_TEXT;
            }
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
        if (!std::strcmp(argv[1], "secure-genkey")) {
            std::string out;
            for (int i = 2; i < argc; i++)
                if (!std::strcmp(argv[i], "-o") && i + 1 < argc) out = argv[++i];
            prism::SigningKey k = prism::generateSigningKey();
            std::printf("fingerprint: %s\n", prism::fingerprint(k.pub).c_str());
            if (!out.empty()) { save_key(out, k); std::printf("wrote %s\n", out.c_str()); }
            return 0;
        }
        if (!std::strcmp(argv[1], "secure-seal") || !std::strcmp(argv[1], "secure-open")) {
            std::string in, out, password, keyf, kdf = "argon2id";
            for (int i = 2; i < argc; i++) {
                std::string a = argv[i];
                auto next = [&](const char *name) -> std::string {
                    if (i + 1 >= argc) throw prism::Error(std::string("missing value for ") + name);
                    return argv[++i];
                };
                if (a == "-o") out = next("-o");
                else if (a == "--password") password = next("--password");
                else if (a == "--kdf") kdf = next("--kdf");
                else if (a == "--sign-key") keyf = next("--sign-key");
                else if (in.empty()) in = a;
                else { usage(argv[0]); return 2; }
            }
            if (in.empty()) { usage(argv[0]); return 2; }
            std::string raw = read_all(in);
            std::vector<uint8_t> data(raw.begin(), raw.end());
            if (!std::strcmp(argv[1], "secure-seal")) {
                prism::SigningKey key;
                prism::SigningKey *kp = nullptr;
                if (!keyf.empty()) { key = load_key(keyf); kp = &key; }
                std::vector<uint8_t> sealed = prism::secureSeal(data, password, kdf, kp);
                if (!out.empty()) {
                    FILE *f = std::fopen(out.c_str(), "wb");
                    if (!f) throw prism::Error("cannot write " + out);
                    std::fwrite(sealed.data(), 1, sealed.size(), f);
                    std::fclose(f);
                    std::printf("wrote %s (%zu -> %zu bytes)\n", out.c_str(), data.size(), sealed.size());
                } else std::fwrite(sealed.data(), 1, sealed.size(), stdout);
                return 0;
            }
            prism::SecureResult r = prism::secureOpen(data, password);
            if (r.signatureValid == 0) throw prism::Error(r.error);
            if (r.bytes.empty() && (r.error.size() || r.needsPassword))
                throw prism::Error(r.error.size() ? r.error : "needs a password");
            if (r.signed_) std::fprintf(stderr, "signature: valid, signer %s\n", r.signerFingerprint.c_str());
            if (!out.empty()) {
                FILE *f = std::fopen(out.c_str(), "wb");
                if (!f) throw prism::Error("cannot write " + out);
                if (!r.bytes.empty()) std::fwrite(r.bytes.data(), 1, r.bytes.size(), f);
                std::fclose(f);
                std::printf("wrote %s (%zu bytes)\n", out.c_str(), r.bytes.size());
            } else { std::fwrite(r.bytes.data(), 1, r.bytes.size(), stdout); std::fputc('\n', stdout); }
            return 0;
        }
        usage(argv[0]);
        return 2;
    } catch (const prism::Error &e) {
        std::fprintf(stderr, "error: %s\n", e.what());
        return 1;
    }
}
