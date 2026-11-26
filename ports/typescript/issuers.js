"use strict";
// Prism verified issuers for the TypeScript port: identify signed Prism
// Secure payloads and look the signer up in an issuer list, same semantics
// as prism-issuers.js and the C/Go/Kotlin/Rust/PHP/Ruby ports.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.identify = identify;
exports.load = load;
exports.normFp = normFp;
exports.findIndex = findIndex;
const fs = __importStar(require("fs"));
const secure_1 = require("./secure");
// identify inspects decoded payload bytes. Returns null for plain or
// unsigned payloads. Never decrypts.
function identify(b) {
    if (b.length < 5 + 65 + 64)
        return null;
    if (b[0] !== 0x50 || b[1] !== 0x53 || b[2] !== 0x43)
        return null; // "PSC"
    const v = b[3];
    if (v !== 1 && v !== 2)
        return null;
    if ((b[4] & 2) === 0)
        return null;
    const finish = b.length;
    const pub = Buffer.from(b.subarray(finish - 129, finish - 64));
    const sig = Buffer.from(b.subarray(finish - 64, finish));
    const body = b.subarray(0, finish - 129);
    const out = {
        signatureValid: (0, secure_1.p256Verify)(pub, body, sig),
        fingerprint: (0, secure_1.fingerprint)(pub),
        encrypted: (b[4] & 1) !== 0,
        message: "",
        hasMessage: false,
    };
    if (out.signatureValid && !out.encrypted && body.length >= 5) {
        const m = body.subarray(5);
        const s = m.toString("utf8");
        // valid UTF-8 round-trip check
        if (Buffer.from(s, "utf8").equals(Buffer.from(m))) {
            out.message = s;
            out.hasMessage = true;
        }
    }
    return out;
}
// load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
function load(path) {
    try {
        const data = fs.readFileSync(path);
        if (data.length > 1 << 20)
            return [];
        const doc = JSON.parse(data.toString("utf8"));
        if (typeof doc !== "object" || doc === null || !Array.isArray(doc.issuers))
            return [];
        const out = [];
        for (const it of doc.issuers) {
            if (typeof it === "object" && it !== null && it.name && it.fingerprint) {
                out.push({ name: String(it.name), fingerprint: String(it.fingerprint) });
            }
        }
        return out;
    }
    catch {
        return [];
    }
}
function normFp(fp) {
    let b = "";
    for (const c of fp) {
        if (b.length >= 15)
            break;
        if (/[0-9a-fA-F]/.test(c))
            b += c.toUpperCase();
    }
    return b;
}
// findIndex: normalized fingerprint match (case-insensitive, separators ignored).
function findIndex(list, fingerprint_) {
    const want = normFp(fingerprint_);
    for (let i = 0; i < list.length; i++) {
        if (normFp(list[i].fingerprint) === want)
            return i;
    }
    return -1;
}
