// Prism tickets and cards: Wi-Fi, contact card (vCard 3.0) and expiring
// ticket payload builders and parsers, payload-compatible with prism-cards.js.
package main

import (
	"fmt"
	"strings"
	"unicode"
)

// ------------------------------------------------------------- Wi-Fi

func escWifi(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if strings.IndexByte("\\;,:\"'", s[i]) >= 0 {
			b.WriteByte('\\')
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// WifiBuild builds the common WIFI: payload other readers agree on.
func WifiBuild(ssid, sec, pass string, hidden bool) string {
	t := sec
	if t == "" {
		t = "WPA"
	}
	var b strings.Builder
	b.WriteString("WIFI:T:")
	b.WriteString(t)
	b.WriteString(";S:")
	b.WriteString(escWifi(ssid))
	b.WriteString(";")
	if t != "nopass" {
		b.WriteString("P:")
		b.WriteString(escWifi(pass))
		b.WriteString(";")
	}
	if hidden {
		b.WriteString("H:true;")
	}
	b.WriteString(";")
	return b.String()
}

type WifiCard struct {
	SSID, Sec, Pass string
	Hidden          bool
}

func WifiParse(text string) (*WifiCard, bool) {
	if len(text) < 5 || !strings.EqualFold(text[:5], "WIFI:") {
		return nil, false
	}
	body := text[5:]
	out := &WifiCard{}
	var key, val []byte
	inKey := true
	haveSSID := false
	flush := func() {
		k := strings.ToUpper(string(key))
		v := string(val)
		switch k {
		case "S":
			out.SSID = v
			haveSSID = true
		case "T":
			out.Sec = strings.ToUpper(v)
		case "P":
			out.Pass = v
		case "H":
			out.Hidden = strings.EqualFold(v, "true")
		}
	}
	for i := 0; ; i++ {
		var c byte
		if i < len(body) {
			c = body[i]
		}
		doFlush := false
		if i >= len(body) {
			doFlush = true
		} else if c == '\\' && i+1 < len(body) {
			if inKey {
				key = append(key, body[i+1])
			} else {
				val = append(val, body[i+1])
			}
			i++
			continue
		} else if inKey && c == ':' {
			inKey = false
			continue
		} else if !inKey && c == ';' {
			doFlush = true
		} else if inKey {
			key = append(key, c)
		} else {
			val = append(val, c)
		}
		if doFlush {
			if len(key) > 0 {
				flush()
			}
			if i >= len(body) {
				break
			}
			key = key[:0]
			val = val[:0]
			inKey = true
		}
	}
	if !haveSSID {
		return nil, false
	}
	if out.Sec == "" {
		out.Sec = "WPA"
	}
	return out, true
}

// ------------------------------------------------------------- vCard

func escVcard(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\\' || c == ',' || c == ';' {
			b.WriteByte('\\')
		}
		if c == '\n' {
			b.WriteString("\\n")
			continue
		}
		b.WriteByte(c)
	}
	return b.String()
}

// VcardBuild builds a vCard 3.0 payload. Any field may be empty.
func VcardBuild(name, org, title, phone, email, url, addr, note string) string {
	var b strings.Builder
	b.WriteString("BEGIN:VCARD\r\nVERSION:3.0\r\n")
	b.WriteString("FN:" + escVcard(name) + "\r\n")
	if name != "" {
		t := strings.TrimSpace(name)
		words := strings.Fields(t)
		first := ""
		rest := "-"
		if len(words) > 0 {
			first = words[0]
		}
		if len(words) > 1 {
			rest = strings.Join(words[1:], " ")
		}
		b.WriteString("N:" + escVcard(rest) + ";" + escVcard(first) + ";;;\r\n")
	}
	if org != "" {
		b.WriteString("ORG:" + escVcard(org) + "\r\n")
	}
	if title != "" {
		b.WriteString("TITLE:" + escVcard(title) + "\r\n")
	}
	if phone != "" {
		b.WriteString("TEL;TYPE=CELL:" + escVcard(phone) + "\r\n")
	}
	if email != "" {
		b.WriteString("EMAIL:" + escVcard(email) + "\r\n")
	}
	if url != "" {
		b.WriteString("URL:" + escVcard(url) + "\r\n")
	}
	if addr != "" {
		b.WriteString("ADR;TYPE=WORK:;;" + escVcard(addr) + ";;;;\r\n")
	}
	if note != "" {
		b.WriteString("NOTE:" + escVcard(note) + "\r\n")
	}
	b.WriteString("END:VCARD")
	return b.String()
}

