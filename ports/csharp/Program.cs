/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Tiny CLI for the C# (.NET) Prism port. */
using System;
using System.IO;
using System.Text;
using PrismCode;

static class Program
{
    static void Usage()
    {
        Console.Error.WriteLine(
            "Prism Code (C# port) - create and read Prism codes. By Avi Shor.\n" +
            "\n" +
            "Usage:\n" +
            "  prism encode (--text TEXT | --file PATH) -o OUT.png [options]\n" +
            "  prism decode IN.png [-o OUT.bin] [--password PW]\n" +
            "  prism secure-seal IN -o OUT [--password PW] [--kdf argon2id|pbkdf2] [--sign-key KEY.json]\n" +
            "  prism secure-open IN [-o OUT] [--password PW]\n" +
            "  prism parts-split IN -o OUTDIR [--name NAME] [--size 2-5]   split a big file into parts\n" +
            "  prism parts-join PART.bin... [-o OUT]                       reassemble parts\n" +
            "  prism card-build wifi|vcard|ticket [fields] [-o OUT.txt]    build a card payload\n" +
            "  prism card-parse IN.txt                                     read a card payload\n" +
            "  prism issuer IN.png|IN.bin [--list issuers.json]            who signed this payload\n" +
            "  prism secure-genkey [-o KEY.json]\n" +
            "  prism capacity\n" +
            "\n" +
            "Encode options:\n" +
            "  --size N       0..5, or -1 automatic (default -1)\n" +
            "  --ecc N        0..3 = 10/20/30/40% repair data (default 1 = 20%)\n" +
            "  --mode M       color | bw (default color; bw holds ~1/3)\n" +
            "  --type T       text | binary (default: text for --text, binary for --file)\n" +
            "  --scale N      PNG pixels per cell unit (default 12; live site uses 8/12/20/32)\n" +
            "  --password PW  lock the payload with Prism Secure (AES-256-GCM)\n" +
            "  --kdf K        argon2id (default) | pbkdf2\n" +
            "  --sign-key KF  sign the payload with a key from secure-genkey\n" +
            "\n" +
            "Decode prints text payloads to stdout; with -o it writes raw payload bytes.");
    }

