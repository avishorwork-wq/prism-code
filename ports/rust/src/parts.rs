// Prism big files in parts (PPT1), byte-compatible with prism-parts.js and
// the C/Go/Kotlin ports.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.

use crate::{capacity, crc32};
use crate::secure::{be32r, be32w};

pub const PARTS_ECC: usize = 2;

pub fn pp_overhead(name_len: usize) -> usize {
    4 + 4 + 2 + 2 + 4 + 4 + 1 + name_len + 4
}

// clean_name: backslash, slash and control bytes become '_', trimmed to 200 chars.
pub fn clean_name(name: &str) -> Vec<u8> {
    let src = if name.is_empty() { b"file".to_vec() } else { name.as_bytes().to_vec() };
    let mut out = Vec::new();
    for c in src {
        if out.len() >= 200 {
            break;
        }
        if c == b'\\' || c == b'/' || c < 0x20 {
            out.push(b'_');
        } else {
            out.push(c);
        }
    }
    out
}

// name_bytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
pub fn name_bytes(name: &str) -> Vec<u8> {
    let clean = clean_name(name);
    let mut n = clean.len();
    if n > 40 {
        n = 40;
        while n > 0 && (clean[n] & 0xC0) == 0x80 {
            n -= 1; // back off to a lead byte
        }
        if n > 0 && (clean[n] & 0x80) != 0 {
            let c = clean[n];
            let need = if (c & 0xE0) == 0xC0 {
                2
            } else if (c & 0xF0) == 0xE0 {
                3
            } else if (c & 0xF8) == 0xF0 {
                4
            } else {
                0
            };
            if need != 0 && n + need > 41 {
                n -= 1;
            }
        }
    }
    clean[..n].to_vec()
}

pub struct Plan {
    pub room: usize,
    pub total: usize,
    pub name: Vec<u8>,
}

pub fn plan_calc(length: usize, name: &str, code_size: usize) -> Result<Plan, String> {
    let nb = name_bytes(name);
    let cap = capacity(code_size, PARTS_ECC, 0);
    let room = cap.payload as isize - pp_overhead(nb.len()) as isize;
    if room < 64 {
        return Err("part size leaves < 64 bytes of room".into());
    }
    let room = room as usize;
    let mut total = (length + room - 1) / room;
    if total < 1 {
        total = 1;
    }
    if total > 65535 {
        return Err("file too big for this part size".into());
    }
    Ok(Plan { room, total, name: nb })
}

// split_file splits bytes into PPT1 part payloads.
pub fn split_file(data: &[u8], name: &str, code_size: usize) -> Result<Vec<Vec<u8>>, String> {
    use rand::RngCore;
    let plan = plan_calc(data.len(), name, code_size)?;
    let mut id = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut id);
    let whole = crc32(data);
    let mut parts = Vec::with_capacity(plan.total);
    for n_idx in 0..plan.total {
        let off = n_idx * plan.room;
        let mut clen = data.len() - off;
        if clen > plan.room {
            clen = plan.room;
        }
        let mut p: Vec<u8> = Vec::with_capacity(pp_overhead(plan.name.len()) + clen);
        p.extend_from_slice(b"PPT1");
        p.extend_from_slice(&id);
        p.push(((n_idx + 1) >> 8) as u8);
        p.push((n_idx + 1) as u8);
        p.push((plan.total >> 8) as u8);
        p.push(plan.total as u8);
        let mut tmp = [0u8; 4];
        be32w(&mut tmp, 0, data.len() as u32);
        p.extend_from_slice(&tmp);
        be32w(&mut tmp, 0, whole);
        p.extend_from_slice(&tmp);
        p.push(plan.name.len() as u8);
        p.extend_from_slice(&plan.name);
        p.extend_from_slice(&data[off..off + clen]);
        be32w(&mut tmp, 0, crc32(&p));
        p.extend_from_slice(&tmp);
        parts.push(p);
    }
    Ok(parts)
}

