// Prism Code - Kotlin (JVM) port of the live JavaScript encoder/decoder.
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// Standard library only (javax.imageio for PNG).
//
// Format: pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray
// coding (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to
// 113x130 cells. Filled corner gap pattern, asymmetric ring, pilot cells,
// triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D
// Reed-Solomon blocks, payload CRC-32.

import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Arrays
import kotlin.math.*

object Prism {

    val S3: Double = sqrt(3.0)
    val Q: Double = 3 * S3
    val SIZES = arrayOf(intArrayOf(21, 24), intArrayOf(29, 33), intArrayOf(41, 47),
                        intArrayOf(57, 66), intArrayOf(81, 94), intArrayOf(113, 130))
    val HEX = arrayOf("#1B1B1B", "#2E5BFF", "#00B8D9", "#2DB35A", "#F5C518",
                      "#F77F00", "#D7263D", "#B5179E", "#FFFFFF")
    val PAL: Array<IntArray> = Array(9) { i ->
        intArrayOf(HEX[i].substring(1, 3).toInt(16),
                   HEX[i].substring(3, 5).toInt(16),
                   HEX[i].substring(5, 7).toInt(16))
    }

    // ---------------------------------------------------------------- rng

    /** Exact port of the JS seeded rng; next() returns a double in [0,1). */
    class Rng(seed: Int) {
        private var seed = seed
        fun next(): Double {
            seed = seed + 0x6D2B79F5
            var t = (seed xor (seed ushr 15)) * (1 or seed)
            t = (t + ((t xor (t ushr 7)) * (61 or t))) xor t
            return Integer.toUnsignedLong(t xor (t ushr 14)).toDouble() / 4294967296.0
        }
    }

    // ---------------------------------------------------------------- crc

    private val CRC_TABLE = IntArray(256).also { t ->
        for (n in 0 until 256) {
            var c = n
            repeat(8) { c = if (c and 1 != 0) 0xEDB88320.toInt() xor (c ushr 1) else c ushr 1 }
            t[n] = c
        }
    }

    fun crc32(data: ByteArray): Long {
        var c = 0xFFFFFFFF.toInt()
        for (b in data) c = CRC_TABLE[(c xor b.toInt()) and 255] xor (c ushr 8)
        return (c xor 0xFFFFFFFF.toInt()).toLong() and 0xFFFFFFFFL
    }

    fun crc4(bits: IntArray): Int {
        var r = 0
        for (b in bits) {
            val f = ((r shr 3) and 1) xor b
            r = (r shl 1) and 15
            if (f != 0) r = r xor 3
        }
        return r
    }

    fun PADK(o: Int): Int {
        var x = (o + 0x9E3779B9.toInt()) * 0x85EBCA6B.toInt()
        x = x xor (x ushr 13)
        x = x * 0xC2B2AE35.toInt()
        x = x xor (x ushr 16)
        return x and 255
    }

    // ---------------------------------------------------------------- GF(256)

    val EXP = IntArray(512)
    val LOG = IntArray(256)

    init {
        var z = 1
        for (i in 0 until 255) {
            EXP[i] = z; LOG[z] = i
            z = z shl 1
            if (z and 256 != 0) z = z xor 0x11D
        }
        for (i in 255 until 512) EXP[i] = EXP[i - 255]
    }

    fun gmul(a: Int, b: Int) = if (a != 0 && b != 0) EXP[LOG[a] + LOG[b]] else 0
    fun gdiv(a: Int, b: Int): Int {
        require(b != 0) { "GF division by zero" }
        return if (a != 0) EXP[(LOG[a] + 255 - LOG[b]) % 255] else 0
    }
    fun peval(p: IntArray, x: Int): Int {
        var y = 0
        for (i in p.size - 1 downTo 0) y = gmul(y, x) xor p[i]
        return y
    }
    fun pmul(a: IntArray, b: IntArray): IntArray {
        val o = IntArray(a.size + b.size - 1)
        for (i in a.indices) {
            val ai = a[i]
            if (ai != 0) for (j in b.indices) o[i + j] = o[i + j] xor gmul(ai, b[j])
        }
        return o
    }

