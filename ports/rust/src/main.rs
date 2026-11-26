// Prism Code - Rust port of the live JavaScript encoder/decoder.
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// Only dependency: flate2 (pure-Rust miniz_oxide) for PNG zlib.

mod cards;
mod issuers;
mod parts;
mod secure;
//
// Format: pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray
// coding (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to
// 113x130 cells. Filled corner gap pattern, asymmetric ring, pilot cells,
// triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D
// Reed-Solomon blocks, payload CRC-32.

use std::f64::consts::PI;

fn s3() -> f64 { 3.0f64.sqrt() } // matches JS Math.sqrt(3) bit-for-bit
fn q() -> f64 { 3.0 * s3() }

const SIZES: [(usize, usize); 6] = [(21, 24), (29, 33), (41, 47), (57, 66), (81, 94), (113, 130)];
const PAL: [[u8; 3]; 9] = [
    [0x1B, 0x1B, 0x1B], [0x2E, 0x5B, 0xFF], [0x00, 0xB8, 0xD9],
    [0x2D, 0xB3, 0x5A], [0xF5, 0xC5, 0x18], [0xF7, 0x7F, 0x00],
    [0xD7, 0x26, 0x3D], [0xB5, 0x17, 0x9E], [0xFF, 0xFF, 0xFF],
];

// ---------------------------------------------------------------- rng / crc

struct Rng { seed: u32 }
impl Rng {
    fn new(seed: u32) -> Self { Rng { seed } }
    // Exact port of the JS mulberry-style rng (returns floats in [0,1)).
    fn next(&mut self) -> f64 {
        self.seed = self.seed.wrapping_add(0x6D2B79F5);
        let mut t = (self.seed ^ (self.seed >> 15)).wrapping_mul(1 | self.seed);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

fn crc32_table() -> &'static [u32; 256] {
    use std::sync::OnceLock;
    static T: OnceLock<[u32; 256]> = OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0u32; 256];
        for n in 0..256u32 {
            let mut c = n;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
            }
            t[n as usize] = c;
        }
        t
    })
}

pub fn crc32(data: &[u8]) -> u32 {
    let t = crc32_table();
    let mut c = 0xFFFFFFFFu32;
    for &b in data {
        c = t[((c ^ b as u32) & 255) as usize] ^ (c >> 8);
    }
    c ^ 0xFFFFFFFF
}

fn crc4(bits: &[u8]) -> u8 {
    let mut r = 0u8;
    for &b in bits {
        let f = ((r >> 3) & 1) ^ b;
        r = (r << 1) & 15;
        if f != 0 { r ^= 3; }
    }
    r
}

fn padk(o: usize) -> u8 {
    let mut x = (o as u32).wrapping_add(0x9E3779B9).wrapping_mul(0x85EBCA6B);
    x ^= x >> 13;
    x = x.wrapping_mul(0xC2B2AE35);
    x ^= x >> 16;
    (x & 255) as u8
}

// ---------------------------------------------------------------- GF(256)

struct Gf { exp: [u8; 512], log: [u8; 256] }
fn gf() -> &'static Gf {
    use std::sync::OnceLock;
    static G: OnceLock<Gf> = OnceLock::new();
    G.get_or_init(|| {
        let mut exp = [0u8; 512];
        let mut log = [0u8; 256];
        let mut z: u16 = 1;
        for i in 0..255 {
            exp[i] = z as u8;
            log[z as usize] = i as u8;
            z <<= 1;
            if z & 256 != 0 { z ^= 0x11D; }
        }
        for i in 255..512 { exp[i] = exp[i - 255]; }
        Gf { exp, log }
    })
}

fn gmul(a: u8, b: u8) -> u8 {
    if a != 0 && b != 0 {
        let g = gf();
        g.exp[g.log[a as usize] as usize + g.log[b as usize] as usize]
    } else { 0 }
}
fn gdiv(a: u8, b: u8) -> u8 {
    assert!(b != 0, "GF division by zero");
    if a == 0 { return 0; }
    let g = gf();
    g.exp[(g.log[a as usize] as usize + 255 - g.log[b as usize] as usize) % 255]
}
fn peval(p: &[u8], x: u8) -> u8 {
    let mut y = 0u8;
    for i in (0..p.len()).rev() { y = gmul(y, x) ^ p[i]; }
    y
}
fn pmul(a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut o = vec![0u8; a.len() + b.len() - 1];
    for (i, &ai) in a.iter().enumerate() {
        if ai != 0 {
            for (j, &bj) in b.iter().enumerate() {
                o[i + j] ^= gmul(ai, bj);
            }
        }
    }
    o
}

fn rs_encode(msg: &[u8], nsym: usize) -> Vec<u8> {
    let mut g = vec![1u8];
    for i in 0..nsym { g = pmul(&g, &[1, gf().exp[i]]); }
    let mut out = msg.to_vec();
    out.resize(msg.len() + nsym, 0);
    for i in 0..msg.len() {
        let c = out[i];
        if c != 0 {
            for j in 1..g.len() { out[i + j] ^= gmul(g[j], c); }
        }
    }
    out[..msg.len()].copy_from_slice(msg);
    out
}

fn syndromes(r: &[u8], n: usize) -> Vec<u8> {
    let mut s = vec![0u8; n];
    for j in 0..n {
        let mut y = 0u8;
        let x = gf().exp[j];
        for &ri in r { y = gmul(y, x) ^ ri; }
        s[j] = y;
    }
    s
}

fn bm(s: &[u8]) -> Vec<u8> {
    let mut c = vec![0u8; s.len() + 1];
    let mut b = vec![0u8; s.len() + 1];
    c[0] = 1; b[0] = 1;
    let (mut l, mut m, mut bb) = (0usize, 1usize, 1u8);
    for n in 0..s.len() {
        let mut d = s[n];
        for i in 1..=l { d ^= gmul(c[i], s[n - i]); }
        if d == 0 { m += 1; continue; }
        let t = c.clone();
        let v = gdiv(d, bb);
        for i in 0..(c.len() - m) { c[i + m] ^= gmul(v, b[i]); }
        if 2 * l <= n {
            l = n + 1 - l;
            b = t;
            bb = d;
            m = 1;
        } else { m += 1; }
    }
    c.truncate(l + 1);
    c
}

