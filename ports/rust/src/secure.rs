// Prism Secure (envelope v2, reads v1): AES-256-GCM payload locking with
// Argon2id (128 MiB, 3 passes) or PBKDF2-SHA256 (600,000 rounds), and
// ECDSA P-256 / SHA-256 signing with RFC 6979 deterministic nonces and
// P1363 r||s signatures, byte-compatible with the live site's
// prism-secure.html JS and the C/Go/Kotlin ports.
//
// Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
// normalization first; this port does not ship a Unicode normalizer, so
// non-ASCII passwords should already be in composed (NFC) form. ASCII
// passwords are unaffected.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, Mac};
use num_bigint::{BigInt, Sign};
use num_traits::{One, Zero};
use sha2::{Digest, Sha256};

pub const ARGON2_MEM: u32 = 131072;
pub const ARGON2_T: u32 = 3;
pub const ARGON2_P: u32 = 1;
pub const PBKDF2_ITER: u32 = 600000;

pub const FLAG_ENC: u8 = 1;
pub const FLAG_SIG: u8 = 2;
pub const HEAD2: usize = 4 + 1 + 1 + 6 + 16 + 12;
pub const HEAD1: usize = 4 + 1 + 16 + 12 + 4;

pub const MAGIC: [u8; 3] = [b'P', b'S', b'C'];

pub fn be32w(b: &mut [u8], off: usize, n: u32) {
    b[off..off + 4].copy_from_slice(&n.to_be_bytes());
}

pub fn be32r(b: &[u8], off: usize) -> u32 {
    u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

fn sha256(d: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(d);
    h.finalize().into()
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).unwrap();
    m.update(data);
    m.finalize().into_bytes().to_vec()
}

// PBKDF2-SHA256 directly on HMAC so the password is its exact UTF-8 bytes.
pub fn pbkdf2_sha256(pw: &[u8], salt: &[u8], iter: u32, key_len: usize) -> Vec<u8> {
    let mut out = vec![0u8; key_len];
    let mut block: u32 = 1;
    let mut done = 0;
    while done < key_len {
        let mut inp = salt.to_vec();
        inp.extend_from_slice(&block.to_be_bytes());
        let mut u = hmac_sha256(pw, &inp);
        let mut t = u.clone();
        for _ in 1..iter {
            u = hmac_sha256(pw, &u);
            for j in 0..t.len() {
                t[j] ^= u[j];
            }
        }
        let n = std::cmp::min(32, key_len - done);
        out[done..done + n].copy_from_slice(&t[..n]);
        done += n;
        block += 1;
    }
    out
}

pub fn argon2id_key(pw: &[u8], salt: &[u8], mem_kib: u32, t: u32, lanes: u32, key_len: usize) -> Result<Vec<u8>, String> {
    if !(8192..=262144).contains(&mem_kib) || !(1..=12).contains(&t) || !(1..=4).contains(&lanes) {
        return Err("argon2id parameters out of range".into());
    }
    let params = Params::new(mem_kib, t, lanes, Some(key_len)).map_err(|e| e.to_string())?;
    let a = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = vec![0u8; key_len];
    a.hash_password_into(pw, salt, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn aes256gcm_encrypt(key: &[u8], iv: &[u8], aad: &[u8], pt: &[u8]) -> Result<(Vec<u8>, Vec<u8>), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = aes_gcm::Nonce::from_slice(iv);
    let sealed = cipher
        .encrypt(nonce, Payload { msg: pt, aad })
        .map_err(|e| e.to_string())?;
    Ok((sealed[..pt.len()].to_vec(), sealed[pt.len()..].to_vec()))
}

pub fn aes256gcm_decrypt(key: &[u8], iv: &[u8], aad: &[u8], ct: &[u8], tag: &[u8]) -> Option<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = aes_gcm::Nonce::from_slice(iv);
    let mut buf = ct.to_vec();
    buf.extend_from_slice(tag);
    cipher.decrypt(nonce, Payload { msg: &buf, aad }).ok()
}

