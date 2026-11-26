/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism tickets and cards: Wi-Fi, contact card (vCard 3.0) and expiring
 * ticket payload builders and parsers, compatible with prism-cards.js. */
using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;

namespace PrismCode
{
    public sealed class WifiCard
    {
        public string Ssid = "";
        public string Sec = "WPA";
        public string Pass = "";
        public bool Hidden;
    }

    public sealed class VCard
    {
        public string Name = "", Org = "", Title = "", Addr = "", Note = "";
        public List<string> Phones = new(), Emails = new(), Urls = new();
    }

    public sealed class TicketCard
    {
        public long ExpiryMs;
        public string Body = "";
    }

    public enum CardKind { None, Ticket, Wifi, VCard }

    public static class PrismCards
    {
        /* ---------- Wi-Fi ---------- */

        static string EscWifi(string s) => Regex.Replace(s, "([\\\\;,:\"'])", "\\$1");

        public static string WifiPayload(string ssid, string sec = "WPA", string pass = "", bool hidden = false)
        {
            string t = string.IsNullOrEmpty(sec) ? "WPA" : sec;
            var sb = new StringBuilder();
            sb.Append("WIFI:T:").Append(t).Append(";S:").Append(EscWifi(ssid ?? "")).Append(';');
            if (t != "nopass") sb.Append("P:").Append(EscWifi(pass ?? "")).Append(';');
            if (hidden) sb.Append("H:true;");
            sb.Append(';');
            return sb.ToString();
        }

        public static bool TryParseWifi(string text, out WifiCard card)
        {
            card = null!;
            if (text == null || !text.StartsWith("WIFI:", StringComparison.OrdinalIgnoreCase)) return false;
            string body = text.Substring(5);
            var fields = new Dictionary<string, string>();
            var key = new StringBuilder();
            var val = new StringBuilder();
            bool inKey = true;
            void Push()
            {
                if (key.Length > 0) fields[key.ToString().ToUpperInvariant()] = val.ToString();
                key.Clear(); val.Clear(); inKey = true;
            }
            for (int i = 0; i < body.Length;)
            {
                char c = body[i];
                if (c == '\\' && i + 1 < body.Length)
                {
                    (inKey ? key : val).Append(body[i + 1]);
                    i += 2;
                    continue;
                }
                if (inKey && c == ':') { inKey = false; i++; continue; }
                if (!inKey && c == ';') { Push(); i++; continue; }
                (inKey ? key : val).Append(c);
                i++;
            }
            Push();
            if (!fields.TryGetValue("S", out string? ssid)) return false;
            card = new WifiCard
            {
                Ssid = ssid,
                Sec = (fields.TryGetValue("T", out string? t) ? t : "WPA").ToUpperInvariant(),
                Pass = fields.TryGetValue("P", out string? p) ? p : "",
                Hidden = string.Equals(fields.TryGetValue("H", out string? h) ? h : "", "true", StringComparison.OrdinalIgnoreCase),
            };
            return true;
        }

        /* ---------- vCard ---------- */

        static string EscV(string s) => s.Replace("\\", "\\\\").Replace("\n", "\\n").Replace(",", "\\,").Replace(";", "\\;");

        public static string VCardPayload(string name, string org = "", string title = "",
            string phone = "", string email = "", string url = "", string addr = "", string note = "")
        {
            var lines = new List<string> { "BEGIN:VCARD", "VERSION:3.0" };
            lines.Add("FN:" + EscV(name ?? ""));
            if (!string.IsNullOrEmpty(name))
            {
                var words = Regex.Split(name.Trim(), @"\s+", RegexOptions.None);
                string rest = words.Length > 1 ? string.Join(" ", words, 1, words.Length - 1) : "-";
                lines.Add("N:" + EscV(rest) + ";" + EscV(words[0]) + ";;;");
            }
            if (!string.IsNullOrEmpty(org)) lines.Add("ORG:" + EscV(org));
            if (!string.IsNullOrEmpty(title)) lines.Add("TITLE:" + EscV(title));
            if (!string.IsNullOrEmpty(phone)) lines.Add("TEL;TYPE=CELL:" + EscV(phone));
            if (!string.IsNullOrEmpty(email)) lines.Add("EMAIL:" + EscV(email));
            if (!string.IsNullOrEmpty(url)) lines.Add("URL:" + EscV(url));
            if (!string.IsNullOrEmpty(addr)) lines.Add("ADR;TYPE=WORK:;;" + EscV(addr) + ";;;;");
            if (!string.IsNullOrEmpty(note)) lines.Add("NOTE:" + EscV(note));
            lines.Add("END:VCARD");
            return string.Join("\r\n", lines);
        }

        static string UnescV(string s) =>
            Regex.Replace(s.Replace("\\n", "\n").Replace("\\N", "\n"), "\\\\([,;\\\\])", "$1");

        public static bool TryParseVCard(string text, out VCard card)
        {
            card = null!;
            if (text == null || text.IndexOf("BEGIN:VCARD", StringComparison.OrdinalIgnoreCase) < 0) return false;
            string unfolded = Regex.Replace(text.Replace("\r\n", "\n").Replace("\r", "\n"), "\n[ \t]", "");
            string[] lines = unfolded.Split('\n');
            string Get(string k)
            {
                var re = new Regex("^" + k + "(;[^:]*)?:(.*)$", RegexOptions.IgnoreCase);
                foreach (var l in lines)
                {
                    var m = re.Match(l);
                    if (m.Success) return UnescV(m.Groups[2].Value);
                }
                return "";
            }
            string name = Get("FN");
            if (name.Length == 0) return false;
            card = new VCard { Name = name, Org = Get("ORG"), Title = Get("TITLE"), Note = Get("NOTE") };
            card.Addr = Get("ADR").TrimStart(';').TrimEnd(';');
            foreach (var l in lines)
            {
                Match m;
                if ((m = Regex.Match(l, "^EMAIL(;[^:]*)?:(.*)$", RegexOptions.IgnoreCase)).Success) card.Emails.Add(m.Groups[2].Value);
                else if ((m = Regex.Match(l, "^TEL(;[^:]*)?:(.*)$", RegexOptions.IgnoreCase)).Success) card.Phones.Add(m.Groups[2].Value);
                else if ((m = Regex.Match(l, "^URL(;[^:]*)?:(.*)$", RegexOptions.IgnoreCase)).Success) card.Urls.Add(m.Groups[2].Value);
            }
            return true;
        }

        /* ---------- ticket ---------- */

        public static string TicketPayload(long expiryMs, string text) =>
            "PRISM-TICKET/1\nEXP:" + (expiryMs / 1000) + "\n" + (text ?? "").Trim();

        public static bool TryParseTicket(string text, out TicketCard card)
        {
            card = null!;
            if (text == null) return false;
            var m = Regex.Match(text, "^PRISM-TICKET/1\nEXP:(\\d+)\n([\\s\\S]*)$");
            if (!m.Success) return false;
            card = new TicketCard { ExpiryMs = long.Parse(m.Groups[1].Value) * 1000, Body = m.Groups[2].Value.Trim() };
            return true;
        }

        public static CardKind Detect(string text)
        {
            if (string.IsNullOrEmpty(text)) return CardKind.None;
            if (TryParseTicket(text, out _)) return CardKind.Ticket;
            if (TryParseWifi(text, out _)) return CardKind.Wifi;
            if (TryParseVCard(text, out _)) return CardKind.VCard;
            return CardKind.None;
        }
    }
}