/// Returns (corrected codeword, num corrected). Err on failure.
fn rs_decode(data: &[u8], nsym: usize) -> Result<Vec<u8>, String> {
    let mut r = data.to_vec();
    let s = syndromes(&r, nsym);
    if s.iter().all(|&x| x == 0) { return Ok(r); }
    let e = bm(&s);
    if 2 * (e.len() - 1) > nsym { return Err("RS correction limit".into()); }
    let loc = e;
    let mut pos = Vec::new();
    for p in 0..r.len() {
        let e_ = r.len() - 1 - p;
        if peval(&loc, gf().exp[(255 - e_) % 255]) == 0 { pos.push(p); }
    }
    if pos.len() != loc.len() - 1 { return Err("RS roots".into()); }
    let mut omega = pmul(&s, &loc);
    omega.truncate(nsym);
    let der_len = (loc.len() - 1).max(1);
    let mut der = vec![0u8; der_len];
    let mut i = 1;
    while i < loc.len() { der[i - 1] = loc[i]; i += 2; }
    for &p in &pos {
        let e_ = r.len() - 1 - p;
        let x = gf().exp[e_];
        let xi = gf().exp[(255 - e_) % 255];
        r[p] ^= gdiv(gmul(x, peval(&omega, xi)), peval(&der, xi));
    }
    if syndromes(&r, nsym).iter().any(|&x| x != 0) { return Err("RS syndrome check".into()); }
    Ok(r)
}

// ---------------------------------------------------------------- layout

#[derive(Clone, Copy, PartialEq)]
enum Role { Data, Gap, Ring, Pilot, Header }

#[derive(Clone)]
struct Cell {
    i: i32, j: i32,
    x: f64, y: f64,
    role: Role,
    symbol: i32,
    pi: i32, pj: i32,
    index: usize,
    header: i32,
}

struct Layout {
    size: usize, c: usize, r: usize,
    w: f64, h: f64,
    cells: Vec<Cell>,
    headers: Vec<usize>, // indices into cells
    data: Vec<usize>,
    known: Vec<usize>,
    cd: Option<Vec<usize>>,
}

fn floor_div(a: i32, b: i32) -> i32 {
    let q = a / b;
    if (a % b != 0) && ((a < 0) != (b < 0)) { q - 1 } else { q }
}

fn make_layout(size: usize) -> Layout {
    let (c, r) = SIZES[size];
    let mut cells = Vec::new();
    let mut m_idx = Vec::new();
    let mut known = Vec::new();
    for j in 0..r as i32 {
        for i in 0..c as i32 {
            let mut role = Role::Data;
            let mut symbol = -1;
            let pi = floor_div(i - 2, 5);
            let pj = floor_div(j - 2, 5);
            if j <= 2 && i <= 2 { role = Role::Gap; symbol = 8; }
            else if j == 0 || j == r as i32 - 1 || i == 0 || i == c as i32 - 1 {
                role = Role::Ring; symbol = ((j * 5 + i * 3) % 8) as i32;
            } else if i % 5 == 2 && j % 5 == 2 {
                role = Role::Pilot; symbol = (pi * 2 + pj * 3) % 9;
            }
            let cell = Cell {
                i, j,
                x: s3() * (i as f64 + 0.5 + 0.5 * ((j & 1) as f64)),
                y: 1.0 + 1.5 * j as f64,
                role, symbol, pi, pj, index: cells.len(), header: -1,
            };
            cells.push(cell);
            if role == Role::Data { m_idx.push(cells.len() - 1); }
            else if role != Role::Gap { known.push(cells.len() - 1); }
        }
    }
    let mut headers = Vec::new();
    for n in 0..72usize {
        let ci = m_idx[(((n as f64) + 0.5) * m_idx.len() as f64 / 72.0) as usize];
        cells[ci].role = Role::Header;
        cells[ci].header = n as i32;
        headers.push(ci);
    }
    let mut data: Vec<usize> = cells.iter().enumerate()
        .filter(|(_, c)| c.role == Role::Data).map(|(i, _)| i).collect();
    let mut rand = Rng::new(0x5EED ^ size as u32);
    for i in (1..data.len()).rev() {
        let jj = (rand.next() * (i as f64 + 1.0)) as usize;
        data.swap(i, jj);
    }
    Layout {
        size, c, r,
        w: s3() * (c as f64 + 0.5),
        h: 2.0 + 1.5 * (r as f64 - 1.0),
        cells, headers, data, known, cd: None,
    }
}

/// Centre-out data order used when a logo sits in the middle (logo=1).
fn plcd(l: &Layout) -> Vec<usize> {
    let cx = l.w / 2.0;
    let cy = l.h / 2.0;
    let mut ent: Vec<(usize, i64)> = l.data.iter().enumerate().map(|(k, &ci)| {
        let c = &l.cells[ci];
        let dx = c.x - cx;
        let dy = c.y - cy;
        ((k), ((dx * dx + dy * dy).sqrt() / 3.0) as i64)
    }).collect();
    // stable sort by (-b, k): sort_by is stable
    ent.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    ent.iter().map(|&(k, _)| l.data[k]).collect()
}

// ---------------------------------------------------------------- capacity

struct BlockSpec { n: usize, nsym: usize, k: usize }
struct Capacity { n: usize, blocks: Vec<BlockSpec>, k: usize, payload: usize }

fn jsround(x: f64) -> f64 { (x + 0.5).floor() }

