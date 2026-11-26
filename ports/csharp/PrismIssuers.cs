/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism verified issuers: identify signed Prism Secure payloads and look the
 * signer up in an issuer list, same semantics as prism-issuers.js. */
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PrismCode
{
    public sealed class IssuerIdentity
    {
        public bool SignatureValid;
        public string Fingerprint = "";
        public bool Encrypted;
        public string? Message; // decoded text for valid, unencrypted payloads
    }

    public sealed class Issuer
    {
        public string Name { get; set; } = "";
        public string Fingerprint { get; set; } = "";
        public string? Url { get; set; }
    }

    public static class PrismIssuers
    {
        /* Inspect decoded payload bytes. Returns null for plain or unsigned
         * payloads, else the identity. Read-only: never decrypts. */
        public static IssuerIdentity? Identify(byte[] bytes)
        {
            if (bytes == null || bytes.Length < 5 + 65 + 64) return null;
            if (bytes[0] != 0x50 || bytes[1] != 0x53 || bytes[2] != 0x43) return null; // "PSC"
            if (bytes[3] != 1 && bytes[3] != 2) return null;
            if ((bytes[4] & 2) == 0) return null; // F_SIG
            int end = bytes.Length;
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
            var outp = new IssuerIdentity
            {
                SignatureValid = valid,
                Encrypted = (bytes[4] & 1) != 0,
                Fingerprint = PrismSecure.Fingerprint(pub),
            };
            if (valid && !outp.Encrypted)
            {
                try { outp.Message = new UTF8Encoding(false, true).GetString(body, 5, body.Length - 5); }
                catch (DecoderFallbackException) { outp.Message = null; }
            }
            return outp;
        }

        /* Loads an issuers.json file (empty list when missing or damaged). */
        public static List<Issuer> Load(string path)
        {
            try
            {
                using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(path));
                var list = new List<Issuer>();
                foreach (var el in doc.RootElement.GetProperty("issuers").EnumerateArray())
                {
                    list.Add(new Issuer
                    {
                        Name = el.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                        Fingerprint = el.TryGetProperty("fingerprint", out var f) ? f.GetString() ?? "" : "",
                        Url = el.TryGetProperty("url", out var u) ? u.GetString() : null,
                    });
                }
                return list;
            }
            catch { return new List<Issuer>(); }
        }

        static string Norm(string f)
        {
            var sb = new StringBuilder();
            foreach (char c in (f ?? "").ToUpperInvariant())
                if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) sb.Append(c);
            return sb.ToString();
        }

        public static Issuer? Find(IEnumerable<Issuer> issuers, string fingerprint)
        {
            string want = Norm(fingerprint);
            foreach (var it in issuers)
                if (Norm(it.Fingerprint) == want) return it;
            return null;
        }
    }
}
