"use strict";
// Prism tickets and cards for the TypeScript port: Wi-Fi, contact card
// (vCard 3.0) and expiring ticket payload builders and parsers,
// payload-compatible with prism-cards.js and the C/Go/Kotlin/Rust/PHP/Ruby
// ports.
Object.defineProperty(exports, "__esModule", { value: true });
exports.wifiBuild = wifiBuild;
exports.wifiParse = wifiParse;
exports.vcardBuild = vcardBuild;
exports.vcardParse = vcardParse;
exports.ticketBuild = ticketBuild;
exports.ticketParse = ticketParse;
exports.detect = detect;
function escWifi(s) {
    return s.replace(/([\\;,:,"'])/g, "\\$1");
}
// wifi_build builds the common WIFI: payload other readers agree on.
function wifiBuild(ssid, sec, pass, hidden) {
    const t = sec.length === 0 ? "WPA" : sec;
    let b = `WIFI:T:${t};S:${escWifi(ssid)};`;
    if (t !== "nopass")
        b += `P:${escWifi(pass)};`;
    if (hidden)
        b += "H:true;";
    return b + ";";
}
// wifiParse returns the card or null.
function wifiParse(text) {
    if (text.length < 5 || text.slice(0, 5).toUpperCase() !== "WIFI:")
        return null;
    const body = text.slice(5);
    const n = body.length;
    const out = { ssid: "", sec: "", pass: "", hidden: false };
    let key = "";
    let val = "";
    let inKey = true;
    let haveSsid = false;
    const flush = () => {
        if (key.length > 0) {
            const k = key.toUpperCase();
            if (k === "S") {
                out.ssid = val;
                haveSsid = true;
            }
            else if (k === "T")
                out.sec = val.toUpperCase();
            else if (k === "P")
                out.pass = val;
            else if (k === "H")
                out.hidden = val.toLowerCase() === "true";
        }
    };
    let i = 0;
    for (;;) {
        const c = i < n ? body[i] : "";
        let doFlush = false;
        if (i >= n) {
            doFlush = true;
        }
        else if (c === "\\" && i + 1 < n) {
            if (inKey)
                key += body[i + 1];
            else
                val += body[i + 1];
            i += 2;
            continue;
        }
        else if (inKey && c === ":") {
            inKey = false;
            i += 1;
            continue;
        }
        else if (!inKey && c === ";") {
            doFlush = true;
        }
        else if (inKey) {
            key += c;
            i += 1;
            continue;
        }
        else {
            val += c;
            i += 1;
            continue;
        }
        if (doFlush) {
            flush();
            if (i >= n)
                break;
            key = "";
            val = "";
            inKey = true;
            i += 1;
        }
    }
    if (!haveSsid)
        return null;
    if (out.sec.length === 0)
        out.sec = "WPA";
    return out;
}
// ------------------------------------------------------------- vCard
function escVcard(s) {
    let out = "";
    for (const c of s) {
        if (c === "\\" || c === "," || c === ";")
            out += "\\";
        if (c === "\n") {
            out += "\\n";
            continue;
        }
        out += c;
    }
    return out;
}
// vcardBuild builds a vCard 3.0 payload. Any field may be empty.
function vcardBuild(name, org, title, phone, email, url, addr, note) {
    let b = "BEGIN:VCARD\r\nVERSION:3.0\r\n";
    b += `FN:${escVcard(name)}\r\n`;
    if (name.length > 0) {
        const words = name.trim().split(/\s+/);
        const first = words[0] || "";
        const rest = words.length > 1 ? words.slice(1).join(" ") : "-";
        b += `N:${escVcard(rest)};${escVcard(first)};;;\r\n`;
    }
    if (org.length > 0)
        b += `ORG:${escVcard(org)}\r\n`;
    if (title.length > 0)
        b += `TITLE:${escVcard(title)}\r\n`;
    if (phone.length > 0)
        b += `TEL;TYPE=CELL:${escVcard(phone)}\r\n`;
    if (email.length > 0)
        b += `EMAIL:${escVcard(email)}\r\n`;
    if (url.length > 0)
        b += `URL:${escVcard(url)}\r\n`;
    if (addr.length > 0)
        b += `ADR;TYPE=WORK:;;${escVcard(addr)};;;;\r\n`;
    if (note.length > 0)
        b += `NOTE:${escVcard(note)}\r\n`;
    return b + "END:VCARD";
}
function keyMatches(line, key) {
    if (line.length < key.length || line.slice(0, key.length).toLowerCase() !== key.toLowerCase())
        return null;
    let p = line.slice(key.length);
    if (p.startsWith(";")) {
        const idx = p.indexOf(":");
        if (idx < 0)
            return null;
        p = p.slice(idx);
    }
    if (!p.startsWith(":"))
        return null;
    return p.slice(1);
}
function unescVcard(s) {
    let out = "";
    let i = 0;
    while (i < s.length) {
        if (s[i] === "\\" && i + 1 < s.length) {
            const c = s[i + 1];
            if (c === "n" || c === "N") {
                out += "\n";
                i += 2;
                continue;
            }
            if (c === "," || c === ";" || c === "\\") {
                out += c;
                i += 2;
                continue;
            }
        }
        out += s[i];
        i += 1;
    }
    return out;
}
// vcardParse returns the card or null.
function vcardParse(text) {
    if (!text.includes("BEGIN:VCARD"))
        return null;
    // unfold continuation lines, drop \r, split on \n
    let flat = "";
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === "\r") {
            i += 1;
            continue;
        }
        if (c === "\n" && i + 1 < text.length && (text[i + 1] === " " || text[i + 1] === "\t")) {
            i += 1;
            continue;
        }
        flat += c;
        i += 1;
    }
    const out = { name: "", org: "", title: "", addr: "", note: "", phones: [], emails: [], urls: [] };
    let foundFn = false;
    for (const line of flat.split("\n")) {
        let v = keyMatches(line, "FN");
        if (v !== null) {
            out.name = unescVcard(v);
            foundFn = true;
            continue;
        }
        v = keyMatches(line, "ORG");
        if (v !== null) {
            out.org = unescVcard(v);
            continue;
        }
        v = keyMatches(line, "TITLE");
        if (v !== null) {
            out.title = unescVcard(v);
            continue;
        }
        v = keyMatches(line, "NOTE");
        if (v !== null) {
            out.note = unescVcard(v);
            continue;
        }
        v = keyMatches(line, "ADR");
        if (v !== null) {
            out.addr = unescVcard(v).replace(/^;+/, "").replace(/;+$/, "");
            continue;
        }
        v = keyMatches(line, "EMAIL");
        if (v !== null) {
            if (out.emails.length < 8)
                out.emails.push(unescVcard(v));
            continue;
        }
        v = keyMatches(line, "TEL");
        if (v !== null) {
            if (out.phones.length < 8)
                out.phones.push(unescVcard(v));
            continue;
        }
        v = keyMatches(line, "URL");
        if (v !== null) {
            if (out.urls.length < 8)
                out.urls.push(unescVcard(v));
            continue;
        }
    }
    if (!foundFn)
        return null;
    return out;
}
// ------------------------------------------------------------- ticket
// ticketBuild builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
function ticketBuild(expiryMs, text) {
    return `PRISM-TICKET/1\nEXP:${Math.floor(expiryMs / 1000)}\n${text.trim()}`;
}
// ticketParse returns the ticket or null.
function ticketParse(text) {
    const prefix = "PRISM-TICKET/1\nEXP:";
    if (!text.startsWith(prefix))
        return null;
    const p = text.slice(prefix.length);
    if (p.length === 0 || !/\d/.test(p[0]))
        return null;
    let exp = 0;
    let i = 0;
    while (i < p.length && /\d/.test(p[i])) {
        exp = exp * 10 + parseInt(p[i]);
        i += 1;
    }
    if (i >= p.length || p[i] !== "\n")
        return null;
    return { expiryMs: exp * 1000, body: p.slice(i + 1).replace(/\s+$/, "") };
}
// detect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
function detect(text) {
    if (text.length === 0)
        return 0;
    if (ticketParse(text))
        return 1;
    if (wifiParse(text))
        return 2;
    if (vcardParse(text))
        return 3;
    return 0;
}