// ------------------------------------------------------------- P-256 / RFC 6979

fn hexbi(s: &str) -> BigInt {
    BigInt::parse_bytes(s.as_bytes(), 16).unwrap()
}

fn p() -> BigInt { hexbi("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF") }
fn n_order() -> BigInt { hexbi("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551") }
fn a_coef() -> BigInt { p() - BigInt::from(3) }
fn b_coef() -> BigInt { hexbi("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B") }
fn g() -> (BigInt, BigInt) {
    (
        hexbi("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296"),
        hexbi("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5"),
    )
}

fn euc_mod(a: &BigInt, m: &BigInt) -> BigInt {
    ((a % m) + m) % m
}

fn mod_inv(a: &BigInt, m: &BigInt) -> Option<BigInt> {
    let zero = BigInt::zero();
    let one = BigInt::one();
    let (mut t, mut new_t) = (zero.clone(), one.clone());
    let (mut r, mut new_r) = (m.clone(), euc_mod(a, m));
    while !new_r.is_zero() {
        let q = &r / &new_r;
        let tmp_t = &t - &q * &new_t;
        t = new_t;
        new_t = tmp_t;
        let tmp_r = &r - &q * &new_r;
        r = new_r;
        new_r = tmp_r;
    }
    if r != one {
        return None;
    }
    Some(euc_mod(&t, m))
}

type Pt = (BigInt, BigInt);

fn pt_add(pa: &Option<Pt>, qa: &Option<Pt>) -> Option<Pt> {
    let pp = p();
    let (px, py) = match pa {
        None => return qa.clone(),
        Some(v) => v.clone(),
    };
    let (qx, qy) = match qa {
        None => return Some((px, py)),
        Some(v) => v.clone(),
    };
    if px == qx {
        if py != qy {
            return None; // p + (-p) = infinity
        }
        if py.is_zero() {
            return None;
        }
        let m = euc_mod(&((&px * &px * BigInt::from(3) + a_coef()) * &mod_inv(&(BigInt::from(2) * &py), &pp)?), &pp);
        let x = euc_mod(&(&m * &m - BigInt::from(2) * &px), &pp);
        let y = euc_mod(&(&m * (&px - &x) - &py), &pp);
        return Some((x, y));
    }
    let m = euc_mod(&((&qy - &py) * &mod_inv(&euc_mod(&(&qx - &px), &pp), &pp)?), &pp);
    let x = euc_mod(&(&m * &m - &px - &qx), &pp);
    let y = euc_mod(&(&m * (&px - &x) - &py), &pp);
    Some((x, y))
}

fn pt_mul(k: &BigInt, p: &Option<Pt>) -> Option<Pt> {
    let mut k = k.clone();
    let mut p = p.clone();
    let mut r: Option<Pt> = None;
    while k.sign() != Sign::NoSign {
        if k.bit(0) {
            r = pt_add(&r, &p);
        }
        p = pt_add(&p, &p);
        k >>= 1;
    }
    r
}

fn is_on_curve(pt: &Pt) -> bool {
    let pp = p();
    let l = euc_mod(&(&pt.1 * &pt.1), &pp);
    let r = euc_mod(&((&pt.0 * &pt.0 + a_coef()) * &pt.0 + b_coef()), &pp);
    l == r
}

fn bi_from(b: &[u8]) -> BigInt {
    BigInt::from_bytes_be(Sign::Plus, b)
}

// rfc6979_k derives the deterministic nonce exactly like the C reference:
// HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
fn rfc6979_k(priv_: &[u8], hash: &[u8]) -> BigInt {
    let nn = n_order();
    let mut v = vec![1u8; 32];
    let mut k = vec![0u8; 32];
    let mut bx = priv_.to_vec();
    bx.extend_from_slice(hash);
    let mut buf = v.clone();
    buf.push(0);
    buf.extend_from_slice(&bx);
    k = hmac_sha256(&k, &buf);
    v = hmac_sha256(&k, &v);
    let mut buf = v.clone();
    buf.push(1);
    buf.extend_from_slice(&bx);
    k = hmac_sha256(&k, &buf);
    v = hmac_sha256(&k, &v);
    loop {
        v = hmac_sha256(&k, &v);
        let kk = bi_from(&v);
        if kk.sign() != Sign::NoSign && kk < nn {
            return kk;
        }
        let mut buf = v.clone();
        buf.push(0);
        k = hmac_sha256(&k, &buf);
        v = hmac_sha256(&k, &v);
    }
}

