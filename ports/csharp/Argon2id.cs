/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Argon2id (RFC 9106, version 0x13) in pure C#, standard library only.
 * Matches hash-wasm's argon2id output (the library the live site inlines).
 * Supports the single-lane and multi-lane general case. */
using System;
using System.Security.Cryptography;

namespace PrismCode
{
    internal static class Blake2b
    {
        private static readonly ulong[] IV = {
            0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
            0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179 };
        private static readonly int[,] SIGMA = {
            {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
            {14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3},
            {11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4},
            {7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8},
            {9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13},
            {2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9},
            {12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11},
            {13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10},
            {6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5},
            {10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0},
            {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
            {14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3} };

        private static ulong Rotr(ulong x, int n) => (x >> n) | (x << (64 - n));

        private static void Compress(ulong[] h, byte[] block, int boff, ulong t, bool last)
        {
            var m = new ulong[16];
            for (int i = 0; i < 16; i++)
                m[i] = BitConverter.ToUInt64(block, boff + i * 8);
            var v = new ulong[16];
            Array.Copy(h, v, 8);
            Array.Copy(IV, 0, v, 8, 8);
            v[12] ^= t;
            if (last) v[14] = ~v[14];
            void G(int a, int b, int c, int d, ulong x, ulong y)
            {
                v[a] = v[a] + v[b] + x; v[d] = Rotr(v[d] ^ v[a], 32);
                v[c] += v[d]; v[b] = Rotr(v[b] ^ v[c], 24);
                v[a] = v[a] + v[b] + y; v[d] = Rotr(v[d] ^ v[a], 16);
                v[c] += v[d]; v[b] = Rotr(v[b] ^ v[c], 63);
            }
            for (int r = 0; r < 12; r++)
            {
                G(0, 4, 8, 12, m[SIGMA[r, 0]], m[SIGMA[r, 1]]);
                G(1, 5, 9, 13, m[SIGMA[r, 2]], m[SIGMA[r, 3]]);
                G(2, 6, 10, 14, m[SIGMA[r, 4]], m[SIGMA[r, 5]]);
                G(3, 7, 11, 15, m[SIGMA[r, 6]], m[SIGMA[r, 7]]);
                G(0, 5, 10, 15, m[SIGMA[r, 8]], m[SIGMA[r, 9]]);
                G(1, 6, 11, 12, m[SIGMA[r, 10]], m[SIGMA[r, 11]]);
                G(2, 7, 8, 13, m[SIGMA[r, 12]], m[SIGMA[r, 13]]);
                G(3, 4, 9, 14, m[SIGMA[r, 14]], m[SIGMA[r, 15]]);
            }
            for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
        }

        /// <summary>Blake2b of data with output length outLen (1..64).</summary>
        public static byte[] Hash(byte[] data, int outLen)
        {
            var h = (ulong[])IV.Clone();
            h[0] ^= 0x01010000 ^ (ulong)outLen;
            ulong t = 0;
            int off = 0;
            while (data.Length - off > 128)
            {
                t += 128;
                Compress(h, data, off, t, false);
                off += 128;
            }
            var last = new byte[128];
            Array.Copy(data, off, last, 0, data.Length - off);
            t += (ulong)(data.Length - off);
            Compress(h, last, 0, t, true);
            var outp = new byte[64];
            for (int i = 0; i < 8; i++) BitConverter.GetBytes(h[i]).CopyTo(outp, i * 8);
            var r = new byte[outLen];
            Array.Copy(outp, r, outLen);
            return r;
        }

        /// <summary>Argon2's variable-length hash H' (RFC 9106 3.3).</summary>
        public static byte[] HashLong(byte[] data, int outLen)
        {
            var le = BitConverter.GetBytes((uint)outLen);
            if (outLen <= 64)
            {
                var inp = new byte[4 + data.Length];
                le.CopyTo(inp, 0); data.CopyTo(inp, 4);
                return Hash(inp, outLen);
            }
            var outp = new byte[outLen];
            var first = new byte[4 + data.Length];
            le.CopyTo(first, 0); data.CopyTo(first, 4);
            int r = (outLen + 31) / 32 - 2;
            // W_1..W_r are the first 32 bytes of V_1..V_r; V_{r+2} has length outLen-32r.
            byte[] v = Hash(first, 64); // V_1
            int at = 0;
            for (int i = 0; i < r; i++)
            {
                Array.Copy(v, 0, outp, at, 32);
                at += 32;
                if (i < r - 1) v = Hash(v, 64); // V_{i+2}; loop leaves v = V_r
            }
            v = Hash(v, outLen - 32 * r); // V_{r+2}
            Array.Copy(v, 0, outp, at, v.Length);
            return outp;
        }
    }

    internal static class Argon2id
    {
        private static ulong Rotr(ulong x, int n) => (x >> n) | (x << (64 - n));
        // BlaMka: x + y + 2 * (x mod 2^32) * (y mod 2^32)
        private static ulong Mul(ulong a, ulong b) => a + b + 2 * ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF));

