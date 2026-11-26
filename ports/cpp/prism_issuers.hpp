/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ API over the C core of Prism verified issuers.
 * Same semantics as prism-issuers.js. */
#ifndef PRISM_ISSUERS_HPP
#define PRISM_ISSUERS_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace prism {

struct IssuerIdentity {
    bool signatureValid = false;
    std::string fingerprint; // "XXXX-XXXX-XXXX-XXXX"
    bool encrypted = false;
    bool hasMessage = false; // valid, unencrypted, UTF-8 payload
    std::string message;
};

// Identifies a signed Prism Secure payload. Returns false for plain or
// unsigned payloads. Never decrypts.
bool issuerIdentify(const std::vector<uint8_t>& bytes, IssuerIdentity& out);

struct Issuer {
    std::string name, fingerprint;
};

// Loads an issuers.json file (empty vector when missing or damaged).
std::vector<Issuer> issuersLoad(const std::string& path);

// Normalized fingerprint match; nullptr when not listed.
const Issuer* issuersFind(const std::vector<Issuer>& list, const std::string& fingerprint);

} // namespace prism

#endif
