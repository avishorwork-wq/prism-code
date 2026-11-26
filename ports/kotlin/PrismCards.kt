// Prism tickets and cards: Wi-Fi, contact card (vCard 3.0) and expiring
// ticket payload builders and parsers, payload-compatible with prism-cards.js
// and the C/Go ports.
package prism

object Cards {

    // ------------------------------------------------------------- Wi-Fi

    fun escWifi(s: String): String {
        val b = StringBuilder()
        for (c in s) {
            if (c in "\\;,:\"" || c == '\'') b.append('\\')
            b.append(c)
        }
        return b.toString()
    }

    // wifiBuild builds the common WIFI: payload other readers agree on.
    fun wifiBuild(ssid: String, secIn: String, pass: String, hidden: Boolean): String {
        val t = if (secIn.isEmpty()) "WPA" else secIn
        val b = StringBuilder()
        b.append("WIFI:T:").append(t).append(";S:").append(escWifi(ssid)).append(";")
        if (t != "nopass") b.append("P:").append(escWifi(pass)).append(";")
        if (hidden) b.append("H:true;")
        b.append(";")
        return b.toString()
    }

    class WifiCard {
        var ssid = ""
        var sec = ""
        var pass = ""
        var hidden = false
    }

    fun wifiParse(text: String): WifiCard? {
        if (text.length < 5 || !text.substring(0, 5).equals("WIFI:", ignoreCase = true)) return null
        val body = text.substring(5)
        val out = WifiCard()
        val key = StringBuilder()
        val v = StringBuilder()
        var inKey = true
        var haveSSID = false
        fun flush() {
            val k = key.toString().uppercase()
            val value = v.toString()
            when (k) {
                "S" -> { out.ssid = value; haveSSID = true }
                "T" -> out.sec = value.uppercase()
                "P" -> out.pass = value
                "H" -> out.hidden = value.equals("true", ignoreCase = true)
            }
        }
        var i = 0
        while (true) {
            var doFlush = false
            if (i >= body.length) {
                doFlush = true
            } else {
                val c = body[i]
                if (c == '\\' && i + 1 < body.length) {
                    if (inKey) key.append(body[i + 1]) else v.append(body[i + 1])
                    i += 2
                    continue
                } else if (inKey && c == ':') {
                    inKey = false
                    i++
                    continue
                } else if (!inKey && c == ';') {
                    doFlush = true
                } else if (inKey) {
                    key.append(c)
                    i++
                    continue
                } else {
                    v.append(c)
                    i++
                    continue
                }
            }
            if (doFlush) {
                if (key.isNotEmpty()) flush()
                if (i >= body.length) break
                key.clear(); v.clear(); inKey = true
                i++
            }
        }
        if (!haveSSID) return null
        if (out.sec.isEmpty()) out.sec = "WPA"
        return out
    }

    // ------------------------------------------------------------- vCard

    fun escVcard(s: String): String {
        val b = StringBuilder()
        for (c in s) {
            if (c == '\\' || c == ',' || c == ';') b.append('\\')
            if (c == '\n') {
                b.append("\\n")
                continue
            }
            b.append(c)
        }
        return b.toString()
    }

    // vcardBuild builds a vCard 3.0 payload. Any field may be empty.
    fun vcardBuild(
        name: String, org: String, title: String, phone: String,
        email: String, url: String, addr: String, note: String
    ): String {
        val b = StringBuilder()
        b.append("BEGIN:VCARD\r\nVERSION:3.0\r\n")
        b.append("FN:").append(escVcard(name)).append("\r\n")
        if (name.isNotEmpty()) {
            val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
            val first = if (words.isNotEmpty()) words[0] else ""
            val rest = if (words.size > 1) words.subList(1, words.size).joinToString(" ") else "-"
            b.append("N:").append(escVcard(rest)).append(";").append(escVcard(first)).append(";;;\r\n")
        }
        if (org.isNotEmpty()) b.append("ORG:").append(escVcard(org)).append("\r\n")
        if (title.isNotEmpty()) b.append("TITLE:").append(escVcard(title)).append("\r\n")
        if (phone.isNotEmpty()) b.append("TEL;TYPE=CELL:").append(escVcard(phone)).append("\r\n")
        if (email.isNotEmpty()) b.append("EMAIL:").append(escVcard(email)).append("\r\n")
        if (url.isNotEmpty()) b.append("URL:").append(escVcard(url)).append("\r\n")
        if (addr.isNotEmpty()) b.append("ADR;TYPE=WORK:;;").append(escVcard(addr)).append(";;;;\r\n")
        if (note.isNotEmpty()) b.append("NOTE:").append(escVcard(note)).append("\r\n")
        b.append("END:VCARD")
        return b.toString()
    }