        private static void GB(ulong[] v, int a, int b, int c, int d)
        {
            v[a] = Mul(v[a], v[b]); v[d] = Rotr(v[d] ^ v[a], 32);
            v[c] = Mul(v[c], v[d]); v[b] = Rotr(v[b] ^ v[c], 24);
            v[a] = Mul(v[a], v[b]); v[d] = Rotr(v[d] ^ v[a], 16);
            v[c] = Mul(v[c], v[d]); v[b] = Rotr(v[b] ^ v[c], 63);
        }
        private static void Round(ulong[] v, int o)
        {
            GB(v, o + 0, o + 4, o + 8, o + 12);
            GB(v, o + 1, o + 5, o + 9, o + 13);
            GB(v, o + 2, o + 6, o + 10, o + 14);
            GB(v, o + 3, o + 7, o + 11, o + 15);
            GB(v, o + 0, o + 5, o + 10, o + 15);
            GB(v, o + 1, o + 6, o + 11, o + 12);
            GB(v, o + 2, o + 7, o + 8, o + 13);
            GB(v, o + 3, o + 4, o + 9, o + 14);
        }
        // Argon2 block permutation P: 8x8 matrix of 16-byte registers.
        private static void Permute(ulong[] v) // 128 ulongs = 1024 bytes
        {
            var row = new ulong[16];
            for (int r = 0; r < 8; r++)
            {
                Array.Copy(v, r * 16, row, 0, 16);
                Round(row, 0);
                Array.Copy(row, 0, v, r * 16, 16);
            }
            for (int c = 0; c < 8; c++)
            {
                for (int k = 0; k < 8; k++) { row[2 * k] = v[16 * k + 2 * c]; row[2 * k + 1] = v[16 * k + 2 * c + 1]; }
                Round(row, 0);
                for (int k = 0; k < 8; k++) { v[16 * k + 2 * c] = row[2 * k]; v[16 * k + 2 * c + 1] = row[2 * k + 1]; }
            }
        }
        // G(X, Y) = R xor P(R), R = X xor Y; writes into out (all 128-ulong blocks)
        private static void G(ulong[] x, int xo, ulong[] y, int yo, ulong[] outp, int oo, bool withXor, ulong[]? old = null, int oldOff = 0)
        {
            var R = new ulong[128];
            for (int i = 0; i < 128; i++) R[i] = x[xo + i] ^ y[yo + i];
            var Q = (ulong[])R.Clone();
            Permute(Q);
            for (int i = 0; i < 128; i++)
            {
                ulong val = Q[i] ^ R[i];
                if (withXor && old != null) val ^= old[oldOff + i];
                outp[oo + i] = val;
            }
        }

