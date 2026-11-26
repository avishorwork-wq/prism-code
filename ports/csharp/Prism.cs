/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C# (.NET) port of the live Prism Code format. A bit-exact port of the encoder
 * and a clean-image decoder, matching the live JavaScript (the self-contained
 * Prism module in prism.html / use.html). Standard library only. */
using System;
using System.Collections.Generic;

namespace PrismCode
{
    public enum PrismMode { Color = 0, BW = 1 }
    public enum PrismType { Text = 0, Binary = 1 }

    public class PrismException : Exception
    {
        public PrismException(string message) : base(message) { }
    }

    public sealed class PrismImage
    {
        public int Width, Height;
        public byte[] Rgba = Array.Empty<byte>(); // Width*Height*4
    }

    public sealed class PrismDecodeResult
    {
        public byte[] Bytes = Array.Empty<byte>();
        public int Type, Size, Ecc, Mode;
    }

    public static class Prism
    {
        /* -------------------------------------------------------- constants */
        private static readonly double S3 = Math.Sqrt(3.0);
        private static readonly double PQ = 3.0 * Math.Sqrt(3.0); // quiet zone
        private static readonly int[,] Sizes = { {21,24},{29,33},{41,47},{57,66},{81,94},{113,130} };
        private static readonly byte[,] Palette = {
            {0x1B,0x1B,0x1B},{0x2E,0x5B,0xFF},{0x00,0xB8,0xD9},{0x2D,0xB3,0x5A},
            {0xF5,0xC5,0x18},{0xF7,0x7F,0x00},{0xD7,0x26,0x3D},{0xB5,0x17,0x9E},
            {0xFF,0xFF,0xFF}};
        private static readonly double[] EccT = { 0.1, 0.2, 0.3, 0.4 };

        private const int RoleData = 0, RoleRing = 1, RolePilot = 2, RoleGap = 3, RoleHeader = 4;

        /* ---------------------------------------------- deterministic RNG */
        // Exact port of the JS rng, all arithmetic mod 2^32.
        private sealed class Rng
        {
            private uint s;
            public Rng(uint seed) { s = seed; }
            public double Next()
            {
                unchecked
                {
                    s += 0x6D2B79F5u;
                    uint t = (s ^ (s >> 15)) * (1u | s);
                    t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
                    return (t ^ (t >> 14)) / 4294967296.0;
                }
            }
        }

        private static byte Padk(uint o)
        {
            unchecked
            {
                uint x = (o + 0x9E3779B9u) * 0x85EBCA6Bu;
                x ^= x >> 13; x *= 0xC2B2AE35u; x ^= x >> 16;
                return (byte)(x & 255);
            }
        }