    class Vcard {
        var name = ""
        var org = ""
        var title = ""
        var addr = ""
        var note = ""
        val phones = ArrayList<String>()
        val emails = ArrayList<String>()
        val urls = ArrayList<String>()
    }

    private fun keyMatches(line: String, key: String): String? {
        if (line.length < key.length || !line.substring(0, key.length).equals(key, ignoreCase = true)) return null
        var p = line.substring(key.length)
        if (p.startsWith(";")) {
            val idx = p.indexOf(':')
            if (idx < 0) return null
            p = p.substring(idx)
        }
        if (!p.startsWith(":")) return null
        return p.substring(1)
    }

    private fun unescVcard(s: String): String {
        val b = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (s[i] == '\\' && i + 1 < s.length) {
                val c = s[i + 1]
                if (c == 'n' || c == 'N') {
                    b.append('\n'); i += 2; continue
                }
                if (c == ',' || c == ';' || c == '\\') {
                    b.append(c); i += 2; continue
                }
            }
            b.append(s[i]); i++
        }
        return b.toString()
    }

    fun vcardParse(text: String): Vcard? {
        if (!text.contains("BEGIN:VCARD")) return null
        // unfold continuation lines, drop \r, split on \n
        val flat = StringBuilder()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == '\r') {
                i++; continue
            }
            if (c == '\n' && i + 1 < text.length && (text[i + 1] == ' ' || text[i + 1] == '\t')) {
                i++; continue
            }
            flat.append(c); i++
        }
        val out = Vcard()
        var foundFN = false
        flat.toString().split("\n").forEach eachLine@{ line ->
            keyMatches(line, "FN")?.let { out.name = unescVcard(it); foundFN = true; return@eachLine }
            keyMatches(line, "ORG")?.let { out.org = unescVcard(it); return@eachLine }
            keyMatches(line, "TITLE")?.let { out.title = unescVcard(it); return@eachLine }
            keyMatches(line, "NOTE")?.let { out.note = unescVcard(it); return@eachLine }
            keyMatches(line, "ADR")?.let { out.addr = unescVcard(it).trimStart(';').trimEnd(';'); return@eachLine }
            keyMatches(line, "EMAIL")?.let { if (out.emails.size < 8) out.emails.add(unescVcard(it)); return@eachLine }
            keyMatches(line, "TEL")?.let { if (out.phones.size < 8) out.phones.add(unescVcard(it)); return@eachLine }
            keyMatches(line, "URL")?.let { if (out.urls.size < 8) out.urls.add(unescVcard(it)); return@eachLine }
        }
        if (!foundFN) return null
        return out
    }

    // ------------------------------------------------------------- ticket

    // ticketBuild builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
    fun ticketBuild(expiryMs: Long, text: String): String {
        val t = text.trim()
        return "PRISM-TICKET/1\nEXP:${expiryMs / 1000}\n$t"
    }

    class Ticket(val expiryMs: Long, val body: String)

    fun ticketParse(text: String): Ticket? {
        val prefix = "PRISM-TICKET/1\nEXP:"
        if (!text.startsWith(prefix)) return null
        val p = text.substring(prefix.length)
        if (p.isEmpty() || p[0] !in '0'..'9') return null
        var exp = 0L
        var i = 0
        while (i < p.length && p[i] in '0'..'9') {
            exp = exp * 10 + (p[i] - '0')
            i++
        }
        if (i >= p.length || p[i] != '\n') return null
        val bodyStr = p.substring(i + 1).trim()
        return Ticket(exp * 1000, bodyStr)
    }

    // detect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
    fun detect(text: String): Int {
        if (text.isEmpty()) return 0
        if (ticketParse(text) != null) return 1
        if (wifiParse(text) != null) return 2
        if (vcardParse(text) != null) return 3
        return 0
    }
}
