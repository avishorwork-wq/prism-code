// Prism big files in parts (PPT1), byte-compatible with prism-parts.js and
// the C/Go ports.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.
package prism

import java.security.SecureRandom
import java.util.zip.CRC32

object Parts {
    const val ECC = 2

    private fun crc32(b: ByteArray, off: Int = 0, len: Int = b.size - off): Long {
        val c = CRC32()
        c.update(b, off, len)
        return c.value
    }

    fun ppOverhead(nameLen: Int) = 4 + 4 + 2 + 2 + 4 + 4 + 1 + nameLen + 4

    // cleanName: backslash, slash and control bytes become '_', trimmed to 200 chars.
    fun cleanName(nameIn: String): String {
        var name = nameIn
        if (name.isEmpty()) name = "file"
        val b = StringBuilder()
        for (c in name.toByteArray(Charsets.UTF_8)) {
            if (b.length >= 200) break
            val u = c.toInt() and 0xFF
            if (c == '\\'.code.toByte() || c == '/'.code.toByte() || u < 0x20) b.append('_')
            else b.append(u.toChar())
        }
        return b.toString()
    }

    // nameBytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
    fun nameBytes(name: String): ByteArray {
        val clean = cleanName(name).toByteArray(Charsets.ISO_8859_1)
        var n = clean.size
        if (n > 40) {
            n = 40
            while (n > 0 && (clean[n].toInt() and 0xC0) == 0x80) n-- // back off to a lead byte
            if (n > 0 && (clean[n].toInt() and 0x80) != 0) {
                var need = 0
                val c = clean[n].toInt() and 0xFF
                if (c and 0xE0 == 0xC0) need = 2
                else if (c and 0xF0 == 0xE0) need = 3
                else if (c and 0xF8 == 0xF0) need = 4
                if (need != 0 && n + need > 41) n--
            }
        }
        return clean.copyOfRange(0, n)
    }

    class Plan(val room: Int, val total: Int, val name: String)

    fun planCalc(length: Int, name: String, codeSize: Int): Plan {
        val nb = nameBytes(name)
        val cap = Prism.capacity(codeSize, ECC, 0)
        val room = cap.payload - ppOverhead(nb.size)
        require(room >= 64) { "part size leaves < 64 bytes of room" }
        var total = (length + room - 1) / room
        if (total < 1) total = 1
        require(total <= 65535) { "file too big for this part size" }
        return Plan(room, total, String(nb, Charsets.ISO_8859_1))
    }

    // splitFile splits bytes into PPT1 part payloads.
    fun splitFile(data: ByteArray, name: String, codeSize: Int): List<ByteArray> {
        val plan = planCalc(data.size, name, codeSize)
        val nb = plan.name.toByteArray(Charsets.ISO_8859_1)
        val id = ByteArray(4).also { SecureRandom().nextBytes(it) }
        val whole = crc32(data)
        val parts = ArrayList<ByteArray>(plan.total)
        for (nIdx in 0 until plan.total) {
            val off = nIdx * plan.room
            var clen = data.size - off
            if (clen > plan.room) clen = plan.room
            val p = ArrayList<Byte>(ppOverhead(nb.size) + clen)
            p.addAll(listOf('P'.code.toByte(), 'P'.code.toByte(), 'T'.code.toByte(), '1'.code.toByte()))
            p.addAll(id.asList())
            p.add(((nIdx + 1) shr 8).toByte()); p.add((nIdx + 1).toByte())
            p.add((plan.total shr 8).toByte()); p.add(plan.total.toByte())
            val tmp = ByteArray(4)
            Secure.be32w(tmp, 0, data.size.toLong()); p.addAll(tmp.asList())
            Secure.be32w(tmp, 0, whole); p.addAll(tmp.asList())
            p.add(nb.size.toByte())
            p.addAll(nb.asList())
            for (i in off until off + clen) p.add(data[i])
            val pb = p.toByteArray()
            Secure.be32w(tmp, 0, crc32(pb))
            parts.add(pb + tmp)
        }
        return parts
    }

