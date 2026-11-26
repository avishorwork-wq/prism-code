// Prism tickets and cards: Wi-Fi, contact card (vCard 3.0) and expiring
// ticket payload builders and parsers, payload-compatible with prism-cards.js
// and the C/Go/Kotlin ports.

pub fn esc_wifi(s: &str) -> String {
    let mut b = String::new();
    for c in s.chars() {
        if "\\;,:\"'".contains(c) {
            b.push('\\');
        }
        b.push(c);
    }
    b
}

// wifi_build builds the common WIFI: payload other readers agree on.
pub fn wifi_build(ssid: &str, sec: &str, pass: &str, hidden: bool) -> String {
    let t = if sec.is_empty() { "WPA" } else { sec };
    let mut b = String::new();
    b.push_str("WIFI:T:");
    b.push_str(t);
    b.push_str(";S:");
    b.push_str(&esc_wifi(ssid));
    b.push(';');
    if t != "nopass" {
        b.push_str("P:");
        b.push_str(&esc_wifi(pass));
        b.push(';');
    }
    if hidden {
        b.push_str("H:true;");
    }
    b.push(';');
    b
}

#[derive(Default)]
pub struct WifiCard {
    pub ssid: String,
    pub sec: String,
    pub pass: String,
    pub hidden: bool,
}

pub fn wifi_parse(text: &str) -> Option<WifiCard> {
    if text.len() < 5 || !text[..5].eq_ignore_ascii_case("WIFI:") {
        return None;
    }
    let body = text[5..].as_bytes();
    let mut out = WifiCard::default();
    let mut key: Vec<u8> = Vec::new();
    let mut val: Vec<u8> = Vec::new();
    let mut in_key = true;
    let mut have_ssid = false;
    let flush = |key: &[u8], val: &[u8], out: &mut WifiCard, have_ssid: &mut bool| {
        let k = String::from_utf8_lossy(key).to_uppercase();
        let v = String::from_utf8_lossy(val).into_owned();
        match k.as_str() {
            "S" => {
                out.ssid = v;
                *have_ssid = true;
            }
            "T" => out.sec = v.to_uppercase(),
            "P" => out.pass = v,
            "H" => out.hidden = v.eq_ignore_ascii_case("true"),
            _ => {}
        }
    };
    let mut i = 0usize;
    loop {
        let mut do_flush = false;
        if i >= body.len() {
            do_flush = true;
        } else {
            let c = body[i];
            if c == b'\\' && i + 1 < body.len() {
                if in_key {
                    key.push(body[i + 1]);
                } else {
                    val.push(body[i + 1]);
                }
                i += 2;
                continue;
            } else if in_key && c == b':' {
                in_key = false;
                i += 1;
                continue;
            } else if !in_key && c == b';' {
                do_flush = true;
            } else if in_key {
                key.push(c);
                i += 1;
                continue;
            } else {
                val.push(c);
                i += 1;
                continue;
            }
        }
        if do_flush {
            if !key.is_empty() {
                flush(&key, &val, &mut out, &mut have_ssid);
            }
            if i >= body.len() {
                break;
            }
            key.clear();
            val.clear();
            in_key = true;
            i += 1;
        }
    }
    if !have_ssid {
        return None;
    }
    if out.sec.is_empty() {
        out.sec = "WPA".into();
    }
    Some(out)
}

// ------------------------------------------------------------- vCard

pub fn esc_vcard(s: &str) -> String {
    let mut b = String::new();
    for c in s.chars() {
        if c == '\\' || c == ',' || c == ';' {
            b.push('\\');
        }
        if c == '\n' {
            b.push_str("\\n");
            continue;
        }
        b.push(c);
    }
    b
}

// vcard_build builds a vCard 3.0 payload. Any field may be empty.
pub fn vcard_build(
    name: &str,
    org: &str,
    title: &str,
    phone: &str,
    email: &str,
    url: &str,
    addr: &str,
    note: &str,
) -> String {
    let mut b = String::new();
    b.push_str("BEGIN:VCARD\r\nVERSION:3.0\r\n");
    b.push_str(&format!("FN:{}\r\n", esc_vcard(name)));
    if !name.is_empty() {
        let words: Vec<&str> = name.split_whitespace().collect();
        let first = if words.is_empty() { "" } else { words[0] };
        let rest = if words.len() > 1 { words[1..].join(" ") } else { "-".to_string() };
        b.push_str(&format!("N:{};{};;;\r\n", esc_vcard(&rest), esc_vcard(first)));
    }
    if !org.is_empty() {
        b.push_str(&format!("ORG:{}\r\n", esc_vcard(org)));
    }
    if !title.is_empty() {
        b.push_str(&format!("TITLE:{}\r\n", esc_vcard(title)));
    }
    if !phone.is_empty() {
        b.push_str(&format!("TEL;TYPE=CELL:{}\r\n", esc_vcard(phone)));
    }
    if !email.is_empty() {
        b.push_str(&format!("EMAIL:{}\r\n", esc_vcard(email)));
    }
    if !url.is_empty() {
        b.push_str(&format!("URL:{}\r\n", esc_vcard(url)));
    }
    if !addr.is_empty() {
        b.push_str(&format!("ADR;TYPE=WORK:;;{};;;;\r\n", esc_vcard(addr)));
    }
    if !note.is_empty() {
        b.push_str(&format!("NOTE:{}\r\n", esc_vcard(note)));
    }
    b.push_str("END:VCARD");
    b
}