    private val GEN_CACHE = HashMap<Int, IntArray>()

    fun rsEncode(msg: IntArray, nsym: Int): IntArray {
        var g: IntArray? = GEN_CACHE[nsym]
        if (g == null) {
            var ng = intArrayOf(1)
            for (i in 0 until nsym) ng = pmul(ng, intArrayOf(1, EXP[i]))
            GEN_CACHE[nsym] = ng
            g = ng
        }
        val gen = g
        val out = IntArray(msg.size + nsym)
        System.arraycopy(msg, 0, out, 0, msg.size)
        for (i in msg.indices) {
            val c = out[i]
            if (c != 0) for (j in 1 until gen.size) out[i + j] = out[i + j] xor gmul(gen[j], c)
        }
        System.arraycopy(msg, 0, out, 0, msg.size)
        return out
    }

    fun syndromes(r: IntArray, n: Int): IntArray {
        val s = IntArray(n)
        for (j in 0 until n) {
            var y = 0
            val x = EXP[j]
            for (i in r.indices) y = gmul(y, x) xor r[i]
            s[j] = y
        }
        return s
    }

    fun bm(s: IntArray): IntArray {
        val c = IntArray(s.size + 1); val b = IntArray(s.size + 1)
        c[0] = 1; b[0] = 1
        var L = 0; var m = 1; var bb = 1
        for (n in s.indices) {
            var d = s[n]
            for (i in 1..L) d = d xor gmul(c[i], s[n - i])
            if (d == 0) { m++; continue }
            val t = c.copyOf()
            val v = gdiv(d, bb)
            for (i in 0 until c.size - m) c[i + m] = c[i + m] xor gmul(v, b[i])
            if (2 * L <= n) { L = n + 1 - L; for (i in t.indices) b[i] = t[i]; bb = d; m = 1 }
            else m++
        }
        return c.copyOf(L + 1)
    }

    /** Returns the corrected codeword. Throws on failure. */
    fun rsDecode(input: IntArray, nsym: Int, erasures: IntArray = intArrayOf()): IntArray {
        val r = input.copyOf()
        val s = syndromes(r, nsym)
        if (s.all { it == 0 }) return r
        if (erasures.size > nsym) throw IllegalStateException("Too many erasures")
        var G = intArrayOf(1)
        val T = s.toMutableList()
        for (p in erasures) {
            if (p < 0 || p >= r.size) throw IllegalStateException("Erasure index")
            val X = EXP[r.size - 1 - p]
            G = pmul(G, intArrayOf(1, X))
            for (j in 0 until T.size - 1) T[j] = gmul(T[j], X) xor T[j + 1]
            T.removeAt(T.size - 1)
        }
        val E = bm(T.toIntArray())
        if (2 * (E.size - 1) + erasures.size > nsym) throw IllegalStateException("RS correction limit")
        val loc = pmul(G, E)
        val pos = ArrayList<Int>()
        for (p in r.indices) {
            val e = r.size - 1 - p
            if (peval(loc, EXP[((255 - e) % 255 + 255) % 255]) == 0) pos.add(p)
        }
        if (pos.size != loc.size - 1) throw IllegalStateException("RS roots")
        val omega = pmul(s, loc).copyOf(nsym)
        val der = IntArray(max(1, loc.size - 1))
        var i = 1
        while (i < loc.size) { der[i - 1] = loc[i]; i += 2 }
        for (p in pos) {
            val e = r.size - 1 - p
            val X = EXP[e]; val xi = EXP[((255 - e) % 255 + 255) % 255]
            r[p] = r[p] xor gdiv(gmul(X, peval(omega, xi)), peval(der, xi))
        }
        if (syndromes(r, nsym).any { it != 0 }) throw IllegalStateException("RS syndrome check")
        return r
    }

    // ---------------------------------------------------------------- layout

    class Cell(val i: Int, val j: Int, val x: Double, val y: Double,
               var role: String, val symbol: Int, val pi: Int, val pj: Int, val index: Int) {
        var header = -1
    }