pub struct PartInfo {
    pub id: String,
    pub n: usize,
    pub total: usize,
    pub len: u32,
    pub whole: u32,
    pub name: String,
    pub chunk: Vec<u8>,
}

// parse parses one part payload. Ok(None) = not a part; Err = damaged part.
pub fn parse(b: &[u8]) -> Result<Option<PartInfo>, String> {
    if b.len() < 25 || &b[..4] != b"PPT1" {
        return Ok(None);
    }
    if crc32(&b[..b.len() - 4]) != be32r(b, b.len() - 4) {
        return Err("This part failed its own check. Scan it again.".into());
    }
    let mut id = String::new();
    for i in 0..4 {
        id.push_str(&format!("{:02x}", b[4 + i]));
    }
    let n = ((b[8] as usize) << 8) | b[9] as usize;
    let total = ((b[10] as usize) << 8) | b[11] as usize;
    let len = be32r(b, 12);
    let whole = be32r(b, 16);
    let nl = b[20] as usize;
    if 21 + nl + 4 > b.len() || n == 0 || n > total {
        return Err("This part has a broken header.".into());
    }
    let name = String::from_utf8_lossy(&b[21..21 + nl]).into_owned();
    let chunk = b[21 + nl..b.len() - 4].to_vec();
    Ok(Some(PartInfo { id, n, total, len, whole, name, chunk }))
}

// Add statuses, like the site.
pub const NOT_PART: i32 = 0;
pub const BAD: i32 = 1;
pub const OTHER: i32 = 2;
pub const DUPLICATE: i32 = 3;
pub const NEW: i32 = 4;
pub const COMPLETE: i32 = 5;

#[derive(Default)]
pub struct Assembler {
    pub id: String,
    pub total: usize,
    pub len: u32,
    pub whole: u32,
    pub name: String,
    chunks: Vec<Option<Vec<u8>>>,
    pub have: usize,
    pub started: bool,
}

impl Assembler {
    pub fn add(&mut self, b: &[u8]) -> (i32, usize, String) {
        let p = match parse(b) {
            Ok(None) => return (NOT_PART, 0, String::new()),
            Err(m) => return (BAD, 0, m),
            Ok(Some(p)) => p,
        };
        if !self.started {
            self.started = true;
            self.id = p.id.clone();
            self.total = p.total;
            self.len = p.len;
            self.whole = p.whole;
            self.name = p.name.clone();
            self.chunks = vec![None; p.total];
        } else if p.id != self.id {
            let nm = if p.name.is_empty() { "unnamed".to_string() } else { p.name.clone() };
            return (OTHER, 0, format!("That part belongs to a different file ({}). Start over to switch.", nm));
        } else if p.total != self.total || p.len != self.len || p.whole != self.whole {
            return (BAD, 0, "This part does not match the others.".into());
        }
        if self.chunks[p.n - 1].is_some() {
            return (DUPLICATE, p.n, String::new());
        }
        self.chunks[p.n - 1] = Some(p.chunk);
        self.have += 1;
        if self.have == self.total {
            return (COMPLETE, p.n, String::new());
        }
        (NEW, p.n, String::new())
    }

    // finish rebuilds and verifies after COMPLETE.
    pub fn finish(&self) -> Result<(Vec<u8>, String), String> {
        if self.have != self.total {
            return Err("Parts are still missing.".into());
        }
        let mut buf: Vec<u8> = Vec::new();
        for i in 0..self.total {
            let ch = self.chunks[i].as_ref().unwrap();
            if buf.len() + ch.len() > self.len as usize {
                return Err("The parts add up to more than the file size.".into());
            }
            buf.extend_from_slice(ch);
        }
        if buf.len() != self.len as usize {
            return Err(format!("The parts add up to {} bytes, not {}.", buf.len(), self.len));
        }
        if crc32(&buf) != self.whole {
            return Err("The whole-file check failed. Start over and scan the parts again.".into());
        }
        let name = if self.name.is_empty() { "prism-file.bin".to_string() } else { self.name.clone() };
        Ok((buf, name))
    }
}
