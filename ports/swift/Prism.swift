// Prism Code - Swift port of the live JavaScript encoder/decoder.
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// Prism Code by Avi Shor. Free to use, with or without credit. No warranty.
// Standard library + system zlib (PNG compression) only.
import CZlib
import Foundation

public let S3 = 3.0.squareRoot()
public let Q = 3 * S3
public let SIZES: [(Int, Int)] = [(21,24),(29,33),(41,47),(57,66),(81,94),(113,130)]
public let HEX = ["#1B1B1B","#2E5BFF","#00B8D9","#2DB35A","#F5C518","#F77F00","#D7263D","#B5179E","#FFFFFF"]
public let PAL: [(UInt8,UInt8,UInt8)] = HEX.map { h in
    let s = h.dropFirst()
    return (UInt8(s.prefix(2), radix: 16)!, UInt8(s.dropFirst(2).prefix(2), radix: 16)!, UInt8(s.dropFirst(4).prefix(2), radix: 16)!)
}

// ---------------------------------------------------------------- rng / crc

/// Exact port of the JS seeded rng.
public struct Rng {
    var seed: UInt32
    public init(_ seed: Int) { self.seed = UInt32(truncatingIfNeeded: seed) }
    public mutating func next() -> Double {
        seed = seed &+ 0x6D2B79F5
        var t = (seed ^ (seed >> 15)) &* (1 | seed)
        t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
        return Double(t ^ (t >> 14)) / 4294967296.0
    }
}

let CRC_TABLE: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n)
    for _ in 0..<8 { c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1) }
    return c
}

public func crc32(_ data: [UInt8]) -> UInt32 {
    var c: UInt32 = 0xFFFFFFFF
    for b in data { c = CRC_TABLE[Int((c ^ UInt32(b)) & 255)] ^ (c >> 8) }
    return c ^ 0xFFFFFFFF
}

public func crc4(_ bits: [Int]) -> Int {
    var r = 0
    for b in bits {
        let f = ((r >> 3) & 1) ^ b
        r = (r << 1) & 15
        if f != 0 { r ^= 3 }
    }
    return r
}

public func PADK(_ o: Int) -> Int {
    var x = UInt32(truncatingIfNeeded: o) &+ 0x9E3779B9
    x = x &* 0x85EBCA6B
    x ^= x >> 13
    x = x &* 0xC2B2AE35
    x ^= x >> 16
    return Int(x & 255)
}

// ---------------------------------------------------------------- GF(256)

let EXP: [Int] = {
    var e = [Int](repeating: 0, count: 512)
    var z = 1
    for i in 0..<255 { e[i] = z; z <<= 1; if z & 256 != 0 { z ^= 0x11D } }
    for i in 255..<512 { e[i] = e[i - 255] }
    return e
}()
let LOG: [Int] = {
    var l = [Int](repeating: 0, count: 256)
    var z = 1
    for i in 0..<255 { l[z] = i; z <<= 1; if z & 256 != 0 { z ^= 0x11D } }
    return l
}()

func gmul(_ a: Int, _ b: Int) -> Int { (a != 0 && b != 0) ? EXP[LOG[a] + LOG[b]] : 0 }
func gdiv(_ a: Int, _ b: Int) throws -> Int {
    if b == 0 { throw PrismError.gfDivZero }
    return a != 0 ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0
}
func peval(_ p: [Int], _ x: Int) -> Int {
    var y = 0
    for i in stride(from: p.count - 1, through: 0, by: -1) { y = gmul(y, x) ^ p[i] }
    return y
}
func pmul(_ a: [Int], _ b: [Int]) -> [Int] {
    var o = [Int](repeating: 0, count: a.count + b.count - 1)
    for i in 0..<a.count where a[i] != 0 {
        for j in 0..<b.count { o[i + j] ^= gmul(a[i], b[j]) }
    }
    return o
}

var genCache: [Int: [Int]] = [:]

public func rsEncode(_ msg: [Int], _ nsym: Int) -> [Int] {
    var g = genCache[nsym]
    if g == nil {
        var gg = [1]
        for i in 0..<nsym { gg = pmul(gg, [1, EXP[i]]) }
        g = gg
        genCache[nsym] = gg
    }
    let g2 = g!
    var out = msg + [Int](repeating: 0, count: nsym)
    for i in 0..<msg.count {
        let c = out[i]
        if c != 0 { for j in 1..<g2.count { out[i + j] ^= gmul(g2[j], c) } }
    }
    out.replaceSubrange(0..<msg.count, with: msg)
    return out
}