    class Layout {
        var size = 0; var C = 0; var R = 0
        var W = 0.0; var H = 0.0
        lateinit var cells: Array<Cell>
        lateinit var headers: Array<Cell>
        lateinit var data: Array<Cell>
        lateinit var known: Array<Cell>
        var cd: Array<Cell>? = null
    }

    private val LAYOUT_CACHE = arrayOfNulls<Layout>(6)

    @Synchronized
    fun layout(size: Int): Layout {
        LAYOUT_CACHE.getOrNull(size)?.let { return it }
        require(size in SIZES.indices) { "Unknown size" }
        val C = SIZES[size][0]; val R = SIZES[size][1]
        val cells = ArrayList<Cell>(); val M = ArrayList<Cell>(); val known = ArrayList<Cell>()
        for (j in 0 until R) for (i in 0 until C) {
            var role = "data"
            var symbol = -1
            val pi = (i - 2) / 5; val pj = (j - 2) / 5
            if (j <= 2 && i <= 2) { role = "gap"; symbol = 8 }
            else if (j == 0 || j == R - 1 || i == 0 || i == C - 1) { role = "ring"; symbol = (j * 5 + i * 3) % 8 }
            else if (i % 5 == 2 && j % 5 == 2) { role = "pilot"; symbol = (pi * 2 + pj * 3) % 9 }
            val c = Cell(i, j, S3 * (i + .5 + .5 * (j and 1)), 1 + 1.5 * j, role, symbol, pi, pj, cells.size)
            cells.add(c)
            if (role == "data") M.add(c) else if (role != "gap") known.add(c)
        }
        val headers = ArrayList<Cell>()
        for (n in 0 until 72) {
            val c = M[floor((n + .5) * M.size / 72).toInt()]
            c.role = "header"; c.header = n
            headers.add(c)
        }
        val data = cells.filter { it.role == "data" }.toMutableList()
        val rand = Rng(0x5EED xor size)
        for (i in data.size - 1 downTo 1) {
            val j = floor(rand.next() * (i + 1)).toInt()
            val t = data[i]; data[i] = data[j]; data[j] = t
        }
        val l = Layout()
        l.size = size; l.C = C; l.R = R
        l.W = S3 * (C + .5); l.H = 2 + 1.5 * (R - 1)
        l.cells = cells.toTypedArray()
        l.headers = headers.toTypedArray()
        l.data = data.toTypedArray()
        l.known = known.toTypedArray()
        LAYOUT_CACHE[size] = l
        return l
    }

    /** Centre-out data order used when a logo sits in the middle (logo=1). */
    fun PLcd(l: Layout): Array<Cell> {
        l.cd?.let { return it }
        val cx = l.W / 2; val cy = l.H / 2
        val n = l.data.size
        val b = IntArray(n)
        val ord = Array(n) { it }
        for (k in 0 until n) {
            val dx = l.data[k].x - cx; val dy = l.data[k].y - cy
            b[k] = floor(sqrt(dx * dx + dy * dy) / 3).toInt()
        }
        ord.sortWith { p, q -> if (b[p] != b[q]) b[q].compareTo(b[p]) else p.compareTo(q) }
        val cd = Array(n) { l.data[ord[it]] }
        l.cd = cd
        return cd
    }

    class Capacity {
        var n = 0; var k = 0; var payload = 0
        lateinit var blocks: Array<IntArray> // each {n, nsym, k}
    }

    fun capacity(size: Int, ecc: Int, mode: Int): Capacity {
        val l = layout(size)
        val n = l.data.size * (if (mode == 1) 1 else 3) / 8
        val B = (n + 254) / 255
        val cap = Capacity()
        cap.blocks = Array(B) { i ->
            val len = n / B + (if (i < n % B) 1 else 0)
            val nsym = max(4, 2 * floor(len * doubleArrayOf(.1, .2, .3, .4)[ecc] / 2 + 0.5).toInt())
            intArrayOf(len, nsym, len - nsym)
        }
        cap.n = n
        cap.k = cap.blocks.sumOf { it[2] }
        cap.payload = max(0, cap.k - 4)
        return cap
    }

    private fun pushBits(a: MutableList<Int>, x: Int, n: Int) {
        for (k in n - 1 downTo 0) a.add((x shr k) and 1)
    }