pub fn capacity(size: usize, ecc: usize, mode: usize) -> Capacity {
    let l = make_layout(size);
    let bpc = if mode != 0 { 1 } else { 3 };
    let n = l.data.len() * bpc / 8;
    let nb = (n + 254) / 255;
    let pcts = [0.1f64, 0.2, 0.3, 0.4];
    let mut blocks = Vec::new();
    for i in 0..nb {
        let ln = n / nb + if i < n % nb { 1 } else { 0 };
        let nsym = (2.0 * jsround(ln as f64 * pcts[ecc] / 2.0)).max(4.0) as usize;
        blocks.push(BlockSpec { n: ln, nsym, k: ln - nsym });
    }
    let k: usize = blocks.iter().map(|b| b.k).sum();
    Capacity { n, blocks, k, payload: k.saturating_sub(4) }
}

fn push_bits(a: &mut Vec<u8>, x: u32, n: usize) {
    for k in (0..n).rev() {
        a.push(((x >> k) & 1) as u8);
    }
}

fn header_bits(size: usize, ecc: usize, mode: usize, typ: usize, l: usize) -> Vec<u8> {
    let mut b = Vec::new();
    push_bits(&mut b, size as u32, 3);
    push_bits(&mut b, ecc as u32, 2);
    push_bits(&mut b, mode as u32, 1);
    push_bits(&mut b, typ as u32, 1);
    push_bits(&mut b, l as u32, 13);
    let c = crc4(&b);
    push_bits(&mut b, c as u32, 4);
    b
}

fn known_symbol(c: &Cell, mode: usize) -> i32 {
    if mode != 0 {
        if c.role == Role::Ring { return 0; }
        return if (c.pi + c.pj) % 2 == 0 { 0 } else { 8 };
    }
    c.symbol
}

// ---------------------------------------------------------------- encode

struct Code {
    size: usize, ecc: usize, mode: usize, typ: usize,
    bytes: Vec<u8>,
    symbols: Vec<i32>,
    layout: Layout,
    cap_payload: usize,
}

fn encode(payload: &[u8], size_in: i32, ecc: usize, mode: usize, typ: usize, logo: usize) -> Result<Code, String> {
    if payload.len() > 8191 { return Err("payload exceeds 8191 bytes".into()); }
    let mut size = size_in;
    if size < 0 {
        size = -1;
        for i in 0..SIZES.len() {
            if capacity(i, ecc, mode).k >= payload.len() + 4 { size = i as i32; break; }
        }
        if size < 0 { return Err("payload too large for this mode and ECC".into()); }
    }
    let size = size as usize;
    let cap = capacity(size, ecc, mode);
    if cap.k < payload.len() + 4 {
        return Err(format!("payload does not fit: maximum {} bytes", cap.payload));
    }
    let mut msg = vec![0u8; cap.k];
    for i in payload.len() + 4..cap.k { msg[i] = padk(i); }
    msg[..payload.len()].copy_from_slice(payload);
    let crc = crc32(payload);
    for k in 0..4 { msg[payload.len() + k] = (crc >> (24 - 8 * k)) as u8; }
    let mut off = 0;
    let mut blocks = Vec::new();
    for b in &cap.blocks {
        blocks.push(rs_encode(&msg[off..off + b.k], b.nsym));
        off += b.k;
    }
    let maxlen = blocks.iter().map(|x| x.len()).max().unwrap_or(0);
    let mut stream = Vec::new();
    for p in 0..maxlen {
        for b in &blocks {
            if p < b.len() { push_bits(&mut stream, b[p] as u32, 8); }
        }
    }
    let mut rand = Rng::new(0xBEEF);
    let mut l = make_layout(size);
    let mut symbols = vec![8i32; l.cells.len()];
    for &ci in &l.known {
        symbols[ci] = known_symbol(&l.cells[ci], mode);
    }
    let hb = header_bits(size, ecc, mode, typ, payload.len());
    for &ci in &l.headers {
        let h = l.cells[ci].header as usize;
        symbols[ci] = if hb[h % 24] != 0 { 0 } else { 8 };
    }
    for c in &l.cells {
        if c.role == Role::Gap {
            symbols[c.index] = if mode != 0 {
                if (c.i + c.j) % 2 != 0 { 0 } else { 8 }
            } else {
                ((c.j * 5 + c.i * 3) % 8) as i32
            };
        }
    }
    let mut at = 0usize;
    let order = if logo != 0 { plcd(&l) } else { l.data.clone() };
    for &ci in &order {
        if mode != 0 {
            let bit = if at < stream.len() { stream[at] } else { if rand.next() > 0.5 { 1 } else { 0 } };
            at += 1;
            symbols[ci] = if bit != 0 { 0 } else { 8 };
        } else {
            let mut b = 0i32;
            for _ in 0..3 {
                let bit = if at < stream.len() { stream[at] as i32 } else { if rand.next() > 0.5 { 1 } else { 0 } };
                at += 1;
                b = (b << 1) | bit;
            }
            let mut v = b;
            v ^= v >> 1;
            v ^= v >> 2;
            symbols[ci] = v;
        }
    }
    l.cd = Some(order.clone());
    Ok(Code { size, ecc, mode, typ, bytes: payload.to_vec(), symbols, layout: l, cap_payload: cap.payload })
}

// ---------------------------------------------------------------- render / PNG

fn fill_poly(img: &mut [u8], w: usize, h: usize, pts: &[[f64; 2]], rgb: [u8; 3]) {
    let mut miny = f64::INFINITY;
    let mut maxy = f64::NEG_INFINITY;
    for p in pts { miny = miny.min(p[1]); maxy = maxy.max(p[1]); }
    let y0 = (miny.floor() as i64).max(0) as usize;
    let y1 = (maxy.ceil() as i64).min(h as i64 - 1);
    if y1 < y0 as i64 { return; }
    let y1 = y1 as usize;
    for y in y0..=y1 {
        let yc = y as f64 + 0.5;
        let mut xs: Vec<f64> = Vec::with_capacity(pts.len());
        for k in 0..pts.len() {
            let (x1, a) = (pts[k][0], pts[k][1]);
            let (x2, b) = (pts[(k + 1) % pts.len()][0], pts[(k + 1) % pts.len()][1]);
            if (a <= yc && yc < b) || (b <= yc && yc < a) {
                xs.push(x1 + (yc - a) / (b - a) * (x2 - x1));
            }
        }
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let mut k = 0;
        while k + 1 < xs.len() {
            let xa = ((xs[k] - 0.5).round() as i64).max(0) as usize;
            let xb = (((xs[k + 1] - 0.5).round() as i64) - 1).min(w as i64 - 1);
            if xb >= xa as i64 {
                for x in xa..=(xb as usize) {
                    let o = (y * w + x) * 4;
                    img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255;
                }
            }
            k += 2;
        }
    }
}