func syndromes(_ r: [Int], _ n: Int) -> [Int] {
    var s = [Int](repeating: 0, count: n)
    for j in 0..<n {
        var y = 0
        for i in 0..<r.count { y = gmul(y, EXP[j]) ^ r[i] }
        s[j] = y
    }
    return s
}

func bm(_ s: [Int]) throws -> [Int] {
    var c = [Int](repeating: 0, count: s.count + 1)
    var b = [Int](repeating: 0, count: s.count + 1)
    c[0] = 1; b[0] = 1
    var L = 0, m = 1, bb = 1
    for n in 0..<s.count {
        var d = s[n]
        for i in stride(from: 1, through: L, by: 1) { d ^= gmul(c[i], s[n - i]) }
        if d == 0 { m += 1; continue }
        let t = c
        let v = try gdiv(d, bb)
        var i = 0
        while i + m < c.count { c[i + m] ^= gmul(v, b[i]); i += 1 }
        if 2 * L <= n { L = n + 1 - L; b = t; bb = d; m = 1 } else { m += 1 }
    }
    return Array(c[0...L])
}

public func rsDecode(_ input: [Int], _ nsym: Int, erasures: [Int] = []) throws -> [Int] {
    var r = input
    let s = syndromes(r, nsym)
    if s.allSatisfy({ $0 == 0 }) { return r }
    if erasures.count > nsym { throw PrismError.rsFail("Too many erasures") }
    var G = [1]
    var T = s
    for p in erasures {
        if p < 0 || p >= r.count { throw PrismError.rsFail("Erasure index") }
        let X = EXP[r.count - 1 - p]
        G = pmul(G, [1, X])
        for j in 0..<(T.count - 1) { T[j] = gmul(T[j], X) ^ T[j + 1] }
        T.removeLast()
    }
    let E = try bm(T)
    if 2 * (E.count - 1) + erasures.count > nsym { throw PrismError.rsFail("RS correction limit") }
    let loc = pmul(G, E)
    var pos: [Int] = []
    for p in 0..<r.count {
        let e = r.count - 1 - p
        if peval(loc, EXP[((255 - e) % 255 + 255) % 255]) == 0 { pos.append(p) }
    }
    if pos.count != loc.count - 1 { throw PrismError.rsFail("RS roots") }
    let omega = Array(pmul(s, loc).prefix(nsym))
    var der = [Int](repeating: 0, count: max(1, loc.count - 1))
    var i = 1
    while i < loc.count { der[i - 1] = loc[i]; i += 2 }
    for p in pos {
        let e = r.count - 1 - p, X = EXP[e], xi = EXP[((255 - e) % 255 + 255) % 255]
        r[p] ^= try gdiv(gmul(X, peval(omega, xi)), peval(der, xi))
    }
    if !syndromes(r, nsym).allSatisfy({ $0 == 0 }) { throw PrismError.rsFail("RS syndrome check") }
    return r
}

public enum PrismError: Error {
    case gfDivZero, rsFail(String), unknownSize, tooLarge(String), decodeFailed(String), badPNG(String)
}

// ---------------------------------------------------------------- layout

public final class Cell {
    public let i: Int, j: Int, pi: Int, pj: Int, index: Int
    public let x: Double, y: Double
    public var role: String, symbol: Int, header: Int = -1
    init(i: Int, j: Int, x: Double, y: Double, role: String, symbol: Int, pi: Int, pj: Int, index: Int) {
        self.i = i; self.j = j; self.x = x; self.y = y; self.role = role
        self.symbol = symbol; self.pi = pi; self.pj = pj; self.index = index
    }
}

public final class LayoutT {
    public var size = 0, C = 0, R = 0
    public var W = 0.0, H = 0.0
    public var cells: [Cell] = [], headers: [Cell] = [], data: [Cell] = [], known: [Cell] = []
    public var cd: [Cell]? = nil
}

var layoutCache: [Int: LayoutT] = [:]

