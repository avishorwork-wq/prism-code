"use strict";
// Prism big files in parts (PPT1) for the TypeScript port, byte-compatible
// with prism-parts.js and the C/Go/Kotlin/Rust/PHP/Ruby ports.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.
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
exports.Assembler = exports.COMPLETE = exports.NEW = exports.DUPLICATE = exports.OTHER = exports.BAD = exports.NOT_PART = exports.PARTS_ECC = void 0;
exports.overhead = overhead;
exports.cleanName = cleanName;
exports.nameBytes = nameBytes;
exports.plan = plan;
exports.split = split;
exports.parse = parse;
const crypto = __importStar(require("crypto"));
const prism_1 = require("./prism");
exports.PARTS_ECC = 2;
exports.NOT_PART = 0;
exports.BAD = 1;
exports.OTHER = 2;
exports.DUPLICATE = 3;
exports.NEW = 4;
exports.COMPLETE = 5;
function overhead(nameLen) {
    return 4 + 4 + 2 + 2 + 4 + 4 + 1 + nameLen + 4;
}
// clean_name: backslash, slash and control bytes become '_', trimmed to 200 bytes.
function cleanName(name) {
    const src = name.length === 0 ? "file" : name;
    const out = [];
    for (const c of Buffer.from(src, "utf8")) {
        if (out.length >= 200)
            break;
        out.push(c === 0x5c || c === 0x2f || c < 0x20 ? 0x5f : c);
    }
    return Buffer.from(out);
}
// nameBytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
function nameBytes(name) {
    const clean = cleanName(name);
    let n = clean.length;
    if (n > 40) {
        n = 40;
        while (n > 0 && (clean[n] & 0xc0) === 0x80)
            n -= 1; // back off to a lead byte
        if (n > 0 && (clean[n] & 0x80) !== 0) {
            const c = clean[n];
            const need = (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 0;
            if (need !== 0 && n + need > 41)
                n -= 1;
        }
    }
    return clean.subarray(0, n);
}
function plan(length, name, codeSize) {
    const nb = nameBytes(name);
    const cap = (0, prism_1.capacity)(codeSize, exports.PARTS_ECC, 0);
    const room = cap.payload - overhead(nb.length);
    if (room < 64)
        throw new Error("part size leaves < 64 bytes of room");
    let total = Math.floor((length + room - 1) / room);
    if (total < 1)
        total = 1;
    if (total > 65535)
        throw new Error("file too big for this part size");
    return { room, total, name: nb };
}
// split splits bytes into PPT1 part payloads.
function split(data, name, codeSize) {
    const pl = plan(data.length, name, codeSize);
    const id = crypto.randomBytes(4);
    const whole = (0, prism_1.crc32)(new Uint8Array(data));
    const parts = [];
    for (let i = 0; i < pl.total; i++) {
        const off = i * pl.room;
        const clen = Math.min(data.length - off, pl.room);
        const head = Buffer.alloc(21);
        head.write("PPT1", 0, "latin1");
        id.copy(head, 4);
        head.writeUInt16BE(i + 1, 8);
        head.writeUInt16BE(pl.total, 10);
        head.writeUInt32BE(data.length, 12);
        head.writeUInt32BE(whole >>> 0, 16);
        head[20] = pl.name.length;
        let p = Buffer.concat([head, pl.name, data.subarray(off, off + clen)]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE((0, prism_1.crc32)(new Uint8Array(p)) >>> 0);
        p = Buffer.concat([p, crc]);
        parts.push(p);
    }
    return parts;
}
// parse parses one part payload. Returns null = not a part; throws on damage.
function parse(b) {
    if (b.length < 25 || b.toString("latin1", 0, 4) !== "PPT1")
        return null;
    if (((0, prism_1.crc32)(new Uint8Array(b.subarray(0, b.length - 4))) >>> 0) !== b.readUInt32BE(b.length - 4)) {
        throw new Error("This part failed its own check. Scan it again.");
    }
    const id = b.subarray(4, 8).toString("hex");
    const n = b.readUInt16BE(8);
    const total = b.readUInt16BE(10);
    const len = b.readUInt32BE(12);
    const whole = b.readUInt32BE(16);
    const nl = b[20];
    if (21 + nl + 4 > b.length || n === 0 || n > total) {
        throw new Error("This part has a broken header.");
    }
    return {
        id, n, total, len, whole,
        name: b.toString("utf8", 21, 21 + nl),
        chunk: Buffer.from(b.subarray(21 + nl, b.length - 4)),
    };
}
class Assembler {
    constructor() {
        this.started = false;
        this.id = "";
        this.total = 0;
        this.len = 0;
        this.whole = 0;
        this.name = "";
        this.chunks = [];
        this.have = 0;
    }
    // returns [status, n, message]
    add(b) {
        let p;
        try {
            p = parse(b);
        }
        catch (e) {
            return [exports.BAD, 0, e instanceof Error ? e.message : String(e)];
        }
        if (p === null)
            return [exports.NOT_PART, 0, ""];
        if (!this.started) {
            this.started = true;
            this.id = p.id;
            this.total = p.total;
            this.len = p.len;
            this.whole = p.whole;
            this.name = p.name;
            this.chunks = new Array(p.total).fill(null);
        }
        else if (p.id !== this.id) {
            const nm = p.name.length === 0 ? "unnamed" : p.name;
            return [exports.OTHER, 0, `That part belongs to a different file (${nm}). Start over to switch.`];
        }
        else if (p.total !== this.total || p.len !== this.len || p.whole !== this.whole) {
            return [exports.BAD, 0, "This part does not match the others."];
        }
        if (this.chunks[p.n - 1] !== null)
            return [exports.DUPLICATE, p.n, ""];
        this.chunks[p.n - 1] = p.chunk;
        this.have += 1;
        if (this.have === this.total)
            return [exports.COMPLETE, p.n, ""];
        return [exports.NEW, p.n, ""];
    }
    // finish rebuilds and verifies after COMPLETE. Returns [bytes, name].
    finish() {
        if (this.have !== this.total)
            throw new Error("Parts are still missing.");
        const bufs = [];
        let sz = 0;
        for (let i = 0; i < this.total; i++) {
            const ch = this.chunks[i];
            if (sz + ch.length > this.len)
                throw new Error("The parts add up to more than the file size.");
            bufs.push(ch);
            sz += ch.length;
        }
        const buf = Buffer.concat(bufs);
        if (buf.length !== this.len)
            throw new Error(`The parts add up to ${buf.length} bytes, not ${this.len}.`);
        if (((0, prism_1.crc32)(new Uint8Array(buf)) >>> 0) !== this.whole) {
            throw new Error("The whole-file check failed. Start over and scan the parts again.");
        }
        const name = this.name.length === 0 ? "prism-file.bin" : this.name;
        return [buf, name];
    }
}
exports.Assembler = Assembler;