/// Same geometry as Prism.render: hard-edged hexagons on white.
fn render(code: &Code, r: usize) -> (usize, usize, Vec<u8>) {
    let l = &code.layout;
    let w = ((l.w + 2.0 * q()) * r as f64).ceil() as usize;
    let h = ((l.h + 2.0 * q()) * r as f64).ceil() as usize;
    let mut img = vec![255u8; w * h * 4];
    for c in &l.cells {
        let s = code.symbols[c.index];
        if s == 8 { continue; }
        let mut pts = [[0f64; 2]; 6];
        for k in 0..6 {
            let a = (30 + 60 * k) as f64 * PI / 180.0;
            pts[k] = [(c.x + q() + 1.03 * a.cos()) * r as f64,
                      (c.y + q() + 1.03 * a.sin()) * r as f64];
        }
        fill_poly(&mut img, w, h, &pts, PAL[s as usize]);
    }
    (w, h, img)
}

// ---- PNG write (filter 0, zlib via flate2)

fn png_chunk(tag: &[u8; 4], data: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(tag);
    out.extend_from_slice(data);
    let mut v = Vec::with_capacity(4 + data.len());
    v.extend_from_slice(tag);
    v.extend_from_slice(data);
    out.extend_from_slice(&crc32(&v).to_be_bytes());
}

fn write_png(w: usize, h: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    use std::io::Write;
    let stride = w * 4;
    let mut raw = Vec::with_capacity((stride + 1) * h);
    for y in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgba[y * stride..(y + 1) * stride]);
    }
    let mut e = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(&raw).map_err(|er| er.to_string())?;
    let idat = e.finish().map_err(|er| er.to_string())?;
    let mut out = Vec::new();
    out.extend_from_slice(&[137, 80, 78, 71, 13, 10, 26, 10]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    png_chunk(b"IHDR", &ihdr, &mut out);
    png_chunk(b"IDAT", &idat, &mut out);
    png_chunk(b"IEND", &[], &mut out);
    Ok(out)
}

// ---- PNG read (8-bit, colour types 0/2/3/4/6, all filters)

fn paeth(a: i32, b: i32, c: i32) -> i32 {
    let p = a + b - c;
    let pa = (p - a).abs();
    let pb = (p - b).abs();
    let pc = (p - c).abs();
    if pa <= pb && pa <= pc { a } else if pb <= pc { b } else { c }
}

fn read_png(buf: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    if buf.len() < 8 || &buf[..8] != &[137, 80, 78, 71, 13, 10, 26, 10] {
        return Err("not a png".into());
    }
    let mut pos = 8usize;
    let mut ihdr: Option<&[u8]> = None;
    let mut idats: Vec<&[u8]> = Vec::new();
    let mut plte: Option<&[u8]> = None;
    while pos + 12 <= buf.len() {
        let ln = u32::from_be_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]) as usize;
        let tag = &buf[pos + 4..pos + 8];
        if pos + 12 + ln > buf.len() { break; }
        let data = &buf[pos + 8..pos + 8 + ln];
        match tag {
            b"IHDR" => ihdr = Some(data),
            b"IDAT" => idats.push(data),
            b"PLTE" => plte = Some(data),
            b"IEND" => break,
            _ => {}
        }
        pos += 12 + ln;
    }
    let ihdr = ihdr.ok_or("no IHDR")?;
    let w = u32::from_be_bytes([ihdr[0], ihdr[1], ihdr[2], ihdr[3]]) as usize;
    let h = u32::from_be_bytes([ihdr[4], ihdr[5], ihdr[6], ihdr[7]]) as usize;
    let depth = ihdr[8];
    let ctype = ihdr[9];
    if depth != 8 { return Err(format!("unsupported bit depth {}", depth)); }
    let ch = match ctype { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, _ => return Err(format!("unsupported colour type {}", ctype)) };
    let mut zdata = Vec::new();
    for d in idats { zdata.extend_from_slice(d); }
    let raw = {
        use std::io::Read;
        let mut dz = flate2::read::ZlibDecoder::new(&zdata[..]);
        let mut v = Vec::new();
        dz.read_to_end(&mut v).map_err(|e| e.to_string())?;
        v
    };
    let stride = w * ch;
    let mut out = vec![0u8; w * h * 4];
    let mut prev = vec![0u8; stride];
    for y in 0..h {
        let f = raw[y * (stride + 1)];
        let mut line: Vec<u8> = raw[y * (stride + 1) + 1..(y + 1) * (stride + 1)].to_vec();
        if f != 0 {
            for x in 0..stride {
                let a = if x >= ch { line[x - ch] as i32 } else { 0 };
                let b = prev[x] as i32;
                let c = if x >= ch { prev[x - ch] as i32 } else { 0 };
                let v = match f {
                    1 => line[x] as i32 + a,
                    2 => line[x] as i32 + b,
                    3 => line[x] as i32 + ((a + b) >> 1),
                    4 => line[x] as i32 + paeth(a, b, c),
                    _ => return Err(format!("bad filter {}", f)),
                };
                line[x] = (v & 255) as u8;
            }
        }
        for x in 0..w {
            let o = (y * w + x) * 4;
            match ctype {
                6 => { out[o..o + 4].copy_from_slice(&line[x * 4..x * 4 + 4]); }
                2 => {
                    out[o..o + 3].copy_from_slice(&line[x * 3..x * 3 + 3]);
                    out[o + 3] = 255;
                }
                0 => {
                    out[o] = line[x]; out[o + 1] = line[x]; out[o + 2] = line[x]; out[o + 3] = 255;
                }
                4 => {
                    out[o] = line[x * 2]; out[o + 1] = line[x * 2]; out[o + 2] = line[x * 2];
                    out[o + 3] = line[x * 2 + 1];
                }
                3 => {
                    let plte = plte.ok_or("palette missing")?;
                    let pi = line[x] as usize * 3;
                    out[o..o + 3].copy_from_slice(&plte[pi..pi + 3]);
                    out[o + 3] = 255;
                }
                _ => unreachable!(),
            }
        }
        prev = line;
    }
    Ok((w, h, out))
}