public func layout(_ size: Int) throws -> LayoutT {
    if let l = layoutCache[size] { return l }
    if size < 0 || size >= SIZES.count { throw PrismError.unknownSize }
    let (C, R) = SIZES[size]
    var cells: [Cell] = [], M: [Cell] = [], known: [Cell] = []
    for j in 0..<R {
        for i in 0..<C {
            var role = "data", symbol = -1
            let pi = (i - 2) / 5, pj = (j - 2) / 5
            if j <= 2 && i <= 2 { role = "gap"; symbol = 8 }
            else if j == 0 || j == R - 1 || i == 0 || i == C - 1 { role = "ring"; symbol = (j * 5 + i * 3) % 8 }
            else if i % 5 == 2 && j % 5 == 2 { role = "pilot"; symbol = (pi * 2 + pj * 3) % 9 }
            let c = Cell(i: i, j: j, x: S3 * (Double(i) + 0.5 + 0.5 * Double(j & 1)), y: 1 + 1.5 * Double(j),
                         role: role, symbol: symbol, pi: pi, pj: pj, index: cells.count)
            cells.append(c)
            if role == "data" { M.append(c) } else if role != "gap" { known.append(c) }
        }
    }
    var headers: [Cell] = []
    for n in 0..<72 {
        let c = M[Int(((Double(n) + 0.5) * Double(M.count) / 72).rounded(.down))]
        c.role = "header"; c.header = n
        headers.append(c)
    }
    var data = cells.filter { $0.role == "data" }
    var rand = Rng(0x5EED ^ size)
    for i in stride(from: data.count - 1, through: 1, by: -1) {
        let j = Int((rand.next() * Double(i + 1)).rounded(.down))
        data.swapAt(i, j)
    }
    let l = LayoutT()
    l.size = size; l.C = C; l.R = R
    l.W = S3 * (Double(C) + 0.5)
    l.H = 2 + 1.5 * Double(R - 1)
    l.cells = cells; l.headers = headers; l.data = data; l.known = known
    layoutCache[size] = l
    return l
}

/// Centre-out data order used when a logo sits in the middle (logo=1).
public func PLcd(_ l: LayoutT) -> [Cell] {
    if let cd = l.cd { return cd }
    let cx = l.W / 2, cy = l.H / 2
    let indexed = l.data.enumerated().map { (k, c) -> (Cell, Int, Int) in
        let dx = c.x - cx, dy = c.y - cy
        return (c, k, Int((dx * dx + dy * dy).squareRoot() / 3))
    }.sorted { a, b in a.2 != b.2 ? a.2 > b.2 : a.1 < b.1 }
    let cd = indexed.map { $0.0 }
    l.cd = cd
    return cd
}

public struct Capacity { public var n = 0, k = 0, payload = 0; public var blocks: [(n: Int, nsym: Int, k: Int)] = [] }

public func capacity(_ size: Int, _ ecc: Int, _ mode: Int) throws -> Capacity {
    let l = try layout(size)
    let n = l.data.count * (mode == 1 ? 1 : 3) / 8
    let B = (n + 254) / 255
    var cap = Capacity()
    for i in 0..<B {
        let len = n / B + (i < n % B ? 1 : 0)
        let nsym = max(4, 2 * Int((Double(len) * [0.1, 0.2, 0.3, 0.4][ecc] / 2).rounded())) // JS Math.round: half up
        cap.blocks.append((len, nsym, len - nsym))
    }
    cap.n = n
    cap.k = cap.blocks.reduce(0) { $0 + $1.k }
    cap.payload = max(0, cap.k - 4)
    return cap
}

func pushBits(_ a: inout [Int], _ x: Int, _ n: Int) {
    for k in stride(from: n - 1, through: 0, by: -1) { a.append((x >> k) & 1) }
}

public func headerBits(_ size: Int, _ ecc: Int, _ mode: Int, _ type: Int, _ L: Int) -> [Int] {
    var b: [Int] = []
    pushBits(&b, size, 3); pushBits(&b, ecc, 2); pushBits(&b, mode, 1); pushBits(&b, type, 1); pushBits(&b, L, 13)
    pushBits(&b, crc4(b), 4)
    return b
}

public func knownSymbol(_ c: Cell, _ mode: Int) -> Int {
    if mode == 1 {
        if c.role == "ring" { return 0 }
        return (c.pi + c.pj) % 2 == 0 ? 0 : 8
    }
    return c.symbol
}

// ---------------------------------------------------------------- encode

public struct Code {
    public var size = 0, ecc = 0, mode = 0, type = 0
    public var bytes: [UInt8] = []
    public var symbols: [Int] = []
    public var layout: LayoutT? = nil
    public var capacity = Capacity()
}

