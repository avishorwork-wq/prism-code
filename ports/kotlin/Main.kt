// Prism Code CLI (Kotlin/JVM port): encode / decode clean Prism Code PNGs,
// Prism Secure (lock, sign, verify), big files in parts, tickets and cards,
// and verified issuers. Byte-compatible with the live JS and the C/Go ports.
import prism.Cards
import prism.Issuers
import prism.Parts
import prism.Secure
import java.io.File
import java.util.Base64
import javax.imageio.ImageIO
import kotlin.system.exitProcess

private fun arg(a: Array<String>, name: String, dflt: String): String {
    for (i in 0 until a.size - 1) {
        if (a[i] == "--$name" || a[i] == "-$name") return a[i + 1]
    }
    return dflt
}

private fun hasArg(a: Array<String>, name: String): Boolean = a.any { it == "--$name" }

private fun positional(a: Array<String>): String {
    var skip = false
    for (i in a.indices) {
        if (i == 0) continue
        val s = a[i]
        if (skip) {
            skip = false
            continue
        }
        if (s.isNotEmpty() && s[0] == '-') {
            skip = true
            continue
        }
        return s
    }
    return ""
}

private fun atoiOr(s: String, d: Int): Int = s.toIntOrNull() ?: d

private fun modeName(m: Int) = if (m == 0) "color" else "bw"

private fun fatal(msg: String): Nothing {
    System.err.println(msg)
    exitProcess(1)
}

private fun usage(): Nothing {
    System.err.println(
        """usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]
       prism decode I.png [--out O]
       prism capacity
       prism secure-genkey [-o key.json]
       prism secure-seal IN --password P [--kdf argon2id|pbkdf2] [--sign-key key.json] [-o OUT]
       prism secure-open IN [--password P] [-o OUT]
       prism secure-passphrase
       prism secure-strength [PASSWORD]
       prism parts-split IN -o OUTDIR [--name NAME] [--size 0..5]
       prism parts-join PART... [-o OUT]
       prism card-build wifi|vcard|ticket [flags] [-o OUT]
       prism card-parse IN
       prism issuer IN [--list issuers.json]"""
    )
    exitProcess(2)
}

// saveKey writes the key file in the same JSON shape the C/Go ports use.
private fun saveKey(path: String, priv: ByteArray, pub: ByteArray) {
    val b64 = Base64.getUrlEncoder().withoutPadding()
    val hex = pub.joinToString("") { "%02x".format(it) }
    val j = buildString {
        append("{\"publicKeyHex\":\"").append(hex)
        append("\",\"privateJwk\":{\"crv\":\"P-256\",\"d\":\"").append(b64.encodeToString(priv))
        append("\",\"kty\":\"EC\",\"x\":\"").append(b64.encodeToString(pub.copyOfRange(1, 33)))
        append("\",\"y\":\"").append(b64.encodeToString(pub.copyOfRange(33, 65))).append("\"}}")
    }
    File(path).writeText(j)
}

private fun loadKey(path: String): Pair<ByteArray, ByteArray> {
    val json = File(path).readText()
    val fields = Issuers.extractStringFields(json).toMap()
    val pubHex = fields["publicKeyHex"] ?: throw IllegalArgumentException("bad key file")
    val d = fields["d"] ?: throw IllegalArgumentException("bad key file")
    val pub = pubHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    if (pub.size != 65) throw IllegalArgumentException("bad public key")
    val priv = Base64.getUrlDecoder().decode(d)
    if (priv.size != 32) throw IllegalArgumentException("bad private key")
    return priv to pub
}