// ---------------------------------------------------------------- decode (clean images)

#[derive(Default)]
struct Header { size: usize, ecc: usize, mode: usize, typ: usize, length: usize }

fn symbol_bits(sym: i32, mode: usize) -> Vec<u8> {
    if mode != 0 {
        return vec![if sym == 0 { 1 } else { 0 }];
    }
    let t = sym ^ (sym >> 1);
    vec![((t >> 2) & 1) as u8, ((t >> 1) & 1) as u8, (t & 1) as u8]
}

fn nearest_symbol(r: i64, g: i64, b: i64) -> i32 {
    let mut best = 0;
    let mut bestd = i64::MAX;
    for (i, p) in PAL.iter().enumerate() {
        let dr = r - p[0] as i64;
        let dg = g - p[1] as i64;
        let db = b - p[2] as i64;
        let d = dr * dr + dg * dg + db * db;
        if d < bestd { bestd = d; best = i; }
    }
    best as i32
}

fn decode_symbols(symbols: &[i32], l: &Layout, order: Option<&[usize]>) -> Result<(Vec<u8>, Header), String> {
    let mut hb = [0u8; 24];
    for n in 0..24 {
        let mut votes = 0;
        for rep in 0..3 {
            if symbols[l.headers[n + 24 * rep]] == 0 { votes += 1; }
        }
        hb[n] = if votes >= 2 { 1 } else { 0 };
    }
    let mut at = 0usize;
    let mut rd = |n: usize| -> usize {
        let mut v = 0usize;
        for _ in 0..n { v = (v << 1) | hb[at] as usize; at += 1; }
        v
    };
    let size = rd(3);
    let ecc = rd(2);
    let mode = rd(1);
    let typ = rd(1);
    let len = rd(13);
    let hcrc = rd(4);
    if crc4(&hb[..20]) as usize != hcrc || size > 5 || size != l.size {
        return Err("header checksum failed".into());
    }
    let cap = capacity(size, ecc, mode);
    if len > cap.payload { return Err("invalid length".into()); }
    let cells: &[usize] = match order { Some(o) => o, None => &l.data };
    let mut stream = Vec::new();
    for &ci in cells {
        stream.extend_from_slice(&symbol_bits(symbols[ci], mode));
    }
    let nbytes = cap.n;
    let mut bts = vec![0u8; nbytes];
    for i in 0..nbytes {
        let mut v = 0u8;
        for k in 0..8 { v = (v << 1) | stream[8 * i + k]; }
        bts[i] = v;
    }
    let mut blocks: Vec<Vec<u8>> = cap.blocks.iter().map(|b| vec![0u8; b.n]).collect();
    let mut at2 = 0usize;
    let maxn = cap.blocks.iter().map(|b| b.n).max().unwrap_or(0);
    for p in 0..maxn {
        for (bi, b) in cap.blocks.iter().enumerate() {
            if p < b.n {
                blocks[bi][p] = bts[at2];
                at2 += 1;
            }
        }
    }
    let mut msg = Vec::new();
    for (bi, b) in cap.blocks.iter().enumerate() {
        let dec = rs_decode(&blocks[bi], b.nsym)?;
        msg.extend_from_slice(&dec[..b.k]);
    }
    let payload = msg[..len].to_vec();
    let got = ((msg[len] as u32) << 24) | ((msg[len + 1] as u32) << 16)
        | ((msg[len + 2] as u32) << 8) | (msg[len + 3] as u32);
    if crc32(&payload) != got { return Err("payload CRC-32 failed".into()); }
    Ok((payload, Header { size, ecc, mode, typ, length: len }))
}

/// Decode a clean/perfect encoder image (any radius).
fn decode_image(w: usize, h: usize, rgba: &[u8]) -> Result<(Vec<u8>, Header), String> {
    let (mut xmin, mut ymin, mut xmax, mut ymax) = (w, h, -1i64, -1i64);
    for y in 0..h {
        let mut row_white = true;
        for x in 0..w {
            let o = (y * w + x) * 4;
            if rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250 { row_white = false; break; }
        }
        if row_white { continue; }
        for x in 0..w {
            let o = (y * w + x) * 4;
            if rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250 {
                if x < xmin { xmin = x; }
                if x as i64 > xmax { xmax = x as i64; }
                if y < ymin { ymin = y; }
                if y as i64 > ymax { ymax = y as i64; }
            }
        }
    }
    if xmax < 0 { return Err("no code found".into()); }
    const HEXHW: f64 = 1.03 * 0.8660254037844386;
    const HEXHH: f64 = 1.03;
    let mut last_err = String::from("unknown");
    for size in 0..6 {
        let l = make_layout(size);
        let mut mincx = f64::INFINITY;
        let mut maxcx = f64::NEG_INFINITY;
        let mut mincy = f64::INFINITY;
        let mut maxcy = f64::NEG_INFINITY;
        for &ci in &l.known {
            let c = &l.cells[ci];
            if c.role == Role::Ring {
                mincx = mincx.min(c.x); maxcx = maxcx.max(c.x);
                mincy = mincy.min(c.y); maxcy = maxcy.max(c.y);
            }
        }
        mincx -= HEXHW; maxcx += HEXHW; mincy -= HEXHH; maxcy += HEXHH;
        let rx = (xmax - xmin as i64 + 1) as f64 / (maxcx - mincx);
        let ry = (ymax - ymin as i64 + 1) as f64 / (maxcy - mincy);
        if (rx - ry).abs() / rx.max(ry) > 0.05 { continue; }
        let mut symbols = vec![8i32; l.cells.len()];
        for c in &l.cells {
            let px = xmin as f64 + (c.x - mincx) * rx;
            let py = ymin as f64 + (c.y - mincy) * ry;
            let (mut sr, mut sg, mut sb, mut n) = (0i64, 0i64, 0i64, 0i64);
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let xx = ((px + dx as f64 * rx * 0.15) as i64).clamp(0, w as i64 - 1) as usize;
                    let yy = ((py + dy as f64 * ry * 0.15) as i64).clamp(0, h as i64 - 1) as usize;
                    let o = (yy * w + xx) * 4;
                    sr += rgba[o] as i64;
                    sg += rgba[o + 1] as i64;
                    sb += rgba[o + 2] as i64;
                    n += 1;
                }
            }
            symbols[c.index] = nearest_symbol(sr / n, sg / n, sb / n);
        }
        match decode_symbols(&symbols, &l, None) {
            Ok(v) => return Ok(v),
            Err(_) => {
                let cd = plcd(&l);
                match decode_symbols(&symbols, &l, Some(&cd)) {
                    Ok(v) => return Ok(v),
                    Err(e) => { last_err = e; }
                }
            }
        }
    }
    Err(format!("decode failed: {}", last_err))
}

