// Prism verified issuers: identify signed Prism Secure payloads and look the
// signer up in an issuer list, same semantics as prism-issuers.js and the
// C/Go/Kotlin ports.

use crate::secure::{fingerprint, p256_verify};

pub struct IdentifyResult {
    pub signature_valid: bool,
    pub fingerprint: String,
    pub encrypted: bool,
    pub message: String, // decoded text for valid, unencrypted signed payloads
    pub has_message: bool,
}

// identify inspects decoded payload bytes. None for plain or unsigned
// payloads. Never decrypts.
pub fn identify(b: &[u8]) -> Option<IdentifyResult> {
    if b.len() < 5 + 65 + 64 {
        return None;
    }
    if b[0] != b'P' || b[1] != b'S' || b[2] != b'C' {
        return None;
    }
    if b[3] != 1 && b[3] != 2 {
        return None;
    }
    if b[4] & 2 == 0 {
        return None;
    }
    let end = b.len();
    let pub_ = &b[end - 129..end - 64];
    let sig = &b[end - 64..end];
    let body = &b[..end - 129];
    let mut out = IdentifyResult {
        signature_valid: p256_verify(pub_, body, sig),
        fingerprint: fingerprint(pub_),
        encrypted: b[4] & 1 != 0,
        message: String::new(),
        has_message: false,
    };
    if out.signature_valid && !out.encrypted && body.len() >= 5 {
        if let Ok(m) = std::str::from_utf8(&body[5..]) {
            out.message = m.to_string();
            out.has_message = true;
        }
    }
    Some(out)
}

#[derive(serde::Deserialize)]
pub struct Issuer {
    pub name: String,
    pub fingerprint: String,
}

#[derive(serde::Deserialize)]
struct IssuersDoc {
    issuers: Vec<Issuer>,
}

// load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
pub fn load(path: &str) -> Vec<Issuer> {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    if data.len() > 1 << 20 {
        return Vec::new();
    }
    match serde_json::from_slice::<IssuersDoc>(&data) {
        Ok(doc) => doc.issuers,
        Err(_) => Vec::new(),
    }
}

pub fn norm_fp(in_fp: &str) -> String {
    let mut b = String::new();
    for c in in_fp.chars() {
        if b.len() >= 15 {
            break;
        }
        if c.is_ascii_hexdigit() {
            b.push(c.to_ascii_uppercase());
        }
    }
    b
}

// find_index: normalized fingerprint match (case-insensitive, separators ignored).
pub fn find_index(list: &[Issuer], fingerprint: &str) -> Option<usize> {
    let want = norm_fp(fingerprint);
    for (i, it) in list.iter().enumerate() {
        if norm_fp(&it.fingerprint) == want {
            return Some(i);
        }
    }
    None
}