fn pad32(x: &BigInt) -> [u8; 32] {
    let (_, b) = x.to_bytes_be();
    let mut out = [0u8; 32];
    let n = b.len().min(32);
    out[32 - n..].copy_from_slice(&b[b.len() - n..]);
    out
}

// p256_sign produces a deterministic P1363 r||s signature, low-s normalized.
pub fn p256_sign(priv_: &[u8], msg: &[u8]) -> [u8; 64] {
    let nn = n_order();
    let half = &nn / BigInt::from(2);
    let hash = sha256(msg);
    let d = bi_from(priv_);
    let mut e = bi_from(&hash);
    if e >= nn {
        e -= &nn;
    }
    loop {
        let k = rfc6979_k(priv_, &hash);
        let pt = match pt_mul(&k, &Some(g())) {
            Some(p) => p,
            None => continue,
        };
        let r = euc_mod(&pt.0, &nn);
        if r.is_zero() {
            continue;
        }
        let kinv = mod_inv(&k, &nn).unwrap();
        let mut s = euc_mod(&(&kinv * (&e + &d * &r)), &nn);
        if s.is_zero() {
            continue;
        }
        if s > half {
            s = &nn - &s;
        }
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&pad32(&r));
        sig[32..].copy_from_slice(&pad32(&s));
        return sig;
    }
}

pub fn p256_verify(pub_: &[u8], msg: &[u8], sig: &[u8]) -> bool {
    if pub_.len() != 65 || pub_[0] != 4 || sig.len() != 64 {
        return false;
    }
    let nn = n_order();
    let q = (bi_from(&pub_[1..33]), bi_from(&pub_[33..65]));
    if !is_on_curve(&q) {
        return false;
    }
    let hash = sha256(msg);
    let mut e = bi_from(&hash);
    if e >= nn {
        e -= &nn;
    }
    let r = bi_from(&sig[..32]);
    let s = bi_from(&sig[32..]);
    if r.sign() == Sign::NoSign || r >= nn || s.sign() == Sign::NoSign || s >= nn {
        return false;
    }
    let w = match mod_inv(&s, &nn) {
        Some(w) => w,
        None => return false,
    };
    let u1 = euc_mod(&(&e * &w), &nn);
    let u2 = euc_mod(&(&r * &w), &nn);
    let pt = match pt_add(&pt_mul(&u1, &Some(g())), &pt_mul(&u2, &Some(q.clone()))) {
        Some(p) => p,
        None => return false,
    };
    euc_mod(&pt.0, &nn) == r
}

pub fn p256_keygen(priv_: &[u8]) -> Vec<u8> {
    let pt = pt_mul(&bi_from(priv_), &Some(g())).unwrap();
    let mut pub_ = vec![4u8];
    pub_.extend_from_slice(&pad32(&pt.0));
    pub_.extend_from_slice(&pad32(&pt.1));
    pub_
}

// ------------------------------------------------------------- secure envelope

// fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
pub fn fingerprint(pub_: &[u8]) -> String {
    let h = sha256(pub_);
    let mut s = String::new();
    for i in 0..8 {
        s.push_str(&format!("{:02X}", h[i]));
        if i % 2 == 1 && i < 7 {
            s.push('-');
        }
    }
    s
}

