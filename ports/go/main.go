// Prism Code CLI (Go port): encode / decode clean Prism Code PNGs.
package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

func arg(a []string, name, dflt string) string {
	for i := 0; i < len(a)-1; i++ {
		if a[i] == "--"+name || a[i] == "-"+name {
			return a[i+1]
		}
	}
	return dflt
}

func hasArg(a []string, name string) bool {
	for _, s := range a {
		if s == "--"+name {
			return true
		}
	}
	return false
}

func atoiOr(s string, d int) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return v
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]
       prism decode I.png [--out O]
       prism capacity`)
	os.Exit(2)
}

func main() {
	a := os.Args[1:]
	if len(a) == 0 {
		usage()
	}
	switch a[0] {
	case "encode":
		text := arg(a, "text", "")
		input := arg(a, "input", "")
		if text == "" && input == "" {
			fatal("need --text or --input")
		}
		var payload []byte
		var err error
		if text != "" {
			payload = []byte(text)
		} else {
			payload, err = os.ReadFile(input)
			if err != nil {
				fatal(err.Error())
			}
		}
		size := atoiOr(arg(a, "size", "-1"), -1)
		ecc := atoiOr(arg(a, "ecc", "1"), 1)
		modeS := arg(a, "mode", "0")
		mode := 0
		if modeS == "1" || modeS == "bw" {
			mode = 1
		}
		radius := atoiOr(arg(a, "radius", "12"), 12)
		typ := atoiOr(arg(a, "type", "0"), 0)
		logo := atoiOr(arg(a, "logo", "0"), 0)
		out := arg(a, "out", "")
		if out == "" {
			fatal("need --out")
		}
		png, code, err := EncodePNG(payload, radius, size, ecc, mode, typ, logo)
		if err != nil {
			fatal(err.Error())
		}
		if err := os.WriteFile(out, png, 0644); err != nil {
			fatal(err.Error())
		}
		if sj := arg(a, "symbols", ""); sj != "" {
			writeSymbolsJSON(sj, code)
		}
		w, h, _, _ := ReadPNG(png)
		fmt.Printf("wrote %s (%dx%d px, grid %dx%d cells, size %d, %s, ecc %d, %d payload bytes)\n",
			out, w, h, code.Lay.C, code.Lay.R, code.size, modeName(mode), ecc, len(payload))
		fmt.Printf("capacity at these settings: %d payload bytes\n", code.Cap.payload)
	case "decode":
		if len(a) < 2 {
			usage()
		}
		pngPath := a[1]
		buf, err := os.ReadFile(pngPath)
		if err != nil {
			fatal(err.Error())
		}
		payload, hdr, err := DecodePNG(buf)
		if err != nil {
			fatal(err.Error())
		}
		if out := arg(a, "out", ""); out != "" {
			if err := os.WriteFile(out, payload, 0644); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s (%d bytes)\n", out, len(payload))
		} else {
			os.Stdout.Write(payload)
			if len(payload) > 0 {
				os.Stdout.Write([]byte("\n"))
			}
		}
		fmt.Fprintf(os.Stderr, "header: size %d, ecc %d, mode %s, type %d, %d payload bytes, CRC-32 OK\n",
			hdr.Size, hdr.Ecc, modeName(hdr.Mode), hdr.Type, hdr.Length)
	case "secure-genkey":
		priv, pub, err := SecureGenerateSigningKey()
		if err != nil {
			fatal(err.Error())
		}
		fmt.Printf("fingerprint: %s\n", secureFingerprint(pub))
		if out := arg(a, "o", ""); out != "" {
			if err := saveKey(out, priv, pub); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s\n", out)
		}
	case "secure-seal":
		in := positional(a)
		if in == "" {
			usage()
		}
		data, err := os.ReadFile(in)
		if err != nil {
			fatal(err.Error())
		}
		var priv, pub []byte
		if keyf := arg(a, "sign-key", ""); keyf != "" {
			priv, pub, err = loadKey(keyf)
			if err != nil {
				fatal("bad key file " + keyf)
			}
		}
		sealed, err := SecureSeal(data, arg(a, "password", ""), arg(a, "kdf", "argon2id"), priv, pub)
		if err != nil {
			fatal("sealing failed (need --password and/or --sign-key)")
		}
		if out := arg(a, "o", ""); out != "" {
			if err := os.WriteFile(out, sealed, 0644); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s (%d -> %d bytes)\n", out, len(data), len(sealed))
		} else {
			os.Stdout.Write(sealed)
		}
	case "secure-open":
		in := positional(a)
		if in == "" {
			usage()
		}
		data, err := os.ReadFile(in)
		if err != nil {
			fatal(err.Error())
		}
		r := SecureOpen(data, arg(a, "password", ""), nil)
		if r.SignatureValid == 0 {
			fatal(r.Err)
		}
		if r.Bytes == nil {
			if r.Err != "" {
				fatal(r.Err)
			}
			fatal("needs a password")
		}
		if r.Signed {
			fmt.Fprintf(os.Stderr, "signature: valid, signer %s\n", r.SignerFingerprint)
		}
		if out := arg(a, "o", ""); out != "" {
			if err := os.WriteFile(out, r.Bytes, 0644); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s (%d bytes)\n", out, len(r.Bytes))
		} else {
			os.Stdout.Write(r.Bytes)
			os.Stdout.Write([]byte("\n"))
		}
	case "secure-passphrase":
		p, err := SecureGeneratePassphrase()
		if err != nil {
			fatal(err.Error())
		}
		fmt.Println(p)
	case "secure-strength":
		pw := arg(a, "password", "")
		if pw == "" {
			pw = positional(a)
		}
		bits, level, label := SecureStrength(pw)
		fmt.Printf("%d bits, level %d (%s)\n", bits, level, label)
	case "parts-split":
		in := positional(a)
		outdir := arg(a, "o", "")
		if in == "" || outdir == "" {
			usage()
		}
		name := arg(a, "name", "file")
		size := atoiOr(arg(a, "size", "3"), 3)
		data, err := os.ReadFile(in)
		if err != nil {
			fatal(err.Error())
		}
		parts, err := PartsSplitFile(data, name, size)
		if err != nil {
			fatal(err.Error())
		}
		os.MkdirAll(outdir, 0755)
		for i, p := range parts {
			path := fmt.Sprintf("%s/part-%02d.bin", outdir, i+1)
			if err := os.WriteFile(path, p, 0644); err != nil {
				fatal(err.Error())
			}
		}
		fmt.Printf("%d parts written to %s (encode each at --ecc 2, color mode)\n", len(parts), outdir)
	case "parts-join":
		var asm Assembler
		out := arg(a, "o", "")
		nfiles := 0
		for i := 1; i < len(a); i++ {
			if a[i] == "-o" || a[i] == "--o" {
				i++
				continue
			}
			data, err := os.ReadFile(a[i])
			if err != nil {
				fatal("cannot read " + a[i])
			}
			nfiles++
			st, pn, msg := asm.Add(data)
			switch st {
			case PartNotPart:
				fatal(a[i] + " is not a part")
			case PartBad, PartOther:
				fatal(msg)
			case PartDuplicate:
			default:
				fmt.Printf("part %d of %d added (%d/%d)\n", pn, asm.Total, asm.Have, asm.Total)
			}
		}
		if nfiles == 0 {
			usage()
		}
		res, name, err := asm.Finish()
		if err != nil {
			fatal(err.Error())
		}
		if out == "" {
			out = name
		}
		if err := os.WriteFile(out, res, 0644); err != nil {
			fatal(err.Error())
		}
		fmt.Printf("wrote %s (%d bytes, whole-file check passed)\n", out, len(res))
	case "card-build":
		if len(a) < 2 {
			usage()
		}
		kind := a[1]
		hidden := hasArg(a, "hidden")
		var payload string
		switch kind {
		case "wifi":
			payload = WifiBuild(arg(a, "ssid", ""), arg(a, "sec", "WPA"), arg(a, "pass", ""), hidden)
		case "vcard":
			payload = VcardBuild(arg(a, "name", ""), arg(a, "org", ""), arg(a, "title", ""),
				arg(a, "phone", ""), arg(a, "email", ""), arg(a, "url", ""), arg(a, "addr", ""), arg(a, "note", ""))
		case "ticket":
			expMs, _ := strconv.ParseInt(arg(a, "expiry-ms", "0"), 10, 64)
			payload = TicketBuild(expMs, arg(a, "text", ""))
		default:
			usage()
		}
		if out := arg(a, "o", ""); out != "" {
			if err := os.WriteFile(out, []byte(payload), 0644); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s (%d bytes)\n", out, len(payload))
		} else {
			fmt.Println(payload)
		}
	case "card-parse":
		if len(a) < 2 {
			usage()
		}
		data, err := os.ReadFile(a[1])
		if err != nil {
			fatal(err.Error())
		}
		text := string(data)
		if t, ok := TicketParse(text); ok {
			fmt.Printf("ticket: expires %d, body:\n%s\n", t.ExpiryMs, t.Body)
		} else if w, ok := WifiParse(text); ok {
			h := ""
			if w.Hidden {
				h = " hidden"
			}
			fmt.Printf("wifi: ssid %q security %s password %q%s\n", w.SSID, w.Sec, w.Pass, h)
		} else if v, ok := VcardParse(text); ok {
			fmt.Printf("contact: %s", v.Name)
			if v.Org != "" {
				fmt.Printf(", %s", v.Org)
			}
			if v.Title != "" {
				fmt.Printf(" (%s)", v.Title)
			}
			fmt.Println()
			for _, p := range v.Phones {
				fmt.Printf("  phone: %s\n", p)
			}
			for _, e := range v.Emails {
				fmt.Printf("  email: %s\n", e)
			}
			for _, u := range v.Urls {
				fmt.Printf("  url: %s\n", u)
			}
			if v.Addr != "" {
				fmt.Printf("  address: %s\n", v.Addr)
			}
			if v.Note != "" {
				fmt.Printf("  note: %s\n", v.Note)
			}
		} else {
			fmt.Println("not a card payload")
		}
	case "issuer":
		in := positional(a)
		if in == "" {
			usage()
		}
		data, err := os.ReadFile(in)
		if err != nil {
			fatal(err.Error())
		}
		if len(data) > 8 && data[0] == 0x89 && data[1] == 'P' && data[2] == 'N' && data[3] == 'G' {
			dec, _, err := DecodePNG(data)
			if err != nil {
				fatal(err.Error())
			}
			data = dec
		}
		id, ok := IssuerIdentify(data)
		if !ok {
			fmt.Println("not a signed Prism Secure payload")
			break
		}
		if !id.SignatureValid {
			fmt.Println("Signature check failed. This code was changed after it was signed, or was not signed by the key it names.")
		} else {
			fmt.Printf("signature: valid, signer %s", id.Fingerprint)
			if lp := arg(a, "list", ""); lp != "" {
				list := IssuersLoad(lp)
				if hit := IssuersFind(list, id.Fingerprint); hit != nil {
					fmt.Printf(", issuer: %s", hit.Name)
				} else {
					fmt.Printf(" (not on the issuer list)")
				}
			}
			fmt.Println()
			if id.HasMessage {
				fmt.Printf("message: %s\n", id.Message)
			} else if id.Encrypted {
				fmt.Println("the content is locked with a password")
			}
		}
	case "capacity":
		for s := 0; s < 6; s++ {
			for ecc := 0; ecc < 4; ecc++ {
				for mode := 0; mode < 2; mode++ {
					cp, _ := capacity(s, ecc, mode)
					fmt.Printf("size %d (%dx%d) ecc %d %s: %d payload bytes\n",
						s, SIZES[s].C, SIZES[s].R, ecc, modeName(mode), cp.payload)
				}
			}
		}
	default:
		usage()
	}
}

// positional returns the first argument that is not a flag or a flag value.
func positional(a []string) string {
	skip := false
	for i, s := range a {
		if i == 0 {
			continue
		}
		if skip {
			skip = false
			continue
		}
		if len(s) > 0 && (s[0] == '-') {
			skip = true
			continue
		}
		return s
	}
	return ""
}

type keyFile struct {
	PublicKeyHex string `json:"publicKeyHex"`
	PrivateJwk   struct {
		Crv string `json:"crv"`
		D   string `json:"d"`
		Kty string `json:"kty"`
		X   string `json:"x"`
		Y   string `json:"y"`
	} `json:"privateJwk"`
}

func saveKey(path string, priv, pub []byte) error {
	var kf keyFile
	kf.PublicKeyHex = hex.EncodeToString(pub)
	kf.PrivateJwk.Crv = "P-256"
	kf.PrivateJwk.Kty = "EC"
	b64 := base64.RawURLEncoding.EncodeToString
	kf.PrivateJwk.D = b64(priv)
	kf.PrivateJwk.X = b64(pub[1:33])
	kf.PrivateJwk.Y = b64(pub[33:65])
	data, err := json.Marshal(kf)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0600)
}

func loadKey(path string) (priv, pub []byte, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var kf keyFile
	if err := json.Unmarshal(data, &kf); err != nil {
		return nil, nil, err
	}
	pub, err = hex.DecodeString(kf.PublicKeyHex)
	if err != nil || len(pub) != 65 {
		return nil, nil, fmt.Errorf("bad public key")
	}
	priv, err = base64.RawURLEncoding.DecodeString(kf.PrivateJwk.D)
	if err != nil || len(priv) != 32 {
		return nil, nil, fmt.Errorf("bad private key")
	}
	return priv, pub, nil
}

func modeName(m int) string {
	if m == 0 {
		return "color"
	}
	return "bw"
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}

func writeSymbolsJSON(path string, code *Code) {
	f, err := os.Create(path)
	if err != nil {
		fatal(err.Error())
	}
	defer f.Close()
	fmt.Fprintf(f, "{\"size\":%d,\"ecc\":%d,\"mode\":%d,\"C\":%d,\"R\":%d,\"symbols\":[",
		code.size, code.ecc, code.mode, code.Lay.C, code.Lay.R)
	for i, s := range code.Symbols {
		if i > 0 {
			f.WriteString(",")
		}
		fmt.Fprintf(f, "%d", s)
	}
	f.WriteString("]}")
}
