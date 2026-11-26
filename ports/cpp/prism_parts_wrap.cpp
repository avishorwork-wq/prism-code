/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ wrapper over the C Prism parts core. */
#include "prism_parts.hpp"
#include "prism.hpp" // prism::Error
#include <cstring>

namespace prism {

PartsPlan partsPlan(size_t len, const std::string& name, int codeSize) {
    prism_parts_plan p;
    int rc = prism_parts_plan_calc(len, name.c_str(), codeSize, &p);
    if (rc == -1) throw Error("Part size too small");
    if (rc == -2) throw Error("File is too big for this part size");
    if (rc) throw Error("Invalid code size");
    return {p.room, p.total, p.name};
}

std::vector<std::vector<uint8_t>> partsSplit(const std::vector<uint8_t>& bytes,
                                             const std::string& name, int codeSize) {
    prism_parts_split s;
    int rc = prism_parts_split_file(bytes.data(), bytes.size(), name.c_str(), codeSize, &s);
    if (rc == -1) throw Error("Part size too small");
    if (rc == -2) throw Error("File is too big for this part size");
    if (rc) throw Error("Split failed");
    std::vector<std::vector<uint8_t>> out;
    out.reserve((size_t)s.total);
    for (int i = 0; i < s.total; i++)
        out.emplace_back(s.parts[i], s.parts[i] + s.lens[i]);
    prism_parts_split_free(&s);
    return out;
}

PartParse partsParse(const std::vector<uint8_t>& bytes) {
    PartParse r;
    prism_part_info info;
    const char* bad = nullptr;
    int rc = prism_parts_parse(bytes.data(), bytes.size(), &info, &bad);
    if (rc == 0) { r.notPart = true; return r; }
    if (rc < 0) { r.bad = bad; return r; }
    r.ok = true;
    r.info.id = info.id;
    r.info.n = info.n;
    r.info.total = info.total;
    r.info.len = info.len;
    r.info.whole = info.whole;
    r.info.name = info.name;
    r.info.chunk.assign(info.chunk, info.chunk + info.chunk_len);
    return r;
}

Assembler::AddResult Assembler::add(const std::vector<uint8_t>& bytes) {
    int pn = 0;
    const char* msg = nullptr;
    int st = prism_assembler_add(&a_, bytes.data(), bytes.size(), &pn, &msg);
    if (a_.started) { started_ = true; total_ = a_.total; name_ = a_.name; }
    AddResult r;
    r.n = pn;
    r.message = msg ? msg : "";
    switch (st) {
        case PRISM_PART_NOTPART: r.status = NotPart; break;
        case PRISM_PART_BAD: r.status = Bad; break;
        case PRISM_PART_OTHER: r.status = OtherFile; break;
        case PRISM_PART_DUPLICATE: r.status = Duplicate; break;
        case PRISM_PART_NEW: r.status = New; break;
        default: r.status = Complete; break;
    }
    return r;
}

int Assembler::have() const { return a_.have; }

std::vector<uint8_t> Assembler::finish() {
    uint8_t* out = nullptr;
    size_t olen = 0;
    const char* name = nullptr;
    const char* reason = nullptr;
    if (prism_assembler_finish(&a_, &out, &olen, &name, &reason))
        throw Error(reason ? reason : "Assembly failed");
    std::vector<uint8_t> v(out, out + olen);
    free(out);
    return v;
}

} // namespace prism