        /* ------------------------------------------------------ GF(256) / RS */
        private static readonly byte[] GFExp = new byte[512];
        private static readonly byte[] GFLog = new byte[256];
        static Prism()
        {
            int z = 1;
            for (int i = 0; i < 255; i++)
            {
                GFExp[i] = (byte)z; GFLog[z] = (byte)i;
                z <<= 1; if ((z & 256) != 0) z ^= 0x11d;
            }
            for (int i = 255; i < 512; i++) GFExp[i] = GFExp[i - 255];
        }
        private static byte GfMul(int a, int b) => a != 0 && b != 0 ? GFExp[GFLog[a] + GFLog[b]] : (byte)0;
        private static byte GfDiv(int a, int b) => a != 0 ? GFExp[(GFLog[a] + 255 - GFLog[b]) % 255] : (byte)0;
        private static byte GfPeval(byte[] p, int x)
        {
            byte y = 0;
            for (int i = p.Length - 1; i >= 0; i--) y = (byte)(GfMul(y, x) ^ p[i]);
            return y;
        }
        private static byte[] GfPmul(byte[] a, byte[] b)
        {
            var o = new byte[a.Length + b.Length - 1];
            for (int i = 0; i < a.Length; i++)
                for (int j = 0; j < b.Length; j++)
                    o[i + j] ^= GfMul(a[i], b[j]);
            return o;
        }
        private static byte[] RsEncode(byte[] m, int k, int nsym)
        {
            var g = new byte[] { 1 };
            for (int i = 0; i < nsym; i++) g = GfPmul(g, new byte[] { 1, GFExp[i] });
            var outp = new byte[k + nsym];
            Array.Copy(m, outp, k);
            for (int i = 0; i < k; i++)
            {
                byte c = outp[i];
                if (c != 0) for (int j = 1; j < g.Length; j++) outp[i + j] ^= GfMul(g[j], c);
            }
            Array.Copy(m, outp, k);
            return outp;
        }
        private static byte[] RsSyndromes(byte[] r, int nsym)
        {
            var s = new byte[nsym];
            for (int j = 0; j < nsym; j++)
            {
                byte y = 0;
                foreach (byte v in r) y = (byte)(GfMul(y, GFExp[j]) ^ v);
                s[j] = y;
            }
            return s;
        }
        private static byte[] RsBm(byte[] s)
        {
            var c = new byte[s.Length + 1]; var b = new byte[s.Length + 1];
            c[0] = b[0] = 1;
            int L = 0, m = 1; byte bb = 1;
            for (int n = 0; n < s.Length; n++)
            {
                byte d = s[n];
                for (int i = 1; i <= L; i++) d ^= GfMul(c[i], s[n - i]);
                if (d == 0) { m++; continue; }
                var t = (byte[])c.Clone();
                byte v = GfDiv(d, bb);
                for (int i = 0; i + m < c.Length; i++) c[i + m] ^= GfMul(v, b[i]);
                if (2 * L <= n) { L = n + 1 - L; b = t; bb = d; m = 1; }
                else m++;
            }
            var r2 = new byte[L + 1];
            Array.Copy(c, r2, L + 1);
            return r2;
        }
        // Errors-only RS decode; returns corrected count, throws on failure.
        private static int RsDecode(byte[] r, int nsym)
        {
            var s = RsSyndromes(r, nsym);
            bool allzero = true;
            foreach (byte v in s) if (v != 0) { allzero = false; break; }
            if (allzero) return 0;
            var loc = RsBm(s);
            int L = loc.Length - 1;
            if (2 * L > nsym) throw new PrismException("RS correction limit");
            var pos = new List<int>();
            for (int p = 0; p < r.Length; p++)
            {
                int e = r.Length - 1 - p;
                if (GfPeval(loc, GFExp[(255 - e) % 255]) == 0) pos.Add(p);
            }
            if (pos.Count != L) throw new PrismException("RS roots");
            var omegaFull = GfPmul(s, loc);
            var omega = new byte[nsym];
            Array.Copy(omegaFull, omega, nsym);
            var der = new byte[Math.Max(1, L)];
            for (int i = 1; i <= L; i += 2) der[i - 1] = loc[i];
            foreach (int p in pos)
            {
                int e = r.Length - 1 - p;
                byte X = GFExp[e], xi = GFExp[(255 - e) % 255];
                r[p] ^= GfDiv(GfMul(X, GfPeval(omega, xi)), GfPeval(der, xi));
            }
            foreach (byte v in RsSyndromes(r, nsym))
                if (v != 0) throw new PrismException("RS syndrome check");
            return pos.Count;
        }

