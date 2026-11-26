/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism big files in parts (PPT1), byte-compatible with prism-parts.js. */
using System;
using System.Collections.Generic;
using System.Text;

namespace PrismCode
{
    public sealed class PartsPlan
    {
        public int Room;
        public int Total;
        public string Name = "";
    }

    public sealed class PartInfo
    {
        public string Id = "";
        public int N, Total;
        public uint Len, Whole;
        public string Name = "";
        public byte[] Chunk = Array.Empty<byte>();
    }

    public static class PrismParts
    {
        public const int PartsEcc = 2; // parts are encoded at 30% repair data, color mode

        static readonly uint[] CrcTable = BuildTable();

        static uint[] BuildTable()
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

        internal static uint Crc(ReadOnlySpan<byte> b)
        {
            uint c = 0xFFFFFFFFu;
            foreach (byte x in b) c = CrcTable[(c ^ x) & 255] ^ (c >> 8);
            return c ^ 0xFFFFFFFFu;
        }

        static ushort U16(byte[] a, int i) => (ushort)((a[i] << 8) | a[i + 1]);
        static uint U32(byte[] a, int i) => ((uint)a[i] << 24) | ((uint)a[i + 1] << 16) | ((uint)a[i + 2] << 8) | a[i + 3];
        static void Put32(byte[] a, int i, uint v)
        {
            a[i] = (byte)(v >> 24); a[i + 1] = (byte)(v >> 16); a[i + 2] = (byte)(v >> 8); a[i + 3] = (byte)v;
        }

        static string CleanName(string name)
        {
            if (string.IsNullOrEmpty(name)) name = "file";
            var sb = new StringBuilder();
            foreach (char c in name)
            {
                if (sb.Length >= 200) break;
                sb.Append(c == '\\' || c == '/' || c < 0x20 ? '_' : c);
            }
            return sb.ToString();
        }

        // UTF-8 encode, trim to <= 40 bytes without splitting a character.
        static byte[] NameBytes(string name)
        {
            byte[] b = Encoding.UTF8.GetBytes(CleanName(name));
            if (b.Length <= 40) return b;
            int n = 40;
            while (n > 0 && (b[n] & 0xC0) == 0x80) n--;
            if (n > 0 && b[n] >= 0x80)
            {
                int need = (b[n] & 0xE0) == 0xC0 ? 2 : (b[n] & 0xF0) == 0xE0 ? 3 : (b[n] & 0xF8) == 0xF0 ? 4 : 0;
                if (need > 0 && n + need > 41) n--;
            }
            var t = new byte[n];
            Array.Copy(b, t, n);
            return t;
        }

        static int Overhead(int nameLen) => 4 + 4 + 2 + 2 + 4 + 4 + 1 + nameLen + 4;

        public static PartsPlan Plan(long len, string name, int codeSize)
        {
            byte[] nb = NameBytes(name);
            int room = Prism.CapacityPayload(codeSize, PartsEcc, PrismMode.Color) - Overhead(nb.Length);
            if (room < 64) throw new InvalidOperationException("Part size too small");
            long total = Math.Max(1, (len + room - 1) / room);
            if (total > 65535) throw new InvalidOperationException("File is too big for this part size");
            return new PartsPlan { Room = room, Total = (int)total, Name = Encoding.UTF8.GetString(nb) };
        }

        public static byte[][] Split(byte[] bytes, string name, int codeSize)
        {
            var plan = Plan(bytes.Length, name, codeSize);
            byte[] nb = Encoding.UTF8.GetBytes(plan.Name);
            var id = System.Security.Cryptography.RandomNumberGenerator.GetBytes(4);
            uint whole = Crc(bytes);
            var parts = new byte[plan.Total][];
            for (int n = 0; n < plan.Total; n++)
            {
                int off = n * plan.Room;
                int clen = Math.Min(plan.Room, bytes.Length - off);
                var p = new byte[Overhead(nb.Length) + clen];
                int o = 0;
                Buffer.BlockCopy(new byte[] { 0x50, 0x50, 0x54, 0x31 }, 0, p, o, 4); o += 4; // "PPT1"
                Buffer.BlockCopy(id, 0, p, o, 4); o += 4;
                p[o++] = (byte)((n + 1) >> 8); p[o++] = (byte)(n + 1);
                p[o++] = (byte)(plan.Total >> 8); p[o++] = (byte)plan.Total;
                Put32(p, o, (uint)bytes.Length); o += 4;
                Put32(p, o, whole); o += 4;
                p[o++] = (byte)nb.Length;
                Buffer.BlockCopy(nb, 0, p, o, nb.Length); o += nb.Length;
                Buffer.BlockCopy(bytes, off, p, o, clen); o += clen;
                Put32(p, o, Crc(new ReadOnlySpan<byte>(p, 0, o)));
                parts[n] = p;
            }
            return parts;
        }

