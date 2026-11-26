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
            "  prism decode IN.png [-o OUT.bin]\n" +
            "  prism capacity\n" +
            "\n" +
            "Encode options:\n" +
            "  --size N       0..5, or -1 automatic (default -1)\n" +
            "  --ecc N        0..3 = 10/20/30/40% repair data (default 1 = 20%)\n" +
            "  --mode M       color | bw (default color; bw holds ~1/3)\n" +
            "  --type T       text | binary (default: text for --text, binary for --file)\n" +
            "  --scale N      PNG pixels per cell unit (default 12; live site uses 8/12/20/32)\n" +
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
                string? text = null, file = null, outp = null;
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
                Prism.EncodePng(data, outp, size, ecc, mode, (PrismType)type, scale);
                Console.WriteLine($"wrote {outp} ({data.Length} payload bytes)");
                return 0;
            }
            if (args[0] == "decode")
            {
                string? inp = null, outp = null;
                for (int i = 1; i < args.Length; i++)
                {
                    if (args[i] == "-o" && i + 1 < args.Length) outp = args[++i];
                    else if (inp == null) inp = args[i];
                    else { Usage(); return 2; }
                }
                if (inp == null) { Usage(); return 2; }
                var res = Prism.DecodePng(inp);
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
            Usage();
            return 2;
        }
        catch (PrismException e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
    }
}
