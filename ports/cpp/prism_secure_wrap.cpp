/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ wrapper over the C Prism Secure core. */
#include "prism_secure.hpp"
#include "prism.hpp" // prism::Error
#include "prism_secure.h"
#include <cstring>

namespace prism {

SigningKey generateSigningKey() {
    SigningKey k;
    if (prism_secure_generate_signing_key(k.priv.data(), k.pub.data()))
        throw Error("no randomness source");
    return k;
}

std::string fingerprint(const std::array<uint8_t, 65>& pub) {
    char out[24];
    prism_fingerprint(pub.data(), out);
    return out;
}

std::string generatePassphrase() {
    char out[35];
    if (prism_secure_generate_passphrase(out)) throw Error("no randomness source");
    return out;
}

std::tuple<int, int, std::string> secureStrength(const std::string& pw) {
    int bits, level; const char* label;
    prism_secure_strength(pw.c_str(), &bits, &level, &label);
    return { bits, level, label };
}

bool secureIsSecure(const std::vector<uint8_t>& d) {
    return prism_secure_is_secure(d.data(), d.size()) != 0;
}

std::pair<bool, bool> secureInspect(const std::vector<uint8_t>& d) {
    int e = 0, s = 0;
    prism_secure_inspect(d.data(), d.size(), &e, &s);
    return { e != 0, s != 0 };
}

std::vector<uint8_t> secureSeal(const std::vector<uint8_t>& data,
                                const std::string& password,
                                const std::string& kdf,
                                const SigningKey* signWith) {
    if (password.empty() && !signWith) throw Error("Give a password, a signing key, or both");
    uint8_t* out = nullptr; size_t outlen = 0;
    int rc = prism_secure_seal(data.data(), data.size(),
                               password.empty() ? nullptr : password.c_str(), kdf.c_str(),
                               signWith ? signWith->priv.data() : nullptr,
                               signWith ? signWith->pub.data() : nullptr,
                               &out, &outlen);
    if (rc) throw Error("sealing failed");
    std::vector<uint8_t> r(out, out + outlen);
    std::free(out);
    return r;
}

SecureResult secureOpen(const std::vector<uint8_t>& data,
                        const std::string& password,
                        const std::vector<std::string>& trustedFingerprints) {
    std::vector<const char*> tfps;
    for (auto& f : trustedFingerprints) tfps.push_back(f.c_str());
    prism_secure_result cr;
    prism_secure_open(data.data(), data.size(),
                      password.empty() ? nullptr : password.c_str(),
                      tfps.empty() ? nullptr : tfps.data(), (int)tfps.size(), &cr);
    SecureResult r;
    r.secure = cr.secure != 0;
    r.version = cr.version;
    r.encrypted = cr.encrypted != 0;
    r.signed_ = cr.signed_ != 0;
    r.signatureValid = cr.signature_valid;
    if (cr.signer_fingerprint[0]) r.signerFingerprint = cr.signer_fingerprint;
    r.trusted = cr.trusted != 0;
    r.needsPassword = cr.needs_password != 0;
    if (cr.error[0]) r.error = cr.error;
    if (cr.bytes) {
        r.bytes.assign(cr.bytes, cr.bytes + cr.bytes_len);
        std::free(cr.bytes);
    }
    return r;
}

} // namespace prism