fn decode_png(buf: &[u8]) -> Result<(Vec<u8>, Header), String> {
    let (w, h, rgba) = read_png(buf)?;
    decode_image(w, h, &rgba)
}

// ---------------------------------------------------------------- CLI

fn arg<'a>(a: &'a [String], name: &str, dflt: Option<&'a str>) -> Option<&'a str> {
    for i in 0..a.len().saturating_sub(1) {
        if a[i] == format!("--{}", name) || a[i] == format!("-{}", name) {
            return Some(&a[i + 1]);
        }
    }
    dflt
}

fn has_arg(a: &[String], name: &str) -> bool {
    a.iter().any(|s| s == &format!("--{}", name))
}

fn positional(a: &[String]) -> Option<String> {
    let mut skip = false;
    for (i, s) in a.iter().enumerate() {
        if i == 0 {
            continue;
        }
        if skip {
            skip = false;
            continue;
        }
        if !s.is_empty() && s.starts_with('-') {
            skip = true;
            continue;
        }
        return Some(s.clone());
    }
    None
}

#[derive(serde::Serialize, serde::Deserialize)]
struct KeyFile {
    #[serde(rename = "publicKeyHex")]
    public_key_hex: String,
    #[serde(rename = "privateJwk")]
    private_jwk: Jwk,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Jwk {
    crv: String,
    d: String,
    kty: String,
    x: String,
    y: String,
}

// save_key writes the key file in the same JSON shape the C/Go ports use.
fn save_key(path: &str, priv_: &[u8], pub_: &[u8]) -> Result<(), String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let kf = KeyFile {
        public_key_hex: pub_.iter().map(|b| format!("{:02x}", b)).collect(),
        private_jwk: Jwk {
            crv: "P-256".into(),
            d: URL_SAFE_NO_PAD.encode(priv_),
            kty: "EC".into(),
            x: URL_SAFE_NO_PAD.encode(&pub_[1..33]),
            y: URL_SAFE_NO_PAD.encode(&pub_[33..65]),
        },
    };
    let j = serde_json::to_string(&kf).map_err(|e| e.to_string())?;
    std::fs::write(path, j).map_err(|e| e.to_string())
}

