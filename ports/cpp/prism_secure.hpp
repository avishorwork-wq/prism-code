/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ API over the proven C core of Prism Secure (envelope v2, reads v1).
 * Byte-compatible with the live site. */
#ifndef PRISM_SECURE_HPP
#define PRISM_SECURE_HPP

#include <array>
#include <cstdint>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

namespace prism {

struct SigningKey {
    std::array<uint8_t, 32> priv{};
    std::array<uint8_t, 65> pub{};
};

SigningKey generateSigningKey();
std::string fingerprint(const std::array<uint8_t, 65>& pub); // "XXXX-XXXX-XXXX-XXXX"
std::string generatePassphrase();                            // 7x4 chars, 140 bits
// bits, level 0-4, label
std::tuple<int, int, std::string> secureStrength(const std::string& pw);

bool secureIsSecure(const std::vector<uint8_t>& data);
// encrypted, signed
std::pair<bool, bool> secureInspect(const std::vector<uint8_t>& data);

// Seal: password non-empty locks (kdf "argon2id" or "pbkdf2"); key signs.
// At least one of the two. Throws PrismError on misuse.
std::vector<uint8_t> secureSeal(const std::vector<uint8_t>& data,
                                const std::string& password = "",
                                const std::string& kdf = "argon2id",
                                const SigningKey* signWith = nullptr);

struct SecureResult {
    bool secure = false;
    int version = 0;
    bool encrypted = false, signed_ = false;
    int signatureValid = -1; // -1 n/a, 0 invalid, 1 valid
    std::string signerFingerprint;
    bool trusted = false;
    std::vector<uint8_t> bytes; // empty + error set on failure
    bool needsPassword = false;
    std::string error;
    bool ok() const { return !error.size() || bytes.size() || needsPassword; }
};

SecureResult secureOpen(const std::vector<uint8_t>& data,
                        const std::string& password = "",
                        const std::vector<std::string>& trustedFingerprints = {});

} // namespace prism

#endif