        // ok: info set. notPart: not a part. bad: damaged part (site's message).
        public static bool TryParse(byte[] b, out PartInfo info, out bool notPart, out string bad)
        {
            info = null!; notPart = false; bad = null!;
            if (b == null || b.Length < 25 || b[0] != 0x50 || b[1] != 0x50 || b[2] != 0x54 || b[3] != 0x31)
            { notPart = true; return false; }
            if (Crc(new ReadOnlySpan<byte>(b, 0, b.Length - 4)) != U32(b, b.Length - 4))
            { bad = "This part failed its own check. Scan it again."; return false; }
            var p = new PartInfo
            {
                Id = BitConverter.ToString(b, 4, 4).Replace("-", "").ToLowerInvariant(),
                N = U16(b, 8),
                Total = U16(b, 10),
                Len = U32(b, 12),
                Whole = U32(b, 16),
            };
            int nl = b[20];
            if (21 + nl + 4 > b.Length || p.N == 0 || p.N > p.Total)
            { bad = "This part has a broken header."; return false; }
            p.Name = Encoding.UTF8.GetString(b, 21, nl);
            p.Chunk = new byte[b.Length - 4 - 21 - nl];
            Buffer.BlockCopy(b, 21 + nl, p.Chunk, 0, p.Chunk.Length);
            info = p;
            return true;
        }
    }

    public enum PartAddStatus { NotPart, Bad, OtherFile, Duplicate, New, Complete }

    public sealed class PartAddResult
    {
        public PartAddStatus Status;
        public int N;
        public string Message = "";
    }

    public sealed class PartsAssembler
    {
        string _id = null!;
        int _total;
        uint _len, _whole;
        string _name = "";
        byte[][] _chunks = null!;
        int _have;

        public int Have => _have;
        public int Total => _total;
        public string Name => _name;

        public PartAddResult Add(byte[] bytes)
        {
            if (!PrismParts.TryParse(bytes, out var p, out bool notPart, out string bad))
                return new PartAddResult { Status = notPart ? PartAddStatus.NotPart : PartAddStatus.Bad, Message = bad ?? "" };
            if (_id == null)
            {
                _id = p.Id; _total = p.Total; _len = p.Len; _whole = p.Whole; _name = p.Name;
                _chunks = new byte[p.Total][];
            }
            else if (p.Id != _id)
                return new PartAddResult
                {
                    Status = PartAddStatus.OtherFile,
                    Message = "That part belongs to a different file (" + (p.Name.Length > 0 ? p.Name : "unnamed") + "). Start over to switch.",
                };
            else if (p.Total != _total || p.Len != _len || p.Whole != _whole)
                return new PartAddResult { Status = PartAddStatus.Bad, Message = "This part does not match the others." };
            if (_chunks[p.N - 1] != null)
                return new PartAddResult { Status = PartAddStatus.Duplicate, N = p.N };
            _chunks[p.N - 1] = p.Chunk;
            _have++;
            return new PartAddResult { Status = _have == _total ? PartAddStatus.Complete : PartAddStatus.New, N = p.N };
        }

        public byte[] Finish()
        {
            if (_have != _total) throw new InvalidOperationException("Parts are still missing.");
            var outp = new byte[_len];
            long o = 0;
            for (int i = 0; i < _total; i++)
            {
                var c = _chunks[i];
                if (o + c.Length > _len) throw new InvalidOperationException("The parts add up to more than the file size.");
                Buffer.BlockCopy(c, 0, outp, (int)o, c.Length);
                o += c.Length;
            }
            if (o != _len) throw new InvalidOperationException("The parts add up to " + o + " bytes, not " + _len + ".");
            if (PrismParts.Crc(outp) != _whole)
                throw new InvalidOperationException("The whole-file check failed. Start over and scan the parts again.");
            return outp;
        }

        public string ResultName => _name.Length > 0 ? _name : "prism-file.bin";
    }
}