public func encode(_ payload: [UInt8], size: Int = -1, ecc: Int = 1, mode: Int = 0, type: Int = 0, logo: Int = 0) throws -> Code {
    if payload.count > 8191 { throw PrismError.tooLarge("Payload exceeds 8191 bytes") }
    var size = size
    if size < 0 {
        size = -1
        for i in 0..<SIZES.count {
            if try capacity(i, ecc, mode).k >= payload.count + 4 { size = i; break }
        }
        if size < 0 { throw PrismError.tooLarge("Payload too large for this mode and ECC") }
    }
    let cap = try capacity(size, ecc, mode)
    if cap.k < payload.count + 4 { throw PrismError.tooLarge("Payload does not fit: maximum \(cap.payload) bytes") }
    var msg = [Int](repeating: 0, count: cap.k)
    for i in (payload.count + 4)..<cap.k { msg[i] = PADK(i) }
    for i in 0..<payload.count { msg[i] = Int(payload[i]) }
    let crc = crc32(payload)
    for k in 0..<4 { msg[payload.count + k] = Int((crc >> UInt32(24 - 8 * k)) & 255) }
    var off = 0
    var blocks: [[Int]] = []
    for b in cap.blocks {
        blocks.append(rsEncode(Array(msg[off..<(off + b.k)]), b.nsym))
        off += b.k
    }
    var stream: [Int] = []
    let maxLen = blocks.map { $0.count }.max() ?? 0
    for p in 0..<maxLen {
        for b in blocks where p < b.count { pushBits(&stream, b[p], 8) }
    }
    var rand = Rng(0xBEEF)
    let l = try layout(size)
    var symbols = [Int](repeating: 8, count: l.cells.count)
    for c in l.known { symbols[c.index] = knownSymbol(c, mode) }
    let hb = headerBits(size, ecc, mode, type, payload.count)
    for c in l.headers { symbols[c.index] = hb[c.header % 24] != 0 ? 0 : 8 }
    for c in l.cells where c.role == "gap" {
        symbols[c.index] = mode == 1 ? (((c.i + c.j) % 2 != 0) ? 0 : 8) : (c.j * 5 + c.i * 3) % 8
    }
    var at = 0
    let order = logo != 0 ? PLcd(l) : l.data
    for c in order {
        if mode == 1 {
            let bit = at < stream.count ? stream[at] : (rand.next() > 0.5 ? 1 : 0)
            at += 1
            symbols[c.index] = bit != 0 ? 0 : 8
        } else {
            var b = 0
            for _ in 0..<3 {
                let bit = at < stream.count ? stream[at] : (rand.next() > 0.5 ? 1 : 0)
                at += 1
                b = (b << 1) | bit
            }
            var v = b
            v ^= v >> 1
            v ^= v >> 2
            symbols[c.index] = v
        }
    }
    var code = Code()
    code.size = size; code.ecc = ecc; code.mode = mode; code.type = type
    code.bytes = payload; code.symbols = symbols; code.layout = l; code.capacity = cap
    return code
}

// ---------------------------------------------------------------- render / PNG

func fillPoly(_ img: inout [UInt8], _ w: Int, _ h: Int, _ pts: [(Double, Double)], _ rgb: (UInt8, UInt8, UInt8)) {
    let miny = pts.map { $0.1 }.min()!, maxy = pts.map { $0.1 }.max()!
    let y0 = max(0, Int(miny.rounded(.down))), y1 = min(h - 1, Int(maxy.rounded(.up)))
    for y in y0...y1 {
        let yc = Double(y) + 0.5
        var xs: [Double] = []
        for k in 0..<pts.count {
            let (x1, a) = pts[k], (x2, b) = pts[(k + 1) % pts.count]
            if (a <= yc && yc < b) || (b <= yc && yc < a) { xs.append(x1 + (yc - a) / (b - a) * (x2 - x1)) }
        }
        xs.sort()
        var k = 0
        while k + 1 < xs.count {
            let xa = max(0, Int((xs[k] - 0.5).rounded())), xb = min(w - 1, Int((xs[k + 1] - 0.5).rounded()) - 1)
            if xa <= xb {
                for x in xa...xb {
                    let o = (y * w + x) * 4
                    img[o] = rgb.0; img[o + 1] = rgb.1; img[o + 2] = rgb.2; img[o + 3] = 255
                }
            }
            k += 2
        }
    }
}

