/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C# port of Prism Secure (envelope v2): AES-256-GCM payload locking and
 * ECDSA P-256 signing, byte-compatible with the live site (prism-secure.html).
 * Standard library only. Argon2id is implemented in Argon2id.cs (no packages);
 * PBKDF2 uses the built-in Rfc2898DeriveBytes.
 *
 * Envelope v2 (bytes): "PSC" 0x02 | flags | body
 *   flags bit0 = encrypted, bit1 = signed
 *   encrypted body: kdf(1) kdfParams(6) salt(16) iv(12) ciphertext+tag(16)
 *     kdf 2 = Argon2id: memKiB(4, BE) passes(1) lanes(1)   (default 128 MiB, 3 passes)
 *     kdf 1 = PBKDF2-SHA256: iterations(4, BE) + 2 unused  (fallback, 600,000 rounds)
 *   signed: appended pubkey(65, P-256 raw) + signature(64) over everything before it
 * v1 codes (PBKDF2 only, different header) open too. */
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace PrismCode
{
    public sealed class PrismSigningKey
    {
        public byte[] PublicKey = Array.Empty<byte>(); // 65 bytes, 0x04 | X | Y
        public string PrivateJwk = "";                 // JWK JSON, as on the site
    }

    public sealed class PrismSecureResult
    {
        public bool Secure, Encrypted, Signed;
        public bool? SignatureValid;
        public string? SignerFingerprint;
        public bool Trusted;
        public byte[]? Bytes;      // null on wrong password / invalid signature / needsPassword
        public bool NeedsPassword;
        public string? Error;
        public int Version;
    }

    public static class PrismSecure
    {
        private static readonly byte[] MAGIC = { 0x50, 0x53, 0x43 }; // "PSC"
        private const int F_ENC = 1, F_SIG = 2;
        private const int PBKDF2_ITER = 600000;
        private const int A2_MEM = 131072, A2_T = 3, A2_P = 1;
        private const int MAX_MEM = 262144, MAX_T = 12;
        private const int HEAD2 = 4 + 1 + 1 + 6 + 16 + 12;
        private const int HEAD1 = 4 + 1 + 16 + 12 + 4;

        private static byte[] Cat(params byte[][] parts)
        {
            int n = 0; foreach (var p in parts) n += p.Length;
            var o = new byte[n]; int at = 0;
            foreach (var p in parts) { Array.Copy(p, 0, o, at, p.Length); at += p.Length; }
            return o;
        }
        private static byte[] Be32(uint n) => new[] { (byte)(n >> 24), (byte)(n >> 16), (byte)(n >> 8), (byte)n };
        private static uint Rd32(byte[] b, int i) =>
            ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3];
        private static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }
        private static byte[] PasswordBytes(string password) =>
            new UTF8Encoding(false).GetBytes(password.Normalize(NormalizationForm.FormKC));

        private static byte[] DeriveKeyBytes(string password, byte[] salt, int kdf, int iter, int mem, int t, int lanes)
        {
            byte[] pw = PasswordBytes(password);
            try
            {
                if (kdf == 2)
                    return Argon2id.Hash(pw, salt, mem, t, lanes, 32);
                return Rfc2898DeriveBytes.Pbkdf2(pw, salt, iter, HashAlgorithmName.SHA256, 32);
            }
            finally { Array.Clear(pw); }
        }

        public static PrismSigningKey GenerateSigningKey()
        {
            using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var p = ec.ExportParameters(true);
            string B64(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            string jwk = "{\"crv\":\"P-256\",\"d\":\"" + B64(p.D!) + "\",\"kty\":\"EC\",\"x\":\"" + B64(p.Q.X!) + "\",\"y\":\"" + B64(p.Q.Y!) + "\"}";
            return new PrismSigningKey
            {
                PublicKey = Cat(new byte[] { 4 }, p.Q.X!, p.Q.Y!),
                PrivateJwk = jwk
            };
        }

        private static ECDsa ImportPrivateJwk(string jwk)
        {
            // minimal JWK parse for the keys this class and the site produce
            string Get(string name)
            {
                string needle = "\"" + name + "\":\"";
                int i = jwk.IndexOf(needle, StringComparison.Ordinal);
                if (i < 0) throw new PrismException("Bad signing key JWK");
                int j = jwk.IndexOf('"', i + needle.Length);
                return jwk.Substring(i + needle.Length, j - i - needle.Length);
            }
            byte[] Unb64(string s)
            {
                s = s.Replace('-', '+').Replace('_', '/');
                while (s.Length % 4 != 0) s += "=";
                return Convert.FromBase64String(s);
            }
            var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            ec.ImportParameters(new ECParameters
            {
                Curve = ECCurve.NamedCurves.nistP256,
                D = Unb64(Get("d")),
                Q = new ECPoint { X = Unb64(Get("x")), Y = Unb64(Get("y")) }
            });
            return ec;
        }

        public static string Fingerprint(byte[] publicKey65)
        {
            byte[] h = SHA256.HashData(publicKey65);
            var sb = new StringBuilder();
            for (int i = 0; i < 8; i++)
            {
                sb.Append(h[i].ToString("X2"));
                if (i % 2 == 1 && i < 7) sb.Append('-');
            }
            return sb.ToString();
        }

        /// <summary>Seal payload bytes: lock with a password and/or sign. kdf: "argon2id" (default) or "pbkdf2".</summary>
        public static byte[] Seal(byte[] payload, string? password = null, PrismSigningKey? signWith = null, string kdf = "argon2id")
        {
            if (password == null && signWith == null)
                throw new PrismException("Give a password, a signing key, or both");
            int flags = (password != null ? F_ENC : 0) | (signWith != null ? F_SIG : 0);
            byte[] body;
            if (password != null)
            {
                bool useA = kdf == "argon2id";
                byte[] salt = RandomNumberGenerator.GetBytes(16), iv = RandomNumberGenerator.GetBytes(12);
                byte[] kdfParams = useA ? Cat(Be32(A2_MEM), new byte[] { A2_T, A2_P }) : Cat(Be32(PBKDF2_ITER), new byte[] { 0, 0 });
                byte[] head = Cat(MAGIC, new byte[] { 2 }, new byte[] { (byte)flags }, new byte[] { (byte)(useA ? 2 : 1) }, kdfParams, salt, iv);
                byte[] key = DeriveKeyBytes(password, salt, useA ? 2 : 1, PBKDF2_ITER, A2_MEM, A2_T, A2_P);
                try
                {
                    using var aes = new AesGcm(key, 16);
                    var ct = new byte[payload.Length]; var tag = new byte[16];
                    aes.Encrypt(iv, payload, ct, tag, head);
                    body = Cat(head, ct, tag);
                }
                finally { Array.Clear(key); }
            }
            else body = Cat(MAGIC, new byte[] { 2 }, new byte[] { (byte)flags }, payload);
            if (signWith == null) return body;
            using (var ec = ImportPrivateJwk(signWith.PrivateJwk))
            {
                byte[] sig = ec.SignData(body, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
                return Cat(body, signWith.PublicKey, sig);
            }
        }

        public static bool IsSecure(byte[] b) =>
            b.Length >= 6 && b[0] == MAGIC[0] && b[1] == MAGIC[1] && b[2] == MAGIC[2] &&
            (b[3] == 1 || b[3] == 2) && (b[4] & ~3) == 0;

        public static (bool secure, bool encrypted, bool signed) Inspect(byte[] b) =>
            !IsSecure(b) ? (false, false, false) : (true, (b[4] & F_ENC) != 0, (b[4] & F_SIG) != 0);

        /// <summary>Random passphrase: 7 groups of 4 from a 32-symbol alphabet = 140 bits
        /// of entropy (32 symbols = exactly 5 bits each, so no modulo bias).</summary>
        public static string GeneratePassphrase()
        {
            const string ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
            byte[] r = RandomNumberGenerator.GetBytes(28);
            try
            {
                var sb = new StringBuilder(34);
                for (int g = 0; g < 7; g++)
                {
                    if (g > 0) sb.Append('-');
                    for (int i = 0; i < 4; i++) sb.Append(ALPHA[r[g * 4 + i] & 31]);
                }
                return sb.ToString();
            }
            finally { Array.Clear(r); }
        }

        private static readonly string[] COMMON_WORDS = { "password", "passw0rd", "qwerty", "letmein", "welcome", "admin", "iloveyou", "monkey", "dragon", "football", "baseball", "shalom", "israel", "master", "login", "abc123", "prism", "secret", "hello", "test", "summer", "winter", "sunshine", "princess", "trustno1", "whatever", "google", "avi", "1234", "asdf", "zxcv", "love", "god", "cohen", "levi" };

        /// <summary>Strength estimate in bits, same heuristic as the site (deliberately cautious).</summary>
        public static (int bits, int level, string label, string[] warnings) Strength(string pw)
        {
            var warnings = new List<string>();
            if (string.IsNullOrEmpty(pw)) return (0, 0, "none", new[] { "Enter a password" });
            string body = pw.Replace("-", "");
            if (pw.Split('-').Length >= 6 && System.Text.RegularExpressions.Regex.IsMatch(pw, "^[A-HJ-NP-Z2-9-]+$") && body.Length >= 24)
                return ((int)Math.Floor(body.Length * 5.0), 4, "excellent (random)", Array.Empty<string>());
            int pool = 0;
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "[a-z]")) pool += 26;
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "[A-Z]")) pool += 26;
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "[0-9]")) pool += 10;
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "[^A-Za-z0-9]")) pool += 33;
            int uniq = new HashSet<char>(pw).Count;
            double bits = Math.Min(pw.Length, uniq * 2) * Math.Log(Math.Max(pool, 2), 2);
            string low = pw.ToLowerInvariant();
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "^[a-z ]+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            {
                int w = 0; foreach (var x in pw.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)) if (x.Length > 2) w++;
                bits = Math.Min(bits, w > 1 ? w * 12 : pw.Length * 2.5);
                if (w <= 1) warnings.Add("A single word is easy to guess");
            }
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "(.)\\1\\1")) { bits *= 0.7; warnings.Add("Repeated characters"); }
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "(012|123|234|345|456|567|678|789|abc|bcd|cde|def|qwe|wer|asd|sdf|zxc)", System.Text.RegularExpressions.RegexOptions.IgnoreCase)) { bits *= 0.7; warnings.Add("Keyboard or number sequence"); }
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "^[a-z]+$", System.Text.RegularExpressions.RegexOptions.IgnoreCase) || System.Text.RegularExpressions.Regex.IsMatch(pw, "^[0-9]+$")) { bits *= 0.8; warnings.Add("Only one kind of character"); }
            if (System.Text.RegularExpressions.Regex.IsMatch(pw, "(19|20)\\d\\d\\b")) { bits -= 8; warnings.Add("Contains a year"); }
            foreach (var w in COMMON_WORDS)
                if (low.Contains(w)) { bits = Math.Min(bits, 28) - (low == w ? 8 : 0); warnings.Add("Contains a common word or pattern"); break; }
            if (pw.Length < 12) warnings.Add("Shorter than 12 characters");
            int ibits = Math.Max(0, (int)Math.Floor(bits));
            int level = ibits < 40 ? 0 : ibits < 60 ? 1 : ibits < 80 ? 2 : ibits < 100 ? 3 : 4;
            if (ibits < 80) warnings.Add("Someone with a photo of the code can guess offline. Use Random for a code that matters.");
            return (ibits, level, new[] { "weak", "weak", "fair", "good", "strong" }[level], warnings.Distinct().ToArray());
        }

        /// <summary>Open a sealed payload. Plain (non-secure) payloads come back unchanged.</summary>
        public static PrismSecureResult Open(byte[] bytes, string? password = null, string[]? trustedFingerprints = null)
        {
            var outp = new PrismSecureResult();
            if (!IsSecure(bytes)) { outp.Bytes = bytes; return outp; }
            int ver = bytes[3], flags = bytes[4];
            bool encrypted = (flags & F_ENC) != 0, signed = (flags & F_SIG) != 0;
            outp.Secure = true; outp.Version = ver; outp.Encrypted = encrypted; outp.Signed = signed;
            int end = bytes.Length;
            if (signed)
            {
                if (bytes.Length < 5 + 65 + 64) throw new PrismException("Code is damaged");
                byte[] pub = bytes.AsSpan(end - 129, 65).ToArray();
                byte[] sig = bytes.AsSpan(end - 64, 64).ToArray();
                byte[] body = bytes.AsSpan(0, end - 129).ToArray();
                bool valid = false;
                try
                {
                    using var ec = ECDsa.Create(ECCurve.NamedCurves.nistP256);
                    ec.ImportParameters(new ECParameters
                    {
                        Curve = ECCurve.NamedCurves.nistP256,
                        Q = new ECPoint { X = pub.AsSpan(1, 32).ToArray(), Y = pub.AsSpan(33, 32).ToArray() }
                    });
                    valid = ec.VerifyData(body, sig, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
                }
                catch (CryptographicException) { valid = false; }
                outp.SignatureValid = valid;
                outp.SignerFingerprint = Fingerprint(pub);
                if (valid && trustedFingerprints != null)
                    foreach (var f in trustedFingerprints)
                        if (f == outp.SignerFingerprint) outp.Trusted = true;
                end -= 129;
                if (!valid)
                {
                    outp.Bytes = null;
                    outp.Error = "Signature is not valid. This code was changed or forged.";
                    return outp;
                }
            }
            if (!encrypted) { outp.Bytes = bytes.AsSpan(5, end - 5).ToArray(); return outp; }
            int hl; byte[] salt, iv; int kdf, iter = 0, mem = 0, t = 0, lanes = 0;
            if (ver == 1)
            {
                hl = HEAD1;
                if (end < hl + 16) throw new PrismException("Code is damaged");
                salt = bytes.AsSpan(5, 16).ToArray(); iv = bytes.AsSpan(21, 12).ToArray();
                kdf = 1; iter = (int)Rd32(bytes, 33);
            }
            else
            {
                hl = HEAD2;
                if (end < hl + 16) throw new PrismException("Code is damaged");
                kdf = bytes[5];
                salt = bytes.AsSpan(12, 16).ToArray(); iv = bytes.AsSpan(28, 12).ToArray();
                if (kdf == 2) { mem = (int)Rd32(bytes, 6); t = bytes[10]; lanes = bytes[11]; }
                else iter = (int)Rd32(bytes, 6);
            }
            if (kdf == 1 ? (iter < 100000 || iter > 5000000)
                : kdf == 2 ? (mem < 8192 || mem > MAX_MEM || t < 1 || t > MAX_T || lanes < 1 || lanes > 4)
                : true) throw new PrismException("Code is damaged or unsupported");
            if (password == null) { outp.Bytes = null; outp.NeedsPassword = true; return outp; }
            byte[] head2 = bytes.AsSpan(0, hl).ToArray();
            byte[] key = DeriveKeyBytes(password, salt, kdf, iter, mem, t, lanes);
            try
            {
                using var aes = new AesGcm(key, 16);
                var pt = new byte[end - hl - 16];
                var tag = bytes.AsSpan(end - 16, 16).ToArray();
                aes.Decrypt(iv, bytes.AsSpan(hl, end - hl - 16), tag, pt, head2);
                outp.Bytes = pt;
            }
            catch (CryptographicException)
            {
                outp.Bytes = null;
                outp.Error = "Wrong password, or the code was changed.";
            }
            finally { Array.Clear(key); }
            return outp;
        }
    }
}
