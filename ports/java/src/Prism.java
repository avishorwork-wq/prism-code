// Prism Code - Java 17 port of the live JavaScript encoder/decoder.
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

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public final class Prism {

    public static final double S3 = Math.sqrt(3), Q = 3 * S3;
    public static final int[][] SIZES = {{21,24},{29,33},{41,47},{57,66},{81,94},{113,130}};
    public static final String[] HEX = {"#1B1B1B","#2E5BFF","#00B8D9","#2DB35A","#F5C518",
                                        "#F77F00","#D7263D","#B5179E","#FFFFFF"};
    public static final int[][] PAL = new int[9][3];
    static {
        for (int i = 0; i < 9; i++) {
            PAL[i][0] = Integer.parseInt(HEX[i].substring(1,3),16);
            PAL[i][1] = Integer.parseInt(HEX[i].substring(3,5),16);
            PAL[i][2] = Integer.parseInt(HEX[i].substring(5,7),16);
        }
    }

    // ---------------------------------------------------------------- rng

    /** Exact port of the JS seeded rng; next() returns a double in [0,1). */
    public static final class Rng {
        private int seed;
        public Rng(int seed) { this.seed = seed; }
        public double next() {
            seed = seed + 0x6D2B79F5;
            int t = (seed ^ (seed >>> 15)) * (1 | seed);
            t = (t + ((t ^ (t >>> 7)) * (61 | t))) ^ t;
            return Integer.toUnsignedLong(t ^ (t >>> 14)) / 4294967296.0;
        }
    }

    // ---------------------------------------------------------------- crc

    private static final int[] CRC_TABLE = new int[256];
    static {
        for (int n = 0; n < 256; n++) {
            int c = n;
            for (int j = 0; j < 8; j++) c = ((c & 1) != 0) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            CRC_TABLE[n] = c;
        }
    }

    public static long crc32(byte[] data) {
        int c = 0xFFFFFFFF;
        for (byte b : data) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) & 0xFFFFFFFFL;
    }

    public static int crc4(int[] bits) {
        int r = 0;
        for (int b : bits) {
            int f = ((r >> 3) & 1) ^ b;
            r = (r << 1) & 15;
            if (f != 0) r ^= 3;
        }
        return r;
    }

    public static int PADK(int o) {
        int x = (o + 0x9E3779B9) * 0x85EBCA6B;
        x ^= x >>> 13;
        x = x * 0xC2B2AE35;
        x ^= x >>> 16;
        return x & 255;
    }

    // ---------------------------------------------------------------- GF(256)

    static final int[] EXP = new int[512];
    static final int[] LOG = new int[256];
    static {
        int z = 1;
        for (int i = 0; i < 255; i++) {
            EXP[i] = z; LOG[z] = i;
            z <<= 1;
            if ((z & 256) != 0) z ^= 0x11D;
        }
        System.arraycopy(EXP, 0, EXP, 255, 255);
    }

    static int gmul(int a, int b) { return (a != 0 && b != 0) ? EXP[LOG[a] + LOG[b]] : 0; }
    static int gdiv(int a, int b) {
        if (b == 0) throw new IllegalArgumentException("GF division by zero");
        return a != 0 ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0;
    }
    static int peval(int[] p, int x) {
        int y = 0;
        for (int i = p.length - 1; i >= 0; i--) y = gmul(y, x) ^ p[i];
        return y;
    }
    static int[] pmul(int[] a, int[] b) {
        int[] o = new int[a.length + b.length - 1];
        for (int i = 0; i < a.length; i++)
            for (int j = 0; j < b.length; j++) o[i + j] ^= gmul(a[i], b[j]);
        return o;
    }

    private static final java.util.Map<Integer,int[]> GEN_CACHE = new java.util.HashMap<>();

    public static int[] rsEncode(int[] msg, int nsym) {
        int[] g = GEN_CACHE.get(nsym);
        if (g == null) {
            g = new int[]{1};
            for (int i = 0; i < nsym; i++) g = pmul(g, new int[]{1, EXP[i]});
            GEN_CACHE.put(nsym, g);
        }
        int[] out = new int[msg.length + nsym];
        System.arraycopy(msg, 0, out, 0, msg.length);
        for (int i = 0; i < msg.length; i++) {
            int c = out[i];
            if (c != 0) for (int j = 1; j < g.length; j++) out[i + j] ^= gmul(g[j], c);
        }
        System.arraycopy(msg, 0, out, 0, msg.length);
        return out;
    }

    static int[] syndromes(int[] r, int n) {
        int[] s = new int[n];
        for (int j = 0; n > j; j++) {
            int y = 0;
            for (int i = 0; i < r.length; i++) y = gmul(y, EXP[j]) ^ r[i];
            s[j] = y;
        }
        return s;
    }

    static int[] bm(int[] s) {
        int[] c = new int[s.length + 1], b = new int[s.length + 1];
        c[0] = b[0] = 1;
        int L = 0, m = 1, bb = 1;
        for (int n = 0; n < s.length; n++) {
            int d = s[n];
            for (int i = 1; i <= L; i++) d ^= gmul(c[i], s[n - i]);
            if (d == 0) { m++; continue; }
            int[] t = c.clone();
            int v = gdiv(d, bb);
            for (int i = 0; i + m < c.length; i++) c[i + m] ^= gmul(v, b[i]);
            if (2 * L <= n) { L = n + 1 - L; b = t; bb = d; m = 1; }
            else m++;
        }
        return Arrays.copyOf(c, L + 1);
    }

    /** Returns the corrected codeword. Throws on failure. */
    public static int[] rsDecode(int[] input, int nsym, int[] erasures) {
        int[] r = input.clone();
        int[] s = syndromes(r, nsym);
        boolean clean = true;
        for (int x : s) if (x != 0) { clean = false; break; }
        if (clean) return r;
        if (erasures.length > nsym) throw new IllegalStateException("Too many erasures");
        int[] G = {1};
        List<Integer> T = new ArrayList<>();
        for (int x : s) T.add(x);
        for (int p : erasures) {
            if (p < 0 || p >= r.length) throw new IllegalStateException("Erasure index");
            int X = EXP[r.length - 1 - p];
            G = pmul(G, new int[]{1, X});
            for (int j = 0; j < T.size() - 1; j++) T.set(j, gmul(T.get(j), X) ^ T.get(j + 1));
            T.remove(T.size() - 1);
        }
        int[] Tarr = T.stream().mapToInt(Integer::intValue).toArray();
        int[] E = bm(Tarr);
        if (2 * (E.length - 1) + erasures.length > nsym) throw new IllegalStateException("RS correction limit");
        int[] loc = pmul(G, E);
        List<Integer> pos = new ArrayList<>();
        for (int p = 0; p < r.length; p++) {
            int e = r.length - 1 - p;
            if (peval(loc, EXP[((255 - e) % 255 + 255) % 255]) == 0) pos.add(p);
        }
        if (pos.size() != loc.length - 1) throw new IllegalStateException("RS roots");
        int[] omega = Arrays.copyOf(pmul(s, loc), nsym);
        int[] der = new int[Math.max(1, loc.length - 1)];
        for (int i = 1; i < loc.length; i += 2) der[i - 1] = loc[i];
        for (int p : pos) {
            int e = r.length - 1 - p, X = EXP[e], xi = EXP[((255 - e) % 255 + 255) % 255];
            r[p] ^= gdiv(gmul(X, peval(omega, xi)), peval(der, xi));
        }
        for (int x : syndromes(r, nsym)) if (x != 0) throw new IllegalStateException("RS syndrome check");
        return r;
    }

    // ---------------------------------------------------------------- layout

    public static final class Cell {
        public final int i, j, pi, pj, index;
        public final double x, y;
        public String role;
        public int symbol, header = -1;
        Cell(int i, int j, double x, double y, String role, int symbol, int pi, int pj, int index) {
            this.i=i; this.j=j; this.x=x; this.y=y; this.role=role;
            this.symbol=symbol; this.pi=pi; this.pj=pj; this.index=index;
        }
    }

    public static final class Layout {
        public int size, C, R;
        public double W, H;
        public Cell[] cells, headers, data, known, cd;
    }

    private static final Layout[] LAYOUT_CACHE = new Layout[6];

    public static synchronized Layout layout(int size) {
        if (LAYOUT_CACHE[size] != null) return LAYOUT_CACHE[size];
        if (size < 0 || size >= SIZES.length) throw new IllegalArgumentException("Unknown size");
        int C = SIZES[size][0], R = SIZES[size][1];
        List<Cell> cells = new ArrayList<>(), M = new ArrayList<>(), known = new ArrayList<>();
        for (int j = 0; j < R; j++) for (int i = 0; i < C; i++) {
            String role = "data";
            int symbol = -1;
            int pi = (i - 2) / 5, pj = (j - 2) / 5;
            if (j <= 2 && i <= 2) { role = "gap"; symbol = 8; }
            else if (j == 0 || j == R - 1 || i == 0 || i == C - 1) { role = "ring"; symbol = (j * 5 + i * 3) % 8; }
            else if (i % 5 == 2 && j % 5 == 2) { role = "pilot"; symbol = (pi * 2 + pj * 3) % 9; }
            Cell c = new Cell(i, j, S3 * (i + .5 + .5 * (j & 1)), 1 + 1.5 * j, role, symbol, pi, pj, cells.size());
            cells.add(c);
            if (role.equals("data")) M.add(c);
            else if (!role.equals("gap")) known.add(c);
        }
        List<Cell> headers = new ArrayList<>();
        for (int n = 0; n < 72; n++) {
            Cell c = M.get((int) Math.floor((n + .5) * M.size() / 72));
            c.role = "header";
            c.header = n;
            headers.add(c);
        }
        List<Cell> data = new ArrayList<>();
        for (Cell c : cells) if (c.role.equals("data")) data.add(c);
        Rng rand = new Rng(0x5EED ^ size);
        for (int i = data.size() - 1; i > 0; i--) {
            int j = (int) Math.floor(rand.next() * (i + 1));
            Cell t = data.get(i); data.set(i, data.get(j)); data.set(j, t);
        }
        Layout l = new Layout();
        l.size = size; l.C = C; l.R = R;
        l.W = S3 * (C + .5);
        l.H = 2 + 1.5 * (R - 1);
        l.cells = cells.toArray(new Cell[0]);
        l.headers = headers.toArray(new Cell[0]);
        l.data = data.toArray(new Cell[0]);
        l.known = known.toArray(new Cell[0]);
        LAYOUT_CACHE[size] = l;
        return l;
    }

    /** Centre-out data order used when a logo sits in the middle (logo=1). */
    public static Cell[] PLcd(Layout l) {
        if (l.cd != null) return l.cd;
        double cx = l.W / 2, cy = l.H / 2;
        Integer[] ord = new Integer[l.data.length];
        final int[] b = new int[l.data.length];
        for (int k = 0; k < ord.length; k++) {
            double dx = l.data[k].x - cx, dy = l.data[k].y - cy;
            b[k] = (int) Math.floor(Math.sqrt(dx * dx + dy * dy) / 3);
            ord[k] = k;
        }
        Arrays.sort(ord, (p, q) -> b[p] != b[q] ? Integer.compare(b[q], b[p]) : Integer.compare(p, q));
        Cell[] cd = new Cell[ord.length];
        for (int k = 0; k < ord.length; k++) cd[k] = l.data[ord[k]];
        l.cd = cd;
        return cd;
    }

    public static final class Capacity {
        public int n, k, payload;
        public int[][] blocks; // each {n, nsym, k}
    }

    public static Capacity capacity(int size, int ecc, int mode) {
        Layout l = layout(size);
        int n = (int) Math.floor(l.data.length * (mode == 1 ? 1.0 : 3.0) / 8);
        int B = (n + 254) / 255;
        Capacity cap = new Capacity();
        cap.blocks = new int[B][3];
        for (int i = 0; i < B; i++) {
            int len = n / B + (i < n % B ? 1 : 0);
            int nsym = Math.max(4, 2 * (int) Math.round(len * new double[]{.1,.2,.3,.4}[ecc] / 2));
            cap.blocks[i] = new int[]{len, nsym, len - nsym};
        }
        cap.n = n;
        cap.k = Arrays.stream(cap.blocks).mapToInt(b -> b[2]).sum();
        cap.payload = Math.max(0, cap.k - 4);
        return cap;
    }

    static void pushBits(List<Integer> a, int x, int n) {
        for (int k = n - 1; k >= 0; k--) a.add((x >> k) & 1);
    }

    public static int[] headerBits(int size, int ecc, int mode, int type, int L) {
        List<Integer> b = new ArrayList<>();
        pushBits(b, size, 3); pushBits(b, ecc, 2); pushBits(b, mode, 1);
        pushBits(b, type, 1); pushBits(b, L, 13);
        int[] arr = b.stream().mapToInt(Integer::intValue).toArray();
        pushBits(b, crc4(arr), 4);
        return b.stream().mapToInt(Integer::intValue).toArray();
    }

    public static int knownSymbol(Cell c, int mode) {
        if (mode == 1) {
            if (c.role.equals("ring")) return 0;
            return (c.pi + c.pj) % 2 == 0 ? 0 : 8;
        }
        return c.symbol;
    }

    // ---------------------------------------------------------------- encode

    public static final class Code {
        public int size, ecc, mode, type;
        public byte[] bytes;
        public int[] symbols;
        public Layout layout;
        public Capacity capacity;
    }

    public static Code encode(byte[] payload, int size, int ecc, int mode, int type, int logo) {
        if (payload.length > 8191) throw new IllegalArgumentException("Payload exceeds 8191 bytes");
        if (size < 0) {
            size = -1;
            for (int i = 0; i < SIZES.length; i++)
                if (capacity(i, ecc, mode).k >= payload.length + 4) { size = i; break; }
            if (size < 0) throw new IllegalArgumentException("Payload too large for this mode and ECC");
        }
        Capacity cap = capacity(size, ecc, mode);
        if (cap.k < payload.length + 4)
            throw new IllegalArgumentException("Payload does not fit: maximum " + cap.payload + " bytes");
        int[] msg = new int[cap.k];
        for (int i = payload.length + 4; i < cap.k; i++) msg[i] = PADK(i);
        for (int i = 0; i < payload.length; i++) msg[i] = payload[i] & 255;
        long crc = crc32(payload);
        for (int k = 0; k < 4; k++) msg[payload.length + k] = (int) (crc >> (24 - 8 * k)) & 255;
        int off = 0;
        int[][] blocks = new int[cap.blocks.length][];
        for (int bi = 0; bi < cap.blocks.length; bi++) {
            int[] b = cap.blocks[bi];
            blocks[bi] = rsEncode(Arrays.copyOfRange(msg, off, off + b[2]), b[1]);
            off += b[2];
        }
        List<Integer> stream = new ArrayList<>();
        int maxLen = Arrays.stream(blocks).mapToInt(x -> x.length).max().orElse(0);
        for (int p = 0; p < maxLen; p++)
            for (int[] b : blocks) if (p < b.length) pushBits(stream, b[p], 8);
        Rng rand = new Rng(0xBEEF);
        Layout l = layout(size);
        int[] symbols = new int[l.cells.length];
        Arrays.fill(symbols, 8);
        for (Cell c : l.known) symbols[c.index] = knownSymbol(c, mode);
        int[] hb = headerBits(size, ecc, mode, type, payload.length);
        for (Cell c : l.headers) symbols[c.index] = hb[c.header % 24] != 0 ? 0 : 8;
        for (Cell c : l.cells) if (c.role.equals("gap"))
            symbols[c.index] = mode == 1 ? (((c.i + c.j) % 2 != 0) ? 0 : 8) : (c.j * 5 + c.i * 3) % 8;
        int at = 0;
        Cell[] order = logo != 0 ? PLcd(l) : l.data;
        for (Cell c : order) {
            if (mode == 1) {
                int bit = at < stream.size() ? stream.get(at) : (rand.next() > .5 ? 1 : 0);
                at++;
                symbols[c.index] = bit != 0 ? 0 : 8;
            } else {
                int b = 0;
                for (int k = 0; k < 3; k++) {
                    int bit = at < stream.size() ? stream.get(at) : (rand.next() > .5 ? 1 : 0);
                    at++;
                    b = (b << 1) | bit;
                }
                int v = b;
                v ^= v >> 1;
                v ^= v >> 2;
                symbols[c.index] = v;
            }
        }
        Code code = new Code();
        code.size = size; code.ecc = ecc; code.mode = mode; code.type = type;
        code.bytes = payload; code.symbols = symbols; code.layout = l; code.capacity = cap;
        return code;
    }

    public static Code encode(byte[] payload) { return encode(payload, -1, 1, 0, 0, 0); }

    // ---------------------------------------------------------------- render / PNG

    /** Same geometry as Prism.render: hard-edged hexagons on white. */
    public static BufferedImage render(Code code, int r) {
        Layout l = code.layout;
        int w = (int) Math.ceil((l.W + 2 * Q) * r);
        int h = (int) Math.ceil((l.H + 2 * Q) * r);
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
        int[] px = new int[w * h];
        Arrays.fill(px, 0xFFFFFFFF);
        for (Cell c : l.cells) {
            int s = code.symbols[c.index];
            if (s == 8) continue;
            double[][] pts = new double[6][2];
            for (int k = 0; k < 6; k++) {
                double a = Math.toRadians(30 + 60 * k);
                pts[k][0] = (c.x + Q + 1.03 * Math.cos(a)) * r;
                pts[k][1] = (c.y + Q + 1.03 * Math.sin(a)) * r;
            }
            fillPoly(px, w, h, pts, PAL[s]);
        }
        img.setRGB(0, 0, w, h, px, 0, w);
        return img;
    }

    static void fillPoly(int[] img, int w, int h, double[][] pts, int[] rgb) {
        double miny = Double.MAX_VALUE, maxy = -Double.MAX_VALUE;
        for (double[] p : pts) { miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
        int y0 = Math.max(0, (int) Math.floor(miny)), y1 = Math.min(h - 1, (int) Math.ceil(maxy));
        int argb = 0xFF000000 | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        double[] xs = new double[pts.length];
        for (int y = y0; y <= y1; y++) {
            double yc = y + 0.5;
            int nx = 0;
            for (int k = 0; k < pts.length; k++) {
                double x1 = pts[k][0], a = pts[k][1];
                double x2 = pts[(k + 1) % pts.length][0], b = pts[(k + 1) % pts.length][1];
                if ((a <= yc && yc < b) || (b <= yc && yc < a)) xs[nx++] = x1 + (yc - a) / (b - a) * (x2 - x1);
            }
            Arrays.sort(xs, 0, nx);
            for (int k = 0; k + 1 < nx; k += 2) {
                int xa = Math.max(0, (int) Math.round(xs[k] - 0.5));
                int xb = Math.min(w - 1, (int) Math.round(xs[k + 1] - 0.5) - 1);
                for (int x = xa; x <= xb; x++) img[y * w + x] = argb;
            }
        }
    }

    // ---------------------------------------------------------------- decode (clean images)

    public static final class Decoded {
        public byte[] payload;
        public int size, ecc, mode, type, length;
    }

    static int nearestSymbol(int r, int g, int b) {
        int best = 0;
        long bestd = Long.MAX_VALUE;
        for (int i = 0; i < 9; i++) {
            long d = (long)(r - PAL[i][0]) * (r - PAL[i][0]) + (long)(g - PAL[i][1]) * (g - PAL[i][1])
                   + (long)(b - PAL[i][2]) * (b - PAL[i][2]);
            if (d < bestd) { bestd = d; best = i; }
        }
        return best;
    }

    static int[] symbolBits(int sym, int mode) {
        if (mode == 1) return new int[]{sym == 0 ? 1 : 0};
        int t = sym ^ (sym >> 1);
        return new int[]{(t >> 2) & 1, (t >> 1) & 1, t & 1};
    }

    static Decoded decodeSymbols(int[] symbols, Layout l, Cell[] order) {
        int[] hb = new int[24];
        for (int n = 0; n < 24; n++) {
            int votes = 0;
            for (int rep = 0; rep < 3; rep++)
                if (symbols[l.headers[n + 24 * rep].index] == 0) votes++;
            hb[n] = votes >= 2 ? 1 : 0;
        }
        int at = 0;
        int size = 0; for (int k = 0; k < 3; k++) size = (size << 1) | hb[at++];
        int ecc = 0; for (int k = 0; k < 2; k++) ecc = (ecc << 1) | hb[at++];
        int mode = hb[at++], type = hb[at++];
        int L = 0; for (int k = 0; k < 13; k++) L = (L << 1) | hb[at++];
        int hcrc = 0; for (int k = 0; k < 4; k++) hcrc = (hcrc << 1) | hb[at++];
        if (crc4(Arrays.copyOf(hb, 20)) != hcrc || size > 5 || size != l.size)
            throw new IllegalStateException("header checksum failed");
        Capacity cap = capacity(size, ecc, mode);
        if (L > cap.payload) throw new IllegalStateException("invalid length");
        Cell[] cells = order != null ? order : l.data;
        List<Integer> stream = new ArrayList<>();
        for (Cell c : cells) for (int bit : symbolBits(symbols[c.index], mode)) stream.add(bit);
        int[] bts = new int[cap.n];
        for (int i = 0; i < cap.n; i++) {
            int v = 0;
            for (int k = 0; k < 8; k++) v = (v << 1) | stream.get(8 * i + k);
            bts[i] = v;
        }
        int[][] blocks = new int[cap.blocks.length][];
        for (int bi = 0; bi < blocks.length; bi++) blocks[bi] = new int[cap.blocks[bi][0]];
        at = 0;
        int maxn = Arrays.stream(cap.blocks).mapToInt(b -> b[0]).max().orElse(0);
        for (int p = 0; p < maxn; p++)
            for (int bi = 0; bi < blocks.length; bi++)
                if (p < cap.blocks[bi][0]) blocks[bi][p] = bts[at++];
        ByteArrayOutputStream msg = new ByteArrayOutputStream();
        for (int bi = 0; bi < blocks.length; bi++) {
            int[] dec = rsDecode(blocks[bi], cap.blocks[bi][1], new int[0]);
            for (int p = 0; p < cap.blocks[bi][2]; p++) msg.write(dec[p]);
        }
        byte[] m = msg.toByteArray();
        byte[] payload = Arrays.copyOf(m, L);
        long got = ((m[L] & 255L) << 24) | ((m[L+1] & 255L) << 16) | ((m[L+2] & 255L) << 8) | (m[L+3] & 255L);
        if (crc32(payload) != got) throw new IllegalStateException("payload CRC-32 failed");
        Decoded d = new Decoded();
        d.payload = payload; d.size = size; d.ecc = ecc; d.mode = mode; d.type = type; d.length = L;
        return d;
    }

    /** Decode a clean/perfect encoder PNG image. */
    public static Decoded decodeImage(BufferedImage img) {
        int w = img.getWidth(), h = img.getHeight();
        int[] px = img.getRGB(0, 0, w, h, null, 0, w);
        int xmin = w, ymin = h, xmax = -1, ymax = -1;
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            int p = px[y * w + x];
            int r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
            if (r < 250 || g < 250 || b < 250) {
                if (x < xmin) xmin = x;
                if (x > xmax) xmax = x;
                if (y < ymin) ymin = y;
                if (y > ymax) ymax = y;
            }
        }
        if (xmax < 0) throw new IllegalStateException("no code found");
        final double HEXHW = 1.03 * 0.8660254037844386, HEXHH = 1.03;
        Exception last = null;
        for (int size = 0; size < 6; size++) {
            try {
                Layout l = layout(size);
                double mincx = 1e9, maxcx = -1e9, mincy = 1e9, maxcy = -1e9;
                for (Cell c : l.known) if (c.role.equals("ring")) {
                    mincx = Math.min(mincx, c.x); maxcx = Math.max(maxcx, c.x);
                    mincy = Math.min(mincy, c.y); maxcy = Math.max(maxcy, c.y);
                }
                mincx -= HEXHW; maxcx += HEXHW; mincy -= HEXHH; maxcy += HEXHH;
                double rx = (xmax - xmin + 1) / (maxcx - mincx);
                double ry = (ymax - ymin + 1) / (maxcy - mincy);
                if (Math.abs(rx - ry) / Math.max(rx, ry) > 0.05) continue;
                int[] symbols = new int[l.cells.length];
                Arrays.fill(symbols, 8);
                for (Cell c : l.cells) {
                    double pxc = xmin + (c.x - mincx) * rx;
                    double pyc = ymin + (c.y - mincy) * ry;
                    long sr = 0, sg = 0, sb = 0; int n = 0;
                    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                        int xx = Math.min(w - 1, Math.max(0, (int) (pxc + dx * rx * 0.15)));
                        int yy = Math.min(h - 1, Math.max(0, (int) (pyc + dy * ry * 0.15)));
                        int p = px[yy * w + xx];
                        sr += (p >> 16) & 255; sg += (p >> 8) & 255; sb += p & 255; n++;
                    }
                    symbols[c.index] = nearestSymbol((int)(sr / n), (int)(sg / n), (int)(sb / n));
                }
                try {
                    return decodeSymbols(symbols, l, null);
                } catch (Exception e) {
                    return decodeSymbols(symbols, l, PLcd(l)); // logo-encoded codes
                }
            } catch (Exception e) {
                last = e;
            }
        }
        throw new IllegalStateException("decode failed: " + last);
    }
}
