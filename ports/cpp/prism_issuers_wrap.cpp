/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ wrapper over the C Prism issuers core. */
#include "prism_issuers.hpp"
extern "C" {
#include "prism_issuers.h"
}
#include <cstdlib>

namespace prism {

bool issuerIdentify(const std::vector<uint8_t>& bytes, IssuerIdentity& out) {
    prism_issuer_id id;
    if (!prism_issuer_identify(bytes.data(), bytes.size(), &id)) return false;
    out.signatureValid = id.signature_valid != 0;
    out.fingerprint = id.fingerprint;
    out.encrypted = id.encrypted != 0;
    out.hasMessage = id.message != nullptr;
    if (id.message) {
        out.message = id.message;
        free(id.message);
    }
    return true;
}

std::vector<Issuer> issuersLoad(const std::string& path) {
    prism_issuer* list = nullptr;
    int n = prism_issuers_load(path.c_str(), &list);
    std::vector<Issuer> out;
    out.reserve((size_t)n);
    for (int i = 0; i < n; i++)
        out.push_back({list[i].name ? list[i].name : "", list[i].fingerprint ? list[i].fingerprint : ""});
    prism_issuers_free(list, n);
    return out;
}

const Issuer* issuersFind(const std::vector<Issuer>& list, const std::string& fingerprint) {
    auto norm = [](const std::string& s) {
        std::string r;
        for (char c : s)
            if (isxdigit((unsigned char)c)) r += (char)toupper((unsigned char)c);
        return r;
    };
    std::string want = norm(fingerprint);
    for (const auto& it : list)
        if (norm(it.fingerprint) == want) return &it;
    return nullptr;
}

} // namespace prism