    static int Main(string[] args)
    {
        if (args.Length < 1) { Usage(); return 2; }
        try
        {
            if (args[0] == "capacity")
            {
                Console.WriteLine("size  cells      color-ecc0  bw-ecc0  (max payload bytes; ecc1/2/3 fit less)");
                string[] cells = { "21x24", "29x33", "41x47", "57x66", "81x94", "113x130" };
                for (int s = 0; s < 6; s++)
                    Console.WriteLine($"{s}     {cells[s],-10} {Prism.CapacityPayload(s, 0, PrismMode.Color),-11} {Prism.CapacityPayload(s, 0, PrismMode.BW),-8}");
                return 0;
            }
            if (args[0] == "encode")
            {
                string? text = null, file = null, outp = null, password = null, keyFile = null;
                string kdf = "argon2id";
                int size = -1, ecc = 1, scale = 12, type = -1;
                PrismMode mode = PrismMode.Color;
                for (int i = 1; i < args.Length; i++)
                {
                    string Next()
                    {
                        if (i + 1 >= args.Length) throw new PrismException("missing value for " + args[i]);
                        return args[++i];
                    }
                    switch (args[i])
                    {
                        case "--text": text = Next(); break;
                        case "--file": file = Next(); break;
                        case "-o": outp = Next(); break;
                        case "--size": size = int.Parse(Next()); break;
                        case "--ecc": ecc = int.Parse(Next()); break;
                        case "--scale": scale = int.Parse(Next()); break;
                        case "--mode": mode = Next() == "bw" ? PrismMode.BW : PrismMode.Color; break;
                        case "--type": type = Next() == "binary" ? (int)PrismType.Binary : (int)PrismType.Text; break;
                        case "--password": password = Next(); break;
                        case "--kdf": kdf = Next(); break;
                        case "--sign-key": keyFile = Next(); break;
                        default: Usage(); return 2;
                    }
                }
                if ((text == null && file == null) || outp == null) { Usage(); return 2; }
                byte[] data;
                if (file != null)
                {
                    data = File.ReadAllBytes(file);
                    if (type < 0) type = (int)PrismType.Binary;
                }
                else
                {
                    data = new UTF8Encoding(false).GetBytes(text!);
                    if (type < 0) type = (int)PrismType.Text;
                }
                if (password != null || keyFile != null)
                {
                    data = PrismSecure.Seal(data, password, keyFile != null ? LoadKey(keyFile) : null, kdf);
                    type = (int)PrismType.Binary;
                }
                Prism.EncodePng(data, outp, size, ecc, mode, (PrismType)type, scale);
                Console.WriteLine($"wrote {outp} ({data.Length} payload bytes)");
                return 0;
            }
            if (args[0] == "secure-genkey")
            {
                string? keyOut = null;
                for (int i = 1; i < args.Length; i++)
                    if (args[i] == "-o" && i + 1 < args.Length) keyOut = args[++i];
                var key = PrismSecure.GenerateSigningKey();
                string json = "{\"publicKeyHex\":\"" + Convert.ToHexString(key.PublicKey).ToLowerInvariant() + "\",\"privateJwk\":" + key.PrivateJwk + "}";
                if (keyOut != null) File.WriteAllText(keyOut, json);
                Console.WriteLine("fingerprint: " + PrismSecure.Fingerprint(key.PublicKey));
                if (keyOut != null) Console.WriteLine("wrote " + keyOut);
                return 0;
            }
            if (args[0] == "secure-seal" || args[0] == "secure-open")
            {
                string? inp = null, outp = null, pw = null, keyFile = null;
                string kdf = "argon2id";
                for (int i = 1; i < args.Length; i++)
                {
                    string Next()
                    {
                        if (i + 1 >= args.Length) throw new PrismException("missing value for " + args[i]);
                        return args[++i];
                    }
                    switch (args[i])
                    {
                        case "-o": outp = Next(); break;
                        case "--password": pw = Next(); break;
                        case "--kdf": kdf = Next(); break;
                        case "--sign-key": keyFile = Next(); break;
                        default: if (inp == null) inp = args[i]; else { Usage(); return 2; } break;
                    }
                }
                if (inp == null) { Usage(); return 2; }
                byte[] data = File.ReadAllBytes(inp);
                if (args[0] == "secure-seal")
                {
                    PrismSigningKey? key = null;
                    if (keyFile != null)
                    {
                        string json = File.ReadAllText(keyFile);
                        string Get(string name)
                        {
                            string needle = "\"" + name + "\":\"";
                            int i2 = json.IndexOf(needle, StringComparison.Ordinal);
                            if (i2 < 0) throw new PrismException("bad key file");
                            int j2 = json.IndexOf('"', i2 + needle.Length);
                            return json.Substring(i2 + needle.Length, j2 - i2 - needle.Length);
                        }
                        string jwk = json.Substring(json.IndexOf("{\"crv\"", StringComparison.Ordinal));
                        key = new PrismSigningKey { PublicKey = Convert.FromHexString(Get("publicKeyHex")), PrivateJwk = jwk.TrimEnd('}', ' ', '\n', '\r') + "}" };
                    }
                    byte[] sealedData = PrismSecure.Seal(data, pw, key, kdf);
                    if (outp != null) { File.WriteAllBytes(outp, sealedData); Console.WriteLine($"wrote {outp} ({data.Length} -> {sealedData.Length} bytes)"); }
                    else Console.WriteLine(Convert.ToHexString(sealedData).ToLowerInvariant());
                    return 0;
                }
                else
                {
                    var res = PrismSecure.Open(data, pw);
                    if (res.Secure && res.SignatureValid == false) { Console.Error.WriteLine("error: " + res.Error); return 1; }
                    if (res.Bytes == null) { Console.Error.WriteLine("error: " + (res.Error ?? (res.NeedsPassword ? "needs a password" : "cannot open"))); return 1; }
                    if (outp != null) { File.WriteAllBytes(outp, res.Bytes); Console.WriteLine($"wrote {outp} ({res.Bytes.Length} bytes)"); }
                    else { Console.OutputEncoding = new UTF8Encoding(false); Console.Out.Write(new UTF8Encoding(false).GetString(res.Bytes) + "\n"); }
                    if (res.Signed)
                        Console.Error.WriteLine($"signature: {(res.SignatureValid == true ? "valid" : "INVALID")}, signer {res.SignerFingerprint}");
                    return 0;
                }
            }
            if (args[0] == "decode")
            {
                string? inp = null, outp = null, password = null;
                for (int i = 1; i < args.Length; i++)
                {
                    string Next()
                    {
                        if (i + 1 >= args.Length) throw new PrismException("missing value for " + args[i]);
                        return args[++i];
                    }
                    if (args[i] == "-o") outp = Next();
                    else if (args[i] == "--password") password = Next();
                    else if (inp == null) inp = args[i];
                    else { Usage(); return 2; }
                }
                if (inp == null) { Usage(); return 2; }
                var res = Prism.DecodePng(inp);
                if (PrismSecure.IsSecure(res.Bytes))
                {
                    var opened = PrismSecure.Open(res.Bytes, password);
                    if (opened.SignatureValid == false) { Console.Error.WriteLine("error: " + opened.Error); return 1; }
                    if (opened.Bytes == null) { Console.Error.WriteLine("error: " + (opened.Error ?? (opened.NeedsPassword ? "this code is locked; pass --password" : "cannot open"))); return 1; }
                    res.Bytes = opened.Bytes;
                    res.Type = (int)PrismType.Text;
                    if (opened.Signed)
                        Console.Error.WriteLine($"signature: valid, signer {opened.SignerFingerprint}{(opened.Trusted ? " (trusted)" : "")}");
                }
                if (outp != null)
                {
                    File.WriteAllBytes(outp, res.Bytes);
                    Console.WriteLine($"wrote {outp} ({res.Bytes.Length} payload bytes, {(res.Type == (int)PrismType.Text ? "text" : "binary")})");
                }
                else if (res.Type == (int)PrismType.Text)
                {
                    Console.OutputEncoding = new UTF8Encoding(false);
                    Console.Out.Write(new UTF8Encoding(false).GetString(res.Bytes) + "\n");
                }
                else
                {
                    Console.WriteLine($"({res.Bytes.Length} binary payload bytes; use -o OUT.bin to save)");
                }
                return 0;
            }
            if (args[0] == "parts-split")
            {
                string? inp = null, name = "file", outdir = null;
                int size = 3;
                for (int i = 1; i < args.Length; i++)
                {
                    string Next()
                    {
                        if (i + 1 >= args.Length) throw new PrismException("missing value for " + args[i]);
                        return args[++i];
                    }
                    if (args[i] == "--name") name = Next();
                    else if (args[i] == "--size") size = int.Parse(Next());
                    else if (args[i] == "-o") outdir = Next();
                    else if (inp == null) inp = args[i];
                    else { Usage(); return 2; }
                }
                if (inp == null || outdir == null) { Usage(); return 2; }
                var parts = PrismParts.Split(File.ReadAllBytes(inp), name, size);
                Directory.CreateDirectory(outdir);
                for (int i = 0; i < parts.Length; i++)
                    File.WriteAllBytes(Path.Combine(outdir, $"part-{i + 1:00}.bin"), parts[i]);
                Console.WriteLine($"{parts.Length} parts written to {outdir} (encode each at --ecc 2, color mode)");
                return 0;
            }
            if (args[0] == "parts-join")
            {
                string? outp = null;
                var asm = new PartsAssembler();
                for (int i = 1; i < args.Length; i++)
                {
                    if (args[i] == "-o") { outp = args[++i]; continue; }
                    var r = asm.Add(File.ReadAllBytes(args[i]));
                    if (r.Status == PartAddStatus.NotPart) { Console.Error.WriteLine($"error: {args[i]} is not a part"); return 1; }
                    if (r.Status == PartAddStatus.Bad || r.Status == PartAddStatus.OtherFile) { Console.Error.WriteLine("error: " + r.Message); return 1; }
                    if (r.Status != PartAddStatus.Duplicate)
                        Console.WriteLine($"part {r.N} of {asm.Total} added ({asm.Have}/{asm.Total})");
                }
                byte[] bytes;
                try { bytes = asm.Finish(); }
                catch (InvalidOperationException e) { Console.Error.WriteLine("error: " + e.Message); return 1; }
                outp ??= asm.ResultName;
                File.WriteAllBytes(outp, bytes);
                Console.WriteLine($"wrote {outp} ({bytes.Length} bytes, whole-file check passed)");
                return 0;
            }
            if (args[0] == "card-build")
            {
                if (args.Length < 2) { Usage(); return 2; }
                string kind = args[1], outp = null!;
                string ssid = "", sec = "WPA", pass = "", name = "", org = "", title = "",
                       phone = "", email = "", url = "", addr = "", note = "", text = "";
                long expiryMs = 0; bool hidden = false;
                for (int i = 2; i < args.Length; i++)
                {
                    string Next()
                    {
                        if (i + 1 >= args.Length) throw new PrismException("missing value for " + args[i]);
                        return args[++i];
                    }
                    switch (args[i])
                    {
                        case "-o": outp = Next(); break;
                        case "--ssid": ssid = Next(); break;
                        case "--sec": sec = Next(); break;
                        case "--pass": pass = Next(); break;
                        case "--hidden": hidden = true; break;
                        case "--name": name = Next(); break;
                        case "--org": org = Next(); break;
                        case "--title": title = Next(); break;
                        case "--phone": phone = Next(); break;
                        case "--email": email = Next(); break;
                        case "--url": url = Next(); break;
                        case "--addr": addr = Next(); break;
                        case "--note": note = Next(); break;
                        case "--expiry-ms": expiryMs = long.Parse(Next()); break;
                        case "--text": text = Next(); break;
                        default: Usage(); return 2;
                    }
                }
                string payload = kind switch
                {
                    "wifi" => PrismCards.WifiPayload(ssid, sec, pass, hidden),
                    "vcard" => PrismCards.VCardPayload(name, org, title, phone, email, url, addr, note),
                    "ticket" => PrismCards.TicketPayload(expiryMs, text),
                    _ => throw new PrismException("unknown card kind " + kind),
                };
                if (outp != null) { File.WriteAllText(outp, payload); Console.WriteLine($"wrote {outp} ({payload.Length} chars)"); }
                else Console.WriteLine(payload);
                return 0;
            }
            if (args[0] == "card-parse")
            {
                if (args.Length < 2) { Usage(); return 2; }
                string text = File.ReadAllText(args[1]);
                if (PrismCards.TryParseTicket(text, out var t))
                    Console.WriteLine($"ticket: expires {t.ExpiryMs}, body:\n{t.Body}");
                else if (PrismCards.TryParseWifi(text, out var w))
                    Console.WriteLine($"wifi: ssid \"{w.Ssid}\" security {w.Sec} password \"{w.Pass}\"{(w.Hidden ? " hidden" : "")}");
                else if (PrismCards.TryParseVCard(text, out var v))
                {
                    Console.WriteLine($"contact: {v.Name}{(v.Org.Length > 0 ? ", " + v.Org : "")}{(v.Title.Length > 0 ? " (" + v.Title + ")" : "")}");
                    foreach (var p in v.Phones) Console.WriteLine($"  phone: {p}");
                    foreach (var e in v.Emails) Console.WriteLine($"  email: {e}");
                    foreach (var u in v.Urls) Console.WriteLine($"  url: {u}");
                    if (v.Addr.Length > 0) Console.WriteLine($"  address: {v.Addr}");
                    if (v.Note.Length > 0) Console.WriteLine($"  note: {v.Note}");
                }
                else Console.WriteLine("not a card payload");
                return 0;
            }
            if (args[0] == "issuer")
            {
                string? inp = null, listPath = null;
                for (int i = 1; i < args.Length; i++)
                {
                    if (args[i] == "--list" && i + 1 < args.Length) listPath = args[++i];
                    else if (inp == null) inp = args[i];
                    else { Usage(); return 2; }
                }
                if (inp == null) { Usage(); return 2; }
                byte[] bytes = inp.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                    ? Prism.DecodePng(inp).Bytes
                    : File.ReadAllBytes(inp);
                var id = PrismIssuers.Identify(bytes);
                if (id == null) { Console.WriteLine("not a signed Prism Secure payload"); return 0; }
                if (!id.SignatureValid)
                    Console.WriteLine("Signature check failed. This code was changed after it was signed, or was not signed by the key it names.");
                else
                {
                    Console.Write($"signature: valid, signer {id.Fingerprint}");
                    if (listPath != null)
                    {
                        var hit = PrismIssuers.Find(PrismIssuers.Load(listPath), id.Fingerprint);
                        Console.Write(hit != null ? $", issuer: {hit.Name}" : " (not on the issuer list)");
                    }
                    Console.WriteLine();
                    if (id.Message != null) Console.WriteLine($"message: {id.Message}");
                    else if (id.Encrypted) Console.WriteLine("the content is locked with a password");
                }
                return 0;
            }
            Usage();
            return 2;
        }
        catch (PrismException e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
    }

    static PrismCode.PrismSigningKey LoadKey(string keyFile)
    {
        string json = File.ReadAllText(keyFile);
        string Get(string name)
        {
            string needle = "\"" + name + "\":\"";
            int i2 = json.IndexOf(needle, StringComparison.Ordinal);
            if (i2 < 0) throw new PrismCode.PrismException("bad key file");
            int j2 = json.IndexOf('"', i2 + needle.Length);
            return json.Substring(i2 + needle.Length, j2 - i2 - needle.Length);
        }
        string jwk = json.Substring(json.IndexOf("{\"crv\"", StringComparison.Ordinal));
        return new PrismCode.PrismSigningKey { PublicKey = Convert.FromHexString(Get("publicKeyHex")), PrivateJwk = jwk.TrimEnd('}', ' ', '\n', '\r') + "}" };
    }
}