// generate_signing_key draws a non-zero 32-byte private key; returns (priv, pub).
pub fn generate_signing_key() -> (Vec<u8>, Vec<u8>) {
    use rand::RngCore;
    loop {
        let mut priv_ = vec![0u8; 32];
        rand::thread_rng().fill_bytes(&mut priv_);
        if priv_.iter().any(|&b| b != 0) {
            let pub_ = p256_keygen(&priv_);
            return (priv_, pub_);
        }
    }
}

fn derive_key(password: &str, salt: &[u8], kdf: u8, iter: u32, mem: u32, t: u32, lanes: u32) -> Result<Vec<u8>, String> {
    let pw = password.as_bytes();
    if kdf == 2 {
        argon2id_key(pw, salt, mem, t, lanes, 32)
    } else {
        Ok(pbkdf2_sha256(pw, salt, iter, 32))
    }
}

// seal locks (password != "", kdf "argon2id"|"pbkdf2") and/or signs
// (priv present) data. At least one of the two.
pub fn seal(data: &[u8], password: &str, kdf: &str, priv_: Option<&[u8]>, pub_: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use rand::RngCore;
    if password.is_empty() && priv_.is_none() {
        return Err("need a password, a signing key, or both".into());
    }
    let use_a = kdf.is_empty() || kdf == "argon2id";
    let mut flags = 0u8;
    if !password.is_empty() {
        flags |= FLAG_ENC;
    }
    if priv_.is_some() {
        flags |= FLAG_SIG;
    }
    let mut body: Vec<u8>;
    if !password.is_empty() {
        let mut salt = vec![0u8; 16];
        let mut iv = vec![0u8; 12];
        rand::thread_rng().fill_bytes(&mut salt);
        rand::thread_rng().fill_bytes(&mut iv);
        body = vec![0u8; HEAD2];
        body[0..3].copy_from_slice(&MAGIC);
        body[3] = 2;
        body[4] = flags;
        if use_a {
            body[5] = 2;
            be32w(&mut body, 6, ARGON2_MEM);
            body[10] = ARGON2_T as u8;
            body[11] = ARGON2_P as u8;
        } else {
            body[5] = 1;
            be32w(&mut body, 6, PBKDF2_ITER);
        }
        body[12..28].copy_from_slice(&salt);
        body[28..40].copy_from_slice(&iv);
        let key = derive_key(
            password,
            &salt,
            if use_a { 2 } else { 1 },
            PBKDF2_ITER,
            ARGON2_MEM,
            ARGON2_T,
            ARGON2_P,
        )?;
        let (ct, tag) = aes256gcm_encrypt(&key, &iv, &body, data)?;
        body.extend_from_slice(&ct);
        body.extend_from_slice(&tag);
    } else {
        body = Vec::with_capacity(5 + data.len());
        body.extend_from_slice(&MAGIC);
        body.push(2);
        body.push(flags);
        body.extend_from_slice(data);
    }
    if priv_.is_none() {
        return Ok(body);
    }
    let sig = p256_sign(priv_.unwrap(), &body);
    let mut full = body;
    full.extend_from_slice(pub_.unwrap());
    full.extend_from_slice(&sig);
    Ok(full)
}

pub fn is_secure(b: &[u8]) -> bool {
    b.len() >= 6 && b[0] == b'P' && b[1] == b'S' && b[2] == b'C' && (b[3] == 1 || b[3] == 2) && (b[4] & !3) == 0
}

// inspect reports whether the payload is (encrypted, signed).
pub fn inspect(b: &[u8]) -> (bool, bool) {
    if !is_secure(b) {
        return (false, false);
    }
    (b[4] & FLAG_ENC != 0, b[4] & FLAG_SIG != 0)
}

#[derive(Default)]
pub struct OpenResult {
    pub secure: bool,
    pub version: u8,
    pub encrypted: bool,
    pub signed: bool,
    pub signature_valid: i8, // -1 n/a, 0 invalid, 1 valid
    pub signer_fingerprint: String,
    pub trusted: bool,
    pub bytes: Option<Vec<u8>>,
    pub needs_password: bool,
    pub err: Option<String>,
}