    fun headerBits(size: Int, ecc: Int, mode: Int, type: Int, L: Int): IntArray {
        val b = ArrayList<Int>()
        pushBits(b, size, 3); pushBits(b, ecc, 2); pushBits(b, mode, 1)
        pushBits(b, type, 1); pushBits(b, L, 13)
        pushBits(b, crc4(b.toIntArray()), 4)
        return b.toIntArray()
    }

    fun knownSymbol(c: Cell, mode: Int): Int {
        if (mode == 1) {
            if (c.role == "ring") return 0
            return if ((c.pi + c.pj) % 2 == 0) 0 else 8
        }
        return c.symbol
    }

    // ---------------------------------------------------------------- encode

    class Code {
        var size = 0; var ecc = 0; var mode = 0; var type = 0
        lateinit var bytes: ByteArray
        lateinit var symbols: IntArray
        lateinit var layout: Layout
        lateinit var capacity: Capacity
    }

    @JvmOverloads
    fun encode(payload: ByteArray, size0: Int = -1, ecc: Int = 1, mode: Int = 0, type: Int = 0, logo: Int = 0): Code {
        require(payload.size <= 8191) { "Payload exceeds 8191 bytes" }
        var size = size0
        if (size < 0) {
            size = -1
            for (i in SIZES.indices)
                if (capacity(i, ecc, mode).k >= payload.size + 4) { size = i; break }
            require(size >= 0) { "Payload too large for this mode and ECC" }
        }
        val cap = capacity(size, ecc, mode)
        require(cap.k >= payload.size + 4) { "Payload does not fit: maximum ${cap.payload} bytes" }
        val msg = IntArray(cap.k)
        for (i in payload.size + 4 until cap.k) msg[i] = PADK(i)
        for (i in payload.indices) msg[i] = payload[i].toInt() and 255
        val crc = crc32(payload)
        for (k in 0 until 4) msg[payload.size + k] = (crc shr (24 - 8 * k)).toInt() and 255
        var off = 0
        val blocks = Array(cap.blocks.size) { bi ->
            val b = cap.blocks[bi]
            val r = rsEncode(msg.copyOfRange(off, off + b[2]), b[1])
            off += b[2]
            r
        }
        val stream = ArrayList<Int>()
        val maxLen = blocks.maxOf { it.size }
        for (p in 0 until maxLen)
            for (b in blocks) if (p < b.size) pushBits(stream, b[p], 8)
        val rand = Rng(0xBEEF)
        val l = layout(size)
        val symbols = IntArray(l.cells.size) { 8 }
        for (c in l.known) symbols[c.index] = knownSymbol(c, mode)
        val hb = headerBits(size, ecc, mode, type, payload.size)
        for (c in l.headers) symbols[c.index] = if (hb[c.header % 24] != 0) 0 else 8
        for (c in l.cells) if (c.role == "gap")
            symbols[c.index] = if (mode == 1) (if ((c.i + c.j) % 2 != 0) 0 else 8) else (c.j * 5 + c.i * 3) % 8
        var at = 0
        val order = if (logo != 0) PLcd(l) else l.data
        for (c in order) {
            if (mode == 1) {
                val bit = if (at < stream.size) stream[at] else (if (rand.next() > .5) 1 else 0)
                at++
                symbols[c.index] = if (bit != 0) 0 else 8
            } else {
                var b = 0
                repeat(3) {
                    val bit = if (at < stream.size) stream[at] else (if (rand.next() > .5) 1 else 0)
                    at++
                    b = (b shl 1) or bit
                }
                var v = b
                v = v xor (v shr 1)
                v = v xor (v shr 2)
                symbols[c.index] = v
            }
        }
        val code = Code()
        code.size = size; code.ecc = ecc; code.mode = mode; code.type = type
        code.bytes = payload; code.symbols = symbols; code.layout = l; code.capacity = cap
        return code
    }

    // ---------------------------------------------------------------- render / PNG

