/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Minimal PNG reader/writer for the C# Prism port. Standard library only
 * (System.IO.Compression ZLibStream). Supports 8-bit gray/RGB/RGBA,
 * non-interlaced, all five PNG filters. */
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;

namespace PrismCode
{
    internal static class Png
    {
        private static readonly byte[] Sig = { 137, 80, 78, 71, 13, 10, 26, 10 };
        private static readonly uint[] CrcTable = BuildCrcTable();

        private static uint[] BuildCrcTable()
        {
            var t = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                t[n] = c;
            }
            return t;
        }
        private static uint Crc32(byte[] buf, int off, int len)
        {
            uint c = 0xFFFFFFFFu;
            unchecked { for (int i = 0; i < len; i++) c = CrcTable[(c ^ buf[off + i]) & 255] ^ (c >> 8); }
            return c ^ 0xFFFFFFFFu;
        }
        private static void PutBe32(List<byte> v, uint x)
        {
            v.Add((byte)(x >> 24)); v.Add((byte)(x >> 16)); v.Add((byte)(x >> 8)); v.Add((byte)x);
        }

        public static void Write(string path, PrismImage img)
        {
            int stride = img.Width * 4;
            var raw = new byte[(stride + 1) * img.Height];
            for (int y = 0; y < img.Height; y++)
            {
                raw[y * (stride + 1)] = 0;
                Array.Copy(img.Rgba, y * stride, raw, y * (stride + 1) + 1, stride);
            }
            byte[] comp;
            using (var ms = new MemoryStream())
            {
                using (var z = new ZLibStream(ms, CompressionLevel.SmallestSize, true))
                    z.Write(raw, 0, raw.Length);
                comp = ms.ToArray();
            }
            var png = new List<byte>(Sig);
            void Chunk(string type, byte[] data)
            {
                PutBe32(png, (uint)data.Length);
                int at = png.Count;
                foreach (char ch in type) png.Add((byte)ch);
                png.AddRange(data);
                PutBe32(png, Crc32(png.ToArray(), at, 4 + data.Length));
            }
            var ihdr = new byte[13];
            ihdr[0] = (byte)(img.Width >> 24); ihdr[1] = (byte)(img.Width >> 16);
            ihdr[2] = (byte)(img.Width >> 8); ihdr[3] = (byte)img.Width;
            ihdr[4] = (byte)(img.Height >> 24); ihdr[5] = (byte)(img.Height >> 16);
            ihdr[6] = (byte)(img.Height >> 8); ihdr[7] = (byte)img.Height;
            ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
            Chunk("IHDR", ihdr);
            Chunk("IDAT", comp);
            Chunk("IEND", Array.Empty<byte>());
            File.WriteAllBytes(path, png.ToArray());
        }

        private static uint Be32(byte[] p, int off) =>
            ((uint)p[off] << 24) | ((uint)p[off + 1] << 16) | ((uint)p[off + 2] << 8) | p[off + 3];

        public static PrismImage Read(string path)
        {
            byte[] buf;
            try { buf = File.ReadAllBytes(path); }
            catch (Exception e) { throw new PrismException("Cannot open input file: " + path + " (" + e.Message + ")"); }
            if (buf.Length < 8) throw new PrismException("Not a PNG file");
            for (int i = 0; i < 8; i++) if (buf[i] != Sig[i]) throw new PrismException("Not a PNG file");
            int w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
            var idat = new List<byte>();
            int pos = 8;
            while (pos + 12 <= buf.Length)
            {
                uint clen = Be32(buf, pos);
                if (pos + 12 + clen > buf.Length) break;
                string type = System.Text.Encoding.ASCII.GetString(buf, pos + 4, 4);
                if (type == "IHDR")
                {
                    w = (int)Be32(buf, pos + 8); h = (int)Be32(buf, pos + 12);
                    depth = buf[pos + 16]; ctype = buf[pos + 17]; interlace = buf[pos + 20];
                }
                else if (type == "IDAT")
                {
                    for (uint i = 0; i < clen; i++) idat.Add(buf[pos + 8 + i]);
                }
                else if (type == "IEND") break;
                pos += 12 + (int)clen;
            }
            int ch = ctype == 6 ? 4 : ctype == 2 ? 3 : ctype == 0 ? 1 : 0;
            if (w <= 0 || h <= 0 || depth != 8 || ch == 0 || interlace != 0 || idat.Count == 0)
                throw new PrismException("Unsupported PNG (need 8-bit gray/RGB/RGBA, non-interlaced)");
            int stride = w * ch;
            int rawlen = (stride + 1) * h;
            byte[] raw;
            using (var ms = new MemoryStream(idat.ToArray()))
            using (var z = new ZLibStream(ms, CompressionMode.Decompress))
            {
                raw = new byte[rawlen];
                int got = 0;
                while (got < rawlen)
                {
                    int n = z.Read(raw, got, rawlen - got);
                    if (n <= 0) break;
                    got += n;
                }
                if (got != rawlen) throw new PrismException("PNG decompression failed");
            }
            var outp = new byte[stride * h];
            int p = 0;
            for (int y = 0; y < h; y++)
            {
                int filter = raw[p++];
                int rowOff = p; p += stride;
                int curOff = y * stride;
                int prevOff = (y - 1) * stride;
                for (int x = 0; x < stride; x++)
                {
                    int a = x >= ch ? outp[curOff + x - ch] : 0;
                    int b = y > 0 ? outp[prevOff + x] : 0;
                    int c = (y > 0 && x >= ch) ? outp[prevOff + x - ch] : 0;
                    int v = raw[rowOff + x];
                    if (filter == 1) v += a;
                    else if (filter == 2) v += b;
                    else if (filter == 3) v += (a + b) >> 1;
                    else if (filter == 4)
                    {
                        int pp = a + b - c, pa = Math.Abs(pp - a), pb = Math.Abs(pp - b), pc = Math.Abs(pp - c);
                        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                    }
                    else if (filter != 0) throw new PrismException("Bad PNG filter");
                    outp[curOff + x] = (byte)v;
                }
            }
            var img = new PrismImage { Width = w, Height = h, Rgba = new byte[w * h * 4] };
            for (int i = 0; i < w * h; i++)
            {
                img.Rgba[4 * i] = outp[ch * i];
                img.Rgba[4 * i + 1] = ch > 1 ? outp[ch * i + 1] : outp[ch * i];
                img.Rgba[4 * i + 2] = ch > 1 ? outp[ch * i + 2] : outp[ch * i];
                img.Rgba[4 * i + 3] = ch == 4 ? outp[4 * i + 3] : (byte)255;
            }
            return img;
        }
    }
}