// open opens a payload; plain input passes through. Errors are reported in
// err with bytes None (wrong password / tamper / invalid signature), never a
// wrong payload.
pub fn open(b: &[u8], password: &str, trusted_fps: Option<&[String]>) -> OpenResult {
    let mut res = OpenResult {
        signature_valid: -1,
        ..Default::default()
    };
    if !is_secure(b) {
        res.bytes = Some(b.to_vec());
        return res;
    }
    let ver = b[3];
    let flags = b[4];
    let encrypted = flags & FLAG_ENC != 0;
    let sgn = flags & FLAG_SIG != 0;
    res.secure = true;
    res.version = ver;
    res.encrypted = encrypted;
    res.signed = sgn;
    let mut end = b.len();
    if sgn {
        if b.len() < 5 + 65 + 64 {
            res.err = Some("Code is damaged".into());
            return res;
        }
        let pub_ = &b[end - 129..end - 64];
        let sig = &b[end - 64..end];
        res.signature_valid = if p256_verify(pub_, &b[..end - 129], sig) { 1 } else { 0 };
        res.signer_fingerprint = fingerprint(pub_);
        if res.signature_valid == 1 {
            if let Some(fps) = trusted_fps {
                if fps.iter().any(|fp| fp == &res.signer_fingerprint) {
                    res.trusted = true;
                }
            }
        }
        end -= 129;
        if res.signature_valid != 1 {
            res.err = Some("Signature is not valid. This code was changed or forged.".into());
            return res;
        }
    }
    if !encrypted {
        res.bytes = Some(b[5..end].to_vec());
        return res;
    }
    let hl: usize;
    let salt: &[u8];
    let iv: &[u8];
    let kdf: u8;
    let mut iter = 0u32;
    let mut mem = 0u32;
    let mut t = 0u32;
    let mut lanes = 0u32;
    if ver == 1 {
        hl = HEAD1;
        if end < hl + 16 {
            res.err = Some("Code is damaged".into());
            return res;
        }
        salt = &b[5..21];
        iv = &b[21..33];
        kdf = 1;
        iter = be32r(b, 33);
    } else {
        hl = HEAD2;
        if end < hl + 16 {
            res.err = Some("Code is damaged".into());
            return res;
        }
        kdf = b[5];
        salt = &b[12..28];
        iv = &b[28..40];
        if kdf == 2 {
            mem = be32r(b, 6);
            t = b[10] as u32;
            lanes = b[11] as u32;
        } else {
            iter = be32r(b, 6);
        }
    }
    if (kdf == 1 && !(100000..=5000000).contains(&iter))
        || (kdf == 2 && (!(8192..=262144).contains(&mem) || !(1..=12).contains(&t) || !(1..=4).contains(&lanes)))
        || (kdf != 1 && kdf != 2)
    {
        res.err = Some("Code is damaged or unsupported".into());
        return res;
    }
    if password.is_empty() {
        res.needs_password = true;
        return res;
    }
    let key = match derive_key(password, salt, kdf, iter, mem, t, lanes) {
        Ok(k) => k,
        Err(_) => {
            res.err = Some("Key derivation failed".into());
            return res;
        }
    };
    match aes256gcm_decrypt(&key, iv, &b[..hl], &b[hl..end - 16], &b[end - 16..end]) {
        Some(pt) => res.bytes = Some(pt),
        None => res.err = Some("Wrong password, or the code was changed.".into()),
    }
    res
}

// generate_passphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
pub fn generate_passphrase() -> String {
    use rand::RngCore;
    let alpha = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut r = [0u8; 28];
    rand::thread_rng().fill_bytes(&mut r);
    let mut s = String::new();
    for g in 0..7 {
        if g > 0 {
            s.push('-');
        }
        for i in 0..4 {
            s.push(alpha[(r[g * 4 + i] & 31) as usize] as char);
        }
    }
    s
}

