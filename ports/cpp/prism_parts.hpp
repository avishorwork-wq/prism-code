/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ API over the C core of Prism big files in parts (PPT1).
 * Byte-compatible with prism-parts.js. */
#ifndef PRISM_PARTS_HPP
#define PRISM_PARTS_HPP

#include <cstdint>
#include <string>
#include <vector>

#include "prism_parts.h"

namespace prism {

struct PartsPlan {
    int room = 0;   // chunk bytes per part
    int total = 0;  // number of parts
    std::string name; // cleaned, <= 40 UTF-8 bytes
};

// Plans a split for a code size (2..5 like the site; any valid size works).
// Throws prism::Error when the part size leaves < 64 bytes of room or the
// file needs more than 65535 parts.
PartsPlan partsPlan(size_t len, const std::string& name, int codeSize);

// Splits bytes into PPT1 part payloads (encode each at ecc 2, color mode).
std::vector<std::vector<uint8_t>> partsSplit(const std::vector<uint8_t>& bytes,
                                             const std::string& name, int codeSize);

struct PartInfo {
    std::string id;   // 4-byte file id, hex
    int n = 0, total = 0;
    uint32_t len = 0, whole = 0;
    std::string name;
    std::vector<uint8_t> chunk;
};

// Parse one part payload. ok=false + notPart=true when it is not a part;
// ok=false + bad set when it is a damaged part (message matches the site).
struct PartParse {
    bool ok = false;
    bool notPart = false;
    std::string bad;
    PartInfo info;
};
PartParse partsParse(const std::vector<uint8_t>& bytes);

// Reassembles parts, same states and messages as the site's Assembler.
class Assembler {
public:
    Assembler() { prism_assembler_init(&a_); }
    ~Assembler() { prism_assembler_reset(&a_); }
    Assembler(const Assembler&) = delete;
    Assembler& operator=(const Assembler&) = delete;
    enum Status { NotPart, Bad, OtherFile, Duplicate, New, Complete };
    struct AddResult {
        Status status;
        int n = 0;
        std::string message; // set for Bad/OtherFile
    };
    AddResult add(const std::vector<uint8_t>& bytes);
    int have() const;
    int total() const { return total_; }
    // After Complete: verifies length and whole-file CRC. Throws prism::Error
    // with the site's reason text on failure.
    std::vector<uint8_t> finish();
    const std::string& name() const { return name_; }
private:
    prism_assembler a_{};
    bool started_ = false;
    int total_ = 0;
    std::string name_;
};

} // namespace prism

#endif