    class PartInfo(
        val id: String, val n: Int, val total: Int, val len: Long,
        val whole: Long, val name: String, val chunk: ByteArray
    )

    // parse parses one part payload. Triple(info, bad, ok): ok=false,bad="" =
    // not a part; bad set = damaged part.
    fun parse(b: ByteArray): Triple<PartInfo?, String, Boolean> {
        if (b.size < 25 || b[0] != 'P'.code.toByte() || b[1] != 'P'.code.toByte() ||
            b[2] != 'T'.code.toByte() || b[3] != '1'.code.toByte()
        ) return Triple(null, "", false)
        if (crc32(b, 0, b.size - 4) != Secure.be32r(b, b.size - 4)) {
            return Triple(null, "This part failed its own check. Scan it again.", false)
        }
        val id = buildString { for (i in 0 until 4) append("%02x".format(b[4 + i].toInt() and 0xFF)) }
        val n = (b[8].toInt() and 0xFF shl 8) or (b[9].toInt() and 0xFF)
        val total = (b[10].toInt() and 0xFF shl 8) or (b[11].toInt() and 0xFF)
        val len = Secure.be32r(b, 12)
        val whole = Secure.be32r(b, 16)
        val nl = b[20].toInt() and 0xFF
        if (21 + nl + 4 > b.size || n == 0 || n > total) {
            return Triple(null, "This part has a broken header.", false)
        }
        val name = String(b, 21, nl, Charsets.UTF_8)
        val chunk = b.copyOfRange(21 + nl, b.size - 4)
        return Triple(PartInfo(id, n, total, len, whole, name, chunk), "", true)
    }

    // Add statuses, like the site.
    const val NOT_PART = 0
    const val BAD = 1
    const val OTHER = 2
    const val DUPLICATE = 3
    const val NEW = 4
    const val COMPLETE = 5

    class Assembler {
        var id = ""
        var total = 0
        var len = 0L
        var whole = 0L
        var name = ""
        private var chunks = arrayOfNulls<ByteArray>(0)
        var have = 0
        var started = false

        fun reset() {
            id = ""; total = 0; len = 0; whole = 0; name = ""
            chunks = arrayOfNulls(0); have = 0; started = false
        }

        fun add(b: ByteArray): Triple<Int, Int, String> {
            val (p, bad, ok) = parse(b)
            if (!ok && bad.isEmpty()) return Triple(NOT_PART, 0, "")
            if (bad.isNotEmpty()) return Triple(BAD, 0, bad)
            p!!
            if (!started) {
                started = true
                id = p.id; total = p.total; len = p.len; whole = p.whole; name = p.name
                chunks = arrayOfNulls(p.total)
            } else if (p.id != id) {
                val nm = if (p.name.isEmpty()) "unnamed" else p.name
                return Triple(OTHER, 0, "That part belongs to a different file ($nm). Start over to switch.")
            } else if (p.total != total || p.len != len || p.whole != whole) {
                return Triple(BAD, 0, "This part does not match the others.")
            }
            if (chunks[p.n - 1] != null) return Triple(DUPLICATE, p.n, "")
            chunks[p.n - 1] = p.chunk.copyOf()
            have++
            if (have == total) return Triple(COMPLETE, p.n, "")
            return Triple(NEW, p.n, "")
        }

        // finish rebuilds and verifies after COMPLETE.
        fun finish(): Pair<ByteArray, String> {
            require(have == total) { "Parts are still missing." }
            var buf = ByteArray(0)
            for (i in 0 until total) {
                require(buf.size + chunks[i]!!.size <= len.toInt()) { "The parts add up to more than the file size." }
                buf += chunks[i]!!
            }
            require(buf.size == len.toInt()) { "The parts add up to ${buf.size} bytes, not $len." }
            require(crc32(buf) == whole) { "The whole-file check failed. Start over and scan the parts again." }
            var nm = name
            if (nm.isEmpty()) nm = "prism-file.bin"
            return buf to nm
        }
    }
}