/// Same geometry as Prism.render: hard-edged hexagons on white.
public func render(_ code: Code, _ r: Int) -> (Int, Int, [UInt8]) {
    let l = code.layout!
    let w = Int(((l.W + 2 * Q) * Double(r)).rounded(.up))
    let h = Int(((l.H + 2 * Q) * Double(r)).rounded(.up))
    var img = [UInt8](repeating: 255, count: w * h * 4)
    for c in l.cells {
        let s = code.symbols[c.index]
        if s == 8 { continue }
        var pts: [(Double, Double)] = []
        for k in 0..<6 {
            let a = Double(30 + 60 * k) * .pi / 180
            pts.append(((c.x + Q + 1.03 * cos(a)) * Double(r), (c.y + Q + 1.03 * sin(a)) * Double(r)))
        }
        fillPoly(&img, w, h, pts, PAL[s])
    }
    return (w, h, img)
}

func pngChunk(_ tag: [UInt8], _ data: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    var n = UInt32(data.count).bigEndian
    out += withUnsafeBytes(of: &n) { Array($0) }
    out += tag + data
    var c = crc32(tag + data).bigEndian
    out += withUnsafeBytes(of: &c) { Array($0) }
    return out
}

func zlibCompress(_ data: [UInt8], _ level: Int32 = 9) throws -> [UInt8] {
    var bound = compressBound(uLong(data.count))
    var out = [UInt8](repeating: 0, count: Int(bound))
    let rc = data.withUnsafeBufferPointer { src in
        out.withUnsafeMutableBufferPointer { dst in
            CZlib.compress2(dst.baseAddress!, &bound, src.baseAddress!, uLong(data.count), level)
        }
    }
    if rc != Z_OK { throw PrismError.badPNG("zlib compress failed") }
    return Array(out.prefix(Int(bound)))
}

func zlibDecompress(_ data: [UInt8], _ expected: Int) throws -> [UInt8] {
    var out = [UInt8](repeating: 0, count: expected)
    var outLen = uLongf(expected)
    let rc = data.withUnsafeBufferPointer { src in
        out.withUnsafeMutableBufferPointer { dst in
            CZlib.uncompress(dst.baseAddress!, &outLen, src.baseAddress!, uLong(data.count))
        }
    }
    if rc != Z_OK { throw PrismError.badPNG("zlib inflate failed") }
    return Array(out.prefix(Int(outLen)))
}

public func writePNG(_ width: Int, _ height: Int, _ rgba: [UInt8]) throws -> [UInt8] {
    let stride = width * 4
    var raw: [UInt8] = []
    raw.reserveCapacity((stride + 1) * height)
    for y in 0..<height {
        raw.append(0)
        raw += rgba[(y * stride)..<((y + 1) * stride)]
    }
    var ihdr: [UInt8] = []
    var wb = UInt32(width).bigEndian, hb = UInt32(height).bigEndian
    ihdr += withUnsafeBytes(of: &wb) { Array($0) }
    ihdr += withUnsafeBytes(of: &hb) { Array($0) }
    ihdr += [8, 6, 0, 0, 0]
    return [137, 80, 78, 71, 13, 10, 26, 10]
        + pngChunk([73, 72, 68, 82], ihdr)
        + pngChunk([73, 68, 65, 84], try zlibCompress(raw))
        + pngChunk([73, 69, 78, 68], [])
}

func paeth(_ a: Int, _ b: Int, _ c: Int) -> Int {
    let p = a + b - c, pa = abs(p - a), pb = abs(p - b), pc = abs(p - c)
    return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
}