fun main(a: Array<String>) {
    if (a.isEmpty()) usage()
    when (a[0]) {
        "encode" -> {
            val text = arg(a, "text", "")
            val input = arg(a, "input", "")
            if (text.isEmpty() && input.isEmpty()) fatal("need --text or --input")
            val payload = if (text.isNotEmpty()) text.toByteArray(Charsets.UTF_8) else File(input).readBytes()
            val size = atoiOr(arg(a, "size", "-1"), -1)
            val ecc = atoiOr(arg(a, "ecc", "1"), 1)
            val modeS = arg(a, "mode", "0")
            val mode = if (modeS == "1" || modeS == "bw") 1 else 0
            val radius = atoiOr(arg(a, "radius", "12"), 12)
            val type = atoiOr(arg(a, "type", "0"), 0)
            val logo = atoiOr(arg(a, "logo", "0"), 0)
            val out = arg(a, "out", "")
            if (out.isEmpty()) fatal("need --out")
            val code = Prism.encode(payload, size, ecc, mode, type, logo)
            ImageIO.write(Prism.render(code, radius), "png", File(out))
            val sj = arg(a, "symbols", "")
            if (sj.isNotEmpty()) {
                val sb = StringBuilder()
                sb.append("{\"size\":").append(code.size).append(",\"ecc\":").append(code.ecc)
                    .append(",\"mode\":").append(code.mode).append(",\"C\":").append(code.layout.C)
                    .append(",\"R\":").append(code.layout.R).append(",\"symbols\":[")
                for (i in code.symbols.indices) {
                    if (i > 0) sb.append(',')
                    sb.append(code.symbols[i])
                }
                sb.append("]}")
                File(sj).writeText(sb.toString())
            }
            val img = Prism.render(code, radius)
            println("wrote $out (${img.width}x${img.height} px, grid ${code.layout.C}x${code.layout.R} cells, size ${code.size}, ${modeName(mode)}, ecc $ecc, ${payload.size} payload bytes)")
            println("capacity at these settings: ${code.capacity.payload} payload bytes")
        }
        "decode" -> {
            if (a.size < 2) usage()
            val d = Prism.decodeImage(ImageIO.read(File(a[1])))
            val out = arg(a, "out", "")
            if (out.isNotEmpty()) {
                File(out).writeBytes(d.payload)
                println("wrote $out (${d.payload.size} bytes)")
            } else {
                System.out.write(d.payload)
                if (d.payload.isNotEmpty()) println()
            }
            System.err.println("header: size ${d.size}, ecc ${d.ecc}, mode ${modeName(d.mode)}, type ${d.type}, ${d.length} payload bytes, CRC-32 OK")
        }
        "secure-genkey" -> {
            val (priv, pub) = Secure.generateSigningKey()
            println("fingerprint: ${Secure.fingerprint(pub)}")
            val out = arg(a, "o", "")
            if (out.isNotEmpty()) {
                saveKey(out, priv, pub)
                println("wrote $out")
            }
        }
        "secure-seal" -> {
            val inp = positional(a)
            if (inp.isEmpty()) usage()
            val data = File(inp).readBytes()
            var priv: ByteArray? = null
            var pub: ByteArray? = null
            val keyf = arg(a, "sign-key", "")
            if (keyf.isNotEmpty()) {
                try {
                    val kp = loadKey(keyf)
                    priv = kp.first
                    pub = kp.second
                } catch (e: Exception) {
                    fatal("bad key file $keyf")
                }
            }
            val sealed = try {
                Secure.seal(data, arg(a, "password", ""), arg(a, "kdf", "argon2id"), priv, pub)
            } catch (e: Exception) {
                fatal("sealing failed (need --password and/or --sign-key)")
            }
            val out = arg(a, "o", "")
            if (out.isNotEmpty()) {
                File(out).writeBytes(sealed)
                println("wrote $out (${data.size} -> ${sealed.size} bytes)")
            } else {
                System.out.write(sealed)
            }
        }
        "secure-open" -> {
            val inp = positional(a)
            if (inp.isEmpty()) usage()
            val data = File(inp).readBytes()
            val r = Secure.open(data, arg(a, "password", ""), null)
            if (r.signatureValid == 0) fatal(r.err ?: "bad signature")
            if (r.bytes == null) {
                if (r.err != null) fatal(r.err!!)
                fatal("needs a password")
            }
            if (r.signed) System.err.println("signature: valid, signer ${r.signerFingerprint}")
            val out = arg(a, "o", "")
            if (out.isNotEmpty()) {
                File(out).writeBytes(r.bytes!!)
                println("wrote $out (${r.bytes!!.size} bytes)")
            } else {
                System.out.write(r.bytes!!)
                System.out.write('\n'.code)
            }
        }
        "secure-passphrase" -> println(Secure.generatePassphrase())
        "secure-strength" -> {
            var pw = arg(a, "password", "")
            if (pw.isEmpty()) pw = positional(a)
            val (bits, level, label) = Secure.strength(pw)
            println("$bits bits, level $level ($label)")
        }
        "parts-split" -> {
            val inp = positional(a)
            val outdir = arg(a, "o", "")
            if (inp.isEmpty() || outdir.isEmpty()) usage()
            val name = arg(a, "name", "file")
            val size = atoiOr(arg(a, "size", "3"), 3)
            val data = File(inp).readBytes()
            val parts = try {
                Parts.splitFile(data, name, size)
            } catch (e: Exception) {
                fatal(e.message ?: "split failed")
            }
            File(outdir).mkdirs()
            for (i in parts.indices) {
                File(outdir, "part-%02d.bin".format(i + 1)).writeBytes(parts[i])
            }
            println("${parts.size} parts written to $outdir (encode each at --ecc 2, color mode)")
        }
        "parts-join" -> {
            val asm = Parts.Assembler()
            var out = arg(a, "o", "")
            var nfiles = 0
            var i = 1
            while (i < a.size) {
                if (a[i] == "-o" || a[i] == "--o") {
                    i += 2
                    continue
                }
                val data = try {
                    File(a[i]).readBytes()
                } catch (e: Exception) {
                    fatal("cannot read ${a[i]}")
                }
                nfiles++
                val (st, pn, msg) = asm.add(data)
                when (st) {
                    Parts.NOT_PART -> fatal("${a[i]} is not a part")
                    Parts.BAD, Parts.OTHER -> fatal(msg)
                    Parts.DUPLICATE -> {}
                    else -> println("part $pn of ${asm.total} added (${asm.have}/${asm.total})")
                }
                i++
            }
            if (nfiles == 0) usage()
            val (res, name) = try {
                asm.finish()
            } catch (e: Exception) {
                fatal(e.message ?: "join failed")
            }
            if (out.isEmpty()) out = name
            File(out).writeBytes(res)
            println("wrote $out (${res.size} bytes, whole-file check passed)")
        }
        "card-build" -> {
            if (a.size < 2) usage()
            val kind = a[1]
            val hidden = hasArg(a, "hidden")
            val payload = when (kind) {
                "wifi" -> Cards.wifiBuild(arg(a, "ssid", ""), arg(a, "sec", "WPA"), arg(a, "pass", ""), hidden)
                "vcard" -> Cards.vcardBuild(
                    arg(a, "name", ""), arg(a, "org", ""), arg(a, "title", ""),
                    arg(a, "phone", ""), arg(a, "email", ""), arg(a, "url", ""),
                    arg(a, "addr", ""), arg(a, "note", "")
                )
                "ticket" -> Cards.ticketBuild(arg(a, "expiry-ms", "0").toLongOrNull() ?: 0, arg(a, "text", ""))
                else -> usage()
            }
            val out = arg(a, "o", "")
            if (out.isNotEmpty()) {
                File(out).writeText(payload)
                println("wrote $out (${payload.toByteArray(Charsets.UTF_8).size} bytes)")
            } else {
                println(payload)
            }
        }
        "card-parse" -> {
            if (a.size < 2) usage()
            val text = File(a[1]).readText()
            val t = Cards.ticketParse(text)
            val w = Cards.wifiParse(text)
            val v = Cards.vcardParse(text)
            if (t != null) {
                println("ticket: expires ${t.expiryMs}, body:\n${t.body}")
            } else if (w != null) {
                val h = if (w.hidden) " hidden" else ""
                println("wifi: ssid \"${w.ssid}\" security ${w.sec} password \"${w.pass}\"$h")
            } else if (v != null) {
                print("contact: ${v.name}")
                if (v.org.isNotEmpty()) print(", ${v.org}")
                if (v.title.isNotEmpty()) print(" (${v.title})")
                println()
                for (p in v.phones) println("  phone: $p")
                for (e in v.emails) println("  email: $e")
                for (u in v.urls) println("  url: $u")
                if (v.addr.isNotEmpty()) println("  address: ${v.addr}")
                if (v.note.isNotEmpty()) println("  note: ${v.note}")
            } else {
                println("not a card payload")
            }
        }
        "issuer" -> {
            val inp = positional(a)
            if (inp.isEmpty()) usage()
            var data = File(inp).readBytes()
            if (data.size > 8 && data[0] == 0x89.toByte() && data[1] == 'P'.code.toByte() &&
                data[2] == 'N'.code.toByte() && data[3] == 'G'.code.toByte()
            ) {
                data = Prism.decodeImage(ImageIO.read(File(inp))).payload
            }
            val id = Issuers.identify(data)
            if (id == null) {
                println("not a signed Prism Secure payload")
            } else if (!id.signatureValid) {
                println("Signature check failed. This code was changed after it was signed, or was not signed by the key it names.")
            } else {
                print("signature: valid, signer ${id.fingerprint}")
                val lp = arg(a, "list", "")
                if (lp.isNotEmpty()) {
                    val list = Issuers.load(lp)
                    val hit = Issuers.find(list, id.fingerprint)
                    if (hit != null) print(", issuer: ${hit.name}") else print(" (not on the issuer list)")
                }
                println()
                if (id.hasMessage) println("message: ${id.message}")
                else if (id.encrypted) println("the content is locked with a password")
            }
        }
        "capacity" -> {
            for (s in 0 until 6) for (ecc in 0 until 4) for (mode in 0 until 2) {
                val cap = Prism.capacity(s, ecc, mode)
                println("size $s (${Prism.SIZES[s][0]}x${Prism.SIZES[s][1]}) ecc $ecc ${modeName(mode)}: ${cap.payload} payload bytes")
            }
        }
        else -> fatal("unknown command ${a[0]}")
    }
}
