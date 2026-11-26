// Prism verified issuers: identify signed Prism Secure payloads and look the
// signer up in an issuer list, same semantics as prism-issuers.js and the
// C/Go ports.
package prism

import java.io.File

object Issuers {

    class IdentifyResult {
        var signatureValid = false
        var fingerprint = ""
        var encrypted = false
        var message = "" // decoded text for valid, unencrypted signed payloads
        var hasMessage = false
    }

    // identify inspects decoded payload bytes. null for plain or unsigned
    // payloads. Never decrypts.
    fun identify(b: ByteArray): IdentifyResult? {
        if (b.size < 5 + 65 + 64) return null
        if (b[0] != 'P'.code.toByte() || b[1] != 'S'.code.toByte() || b[2] != 'C'.code.toByte()) return null
        if (b[3].toInt() != 1 && b[3].toInt() != 2) return null
        if (b[4].toInt() and 2 == 0) return null
        val end = b.size
        val pub = b.copyOfRange(end - 129, end - 64)
        val sig = b.copyOfRange(end - 64, end)
        val body = b.copyOfRange(0, end - 129)
        val out = IdentifyResult()
        out.signatureValid = Secure.p256Verify(pub, body, sig)
        out.encrypted = b[4].toInt() and 1 != 0
        out.fingerprint = Secure.fingerprint(pub)
        if (out.signatureValid && !out.encrypted && body.size >= 5) {
            try {
                out.message = String(body, 5, body.size - 5, Charsets.UTF_8)
                // reject if decoding replaced anything (not valid UTF-8)
                if (out.message.contains('�')) throw IllegalArgumentException()
                out.hasMessage = true
            } catch (e: Exception) {
                out.message = ""
                out.hasMessage = false
            }
        }
        return out
    }

    class Issuer(val name: String, val fingerprint: String)

    // Minimal JSON extraction for the two shapes this port writes and reads:
    // {"issuers":[{"name":..., "fingerprint":...}, ...]} and the key file
    // {"publicKeyHex":..., "privateJwk":{"crv","d","kty","x","y"}}. Handles
    // simple \" \\ \/ \n \t \r escapes. Not a general JSON parser.
    private val strFieldRe = Regex("\"([A-Za-z]+)\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")

    fun extractStringFields(json: String): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        for (m in strFieldRe.findAll(json)) {
            val key = m.groupValues[1]
            val raw = m.groupValues[2]
            val sb = StringBuilder()
            var i = 0
            while (i < raw.length) {
                if (raw[i] == '\\' && i + 1 < raw.length) {
                    when (raw[i + 1]) {
                        'n' -> sb.append('\n')
                        't' -> sb.append('\t')
                        'r' -> sb.append('\r')
                        '/' -> sb.append('/')
                        '\\' -> sb.append('\\')
                        '"' -> sb.append('"')
                        else -> {
                            sb.append(raw[i]); sb.append(raw[i + 1])
                        }
                    }
                    i += 2
                } else {
                    sb.append(raw[i]); i++
                }
            }
            out.add(key to sb.toString())
        }
        return out
    }

    // load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
    fun load(path: String): List<Issuer> {
        val f = File(path)
        if (!f.exists() || f.length() > (1 shl 20)) return emptyList()
        val json = try {
            f.readText()
        } catch (e: Exception) {
            return emptyList()
        }
        if (!json.contains("\"issuers\"")) return emptyList()
        val fields = extractStringFields(json)
        val out = ArrayList<Issuer>()
        var pendingName: String? = null
        for ((k, v) in fields) {
            if (k == "name") {
                pendingName = v
            } else if (k == "fingerprint" && pendingName != null) {
                out.add(Issuer(pendingName, v))
                pendingName = null
            }
        }
        return out
    }

    fun normFp(inFp: String): String {
        val b = StringBuilder()
        for (c in inFp) {
            if (b.length >= 15) break
            if (c.isDigit() || c in 'a'..'f' || c in 'A'..'F') b.append(c.uppercaseChar())
        }
        return b.toString()
    }

    // find: normalized fingerprint match (case-insensitive, separators ignored).
    fun find(list: List<Issuer>, fingerprint: String): Issuer? {
        val want = normFp(fingerprint)
        for (i in list) if (normFp(i.fingerprint) == want) return i
        return null
    }
}