public func readPNG(_ buf: [UInt8]) throws -> (Int, Int, [UInt8]) {
    if Array(buf.prefix(8)) != [137, 80, 78, 71, 13, 10, 26, 10] { throw PrismError.badPNG("not a png") }
    var pos = 8, ihdr: [UInt8] = [], idats: [UInt8] = [], plte: [UInt8] = []
    while pos + 8 <= buf.count {
        let ln = Int(buf[pos]) << 24 | Int(buf[pos + 1]) << 16 | Int(buf[pos + 2]) << 8 | Int(buf[pos + 3])
        let tag = Array(buf[(pos + 4)..<(pos + 8)])
        let data = Array(buf[(pos + 8)..<(pos + 8 + ln)])
        if tag == [73, 72, 68, 82] { ihdr = data }
        else if tag == [73, 68, 65, 84] { idats += data }
        else if tag == [80, 76, 84, 69] { plte = data }
        else if tag == [73, 69, 78, 68] { break }
        pos += 12 + ln
    }
    let w = Int(ihdr[0]) << 24 | Int(ihdr[1]) << 16 | Int(ihdr[2]) << 8 | Int(ihdr[3])
    let h = Int(ihdr[4]) << 24 | Int(ihdr[5]) << 16 | Int(ihdr[6]) << 8 | Int(ihdr[7])
    let depth = ihdr[8], ctype = ihdr[9]
    if depth != 8 { throw PrismError.badPNG("unsupported bit depth \(depth)") }
    let chMap: [UInt8: Int] = [0: 1, 2: 3, 3: 1, 4: 2, 6: 4]
    guard let ch = chMap[ctype] else { throw PrismError.badPNG("unsupported colour type \(ctype)") }
    let stride = w * ch
    let raw = try zlibDecompress(idats, (stride + 1) * h)
    var out = [UInt8](repeating: 0, count: w * h * 4)
    var prev = [UInt8](repeating: 0, count: stride)
    for y in 0..<h {
        let f = raw[y * (stride + 1)]
        var line = Array(raw[(y * (stride + 1) + 1)..<((y + 1) * (stride + 1))])
        if f != 0 {
            for x in 0..<stride {
                let a = x >= ch ? Int(line[x - ch]) : 0
                let b = Int(prev[x])
                let c = x >= ch ? Int(prev[x - ch]) : 0
                let v = Int(line[x])
                switch f {
                case 1: line[x] = UInt8((v + a) & 255)
                case 2: line[x] = UInt8((v + b) & 255)
                case 3: line[x] = UInt8((v + ((a + b) >> 1)) & 255)
                case 4: line[x] = UInt8((v + paeth(a, b, c)) & 255)
                default: throw PrismError.badPNG("bad filter \(f)")
                }
            }
        }
        for x in 0..<w {
            let o = (y * w + x) * 4
            switch ctype {
            case 6: out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]
            case 2: out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255
            case 0: out[o] = line[x]; out[o + 1] = line[x]; out[o + 2] = line[x]; out[o + 3] = 255
            case 4: out[o] = line[x * 2]; out[o + 1] = line[x * 2]; out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1]
            default:
                let pi = Int(line[x]) * 3
                out[o] = plte[pi]; out[o + 1] = plte[pi + 1]; out[o + 2] = plte[pi + 2]; out[o + 3] = 255
            }
        }
        prev = line
    }
    return (w, h, out)
}

// ---------------------------------------------------------------- decode (clean images)

public struct Decoded {
    public var payload: [UInt8] = []
    public var size = 0, ecc = 0, mode = 0, type = 0, length = 0
}

func symbolBits(_ sym: Int, _ mode: Int) -> [Int] {
    if mode == 1 { return [sym == 0 ? 1 : 0] }
    let t = sym ^ (sym >> 1)
    return [(t >> 2) & 1, (t >> 1) & 1, t & 1]
}

func nearestSymbol(_ r: Int, _ g: Int, _ b: Int) -> Int {
    var best = 0, bestd = Int.max
    for i in 0..<9 {
        let d = (r - Int(PAL[i].0)) * (r - Int(PAL[i].0)) + (g - Int(PAL[i].1)) * (g - Int(PAL[i].1)) + (b - Int(PAL[i].2)) * (b - Int(PAL[i].2))
        if d < bestd { bestd = d; best = i }
    }
    return best
}

