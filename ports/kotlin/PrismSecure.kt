// Prism Secure (envelope v2, reads v1): AES-256-GCM payload locking with
// Argon2id (128 MiB, 3 passes) or PBKDF2-SHA256 (600,000 rounds), and
// ECDSA P-256 / SHA-256 signing with RFC 6979 deterministic nonces and
// P1363 r||s signatures, byte-compatible with the live site's
// prism-secure.html JS and the C/Go ports. See that file for the format spec.
//
// Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
// normalization first; this port does not ship a Unicode normalizer, so
// non-ASCII passwords should already be in composed (NFC) form. ASCII
// passwords are unaffected.
//
// Argon2id comes from Bouncy Castle (bcprov); AES-GCM and HMAC from the JDK.
package prism

import java.math.BigInteger
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters

object Secure {
    const val ARGON2_MEM = 131072
    const val ARGON2_T = 3
    const val ARGON2_P = 1
    const val PBKDF2_ITER = 600000

    const val FLAG_ENC = 1
    const val FLAG_SIG = 2
    const val HEAD2 = 4 + 1 + 1 + 6 + 16 + 12
    const val HEAD1 = 4 + 1 + 16 + 12 + 4

    private val MAGIC = byteArrayOf('P'.code.toByte(), 'S'.code.toByte(), 'C'.code.toByte())

    fun be32w(b: ByteArray, off: Int, n: Long) {
        b[off] = (n ushr 24).toByte(); b[off + 1] = (n ushr 16).toByte()
        b[off + 2] = (n ushr 8).toByte(); b[off + 3] = n.toByte()
    }

    fun be32r(b: ByteArray, off: Int): Long =
        ((b[off].toLong() and 0xFF) shl 24) or ((b[off + 1].toLong() and 0xFF) shl 16) or
            ((b[off + 2].toLong() and 0xFF) shl 8) or (b[off + 3].toLong() and 0xFF)

    // ------------------------------------------------------------- crypto pieces

    private fun sha256(d: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(d)

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        return m.doFinal(data)
    }

    // PBKDF2-SHA256 implemented directly on HMAC so the password is its exact
    // UTF-8 bytes (the JCE PBKDF2WithHmacSHA256 would take chars instead).
    fun pbkdf2SHA256(pw: ByteArray, salt: ByteArray, iter: Int, keyLen: Int): ByteArray {
        val out = ByteArray(keyLen)
        var block = 1
        var done = 0
        while (done < keyLen) {
            val ib = byteArrayOf(
                (block ushr 24).toByte(), (block ushr 16).toByte(),
                (block ushr 8).toByte(), block.toByte()
            )
            var u = hmacSha256(pw, salt + ib)
            val t = u.copyOf()
            for (i in 1 until iter) {
                u = hmacSha256(pw, u)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            val n = minOf(32, keyLen - done)
            System.arraycopy(t, 0, out, done, n)
            done += n
            block++
        }
        return out
    }

    fun argon2idKey(pw: ByteArray, salt: ByteArray, memKiB: Int, t: Int, lanes: Int, keyLen: Int): ByteArray {
        require(memKiB in 8192..262144 && t in 1..12 && lanes in 1..4) { "argon2id parameters out of range" }
        val params = Argon2Parameters.Builder(Argon2Parameters.ARGON2_id)
            .withVersion(Argon2Parameters.ARGON2_VERSION_13)
            .withMemoryAsKB(memKiB).withIterations(t).withParallelism(lanes)
            .withSalt(salt).build()
        val g = Argon2BytesGenerator()
        g.init(params)
        val out = ByteArray(keyLen)
        g.generateBytes(pw, out)
        return out
    }

    fun aes256gcmEncrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, pt: ByteArray): Pair<ByteArray, ByteArray> {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        c.updateAAD(aad)
        val sealed = c.doFinal(pt) // ct || tag
        return sealed.copyOfRange(0, pt.size) to sealed.copyOfRange(pt.size, sealed.size)
    }

    fun aes256gcmDecrypt(key: ByteArray, iv: ByteArray, aad: ByteArray, ct: ByteArray, tag: ByteArray): ByteArray? {
        return try {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            c.updateAAD(aad)
            c.doFinal(ct + tag)
        } catch (e: Exception) {
            null
        }
    }

    // ------------------------------------------------------------- P-256 / RFC 6979