    /** Same geometry as Prism.render: hard-edged hexagons on white. */
    fun render(code: Code, r: Int): BufferedImage {
        val l = code.layout
        val w = ceil((l.W + 2 * Q) * r).toInt()
        val h = ceil((l.H + 2 * Q) * r).toInt()
        val img = BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB)
        val px = IntArray(w * h) { 0xFFFFFFFF.toInt() }
        for (c in l.cells) {
            val s = code.symbols[c.index]
            if (s == 8) continue
            val pts = Array(6) { k ->
                val a = Math.toRadians((30 + 60 * k).toDouble())
                doubleArrayOf((c.x + Q + 1.03 * cos(a)) * r, (c.y + Q + 1.03 * sin(a)) * r)
            }
            fillPoly(px, w, h, pts, PAL[s])
        }
        img.setRGB(0, 0, w, h, px, 0, w)
        return img
    }

    private fun fillPoly(img: IntArray, w: Int, h: Int, pts: Array<DoubleArray>, rgb: IntArray) {
        var miny = Double.MAX_VALUE; var maxy = -Double.MAX_VALUE
        for (p in pts) { miny = min(miny, p[1]); maxy = max(maxy, p[1]) }
        val y0 = max(0, floor(miny).toInt()); val y1 = min(h - 1, ceil(maxy).toInt())
        val argb = 0xFF000000.toInt() or (rgb[0] shl 16) or (rgb[1] shl 8) or rgb[2]
        val xs = DoubleArray(pts.size)
        for (y in y0..y1) {
            val yc = y + 0.5
            var nx = 0
            for (k in pts.indices) {
                val x1 = pts[k][0]; val a = pts[k][1]
                val x2 = pts[(k + 1) % pts.size][0]; val b = pts[(k + 1) % pts.size][1]
                if ((a <= yc && yc < b) || (b <= yc && yc < a)) xs[nx++] = x1 + (yc - a) / (b - a) * (x2 - x1)
            }
            Arrays.sort(xs, 0, nx)
            var k = 0
            while (k + 1 < nx) {
                val xa = max(0, Math.round(xs[k] - 0.5).toInt())
                val xb = min(w - 1, Math.round(xs[k + 1] - 0.5).toInt() - 1)
                for (x in xa..xb) img[y * w + x] = argb
                k += 2
            }
        }
    }

    // ---------------------------------------------------------------- decode (clean images)

    class Decoded {
        lateinit var payload: ByteArray
        var size = 0; var ecc = 0; var mode = 0; var type = 0; var length = 0
    }

    private fun nearestSymbol(r: Int, g: Int, b: Int): Int {
        var best = 0; var bestd = Long.MAX_VALUE
        for (i in 0 until 9) {
            val d = (r - PAL[i][0]).toLong() * (r - PAL[i][0]) +
                    (g - PAL[i][1]).toLong() * (g - PAL[i][1]) +
                    (b - PAL[i][2]).toLong() * (b - PAL[i][2])
            if (d < bestd) { bestd = d; best = i }
        }
        return best
    }

    private fun symbolBits(sym: Int, mode: Int): IntArray {
        if (mode == 1) return intArrayOf(if (sym == 0) 1 else 0)
        val t = sym xor (sym shr 1)
        return intArrayOf((t shr 2) and 1, (t shr 1) and 1, t and 1)
    }

    private fun decodeSymbols(symbols: IntArray, l: Layout, order: Array<Cell>?): Decoded {
        val hb = IntArray(24)
        for (n in 0 until 24) {
            var votes = 0
            for (rep in 0 until 3)
                if (symbols[l.headers[n + 24 * rep].index] == 0) votes++
            hb[n] = if (votes >= 2) 1 else 0
        }
        var at = 0
        fun rd(n: Int): Int {
            var v = 0
            repeat(n) { v = (v shl 1) or hb[at++] }
            return v
        }
        val size = rd(3); val ecc = rd(2); val mode = rd(1); val type = rd(1)
        val L = rd(13); val hcrc = rd(4)
        if (crc4(hb.copyOf(20)) != hcrc || size > 5 || size != l.size)
            throw IllegalStateException("header checksum failed")
        val cap = capacity(size, ecc, mode)
        if (L > cap.payload) throw IllegalStateException("invalid length")
        val cells = order ?: l.data
        val stream = ArrayList<Int>()
        for (c in cells) for (bit in symbolBits(symbols[c.index], mode)) stream.add(bit)
        val bts = IntArray(cap.n)
        for (i in 0 until cap.n) {
            var v = 0
            for (k in 0 until 8) v = (v shl 1) or stream[8 * i + k]
            bts[i] = v
        }
        val blocks = Array(cap.blocks.size) { IntArray(cap.blocks[it][0]) }
        at = 0
        val maxn = cap.blocks.maxOf { it[0] }
        for (p in 0 until maxn)
            for (bi in blocks.indices)
                if (p < cap.blocks[bi][0]) blocks[bi][p] = bts[at++]
        val msg = ByteArrayOutputStream()
        for (bi in blocks.indices) {
            val dec = rsDecode(blocks[bi], cap.blocks[bi][1])
            for (p in 0 until cap.blocks[bi][2]) msg.write(dec[p])
        }
        val m = msg.toByteArray()
        val payload = m.copyOf(L)
        val got = (m[L].toLong() and 255 shl 24) or (m[L + 1].toLong() and 255 shl 16) or
                  (m[L + 2].toLong() and 255 shl 8) or (m[L + 3].toLong() and 255)
        if (crc32(payload) != got) throw IllegalStateException("payload CRC-32 failed")
        val d = Decoded()
        d.payload = payload; d.size = size; d.ecc = ecc; d.mode = mode; d.type = type; d.length = L
        return d
    }

    /** Decode a clean/perfect encoder PNG image. */
    fun decodeImage(img: BufferedImage): Decoded {
        val w = img.width; val h = img.height
        val px = img.getRGB(0, 0, w, h, null, 0, w)
        var xmin = w; var ymin = h; var xmax = -1; var ymax = -1
        for (y in 0 until h) for (x in 0 until w) {
            val p = px[y * w + x]
            val r = (p shr 16) and 255; val g = (p shr 8) and 255; val b = p and 255
            if (r < 250 || g < 250 || b < 250) {
                if (x < xmin) xmin = x
                if (x > xmax) xmax = x
                if (y < ymin) ymin = y
                if (y > ymax) ymax = y
            }
        }
        if (xmax < 0) throw IllegalStateException("no code found")
        val HEXHW = 1.03 * 0.8660254037844386; val HEXHH = 1.03
        var last: Exception? = null
        for (size in 0 until 6) {
            try {
                val l = layout(size)
                var mincx = 1e9; var maxcx = -1e9; var mincy = 1e9; var maxcy = -1e9
                for (c in l.known) if (c.role == "ring") {
                    mincx = min(mincx, c.x); maxcx = max(maxcx, c.x)
                    mincy = min(mincy, c.y); maxcy = max(maxcy, c.y)
                }
                mincx -= HEXHW; maxcx += HEXHW; mincy -= HEXHH; maxcy += HEXHH
                val rx = (xmax - xmin + 1) / (maxcx - mincx)
                val ry = (ymax - ymin + 1) / (maxcy - mincy)
                if (abs(rx - ry) / max(rx, ry) > 0.05) continue
                val symbols = IntArray(l.cells.size) { 8 }
                for (c in l.cells) {
                    val pxc = xmin + (c.x - mincx) * rx
                    val pyc = ymin + (c.y - mincy) * ry
                    var sr = 0L; var sg = 0L; var sb = 0L; var n = 0
                    for (dy in -1..1) for (dx in -1..1) {
                        val xx = min(w - 1, max(0, (pxc + dx * rx * 0.15).toInt()))
                        val yy = min(h - 1, max(0, (pyc + dy * ry * 0.15).toInt()))
                        val p = px[yy * w + xx]
                        sr += (p shr 16) and 255; sg += (p shr 8) and 255; sb += p and 255; n++
                    }
                    symbols[c.index] = nearestSymbol((sr / n).toInt(), (sg / n).toInt(), (sb / n).toInt())
                }
                try {
                    return decodeSymbols(symbols, l, null)
                } catch (e: Exception) {
                    return decodeSymbols(symbols, l, PLcd(l)) // logo-encoded codes
                }
            } catch (e: Exception) {
                last = e
            }
        }
        throw IllegalStateException("decode failed: $last")
    }
}