type Vcard struct {
	Name, Org, Title, Addr, Note string
	Phones, Emails, Urls         []string
}

func keyMatches(line, key string) (string, bool) {
	if len(line) < len(key) || !strings.EqualFold(line[:len(key)], key) {
		return "", false
	}
	p := line[len(key):]
	if strings.HasPrefix(p, ";") {
		idx := strings.IndexByte(p, ':')
		if idx < 0 {
			return "", false
		}
		p = p[idx:]
	}
	if !strings.HasPrefix(p, ":") {
		return "", false
	}
	return p[1:], true
}

func unescVcard(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			c := s[i+1]
			if c == 'n' || c == 'N' {
				b.WriteByte('\n')
				i++
				continue
			}
			if c == ',' || c == ';' || c == '\\' {
				b.WriteByte(c)
				i++
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func VcardParse(text string) (*Vcard, bool) {
	if !strings.Contains(text, "BEGIN:VCARD") {
		return nil, false
	}
	// unfold continuation lines, drop \r, split on \n
	var flat []byte
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c == '\r' {
			continue
		}
		if c == '\n' && i+1 < len(text) && (text[i+1] == ' ' || text[i+1] == '\t') {
			continue
		}
		flat = append(flat, c)
	}
	out := &Vcard{}
	foundFN := false
	for _, line := range strings.Split(string(flat), "\n") {
		if v, ok := keyMatches(line, "FN"); ok {
			out.Name = unescVcard(v)
			foundFN = true
		} else if v, ok := keyMatches(line, "ORG"); ok {
			out.Org = unescVcard(v)
		} else if v, ok := keyMatches(line, "TITLE"); ok {
			out.Title = unescVcard(v)
		} else if v, ok := keyMatches(line, "NOTE"); ok {
			out.Note = unescVcard(v)
		} else if v, ok := keyMatches(line, "ADR"); ok {
			tmp := unescVcard(v)
			tmp = strings.TrimLeft(tmp, ";")
			tmp = strings.TrimRight(tmp, ";")
			out.Addr = tmp
		} else if v, ok := keyMatches(line, "EMAIL"); ok && len(out.Emails) < 8 {
			out.Emails = append(out.Emails, unescVcard(v))
		} else if v, ok := keyMatches(line, "TEL"); ok && len(out.Phones) < 8 {
			out.Phones = append(out.Phones, unescVcard(v))
		} else if v, ok := keyMatches(line, "URL"); ok && len(out.Urls) < 8 {
			out.Urls = append(out.Urls, unescVcard(v))
		}
	}
	if !foundFN {
		return nil, false
	}
	return out, true
}

// ------------------------------------------------------------- ticket

// TicketBuild builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
func TicketBuild(expiryMs int64, text string) string {
	t := strings.TrimSpace(text)
	return fmt.Sprintf("PRISM-TICKET/1\nEXP:%d\n%s", expiryMs/1000, t)
}

type Ticket struct {
	ExpiryMs int64
	Body     string
}

func TicketParse(text string) (*Ticket, bool) {
	const prefix = "PRISM-TICKET/1\nEXP:"
	if !strings.HasPrefix(text, prefix) {
		return nil, false
	}
	p := text[len(prefix):]
	if p == "" || p[0] < '0' || p[0] > '9' {
		return nil, false
	}
	exp := int64(0)
	i := 0
	for i < len(p) && p[i] >= '0' && p[i] <= '9' {
		exp = exp*10 + int64(p[i]-'0')
		i++
	}
	if i >= len(p) || p[i] != '\n' {
		return nil, false
	}
	body := strings.TrimRightFunc(p[i+1:], unicode.IsSpace)
	return &Ticket{ExpiryMs: exp * 1000, Body: body}, true
}

// CardDetect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
func CardDetect(text string) int {
	if text == "" {
		return 0
	}
	if _, ok := TicketParse(text); ok {
		return 1
	}
	if _, ok := WifiParse(text); ok {
		return 2
	}
	if _, ok := VcardParse(text); ok {
		return 3
	}
	return 0
}