fn load_key(path: &str) -> Result<(Vec<u8>, Vec<u8>), String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let kf: KeyFile = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
    let pub_ = (0..kf.public_key_hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&kf.public_key_hex[i..i + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .map_err(|e| e.to_string())?;
    if pub_.len() != 65 {
        return Err("bad public key".into());
    }
    let priv_ = URL_SAFE_NO_PAD.decode(&kf.private_jwk.d).map_err(|e| e.to_string())?;
    if priv_.len() != 32 {
        return Err("bad private key".into());
    }
    Ok((priv_, pub_))
}

fn mode_name(m: usize) -> &'static str { if m == 0 { "color" } else { "bw" } }

fn usage() -> ! {
    eprintln!("usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n       prism decode I.png [--out O]\n       prism capacity\n       prism secure-genkey [-o key.json]\n       prism secure-seal IN --password P [--kdf argon2id|pbkdf2] [--sign-key key.json] [-o OUT]\n       prism secure-open IN [--password P] [-o OUT]\n       prism secure-passphrase\n       prism secure-strength [PASSWORD]\n       prism parts-split IN -o OUTDIR [--name NAME] [--size 0..5]\n       prism parts-join PART... [-o OUT]\n       prism card-build wifi|vcard|ticket [flags] [-o OUT]\n       prism card-parse IN\n       prism issuer IN [--list issuers.json]");
    std::process::exit(2);
}

fn fail(msg: &str) -> ! {
    eprintln!("error: {}", msg);
    std::process::exit(1);
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.is_empty() {
        eprintln!("usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n       prism decode I.png [--out O]\n       prism capacity");
        std::process::exit(2);
    }
    match a[0].as_str() {
        "encode" => {
            let text = arg(&a, "text", None).map(|s| s.to_string());
            let input = arg(&a, "input", None).map(|s| s.to_string());
            if text.is_none() && input.is_none() { fail("need --text or --input"); }
            let payload = match text {
                Some(t) => t.into_bytes(),
                None => std::fs::read(input.unwrap()).unwrap_or_else(|e| fail(&e.to_string())),
            };
            let size: i32 = arg(&a, "size", Some("-1")).unwrap().parse().unwrap_or(-1);
            let ecc: usize = arg(&a, "ecc", Some("1")).unwrap().parse().unwrap_or(1);
            let mode_s = arg(&a, "mode", Some("0")).unwrap();
            let mode = if mode_s == "1" || mode_s == "bw" { 1 } else { 0 };
            let radius: usize = arg(&a, "radius", Some("12")).unwrap().parse().unwrap_or(12);
            let typ: usize = arg(&a, "type", Some("0")).unwrap().parse().unwrap_or(0);
            let logo: usize = arg(&a, "logo", Some("0")).unwrap().parse().unwrap_or(0);
            let out = arg(&a, "out", None).unwrap_or_else(|| fail("need --out"));
            let code = encode(&payload, size, ecc, mode, typ, logo).unwrap_or_else(|e| fail(&e));
            let (w, h, img) = render(&code, radius);
            let png = write_png(w, h, &img).unwrap_or_else(|e| fail(&e));
            std::fs::write(out, &png).unwrap_or_else(|e| fail(&e.to_string()));
            if let Some(sj) = arg(&a, "symbols", None) {
                let mut s = format!("{{\"size\":{},\"ecc\":{},\"mode\":{},\"C\":{},\"R\":{},\"symbols\":[",
                    code.size, code.ecc, code.mode, code.layout.c, code.layout.r);
                for (i, v) in code.symbols.iter().enumerate() {
                    if i > 0 { s.push(','); }
                    s.push_str(&v.to_string());
                }
                s.push_str("]}");
                std::fs::write(sj, s).unwrap_or_else(|e| fail(&e.to_string()));
            }
            println!("wrote {} ({}x{} px, grid {}x{} cells, size {}, {}, ecc {}, {} payload bytes)",
                out, w, h, code.layout.c, code.layout.r, code.size, mode_name(mode), ecc, payload.len());
            println!("capacity at these settings: {} payload bytes", code.cap_payload);
        }
        "decode" => {
            if a.len() < 2 { fail("need png path"); }
            let buf = std::fs::read(&a[1]).unwrap_or_else(|e| fail(&e.to_string()));
            let (payload, hdr) = decode_png(&buf).unwrap_or_else(|e| fail(&e));
            match arg(&a, "out", None) {
                Some(out) => {
                    std::fs::write(out, &payload).unwrap_or_else(|e| fail(&e.to_string()));
                    println!("wrote {} ({} bytes)", out, payload.len());
                }
                None => {
                    use std::io::Write;
                    std::io::stdout().write_all(&payload).unwrap();
                    if !payload.is_empty() { println!(); }
                }
            }
            eprintln!("header: size {}, ecc {}, mode {}, type {}, {} payload bytes, CRC-32 OK",
                hdr.size, hdr.ecc, mode_name(hdr.mode), hdr.typ, hdr.length);
        }
        "secure-genkey" => {
            let (priv_, pub_) = secure::generate_signing_key();
            println!("fingerprint: {}", secure::fingerprint(&pub_));
            if let Some(out) = arg(&a, "o", None) {
                save_key(out, &priv_, &pub_).unwrap_or_else(|e| fail(&e));
                println!("wrote {}", out);
            }
        }
        "secure-seal" => {
            let inp = positional(&a).unwrap_or_else(|| usage());
            let data = std::fs::read(&inp).unwrap_or_else(|e| fail(&e.to_string()));
            let mut priv_: Option<Vec<u8>> = None;
            let mut pub_: Option<Vec<u8>> = None;
            if let Some(keyf) = arg(&a, "sign-key", None) {
                match load_key(keyf) {
                    Ok((pr, pu)) => {
                        priv_ = Some(pr);
                        pub_ = Some(pu);
                    }
                    Err(_) => fail(&format!("bad key file {}", keyf)),
                }
            }
            let sealed = secure::seal(
                &data,
                arg(&a, "password", Some("")).unwrap(),
                arg(&a, "kdf", Some("argon2id")).unwrap(),
                priv_.as_deref(),
                pub_.as_deref(),
            )
            .unwrap_or_else(|_| fail("sealing failed (need --password and/or --sign-key)"));
            match arg(&a, "o", None) {
                Some(out) => {
                    std::fs::write(out, &sealed).unwrap_or_else(|e| fail(&e.to_string()));
                    println!("wrote {} ({} -> {} bytes)", out, data.len(), sealed.len());
                }
                None => {
                    use std::io::Write;
                    std::io::stdout().write_all(&sealed).unwrap();
                }
            }
        }
        "secure-open" => {
            let inp = positional(&a).unwrap_or_else(|| usage());
            let data = std::fs::read(&inp).unwrap_or_else(|e| fail(&e.to_string()));
            let r = secure::open(&data, arg(&a, "password", Some("")).unwrap(), None);
            if r.signature_valid == 0 {
                fail(&r.err.unwrap_or_else(|| "bad signature".into()));
            }
            let bytes = match r.bytes {
                Some(b) => b,
                None => match r.err {
                    Some(m) => fail(&m),
                    None => fail("needs a password"),
                },
            };
            if r.signed {
                eprintln!("signature: valid, signer {}", r.signer_fingerprint);
            }
            match arg(&a, "o", None) {
                Some(out) => {
                    std::fs::write(out, &bytes).unwrap_or_else(|e| fail(&e.to_string()));
                    println!("wrote {} ({} bytes)", out, bytes.len());
                }
                None => {
                    use std::io::Write;
                    std::io::stdout().write_all(&bytes).unwrap();
                    println!();
                }
            }
        }
        "secure-passphrase" => println!("{}", secure::generate_passphrase()),
        "secure-strength" => {
            let pw = match arg(&a, "password", None) {
                Some(p) => p.to_string(),
                None => positional(&a).unwrap_or_default(),
            };
            let (bits, level, label) = secure::strength(&pw);
            println!("{} bits, level {} ({})", bits, level, label);
        }
        "parts-split" => {
            let inp = positional(&a).unwrap_or_else(|| usage());
            let outdir = arg(&a, "o", None).unwrap_or_else(|| usage());
            let name = arg(&a, "name", Some("file")).unwrap();
            let size: usize = arg(&a, "size", Some("3")).unwrap().parse().unwrap_or(3);
            let data = std::fs::read(&inp).unwrap_or_else(|e| fail(&e.to_string()));
            let parts = parts::split_file(&data, name, size).unwrap_or_else(|e| fail(&e));
            std::fs::create_dir_all(outdir).unwrap_or_else(|e| fail(&e.to_string()));
            for (i, p) in parts.iter().enumerate() {
                std::fs::write(format!("{}/part-{:02}.bin", outdir, i + 1), p)
                    .unwrap_or_else(|e| fail(&e.to_string()));
            }
            println!("{} parts written to {} (encode each at --ecc 2, color mode)", parts.len(), outdir);
        }
        "parts-join" => {
            let mut asm = parts::Assembler::default();
            let mut out = arg(&a, "o", None).map(|s| s.to_string());
            let mut nfiles = 0;
            let mut i = 1;
            while i < a.len() {
                if a[i] == "-o" || a[i] == "--o" {
                    i += 2;
                    continue;
                }
                let data = std::fs::read(&a[i]).unwrap_or_else(|_| fail(&format!("cannot read {}", a[i])));
                nfiles += 1;
                let (st, pn, msg) = asm.add(&data);
                match st {
                    parts::NOT_PART => fail(&format!("{} is not a part", a[i])),
                    parts::BAD | parts::OTHER => fail(&msg),
                    parts::DUPLICATE => {}
                    _ => println!("part {} of {} added ({}/{})", pn, asm.total, asm.have, asm.total),
                }
                i += 1;
            }
            if nfiles == 0 {
                usage();
            }
            let (res, name) = asm.finish().unwrap_or_else(|e| fail(&e));
            if out.is_none() {
                out = Some(name);
            }
            let out = out.unwrap();
            std::fs::write(&out, &res).unwrap_or_else(|e| fail(&e.to_string()));
            println!("wrote {} ({} bytes, whole-file check passed)", out, res.len());
        }
        "card-build" => {
            if a.len() < 2 {
                usage();
            }
            let kind = a[1].as_str();
            let hidden = has_arg(&a, "hidden");
            let payload = match kind {
                "wifi" => cards::wifi_build(
                    arg(&a, "ssid", Some("")).unwrap(),
                    arg(&a, "sec", Some("WPA")).unwrap(),
                    arg(&a, "pass", Some("")).unwrap(),
                    hidden,
                ),
                "vcard" => cards::vcard_build(
                    arg(&a, "name", Some("")).unwrap(),
                    arg(&a, "org", Some("")).unwrap(),
                    arg(&a, "title", Some("")).unwrap(),
                    arg(&a, "phone", Some("")).unwrap(),
                    arg(&a, "email", Some("")).unwrap(),
                    arg(&a, "url", Some("")).unwrap(),
                    arg(&a, "addr", Some("")).unwrap(),
                    arg(&a, "note", Some("")).unwrap(),
                ),
                "ticket" => cards::ticket_build(
                    arg(&a, "expiry-ms", Some("0")).unwrap().parse().unwrap_or(0),
                    arg(&a, "text", Some("")).unwrap(),
                ),
                _ => usage(),
            };
            match arg(&a, "o", None) {
                Some(out) => {
                    std::fs::write(out, &payload).unwrap_or_else(|e| fail(&e.to_string()));
                    println!("wrote {} ({} bytes)", out, payload.len());
                }
                None => println!("{}", payload),
            }
        }
        "card-parse" => {
            if a.len() < 2 {
                usage();
            }
            let data = std::fs::read(&a[1]).unwrap_or_else(|e| fail(&e.to_string()));
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Some(t) = cards::ticket_parse(&text) {
                println!("ticket: expires {}, body:\n{}", t.expiry_ms, t.body);
            } else if let Some(w) = cards::wifi_parse(&text) {
                println!(
                    "wifi: ssid {:?} security {} password {:?}{}",
                    w.ssid,
                    w.sec,
                    w.pass,
                    if w.hidden { " hidden" } else { "" }
                );
            } else if let Some(v) = cards::vcard_parse(&text) {
                print!("contact: {}", v.name);
                if !v.org.is_empty() {
                    print!(", {}", v.org);
                }
                if !v.title.is_empty() {
                    print!(" ({})", v.title);
                }
                println!();
                for p in &v.phones {
                    println!("  phone: {}", p);
                }
                for e in &v.emails {
                    println!("  email: {}", e);
                }
                for u in &v.urls {
                    println!("  url: {}", u);
                }
                if !v.addr.is_empty() {
                    println!("  address: {}", v.addr);
                }
                if !v.note.is_empty() {
                    println!("  note: {}", v.note);
                }
            } else {
                println!("not a card payload");
            }
        }
        "issuer" => {
            let inp = positional(&a).unwrap_or_else(|| usage());
            let mut data = std::fs::read(&inp).unwrap_or_else(|e| fail(&e.to_string()));
            if data.len() > 8 && data[0] == 0x89 && data[1] == b'P' && data[2] == b'N' && data[3] == b'G' {
                let (dec, _) = decode_png(&data).unwrap_or_else(|e| fail(&e));
                data = dec;
            }
            match issuers::identify(&data) {
                None => println!("not a signed Prism Secure payload"),
                Some(id) => {
                    if !id.signature_valid {
                        println!("Signature check failed. This code was changed after it was signed, or was not signed by the key it names.");
                    } else {
                        print!("signature: valid, signer {}", id.fingerprint);
                        if let Some(lp) = arg(&a, "list", None) {
                            let list = issuers::load(lp);
                            match issuers::find_index(&list, &id.fingerprint) {
                                Some(idx) => print!(", issuer: {}", list[idx].name),
                                None => print!(" (not on the issuer list)"),
                            }
                        }
                        println!();
                        if id.has_message {
                            println!("message: {}", id.message);
                        } else if id.encrypted {
                            println!("the content is locked with a password");
                        }
                    }
                }
            }
        }
        "capacity" => {
            for s in 0..6 {
                for ecc in 0..4 {
                    for mode in 0..2 {
                        let cap = capacity(s, ecc, mode);
                        println!("size {} ({}x{}) ecc {} {}: {} payload bytes",
                            s, SIZES[s].0, SIZES[s].1, ecc, mode_name(mode), cap.payload);
                    }
                }
            }
        }
        _ => fail(&format!("unknown command {}", a[0])),
    }
}