func decodeSymbols(_ symbols: [Int], _ l: LayoutT, _ order: [Cell]?) throws -> Decoded {
    var hb = [Int](repeating: 0, count: 24)
    for n in 0..<24 {
        var votes = 0
        for rep in 0..<3 { if symbols[l.headers[n + 24 * rep].index] == 0 { votes += 1 } }
        hb[n] = votes >= 2 ? 1 : 0
    }
    var at = 0
    func rd(_ n: Int) -> Int { var v = 0; for _ in 0..<n { v = (v << 1) | hb[at]; at += 1 }; return v }
    let size = rd(3), ecc = rd(2), mode = rd(1), type = rd(1), L = rd(13), hcrc = rd(4)
    if crc4(Array(hb[0..<20])) != hcrc || size > 5 || size != l.size { throw PrismError.decodeFailed("header checksum failed") }
    let cap = try capacity(size, ecc, mode)
    if L > cap.payload { throw PrismError.decodeFailed("invalid length") }
    let cells = order ?? l.data
    var stream: [Int] = []
    stream.reserveCapacity(cells.count * (mode == 1 ? 1 : 3))
    for c in cells { stream += symbolBits(symbols[c.index], mode) }
    var bts = [Int](repeating: 0, count: cap.n)
    for i in 0..<cap.n {
        var v = 0
        for k in 0..<8 { v = (v << 1) | stream[8 * i + k] }
        bts[i] = v
    }
    var blocks = cap.blocks.map { [Int](repeating: 0, count: $0.n) }
    at = 0
    let maxn = cap.blocks.map { $0.n }.max() ?? 0
    for p in 0..<maxn {
        for bi in 0..<blocks.count where p < cap.blocks[bi].n {
            blocks[bi][p] = bts[at]; at += 1
        }
    }
    var msg: [UInt8] = []
    for bi in 0..<blocks.count {
        let dec = try rsDecode(blocks[bi], cap.blocks[bi].nsym)
        msg += dec[0..<cap.blocks[bi].k].map { UInt8($0) }
    }
    let payload = Array(msg[0..<L])
    let got = UInt32(msg[L]) << 24 | UInt32(msg[L + 1]) << 16 | UInt32(msg[L + 2]) << 8 | UInt32(msg[L + 3])
    if crc32(payload) != got { throw PrismError.decodeFailed("payload CRC-32 failed") }
    var d = Decoded()
    d.payload = payload; d.size = size; d.ecc = ecc; d.mode = mode; d.type = type; d.length = L
    return d
}

/// Decode a clean/perfect encoder PNG image.
public func decodeImage(_ w: Int, _ h: Int, _ rgba: [UInt8]) throws -> Decoded {
    var xmin = w, ymin = h, xmax = -1, ymax = -1
    for y in 0..<h {
        let row = y * w * 4
        for x in 0..<w {
            let o = row + x * 4
            if rgba[o] < 250 || rgba[o + 1] < 250 || rgba[o + 2] < 250 {
                if x < xmin { xmin = x }
                if x > xmax { xmax = x }
                if y < ymin { ymin = y }
                if y > ymax { ymax = y }
            }
        }
    }
    if xmax < 0 { throw PrismError.decodeFailed("no code found") }
    let HEXHW = 1.03 * 0.8660254037844386, HEXHH = 1.03
    var lastErr: Error = PrismError.decodeFailed("no candidate")
    for size in 0..<6 {
        do {
            let l = try layout(size)
            let ring = l.known.filter { $0.role == "ring" }
            let mincx = ring.map { $0.x }.min()! - HEXHW, maxcx = ring.map { $0.x }.max()! + HEXHW
            let mincy = ring.map { $0.y }.min()! - HEXHH, maxcy = ring.map { $0.y }.max()! + HEXHH
            let rx = Double(xmax - xmin + 1) / (maxcx - mincx)
            let ry = Double(ymax - ymin + 1) / (maxcy - mincy)
            if abs(rx - ry) / max(rx, ry) > 0.05 { continue }
            var symbols = [Int](repeating: 8, count: l.cells.count)
            for c in l.cells {
                let pxc = Double(xmin) + (c.x - mincx) * rx
                let pyc = Double(ymin) + (c.y - mincy) * ry
                var sr = 0, sg = 0, sb = 0, n = 0
                for dy in -1...1 {
                    for dx in -1...1 {
                        let xx = min(w - 1, max(0, Int(pxc + Double(dx) * rx * 0.15)))
                        let yy = min(h - 1, max(0, Int(pyc + Double(dy) * ry * 0.15)))
                        let o = (yy * w + xx) * 4
                        sr += Int(rgba[o]); sg += Int(rgba[o + 1]); sb += Int(rgba[o + 2]); n += 1
                    }
                }
                symbols[c.index] = nearestSymbol(sr / n, sg / n, sb / n)
            }
            do {
                return try decodeSymbols(symbols, l, nil)
            } catch {
                return try decodeSymbols(symbols, l, PLcd(l)) // logo-encoded codes
            }
        } catch {
            lastErr = error
            continue
        }
    }
    throw PrismError.decodeFailed("decode failed: \(lastErr)")
}

public func decodePNG(_ buf: [UInt8]) throws -> Decoded {
    let (w, h, rgba) = try readPNG(buf)
    return try decodeImage(w, h, rgba)
}