        /* ------------------------------------------------------------ CRC */
        public static uint Crc32(byte[] bytes, int len)
        {
            uint c = 0xFFFFFFFFu;
            unchecked
            {
                for (int i = 0; i < len; i++)
                {
                    c ^= bytes[i];
                    for (int j = 0; j < 8; j++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                }
            }
            return c ^ 0xFFFFFFFFu;
        }
        private static int Crc4(byte[] bits, int n)
        {
            int r = 0;
            for (int i = 0; i < n; i++)
            {
                int f = ((r >> 3) & 1) ^ bits[i];
                r = (r << 1) & 15;
                if (f != 0) r ^= 3;
            }
            return r;
        }
        private static void PushBits(List<byte> a, uint x, int n)
        {
            for (int k = n - 1; k >= 0; k--) a.Add((byte)((x >> k) & 1));
        }

        /* ----------------------------------------------------------- layout */
        private sealed class Cell
        {
            public int I, J;
            public double X, Y;
            public int Role = RoleData, Symbol = -1, Pi, Pj, Header = -1, Index;
        }
        private sealed class Layout
        {
            public int Size, C, R;
            public double W, H;
            public Cell[] Cells = Array.Empty<Cell>();
            public List<int> Headers = new List<int>(); // 72
            public List<int> Data = new List<int>();    // shuffled encode order
            public List<int> Known = new List<int>();   // ring+pilot, row-major
        }

        private static Layout LayoutBuild(int size)
        {
            if (size < 0 || size > 5) throw new PrismException("Unknown size");
            var l = new Layout { Size = size, C = Sizes[size, 0], R = Sizes[size, 1] };
            l.Cells = new Cell[l.C * l.R];
            var M = new List<int>();
            for (int j = 0; j < l.R; j++) for (int i = 0; i < l.C; i++)
            {
                var c = new Cell
                {
                    I = i, J = j, Index = j * l.C + i,
                    Pi = (i - 2) / 5, Pj = (j - 2) / 5,
                    X = S3 * (i + 0.5 + 0.5 * (j & 1)),
                    Y = 1 + 1.5 * j
                };
                if (j <= 2 && i <= 2) { c.Role = RoleGap; c.Symbol = 8; }
                else if (j == 0 || j == l.R - 1 || i == 0 || i == l.C - 1) { c.Role = RoleRing; c.Symbol = (j * 5 + i * 3) % 8; }
                else if (i % 5 == 2 && j % 5 == 2) { c.Role = RolePilot; c.Symbol = (c.Pi * 2 + c.Pj * 3) % 9; }
                l.Cells[c.Index] = c;
                if (c.Role == RoleData) M.Add(c.Index);
                else if (c.Role != RoleGap) l.Known.Add(c.Index);
            }
            for (int n = 0; n < 72; n++)
            {
                int mi = (int)((n + 0.5) * M.Count / 72.0);
                var c = l.Cells[M[mi]];
                c.Role = RoleHeader; c.Header = n;
                l.Headers.Add(c.Index);
            }
            for (int k = 0; k < l.Cells.Length; k++)
                if (l.Cells[k].Role == RoleData) l.Data.Add(k);
            var rand = new Rng(0x5EEDu ^ (uint)size);
            for (int i = l.Data.Count - 1; i > 0; i--)
            {
                int j = (int)(rand.Next() * (i + 1));
                (l.Data[i], l.Data[j]) = (l.Data[j], l.Data[i]);
            }
            l.W = S3 * (l.C + 0.5);
            l.H = 2 + 1.5 * (l.R - 1);
            return l;
        }
        private static int KnownSymbol(Cell c, int mode)
        {
            if (mode != 0)
            {
                if (c.Role == RoleRing) return 0;
                return (c.Pi + c.Pj) % 2 == 0 ? 0 : 8;
            }
            return c.Symbol;
        }

        /* --------------------------------------------------------- capacity */
        private struct RBlock { public int N, Nsym, K; }
        private struct Capacity { public int N; public List<RBlock> Blocks; public int K; public int Payload; }

        private static Capacity CapacityOf(int size, int ecc, int mode)
        {
            var l = LayoutBuild(size);
            int n = l.Data.Count * (mode != 0 ? 1 : 3) / 8;
            int B = (n + 254) / 255;
            var cap = new Capacity { N = n, Blocks = new List<RBlock>(), K = 0 };
            for (int i = 0; i < B; i++)
            {
                int len = n / B + (i < n % B ? 1 : 0);
                int nsym = 2 * (int)Math.Floor(len * EccT[ecc] / 2 + 0.5);
                if (nsym < 4) nsym = 4;
                cap.Blocks.Add(new RBlock { N = len, Nsym = nsym, K = len - nsym });
                cap.K += len - nsym;
            }
            cap.Payload = Math.Max(0, cap.K - 4);
            return cap;
        }

        /// <summary>Maximum payload bytes for a size (0..5), ecc (0..3) and mode.</summary>
        public static int CapacityPayload(int size, int ecc, PrismMode mode) =>
            CapacityOf(size, ecc, (int)mode).Payload;

        private static byte[] HeaderBits(int size, int ecc, int mode, int type, int len)
        {
            var b = new List<byte>();
            PushBits(b, (uint)size, 3);
            PushBits(b, (uint)ecc, 2);
            PushBits(b, (uint)mode, 1);
            PushBits(b, (uint)type, 1);
            PushBits(b, (uint)len, 13);
            PushBits(b, (uint)Crc4(b.ToArray(), 20), 4);
            return b.ToArray();
        }

        /* ----------------------------------------------------------- encode */
        private sealed class Code
        {
            public int Size, Ecc, Mode, Type;
            public byte[] Symbols = Array.Empty<byte>();
            public Layout L = new Layout();
            public Capacity Cap;
        }

        private static Code EncodeCode(byte[] bytes, int size, int ecc, int mode, int type)
        {
            if (bytes.Length > 8191) throw new PrismException("Payload exceeds 8191 bytes");
            if (size < 0)
            {
                size = -1;
                for (int s = 0; s < 6; s++)
                    if (CapacityOf(s, ecc, mode).K >= bytes.Length + 4) { size = s; break; }
                if (size < 0) throw new PrismException("Payload too large for this mode and ECC");
            }
            var code = new Code { Cap = CapacityOf(size, ecc, mode) };
            if (code.Cap.K < bytes.Length + 4)
                throw new PrismException("Payload does not fit: maximum " + code.Cap.Payload + " bytes");
            code.L = LayoutBuild(size);
            code.Size = size; code.Ecc = ecc; code.Mode = mode; code.Type = type;
            var l = code.L;
            code.Symbols = new byte[l.Cells.Length];
            for (int i = 0; i < code.Symbols.Length; i++) code.Symbols[i] = 8;

            var msg = new byte[code.Cap.K];
            for (int i = bytes.Length + 4; i < msg.Length; i++) msg[i] = Padk((uint)i);
            Array.Copy(bytes, msg, bytes.Length);
            uint crc = Crc32(bytes, bytes.Length);
            for (int k = 0; k < 4; k++) msg[bytes.Length + k] = (byte)(crc >> (24 - 8 * k));

            var blocks = new List<byte[]>();
            int maxn = 0, off = 0;
            foreach (var rb in code.Cap.Blocks)
            {
                var slice = new byte[rb.K];
                Array.Copy(msg, off, slice, 0, rb.K);
                blocks.Add(RsEncode(slice, rb.K, rb.Nsym));
                off += rb.K;
                maxn = Math.Max(maxn, rb.N);
            }
            var stream = new List<byte>(code.Cap.N * 8);
            for (int p = 0; p < maxn; p++)
                foreach (var bl in blocks)
                    if (p < bl.Length) PushBits(stream, bl[p], 8);

            foreach (int idx in l.Known) code.Symbols[idx] = (byte)KnownSymbol(l.Cells[idx], mode);
            var hb = HeaderBits(size, ecc, mode, type, bytes.Length);
            foreach (int idx in l.Headers) code.Symbols[idx] = hb[l.Cells[idx].Header % 24] != 0 ? (byte)0 : (byte)8;
            foreach (var c in l.Cells)
                if (c.Role == RoleGap)
                    code.Symbols[c.Index] = (byte)(mode != 0 ? ((c.I + c.J) % 2 != 0 ? 0 : 8) : (c.J * 5 + c.I * 3) % 8);
            var rand = new Rng(0xBEEFu);
            int at = 0;
            foreach (int idx in l.Data)
            {
                if (mode != 0)
                {
                    int bit = at < stream.Count ? stream[at++] : (rand.Next() > 0.5 ? 1 : 0);
                    code.Symbols[idx] = bit != 0 ? (byte)0 : (byte)8;
                }
                else
                {
                    int b = 0;
                    for (int q = 0; q < 3; q++)
                    {
                        int bit = at < stream.Count ? stream[at++] : (rand.Next() > 0.5 ? 1 : 0);
                        b = (b << 1) | bit;
                    }
                    int v = b; v ^= v >> 1; v ^= v >> 2;
                    code.Symbols[idx] = (byte)v;
                }
            }
            return code;
        }

        /* ----------------------------------------------------------- render */
        /// <summary>Encode payload bytes to an in-memory RGBA image.</summary>
        public static PrismImage Encode(byte[] payload, int size = -1, int ecc = 1,
                                        PrismMode mode = PrismMode.Color, PrismType type = PrismType.Text,
                                        int scale = 12)
        {
            var code = EncodeCode(payload, size, ecc, (int)mode, (int)type);
            if (scale <= 0) scale = 12;
            double r = scale;
            var l = code.L;
            var img = new PrismImage
            {
                Width = (int)Math.Ceiling((l.W + 2 * PQ) * r),
                Height = (int)Math.Ceiling((l.H + 2 * PQ) * r)
            };
            img.Rgba = new byte[img.Width * img.Height * 4];
            for (int i = 0; i < img.Rgba.Length; i++) img.Rgba[i] = 255;
            const double deg = Math.PI / 180.0;
            foreach (var c in l.Cells)
            {
                int s = code.Symbols[c.Index];
                if (s == 8) continue;
                var vx = new double[6]; var vy = new double[6];
                for (int k = 0; k < 6; k++)
                {
                    double a = (30 + 60 * k) * deg;
                    vx[k] = (c.X + PQ + 1.03 * Math.Cos(a)) * r;
                    vy[k] = (c.Y + PQ + 1.03 * Math.Sin(a)) * r;
                }
                double ymin = vy[0], ymax = vy[0];
                for (int k = 1; k < 6; k++) { ymin = Math.Min(ymin, vy[k]); ymax = Math.Max(ymax, vy[k]); }
                int y0 = Math.Max(0, (int)Math.Floor(ymin));
                int y1 = Math.Min(img.Height - 1, (int)Math.Ceiling(ymax));
                for (int y = y0; y <= y1; y++)
                {
                    double yc = y + 0.5;
                    var xs = new double[6]; int nx = 0;
                    for (int k = 0; k < 6; k++)
                    {
                        int k2 = (k + 1) % 6;
                        if ((vy[k] <= yc && vy[k2] > yc) || (vy[k2] <= yc && vy[k] > yc))
                            xs[nx++] = vx[k] + (yc - vy[k]) / (vy[k2] - vy[k]) * (vx[k2] - vx[k]);
                    }
                    Array.Sort(xs, 0, nx);
                    for (int p = 0; p + 1 < nx; p += 2)
                    {
                        int xa = Math.Max(0, (int)Math.Ceiling(xs[p] - 0.5));
                        int xb = Math.Min(img.Width - 1, (int)Math.Floor(xs[p + 1] - 0.5));
                        for (int x = xa; x <= xb; x++)
                        {
                            int o = 4 * (y * img.Width + x);
                            img.Rgba[o] = Palette[s, 0]; img.Rgba[o + 1] = Palette[s, 1];
                            img.Rgba[o + 2] = Palette[s, 2]; img.Rgba[o + 3] = 255;
                        }
                    }
                }
            }
            return img;
        }

        /// <summary>Encode and write a PNG file.</summary>
        public static void EncodePng(byte[] payload, string path, int size = -1, int ecc = 1,
                                     PrismMode mode = PrismMode.Color, PrismType type = PrismType.Text,
                                     int scale = 12) =>
            Png.Write(path, Encode(payload, size, ecc, mode, type, scale));

        /* ----------------------------------------------------------- decode */
        private static int NearestSymbol(int r, int g, int b)
        {
            int best = 8; long bd = long.MaxValue;
            for (int i = 0; i < 9; i++)
            {
                long dr = r - Palette[i, 0], dg = g - Palette[i, 1], db = b - Palette[i, 2];
                long d = dr * dr + dg * dg + db * db;
                if (d < bd) { bd = d; best = i; }
            }
            return best;
        }

        private static PrismDecodeResult DecodeSized(PrismImage img, int size, double r)
        {
            var l = LayoutBuild(size);
            var sym = new byte[l.Cells.Length];
            for (int k = 0; k < l.Cells.Length; k++)
            {
                var c = l.Cells[k];
                int x = Math.Clamp((int)((c.X + PQ) * r), 0, img.Width - 1);
                int y = Math.Clamp((int)((c.Y + PQ) * r), 0, img.Height - 1);
                int o = 4 * (y * img.Width + x);
                sym[k] = (byte)NearestSymbol(img.Rgba[o], img.Rgba[o + 1], img.Rgba[o + 2]);
            }
            // header: 3 voted copies of each of 24 bits
            var hb = new byte[24];
            for (int b = 0; b < 24; b++)
            {
                int vote = 0;
                foreach (int idx in l.Headers)
                {
                    var c = l.Cells[idx];
                    if (c.Header % 24 != b) continue;
                    vote += sym[idx] == 0 ? 1 : (sym[idx] == 8 ? -1 : 0);
                }
                hb[b] = (byte)(vote > 0 ? 1 : 0);
            }
            int at = 0;
            int ReadBits(int n) { int v = 0; while (n-- > 0) v = (v << 1) | hb[at++]; return v; }
            int hsize = ReadBits(3), hecc = ReadBits(2), hmode = ReadBits(1), htype = ReadBits(1);
            int hlen = ReadBits(13), hcrc = ReadBits(4);
            if (Crc4(hb, 20) != hcrc || hsize > 5 || hsize != size)
                throw new PrismException("Header checksum did not pass");
            var cap = CapacityOf(hsize, hecc, hmode);
            if (hlen > cap.Payload) throw new PrismException("Invalid length");

            int bitsPer = hmode != 0 ? 1 : 3;
            var invGray = new[] { 0, 1, 3, 2, 6, 7, 5, 4 };
            var stream = new List<byte>(l.Data.Count * bitsPer);
            foreach (int idx in l.Data)
            {
                int s = sym[idx];
                if (hmode != 0)
                {
                    if (s != 0 && s != 8) throw new PrismException("Unexpected cell colors");
                    stream.Add(s == 0 ? (byte)1 : (byte)0);
                }
                else
                {
                    if (s > 7) throw new PrismException("Unexpected cell colors");
                    int b = invGray[s];
                    stream.Add((byte)((b >> 2) & 1));
                    stream.Add((byte)((b >> 1) & 1));
                    stream.Add((byte)(b & 1));
                }
            }
            var bytes = new byte[cap.N];
            for (int i = 0; i < cap.N; i++)
            {
                int v = 0;
                for (int k = 0; k < 8; k++) v = (v << 1) | stream[8 * i + k];
                bytes[i] = (byte)v;
            }
            var bb = new byte[cap.Blocks.Count][];
            int maxn = 0;
            for (int b = 0; b < cap.Blocks.Count; b++)
            {
                bb[b] = new byte[cap.Blocks[b].N];
                maxn = Math.Max(maxn, cap.Blocks[b].N);
            }
            at = 0;
            for (int p = 0; p < maxn; p++)
                for (int b = 0; b < cap.Blocks.Count; b++)
                    if (p < bb[b].Length) bb[b][p] = bytes[at++];
            // restore encoder-written deterministic padding
            int moff = 0;
            for (int b = 0; b < cap.Blocks.Count; b++)
            {
                for (int p = 0; p < cap.Blocks[b].K; p++)
                    if (hlen > 0 && moff + p >= hlen + 4) bb[b][p] = Padk((uint)(moff + p));
                moff += cap.Blocks[b].K;
            }
            var msg = new List<byte>(cap.K);
            for (int b = 0; b < cap.Blocks.Count; b++)
            {
                RsDecode(bb[b], cap.Blocks[b].Nsym);
                msg.AddRange(bb[b].AsSpan(0, cap.Blocks[b].K).ToArray());
            }
            uint want = 0;
            for (int k = 0; k < 4; k++) want = (want << 8) | msg[hlen + k];
            if (Crc32(msg.ToArray(), hlen) != want)
                throw new PrismException("Payload checksum did not pass");
            var res = new PrismDecodeResult
            {
                Bytes = msg.GetRange(0, hlen).ToArray(),
                Type = htype, Size = hsize, Ecc = hecc, Mode = hmode
            };
            return res;
        }

        /// <summary>
        /// Decode a Prism code from a clean PNG (encoder output; not the robust
        /// camera pipeline). CRC32 verified. Throws PrismException on failure.
        /// </summary>
        public static PrismDecodeResult DecodePng(string path)
        {
            var img = Png.Read(path);
            string lasterr = "No Prism code found";
            for (int size = 0; size < 6; size++)
            {
                var probe = LayoutBuild(size);
                double Wt = probe.W + 2 * PQ, Ht = probe.H + 2 * PQ;
                double r = (img.Width / Wt + img.Height / Ht) / 2;
                if (r < 3.9) continue;
                if (Math.Abs(Wt * r - img.Width) > 2.0 || Math.Abs(Ht * r - img.Height) > 2.0) continue;
                try
                {
                    var res = DecodeSized(img, size, r);
                    if (res.Type == (int)PrismType.Text)
                    {
                        try
                        {
                            new System.Text.UTF8Encoding(false, true).GetString(res.Bytes);
                        }
                        catch (System.Text.DecoderFallbackException)
                        {
                            throw new PrismException("Payload is not valid UTF-8 text");
                        }
                    }
                    return res;
                }
                catch (PrismException e)
                {
                    lasterr = e.Message;
                }
            }
            throw new PrismException(lasterr);
        }
    }
}