#[derive(Default)]
pub struct Vcard {
    pub name: String,
    pub org: String,
    pub title: String,
    pub addr: String,
    pub note: String,
    pub phones: Vec<String>,
    pub emails: Vec<String>,
    pub urls: Vec<String>,
}

fn key_matches<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    if line.len() < key.len() || !line[..key.len()].eq_ignore_ascii_case(key) {
        return None;
    }
    let mut p = &line[key.len()..];
    if p.starts_with(';') {
        let idx = p.find(':')?;
        p = &p[idx..];
    }
    if !p.starts_with(':') {
        return None;
    }
    Some(&p[1..])
}

fn unesc_vcard(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            let c = b[i + 1];
            if c == b'n' || c == b'N' {
                out.push('\n');
                i += 2;
                continue;
            }
            if c == b',' || c == b';' || c == b'\\' {
                out.push(c as char);
                i += 2;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

pub fn vcard_parse(text: &str) -> Option<Vcard> {
    if !text.contains("BEGIN:VCARD") {
        return None;
    }
    // unfold continuation lines, drop \r, split on \n
    let tb = text.as_bytes();
    let mut flat: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < tb.len() {
        let c = tb[i];
        if c == b'\r' {
            i += 1;
            continue;
        }
        if c == b'\n' && i + 1 < tb.len() && (tb[i + 1] == b' ' || tb[i + 1] == b'\t') {
            i += 1;
            continue;
        }
        flat.push(c);
        i += 1;
    }
    let flat = String::from_utf8_lossy(&flat).into_owned();
    let mut out = Vcard::default();
    let mut found_fn = false;
    for line in flat.split('\n') {
        if let Some(v) = key_matches(line, "FN") {
            out.name = unesc_vcard(v);
            found_fn = true;
        } else if let Some(v) = key_matches(line, "ORG") {
            out.org = unesc_vcard(v);
        } else if let Some(v) = key_matches(line, "TITLE") {
            out.title = unesc_vcard(v);
        } else if let Some(v) = key_matches(line, "NOTE") {
            out.note = unesc_vcard(v);
        } else if let Some(v) = key_matches(line, "ADR") {
            let t = unesc_vcard(v);
            out.addr = t.trim_start_matches(';').trim_end_matches(';').to_string();
        } else if let Some(v) = key_matches(line, "EMAIL") {
            if out.emails.len() < 8 {
                out.emails.push(unesc_vcard(v));
            }
        } else if let Some(v) = key_matches(line, "TEL") {
            if out.phones.len() < 8 {
                out.phones.push(unesc_vcard(v));
            }
        } else if let Some(v) = key_matches(line, "URL") {
            if out.urls.len() < 8 {
                out.urls.push(unesc_vcard(v));
            }
        }
    }
    if !found_fn {
        return None;
    }
    Some(out)
}

// ------------------------------------------------------------- ticket

// ticket_build builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
pub fn ticket_build(expiry_ms: i64, text: &str) -> String {
    format!("PRISM-TICKET/1\nEXP:{}\n{}", expiry_ms / 1000, text.trim())
}

pub struct Ticket {
    pub expiry_ms: i64,
    pub body: String,
}

pub fn ticket_parse(text: &str) -> Option<Ticket> {
    let prefix = "PRISM-TICKET/1\nEXP:";
    if !text.starts_with(prefix) {
        return None;
    }
    let p = &text[prefix.len()..];
    let pb = p.as_bytes();
    if pb.is_empty() || !pb[0].is_ascii_digit() {
        return None;
    }
    let mut exp: i64 = 0;
    let mut i = 0;
    while i < pb.len() && pb[i].is_ascii_digit() {
        exp = exp * 10 + (pb[i] - b'0') as i64;
        i += 1;
    }
    if i >= pb.len() || pb[i] != b'\n' {
        return None;
    }
    let body = p[i + 1..].trim_end().to_string();
    Some(Ticket { expiry_ms: exp * 1000, body })
}

// detect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
pub fn detect(text: &str) -> i32 {
    if text.is_empty() {
        return 0;
    }
    if ticket_parse(text).is_some() {
        return 1;
    }
    if wifi_parse(text).is_some() {
        return 2;
    }
    if vcard_parse(text).is_some() {
        return 3;
    }
    0
}