        /// <summary>Argon2id: password, salt, memory in KiB, passes, lanes, output length.</summary>
        public static byte[] Hash(byte[] password, byte[] salt, int memKiB, int passes, int lanes, int outLen)
        {
            const int SYNC_POINTS = 4;
            int laneLen = memKiB / (lanes * SYNC_POINTS) * SYNC_POINTS;
            int mPrime = laneLen * lanes;
            int segLen = laneLen / SYNC_POINTS;

            // H0
            var h0inp = new System.IO.MemoryStream();
            void W32(uint v) { h0inp.Write(BitConverter.GetBytes(v), 0, 4); }
            void Wb(byte[] b) { W32((uint)b.Length); h0inp.Write(b, 0, b.Length); }
            W32((uint)lanes); W32((uint)outLen); W32((uint)memKiB); W32((uint)passes);
            W32(0x13); W32(2); // version 19, type argon2id
            Wb(password); Wb(salt); W32(0); W32(0);
            byte[] H0 = Blake2b.Hash(h0inp.ToArray(), 64);

            var mem = new ulong[mPrime * 128];
            var hbuf = new byte[4 + 64 + 8];
            for (int l = 0; l < lanes; l++)
            {
                for (int b = 0; b < 2; b++)
                {
                    var inp = new byte[64 + 8];
                    Array.Copy(H0, inp, 64);
                    BitConverter.GetBytes((uint)b).CopyTo(inp, 64);
                    BitConverter.GetBytes((uint)l).CopyTo(inp, 68);
                    byte[] blk = Blake2b.HashLong(inp, 1024);
                    for (int i = 0; i < 128; i++) mem[(l * laneLen + b) * 128 + i] = BitConverter.ToUInt64(blk, i * 8);
                }
            }

            var zero = new ulong[128];
            var addressBlock = new ulong[128];
            var inputBlock = new ulong[128];
            var tmp = new ulong[128];

            for (int pass = 0; pass < passes; pass++)
            {
                for (int slice = 0; slice < SYNC_POINTS; slice++)
                {
                    for (int lane = 0; lane < lanes; lane++)
                    {
                        bool dataIndep = pass == 0 && slice < SYNC_POINTS / 2; // Argon2id
                        int startIdx = (pass == 0 && slice == 0) ? 2 : 0;
                        // Per RFC 9106 / the reference implementation, the address and
                        // input blocks are reset at the start of every segment: the first
                        // segment (pass 0, slice 0) therefore uses a zero address block
                        // until index 128, where the counter starts at 1.
                        Array.Clear(addressBlock, 0, 128);
                        Array.Clear(inputBlock, 0, 128);
                        inputBlock[0] = (ulong)pass;
                        inputBlock[1] = (ulong)lane;
                        inputBlock[2] = (ulong)slice;
                        inputBlock[3] = (ulong)mPrime;
                        inputBlock[4] = (ulong)passes;
                        inputBlock[5] = 2;
                        if (pass == 0 && slice == 0)
                        {
                            // The reference implementation generates the first block of
                            // addresses up front; indices 2..127 use addressBlock[2..127].
                            inputBlock[6]++;
                            G(zero, 0, inputBlock, 0, tmp, 0, false);
                            G(zero, 0, tmp, 0, addressBlock, 0, false);
                        }
                        for (int idx = startIdx; idx < segLen; idx++)
                        {
                            int curOff = (lane * laneLen + slice * segLen + idx) * 128;
                            int prevIdx = (slice * segLen + idx) == 0 ? laneLen - 1 : slice * segLen + idx - 1;
                            int prevOff = (lane * laneLen + prevIdx) * 128;
                            ulong j1, j2;
                            if (dataIndep)
                            {
                                if (idx % 128 == 0)
                                {
                                    inputBlock[6]++;
                                    G(zero, 0, inputBlock, 0, tmp, 0, false);
                                    G(zero, 0, tmp, 0, addressBlock, 0, false);
                                }
                                // pseudo-random 64-bit word: J1 = low 32 bits, J2 = high 32 bits
                                ulong pr = addressBlock[idx % 128];
                                j1 = pr & 0xFFFFFFFF;
                                j2 = (pr >> 32) & 0xFFFFFFFF;
                            }
                            else
                            {
                                j1 = mem[prevOff] & 0xFFFFFFFF;
                                j2 = (mem[prevOff] >> 32) & 0xFFFFFFFF;
                            }
                            int refLane = (int)(j2 % (ulong)lanes);
                            if (pass == 0 && slice == 0) refLane = lane; // first slice cannot reference other lanes yet
                            bool sameLane = refLane == lane;
                            long refAreaSize;
                            if (pass == 0)
                            {
                                if (slice == 0) refAreaSize = idx - 1;
                                else refAreaSize = (long)slice * segLen + (sameLane ? idx - 1 : (idx == 0 ? -1 : 0));
                            }
                            else
                            {
                                refAreaSize = (long)laneLen - segLen + (sameLane ? idx - 1 : (idx == 0 ? -1 : 0));
                            }
                            ulong rel = j1;
                            rel = rel * rel >> 32;
                            rel = (ulong)refAreaSize - 1 - ((ulong)refAreaSize * rel >> 32);
                            long startPos = pass == 0 ? 0 : (slice == SYNC_POINTS - 1 ? 0 : (long)(slice + 1) * segLen);
                            long absPos = (startPos + (long)rel) % laneLen;
                            int refOff = (refLane * laneLen + (int)absPos) * 128;
                            if (pass == 0)
                                G(mem, prevOff, mem, refOff, mem, curOff, false);
                            else
                                G(mem, prevOff, mem, refOff, mem, curOff, true, mem, curOff);
                        }
                    }
                }
            }

            var final = new ulong[128];
            for (int l = 0; l < lanes; l++)
            {
                int off = (l * laneLen + laneLen - 1) * 128;
                for (int i = 0; i < 128; i++) final[i] ^= mem[off + i];
            }
            var finalBytes = new byte[1024];
            for (int i = 0; i < 128; i++) BitConverter.GetBytes(final[i]).CopyTo(finalBytes, i * 8);
            return Blake2b.HashLong(finalBytes, outLen);
        }
    }
}
