// Prism big files in parts (PPT1) for the TypeScript port, byte-compatible
// with prism-parts.js and the C/Go/Kotlin/Rust/PHP/Ruby ports.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.

import * as crypto from "crypto";
import { crc32, capacity } from "./prism";

export const PARTS_ECC = 2;

export const NOT_PART = 0;
export const BAD = 1;
export const OTHER = 2;
export const DUPLICATE = 3;
export const NEW = 4;
export const COMPLETE = 5;

export function overhead(nameLen: number): number {
  return 4 + 4 + 2 + 2 + 4 + 4 + 1 + nameLen + 4;
}

// clean_name: backslash, slash and control bytes become '_', trimmed to 200 bytes.
export function cleanName(name: string): Buffer {
  const src = name.length === 0 ? "file" : name;
  const out: number[] = [];
  for (const c of Buffer.from(src, "utf8")) {
    if (out.length >= 200) break;
    out.push(c === 0x5c || c === 0x2f || c < 0x20 ? 0x5f : c);
  }
  return Buffer.from(out);
}

// nameBytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
export function nameBytes(name: string): Buffer {
  const clean = cleanName(name);
  let n = clean.length;
  if (n > 40) {
    n = 40;
    while (n > 0 && (clean[n] & 0xc0) === 0x80) n -= 1; // back off to a lead byte
    if (n > 0 && (clean[n] & 0x80) !== 0) {
      const c = clean[n];
      const need = (c & 0xe0) === 0xc0 ? 2 : (c & 0xf0) === 0xe0 ? 3 : (c & 0xf8) === 0xf0 ? 4 : 0;
      if (need !== 0 && n + need > 41) n -= 1;
    }
  }
  return clean.subarray(0, n);
}

export interface Plan { room: number; total: number; name: Buffer }

export function plan(length: number, name: string, codeSize: number): Plan {
  const nb = nameBytes(name);
  const cap = capacity(codeSize, PARTS_ECC, 0);
  const room = cap.payload - overhead(nb.length);
  if (room < 64) throw new Error("part size leaves < 64 bytes of room");
  let total = Math.floor((length + room - 1) / room);
  if (total < 1) total = 1;
  if (total > 65535) throw new Error("file too big for this part size");
  return { room, total, name: nb };
}

// split splits bytes into PPT1 part payloads.
export function split(data: Buffer, name: string, codeSize: number): Buffer[] {
  const pl = plan(data.length, name, codeSize);
  const id = crypto.randomBytes(4);
  const whole = crc32(new Uint8Array(data));
  const parts: Buffer[] = [];
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
    crc.writeUInt32BE(crc32(new Uint8Array(p)) >>> 0);
    p = Buffer.concat([p, crc]);
    parts.push(p);
  }
  return parts;
}

export interface ParsedPart {
  id: string; n: number; total: number; len: number; whole: number;
  name: string; chunk: Buffer;
}

// parse parses one part payload. Returns null = not a part; throws on damage.
export function parse(b: Buffer): ParsedPart | null {
  if (b.length < 25 || b.toString("latin1", 0, 4) !== "PPT1") return null;
  if ((crc32(new Uint8Array(b.subarray(0, b.length - 4))) >>> 0) !== b.readUInt32BE(b.length - 4)) {
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

export class Assembler {
  started = false;
  id = "";
  total = 0;
  len = 0;
  whole = 0;
  name = "";
  chunks: (Buffer | null)[] = [];
  have = 0;

  // returns [status, n, message]
  add(b: Buffer): [number, number, string] {
    let p: ParsedPart | null;
    try {
      p = parse(b);
    } catch (e) {
      return [BAD, 0, e instanceof Error ? e.message : String(e)];
    }
    if (p === null) return [NOT_PART, 0, ""];
    if (!this.started) {
      this.started = true;
      this.id = p.id;
      this.total = p.total;
      this.len = p.len;
      this.whole = p.whole;
      this.name = p.name;
      this.chunks = new Array(p.total).fill(null);
    } else if (p.id !== this.id) {
      const nm = p.name.length === 0 ? "unnamed" : p.name;
      return [OTHER, 0, `That part belongs to a different file (${nm}). Start over to switch.`];
    } else if (p.total !== this.total || p.len !== this.len || p.whole !== this.whole) {
      return [BAD, 0, "This part does not match the others."];
    }
    if (this.chunks[p.n - 1] !== null) return [DUPLICATE, p.n, ""];
    this.chunks[p.n - 1] = p.chunk;
    this.have += 1;
    if (this.have === this.total) return [COMPLETE, p.n, ""];
    return [NEW, p.n, ""];
  }

  // finish rebuilds and verifies after COMPLETE. Returns [bytes, name].
  finish(): [Buffer, string] {
    if (this.have !== this.total) throw new Error("Parts are still missing.");
    const bufs: Buffer[] = [];
    let sz = 0;
    for (let i = 0; i < this.total; i++) {
      const ch = this.chunks[i]!;
      if (sz + ch.length > this.len) throw new Error("The parts add up to more than the file size.");
      bufs.push(ch);
      sz += ch.length;
    }
    const buf = Buffer.concat(bufs);
    if (buf.length !== this.len) throw new Error(`The parts add up to ${buf.length} bytes, not ${this.len}.`);
    if ((crc32(new Uint8Array(buf)) >>> 0) !== this.whole) {
      throw new Error("The whole-file check failed. Start over and scan the parts again.");
    }
    const name = this.name.length === 0 ? "prism-file.bin" : this.name;
    return [buf, name];
  }
}