// strength estimates password strength; same heuristic as the site.
// Returns (bits, level 0-4, label).
pub fn strength(pw: &str) -> (i32, i32, String) {
    let labels = ["weak", "weak", "fair", "good", "strong"];
    let pb = pw.as_bytes();
    let n = pb.len();
    if n == 0 {
        return (0, 0, "none".into());
    }
    // generated-passphrase shape
    {
        let mut groups = 1;
        let mut ok = true;
        let mut body = 0;
        for &c in pb {
            if c == b'-' {
                groups += 1;
                continue;
            }
            if !(c.is_ascii_uppercase() && c != b'I' && c != b'O') && !(b'2'..=b'9').contains(&c) {
                ok = false;
                break;
            }
            body += 1;
        }
        if groups >= 6 && ok && body >= 24 {
            return (body * 5, 4, "excellent (random)".into());
        }
    }
    let mut lo = false;
    let mut up = false;
    let mut dig = false;
    let mut sym = false;
    for &c in pb {
        match c {
            b'a'..=b'z' => lo = true,
            b'A'..=b'Z' => up = true,
            b'0'..=b'9' => dig = true,
            _ => sym = true,
        }
    }
    let mut pool = 0i32;
    if lo {
        pool += 26;
    }
    if up {
        pool += 26;
    }
    if dig {
        pool += 10;
    }
    if sym {
        pool += 33;
    }
    if pool < 2 {
        pool = 2;
    }
    let mut lp = 0.0f64;
    {
        let mut p = pool;
        while p > 1 {
            lp += 1.0;
            p >>= 1;
        }
        let base = 1i32 << (lp as i32);
        lp += (pool - base) as f64 / base as f64;
    }
    let mut uniq = 0;
    for i in 0..n {
        let mut seen = false;
        for j in 0..i {
            if pb[j] == pb[i] {
                seen = true;
            }
        }
        if !seen {
            uniq += 1;
        }
    }
    let mut cap_n = n;
    if uniq * 2 < n {
        cap_n = uniq * 2;
    }
    let mut bits = cap_n as f64 * lp;
    for i in 0..n.saturating_sub(2) {
        if pb[i] == pb[i + 1] && pb[i] == pb[i + 2] {
            bits *= 0.7;
            break;
        }
    }
    let seqs = [
        "012", "123", "234", "345", "456", "567", "678", "789", "abc", "bcd", "cde", "def", "qwe", "wer", "asd",
        "sdf", "zxc",
    ];
    'outer: for sq in seqs {
        let sb = sq.as_bytes();
        for i in 0..n.saturating_sub(2) {
            if pb[i] | 32 == sb[0] && pb[i + 1] | 32 == sb[1] && pb[i + 2] | 32 == sb[2] {
                bits *= 0.7;
                break 'outer;
            }
        }
    }
    if (lo && !up && !dig && !sym) || (dig && !lo && !up && !sym) {
        bits *= 0.8;
    }
    for i in 0..n.saturating_sub(3) {
        if (pb[i] == b'1' && pb[i + 1] == b'9') || (pb[i] == b'2' && pb[i + 1] == b'0') {
            if pb[i + 2].is_ascii_digit() && pb[i + 3].is_ascii_digit() {
                bits -= 8.0;
                break;
            }
        }
    }
    let common = [
        "password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon",
        "football", "baseball", "shalom", "israel", "master", "login", "abc123", "prism", "secret", "hello",
        "test", "summer", "winter", "sunshine", "princess", "trustno1", "whatever", "google", "avi", "1234",
        "asdf", "zxcv", "love", "god", "cohen", "levi",
    ];
    let low = pw.to_lowercase();
    for w in common {
        if low.contains(w) {
            if bits > 28.0 {
                bits = 28.0;
            }
            if low == w {
                bits -= 8.0;
            }
            break;
        }
    }
    let mut ibits = bits as i32;
    if ibits < 0 {
        ibits = 0;
    }
    let level = if ibits < 40 {
        0
    } else if ibits < 60 {
        1
    } else if ibits < 80 {
        2
    } else if ibits < 100 {
        3
    } else {
        4
    };
    (ibits, level, labels[level as usize].to_string())
}
