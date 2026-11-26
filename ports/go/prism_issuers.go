// Prism verified issuers: identify signed Prism Secure payloads and look the
// signer up in an issuer list, same semantics as prism-issuers.js.
package main

import (
	"encoding/json"
	"os"
	"strings"
	"unicode/utf8"
)

type IssuerID struct {
	SignatureValid bool
	Fingerprint    string
	Encrypted      bool
	Message        string // decoded text for valid, unencrypted signed payloads
	HasMessage     bool
}

// IssuerIdentify inspects decoded payload bytes. ok=false for plain or
// unsigned payloads. Never decrypts.
func IssuerIdentify(b []byte) (*IssuerID, bool) {
	if len(b) < 5+65+64 {
		return nil, false
	}
	if b[0] != 'P' || b[1] != 'S' || b[2] != 'C' {
		return nil, false
	}
	if b[3] != 1 && b[3] != 2 {
		return nil, false
	}
	if b[4]&2 == 0 {
		return nil, false
	}
	end := len(b)
	pub := b[end-129 : end-64]
	sig := b[end-64 : end]
	body := b[:end-129]
	out := &IssuerID{}
	out.SignatureValid = p256Verify(pub, body, sig)
	out.Encrypted = b[4]&1 != 0
	out.Fingerprint = secureFingerprint(pub)
	if out.SignatureValid && !out.Encrypted && len(body) >= 5 {
		if utf8.Valid(body[5:]) {
			out.Message = string(body[5:])
			out.HasMessage = true
		}
	}
	return out, true
}

type Issuer struct {
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

// IssuersLoad loads an issuers.json file ({"issuers":[{name, fingerprint}]}).
func IssuersLoad(path string) []Issuer {
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 1<<20 {
		return nil
	}
	var doc struct {
		Issuers []Issuer `json:"issuers"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return nil
	}
	return doc.Issuers
}

func normFp(in string) string {
	var b strings.Builder
	for i := 0; i < len(in) && b.Len() < 15; i++ {
		c := in[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') {
			b.WriteByte(strings.ToUpper(string(c))[0])
		}
	}
	return b.String()
}

// IssuersFind: normalized fingerprint match (case-insensitive, separators ignored).
func IssuersFind(list []Issuer, fingerprint string) *Issuer {
	want := normFp(fingerprint)
	for i := range list {
		if normFp(list[i].Fingerprint) == want {
			return &list[i]
		}
	}
	return nil
}