    private val P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
    private val N = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)
    private val A = P.subtract(BigInteger.valueOf(3))
    private val GX = BigInteger("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296", 16)
    private val GY = BigInteger("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5", 16)
    private val G = Pt(GX, GY)
    private val HALF_N = N.shiftRight(1)

    private data class Pt(val x: BigInteger, val y: BigInteger)

    private fun ptAdd(p: Pt?, q: Pt?): Pt? {
        if (p == null) return q
        if (q == null) return p
        if (p.x == q.x) {
            if (p.y != q.y) return null // p + (-p) = infinity
            if (p.y.signum() == 0) return null
            val m = (p.x.multiply(p.x).multiply(BigInteger.valueOf(3)).add(A))
                .multiply(p.y.shiftLeft(1).modInverse(P)).mod(P)
            val x = m.multiply(m).subtract(p.x.shiftLeft(1)).mod(P)
            val y = m.multiply(p.x.subtract(x)).subtract(p.y).mod(P)
            return Pt(x, y)
        }
        val m = q.y.subtract(p.y).multiply(q.x.subtract(p.x).modInverse(P)).mod(P)
        val x = m.multiply(m).subtract(p.x).subtract(q.x).mod(P)
        val y = m.multiply(p.x.subtract(x)).subtract(p.y).mod(P)
        return Pt(x, y)
    }

    private fun ptMul(kIn: BigInteger, pIn: Pt?): Pt? {
        var k = kIn
        var p = pIn
        var r: Pt? = null
        while (k.signum() > 0) {
            if (k.testBit(0)) r = ptAdd(r, p)
            p = ptAdd(p, p)
            k = k.shiftRight(1)
        }
        return r
    }

    private fun isOnCurve(p: Pt): Boolean {
        val l = p.y.multiply(p.y).mod(P)
        val r = p.x.multiply(p.x).add(A).multiply(p.x).add(
            BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
        ).mod(P)
        return l == r
    }

    // rfc6979K derives the deterministic nonce exactly like the C reference:
    // HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
    private fun rfc6979K(priv: ByteArray, hash: ByteArray): BigInteger {
        var v = ByteArray(32) { 1 }
        var k = ByteArray(32)
        val bx = priv + hash
        k = hmacSha256(k, v + byteArrayOf(0) + bx)
        v = hmacSha256(k, v)
        k = hmacSha256(k, v + byteArrayOf(1) + bx)
        v = hmacSha256(k, v)
        while (true) {
            v = hmacSha256(k, v)
            val kk = BigInteger(1, v)
            if (kk.signum() != 0 && kk < N) return kk
            k = hmacSha256(k, v + byteArrayOf(0))
            v = hmacSha256(k, v)
        }
    }

    // p256Sign produces a deterministic P1363 r||s signature, low-s normalized.
    fun p256Sign(priv: ByteArray, msg: ByteArray): ByteArray {
        val sig = ByteArray(64)
        val hash = sha256(msg)
        val d = BigInteger(1, priv)
        var e = BigInteger(1, hash)
        if (e >= N) e = e.subtract(N)
        while (true) {
            val k = rfc6979K(priv, hash)
            val p = ptMul(k, G) ?: continue
            val r = p.x.mod(N)
            if (r.signum() == 0) continue
            val kinv = k.modInverse(N)
            var s = d.multiply(r).add(e).multiply(kinv).mod(N)
            if (s.signum() == 0) continue
            if (s > HALF_N) s = N.subtract(s)
            val rb = r.toByteArray()
            val rbT = if (rb.size > 32) rb.copyOfRange(rb.size - 32, rb.size) else rb
            System.arraycopy(rbT, 0, sig, 32 - rbT.size, rbT.size)
            val sb = s.toByteArray()
            val sbT = if (sb.size > 32) sb.copyOfRange(sb.size - 32, sb.size) else sb
            System.arraycopy(sbT, 0, sig, 64 - sbT.size, sbT.size)
            return sig
        }
    }

    fun p256Verify(pub: ByteArray, msg: ByteArray, sig: ByteArray): Boolean {
        if (pub.size != 65 || pub[0].toInt() != 4 || sig.size != 64) return false
        val q = Pt(BigInteger(1, pub.copyOfRange(1, 33)), BigInteger(1, pub.copyOfRange(33, 65)))
        if (!isOnCurve(q)) return false
        val hash = sha256(msg)
        var e = BigInteger(1, hash)
        if (e >= N) e = e.subtract(N)
        val r = BigInteger(1, sig.copyOfRange(0, 32))
        val s = BigInteger(1, sig.copyOfRange(32, 64))
        if (r.signum() <= 0 || r >= N || s.signum() <= 0 || s >= N) return false
        val w = s.modInverse(N)
        val u1 = e.multiply(w).mod(N)
        val u2 = r.multiply(w).mod(N)
        val p = ptAdd(ptMul(u1, G), ptMul(u2, q)) ?: return false
        return p.x.mod(N) == r
    }

    fun p256Keygen(priv: ByteArray): ByteArray {
        val p = ptMul(BigInteger(1, priv), G)!!
        val pub = ByteArray(65)
        pub[0] = 4
        val xb = p.x.toByteArray()
        val xbT = if (xb.size > 32) xb.copyOfRange(xb.size - 32, xb.size) else xb
        System.arraycopy(xbT, 0, pub, 33 - xbT.size, xbT.size)
        val yb = p.y.toByteArray()
        val ybT = if (yb.size > 32) yb.copyOfRange(yb.size - 32, yb.size) else yb
        System.arraycopy(ybT, 0, pub, 65 - ybT.size, ybT.size)
        return pub
    }

    // ------------------------------------------------------------- secure envelope

    // Fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
    fun fingerprint(pub: ByteArray): String {
        val h = sha256(pub)
        val sb = StringBuilder()
        for (i in 0 until 8) {
            sb.append("%02X".format(h[i].toInt() and 0xFF))
            if (i % 2 == 1 && i < 7) sb.append('-')
        }
        return sb.toString()
    }

    // generateSigningKey draws a non-zero 32-byte private key; returns priv, pub.
    fun generateSigningKey(): Pair<ByteArray, ByteArray> {
        val rnd = SecureRandom()
        while (true) {
            val priv = ByteArray(32)
            rnd.nextBytes(priv)
            if (priv.any { it.toInt() != 0 }) return priv to p256Keygen(priv)
        }
    }

    private fun deriveKey(password: String, salt: ByteArray, kdf: Int, iter: Long, mem: Long, t: Int, lanes: Int): ByteArray {
        val pw = password.toByteArray(Charsets.UTF_8)
        return if (kdf == 2) argon2idKey(pw, salt, mem.toInt(), t, lanes, 32)
        else pbkdf2SHA256(pw, salt, iter.toInt(), 32)
    }

    // seal locks (password != "", kdf "argon2id"|"pbkdf2") and/or signs
    // (priv != null) data. At least one of the two.
    fun seal(data: ByteArray, password: String, kdf: String, priv: ByteArray?, pub: ByteArray?): ByteArray {
        require(password.isNotEmpty() || priv != null) { "need a password, a signing key, or both" }
        val useA = kdf.isEmpty() || kdf == "argon2id"
        var flags = 0
        if (password.isNotEmpty()) flags = flags or FLAG_ENC
        if (priv != null) flags = flags or FLAG_SIG
        val rnd = SecureRandom()
        var body: ByteArray
        if (password.isNotEmpty()) {
            val salt = ByteArray(16).also { rnd.nextBytes(it) }
            val iv = ByteArray(12).also { rnd.nextBytes(it) }
            body = ByteArray(HEAD2)
            System.arraycopy(MAGIC, 0, body, 0, 3)
            body[3] = 2
            body[4] = flags.toByte()
            if (useA) {
                body[5] = 2
                be32w(body, 6, ARGON2_MEM.toLong())
                body[10] = ARGON2_T.toByte()
                body[11] = ARGON2_P.toByte()
            } else {
                body[5] = 1
                be32w(body, 6, PBKDF2_ITER.toLong())
            }
            System.arraycopy(salt, 0, body, 12, 16)
            System.arraycopy(iv, 0, body, 28, 12)
            val key = deriveKey(password, salt, if (useA) 2 else 1,
                PBKDF2_ITER.toLong(), ARGON2_MEM.toLong(), ARGON2_T, ARGON2_P)
            val (ct, tag) = aes256gcmEncrypt(key, iv, body, data)
            body = body + ct + tag
        } else {
            body = ByteArray(5)
            System.arraycopy(MAGIC, 0, body, 0, 3)
            body[3] = 2
            body[4] = flags.toByte()
            body = body + data
        }
        if (priv == null) return body
        val sig = p256Sign(priv, body)
        return body + pub!! + sig
    }

    fun isSecure(b: ByteArray): Boolean =
        b.size >= 6 && b[0] == 'P'.code.toByte() && b[1] == 'S'.code.toByte() &&
            b[2] == 'C'.code.toByte() && (b[3].toInt() == 1 || b[3].toInt() == 2) &&
            (b[4].toInt() and 3.inv()) == 0

    // inspect reports whether the payload is encrypted / signed.
    fun inspect(b: ByteArray): Pair<Boolean, Boolean> =
        if (!isSecure(b)) false to false
        else (b[4].toInt() and FLAG_ENC != 0) to (b[4].toInt() and FLAG_SIG != 0)

    class Result {
        var secure = false
        var version = 0
        var encrypted = false
        var signed = false
        var signatureValid = -1 // -1 n/a, 0 invalid, 1 valid
        var signerFingerprint = ""
        var trusted = false
        var bytes: ByteArray? = null
        var needsPassword = false
        var err: String? = null
    }

    // open opens a payload; plain input passes through. Errors are reported in
    // err with bytes null (wrong password / tamper / invalid signature), never
    // a wrong payload.
    fun open(b: ByteArray, password: String, trustedFps: List<String>?): Result {
        val res = Result()
        if (!isSecure(b)) {
            res.bytes = b.copyOf()
            return res
        }
        val ver = b[3].toInt()
        val flags = b[4].toInt()
        val encrypted = flags and FLAG_ENC != 0
        val sgn = flags and FLAG_SIG != 0
        res.secure = true
        res.version = ver
        res.encrypted = encrypted
        res.signed = sgn
        var end = b.size
        if (sgn) {
            if (b.size < 5 + 65 + 64) {
                res.err = "Code is damaged"
                return res
            }
            val pub = b.copyOfRange(end - 129, end - 64)
            val sig = b.copyOfRange(end - 64, end)
            res.signatureValid = if (p256Verify(pub, b.copyOfRange(0, end - 129), sig)) 1 else 0
            res.signerFingerprint = fingerprint(pub)
            if (res.signatureValid == 1 && trustedFps != null) {
                for (fp in trustedFps) if (fp == res.signerFingerprint) res.trusted = true
            }
            end -= 129
            if (res.signatureValid != 1) {
                res.err = "Signature is not valid. This code was changed or forged."
                return res
            }
        }
        if (!encrypted) {
            res.bytes = b.copyOfRange(5, end)
            return res
        }
        val hl: Int
        val salt: ByteArray
        val iv: ByteArray
        var kdf: Int
        var iter = 0L
        var mem = 0L
        var t = 0
        var lanes = 0
        if (ver == 1) {
            hl = HEAD1
            if (end < hl + 16) {
                res.err = "Code is damaged"
                return res
            }
            salt = b.copyOfRange(5, 21)
            iv = b.copyOfRange(21, 33)
            kdf = 1
            iter = be32r(b, 33)
        } else {
            hl = HEAD2
            if (end < hl + 16) {
                res.err = "Code is damaged"
                return res
            }
            kdf = b[5].toInt()
            salt = b.copyOfRange(12, 28)
            iv = b.copyOfRange(28, 40)
            if (kdf == 2) {
                mem = be32r(b, 6)
                t = b[10].toInt()
                lanes = b[11].toInt()
            } else {
                iter = be32r(b, 6)
            }
        }
        if ((kdf == 1 && (iter < 100000 || iter > 5000000)) ||
            (kdf == 2 && (mem < 8192 || mem > 262144 || t < 1 || t > 12 || lanes < 1 || lanes > 4)) ||
            (kdf != 1 && kdf != 2)
        ) {
            res.err = "Code is damaged or unsupported"
            return res
        }
        if (password.isEmpty()) {
            res.needsPassword = true
            return res
        }
        val key = try {
            deriveKey(password, salt, kdf, iter, mem, t, lanes)
        } catch (e: Exception) {
            res.err = "Key derivation failed"
            return res
        }
        val pt = aes256gcmDecrypt(key, iv, b.copyOfRange(0, hl), b.copyOfRange(hl, end - 16), b.copyOfRange(end - 16, end))
        if (pt == null) {
            res.err = "Wrong password, or the code was changed."
            return res
        }
        res.bytes = pt
        return res
    }

    // generatePassphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
    fun generatePassphrase(): String {
        val alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        val r = ByteArray(28)
        SecureRandom().nextBytes(r)
        val sb = StringBuilder()
        for (g in 0 until 7) {
            if (g > 0) sb.append('-')
            for (i in 0 until 4) sb.append(alpha[r[g * 4 + i].toInt() and 31])
        }
        return sb.toString()
    }

    // strength estimates password strength; same heuristic as the site.
    // Returns Triple(bits, level 0-4, label).
    fun strength(pw: String): Triple<Int, Int, String> {
        val labels = arrayOf("weak", "weak", "fair", "good", "strong")
        val n = pw.length
        if (n == 0) return Triple(0, 0, "none")
        run { // generated-passphrase shape
            var groups = 1
            var ok = true
            var bodyLen = 0
            for (i in 0 until n) {
                val c = pw[i]
                if (c == '-') {
                    groups++
                    continue
                }
                if (!(c in 'A'..'Z' && c != 'I' && c != 'O') && c !in '2'..'9') {
                    ok = false
                    break
                }
                bodyLen++
            }
            if (groups >= 6 && ok && bodyLen >= 24) return Triple(bodyLen * 5, 4, "excellent (random)")
        }
        var lo = false
        var up = false
        var dig = false
        var sym = false
        for (i in 0 until n) {
            val c = pw[i]
            when {
                c in 'a'..'z' -> lo = true
                c in 'A'..'Z' -> up = true
                c in '0'..'9' -> dig = true
                else -> sym = true
            }
        }
        var pool = 0
        if (lo) pool += 26
        if (up) pool += 26
        if (dig) pool += 10
        if (sym) pool += 33
        if (pool < 2) pool = 2
        var lp = 0.0
        run {
            var p = pool
            while (p > 1) {
                lp += 1
                p = p shr 1
            }
            lp += (pool - (1 shl lp.toInt())).toDouble() / (1 shl lp.toInt()).toDouble()
        }
        var uniq = 0
        for (i in 0 until n) {
            var seen = false
            for (j in 0 until i) if (pw[j] == pw[i]) seen = true
            if (!seen) uniq++
        }
        var capN = n
        if (uniq * 2 < n) capN = uniq * 2
        var bits = capN * lp
        for (i in 0 until n - 2) {
            if (pw[i] == pw[i + 1] && pw[i] == pw[i + 2]) {
                bits *= 0.7
                break
            }
        }
        val seqs = arrayOf(
            "012", "123", "234", "345", "456", "567", "678", "789",
            "abc", "bcd", "cde", "def", "qwe", "wer", "asd", "sdf", "zxc"
        )
        seqloop@ for (sq in seqs) {
            for (i in 0 until n - 2) {
                if (pw[i].lowercaseChar() == sq[0] && pw[i + 1].lowercaseChar() == sq[1] &&
                    pw[i + 2].lowercaseChar() == sq[2]
                ) {
                    bits *= 0.7
                    break@seqloop
                }
            }
        }
        if ((lo && !up && !dig && !sym) || (dig && !lo && !up && !sym)) bits *= 0.8
        for (i in 0 until n - 3) {
            if ((pw[i] == '1' && pw[i + 1] == '9') || (pw[i] == '2' && pw[i + 1] == '0')) {
                if (pw[i + 2] in '0'..'9' && pw[i + 3] in '0'..'9') {
                    bits -= 8
                    break
                }
            }
        }
        val common = arrayOf(
            "password", "passw0rd", "qwerty", "letmein", "welcome", "admin",
            "iloveyou", "monkey", "dragon", "football", "baseball", "shalom", "israel",
            "master", "login", "abc123", "prism", "secret", "hello", "test", "summer",
            "winter", "sunshine", "princess", "trustno1", "whatever", "google", "avi",
            "1234", "asdf", "zxcv", "love", "god", "cohen", "levi"
        )
        val low = pw.lowercase()
        for (w in common) {
            if (low.contains(w)) {
                if (bits > 28) bits = 28.0
                if (low == w) bits -= 8
                break
            }
        }
        var ibits = bits.toInt()
        if (ibits < 0) ibits = 0
        val level = when {
            ibits < 40 -> 0
            ibits < 60 -> 1
            ibits < 80 -> 2
            ibits < 100 -> 3
            else -> 4
        }
        return Triple(ibits, level, labels[level])
    }
}
