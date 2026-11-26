// Prism Secure (envelope v2, reads v1): AES-256-GCM payload locking with
// Argon2id (128 MiB, 3 passes) or PBKDF2-SHA256 (600,000 rounds), and
// ECDSA P-256 / SHA-256 signing with RFC 6979 deterministic nonces and
// P1363 r||s signatures, byte-compatible with the live site's
// prism-secure.html JS. See that file for the format spec.
//
// Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
// normalization first; this port does not ship a Unicode normalizer, so
// non-ASCII passwords should already be in composed (NFC) form. ASCII
// passwords are unaffected.
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/pbkdf2"
)

const (
	secureArgon2Mem  = 131072
	secureArgon2T    = 3
	secureArgon2P    = 1
	securePBKDF2Iter = 600000

	flagEnc = 1
	flagSig = 2
	head2   = 4 + 1 + 1 + 6 + 16 + 12
	head1   = 4 + 1 + 16 + 12 + 4
)

var secureMagic = []byte{'P', 'S', 'C'}

func be32w(b []byte, n uint32) { binary.BigEndian.PutUint32(b, n) }
func be32r(b []byte) uint32    { return binary.BigEndian.Uint32(b) }

// ------------------------------------------------------------- crypto pieces

func pbkdf2SHA256(pw, salt []byte, iter, keyLen int) []byte {
	return pbkdf2.Key(pw, salt, iter, keyLen, sha256.New)
}

func argon2idKey(pw, salt []byte, memKiB, t, lanes uint32, keyLen int) ([]byte, error) {
	if memKiB < 8192 || memKiB > 262144 || t < 1 || t > 12 || lanes < 1 || lanes > 4 {
		return nil, errors.New("argon2id parameters out of range")
	}
	return argon2.IDKey(pw, salt, t, memKiB, uint8(lanes), uint32(keyLen)), nil
}

func aes256gcmEncrypt(key, iv, aad, plaintext []byte) (ct, tag []byte, err error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, nil, err
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, nil, err
	}
	sealed := g.Seal(nil, iv, plaintext, aad)
	return sealed[:len(plaintext)], sealed[len(plaintext):], nil
}

func aes256gcmDecrypt(key, iv, aad, ct, tag []byte) ([]byte, bool) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, false
	}
	g, err := cipher.NewGCM(block)
	if err != nil {
		return nil, false
	}
	buf := make([]byte, 0, len(ct)+16)
	buf = append(buf, ct...)
	buf = append(buf, tag...)
	pt, err := g.Open(nil, iv, buf, aad)
	if err != nil {
		return nil, false
	}
	return pt, true
}

// ------------------------------------------------------------- P-256 / RFC 6979

var (
	p256N     = elliptic.P256().Params().N
	p256HalfN = new(big.Int).Rsh(new(big.Int).Set(p256N), 1)
)

// rfc6979K derives the deterministic nonce exactly like the C reference:
// HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
func rfc6979K(priv, hash []byte) *big.Int {
	v := make([]byte, 32)
	for i := range v {
		v[i] = 1
	}
	k := make([]byte, 32) // zeros
	bx := append(append([]byte{}, priv...), hash...)
	hmacHash := func(key, data []byte) []byte {
		h := hmac.New(sha256.New, key)
		h.Write(data)
		return h.Sum(nil)
	}
	buf := append(append([]byte{}, v...), 0x00)
	buf = append(buf, bx...)
	k = hmacHash(k, buf)
	v = hmacHash(k, v)
	buf = append(append([]byte{}, v...), 0x01)
	buf = append(buf, bx...)
	k = hmacHash(k, buf)
	v = hmacHash(k, v)
	for {
		v = hmacHash(k, v)
		kk := new(big.Int).SetBytes(v)
		if kk.Sign() != 0 && kk.Cmp(p256N) < 0 {
			return kk
		}
		buf := append(append([]byte{}, v...), 0x00)
		k = hmacHash(k, buf)
		v = hmacHash(k, v)
	}
}

// p256Sign produces a deterministic P1363 r||s signature, low-s normalized.
func p256Sign(priv, msg []byte) [64]byte {
	var sig [64]byte
	hash := sha256.Sum256(msg)
	d := new(big.Int).SetBytes(priv)
	e := new(big.Int).SetBytes(hash[:])
	if e.Cmp(p256N) >= 0 {
		e.Sub(e, p256N)
	}
	for {
		k := rfc6979K(priv, hash[:])
		x, _ := elliptic.P256().ScalarBaseMult(k.Bytes())
		r := new(big.Int).Mod(x, p256N)
		if r.Sign() == 0 {
			continue
		}
		kinv := new(big.Int).ModInverse(k, p256N)
		s := new(big.Int).Mul(d, r)
		s.Add(s, e)
		s.Mul(s, kinv)
		s.Mod(s, p256N)
		if s.Sign() == 0 {
			continue
		}
		if s.Cmp(p256HalfN) > 0 {
			s.Sub(p256N, s)
		}
		rb, sb := r.Bytes(), s.Bytes()
		copy(sig[32-len(rb):32], rb)
		copy(sig[64-len(sb):], sb)
		return sig
	}
}

func p256Verify(pub, msg, sig []byte) bool {
	if len(pub) != 65 || pub[0] != 4 || len(sig) != 64 {
		return false
	}
	x := new(big.Int).SetBytes(pub[1:33])
	y := new(big.Int).SetBytes(pub[33:65])
	if !elliptic.P256().IsOnCurve(x, y) {
		return false
	}
	hash := sha256.Sum256(msg)
	e := new(big.Int).SetBytes(hash[:])
	if e.Cmp(p256N) >= 0 {
		e.Sub(e, p256N)
	}
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if r.Sign() <= 0 || r.Cmp(p256N) >= 0 || s.Sign() <= 0 || s.Cmp(p256N) >= 0 {
		return false
	}
	w := new(big.Int).ModInverse(s, p256N)
	if w == nil {
		return false
	}
	u1 := new(big.Int).Mul(e, w)
	u1.Mod(u1, p256N)
	u2 := new(big.Int).Mul(r, w)
	u2.Mod(u2, p256N)
	x1, y1 := elliptic.P256().ScalarBaseMult(u1.Bytes())
	x2, y2 := elliptic.P256().ScalarMult(x, y, u2.Bytes())
	x3, _ := elliptic.P256().Add(x1, y1, x2, y2)
	if x3 == nil {
		return false
	}
	x3.Mod(x3, p256N)
	return x3.Cmp(r) == 0
}

func p256Keygen(priv []byte) []byte {
	x, y := elliptic.P256().ScalarBaseMult(priv)
	pub := make([]byte, 65)
	pub[0] = 4
	xb, yb := x.Bytes(), y.Bytes()
	copy(pub[33-len(xb):33], xb)
	copy(pub[65-len(yb):], yb)
	return pub
}

// ------------------------------------------------------------- secure envelope

// Fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
func secureFingerprint(pub []byte) string {
	h := sha256.Sum256(pub)
	var sb strings.Builder
	for i := 0; i < 8; i++ {
		fmt.Fprintf(&sb, "%02X", h[i])
		if i%2 == 1 && i < 7 {
			sb.WriteByte('-')
		}
	}
	return sb.String()
}

// SecureGenerateSigningKey draws a non-zero 32-byte private key; returns priv, pub.
func SecureGenerateSigningKey() ([]byte, []byte, error) {
	for {
		priv := make([]byte, 32)
		if _, err := rand.Read(priv); err != nil {
			return nil, nil, err
		}
		nz := false
		for _, b := range priv {
			if b != 0 {
				nz = true
				break
			}
		}
		if nz {
			return priv, p256Keygen(priv), nil
		}
	}
}

func deriveKey(password string, salt []byte, kdf int, iter, mem uint32, t, lanes int) ([]byte, error) {
	pw := []byte(password)
	if kdf == 2 {
		return argon2idKey(pw, salt, mem, uint32(t), uint32(lanes), 32)
	}
	return pbkdf2SHA256(pw, salt, int(iter), 32), nil
}

// SecureSeal locks (password != "", kdf "argon2id"|"pbkdf2") and/or signs
// (priv != nil) data. At least one of the two.
func SecureSeal(data []byte, password, kdf string, priv, pub []byte) ([]byte, error) {
	if password == "" && priv == nil {
		return nil, errors.New("need a password, a signing key, or both")
	}
	useA := kdf == "" || kdf == "argon2id"
	flags := 0
	if password != "" {
		flags |= flagEnc
	}
	if priv != nil {
		flags |= flagSig
	}
	var body []byte
	if password != "" {
		salt := make([]byte, 16)
		iv := make([]byte, 12)
		if _, err := rand.Read(salt); err != nil {
			return nil, err
		}
		if _, err := rand.Read(iv); err != nil {
			return nil, err
		}
		body = make([]byte, head2, head2+len(data)+16)
		copy(body, secureMagic)
		body[3] = 2
		body[4] = byte(flags)
		if useA {
			body[5] = 2
			be32w(body[6:], secureArgon2Mem)
			body[10] = secureArgon2T
			body[11] = secureArgon2P
		} else {
			body[5] = 1
			be32w(body[6:], securePBKDF2Iter)
		}
		copy(body[12:], salt)
		copy(body[28:], iv)
		key, err := deriveKey(password, salt, map[bool]int{true: 2, false: 1}[useA],
			securePBKDF2Iter, secureArgon2Mem, secureArgon2T, secureArgon2P)
		if err != nil {
			return nil, err
		}
		ct, tag, err := aes256gcmEncrypt(key, iv, body[:head2], data)
		if err != nil {
			return nil, err
		}
		body = append(body, ct...)
		body = append(body, tag...)
	} else {
		body = make([]byte, 5, 5+len(data))
		copy(body, secureMagic)
		body[3] = 2
		body[4] = byte(flags)
		body = append(body, data...)
	}
	if priv == nil {
		return body, nil
	}
	sig := p256Sign(priv, body)
	full := make([]byte, 0, len(body)+129)
	full = append(full, body...)
	full = append(full, pub...)
	full = append(full, sig[:]...)
	return full, nil
}

func SecureIsSecure(b []byte) bool {
	return len(b) >= 6 && b[0] == 'P' && b[1] == 'S' && b[2] == 'C' &&
		(b[3] == 1 || b[3] == 2) && (b[4] & ^byte(3)) == 0
}

// SecureInspect reports whether the payload is encrypted / signed.
func SecureInspect(b []byte) (encrypted, signed bool) {
	if !SecureIsSecure(b) {
		return false, false
	}
	return b[4]&flagEnc != 0, b[4]&flagSig != 0
}

// SecureResult mirrors the C prism_secure_result.
type SecureResult struct {
	Secure             bool
	Version            int
	Encrypted, Signed  bool
	SignatureValid     int // -1 n/a, 0 invalid, 1 valid
	SignerFingerprint  string
	Trusted            bool
	Bytes              []byte
	NeedsPassword      bool
	Err                string
}

// SecureOpen opens a payload; plain input passes through. Errors are reported
// in Err with Bytes nil (wrong password / tamper / invalid signature), never
// a wrong payload.
func SecureOpen(b []byte, password string, trustedFps []string) *SecureResult {
	res := &SecureResult{SignatureValid: -1}
	if !SecureIsSecure(b) {
		res.Bytes = append([]byte{}, b...)
		return res
	}
	ver, flags := int(b[3]), b[4]
	encrypted := flags&flagEnc != 0
	sgn := flags&flagSig != 0
	res.Secure = true
	res.Version = ver
	res.Encrypted = encrypted
	res.Signed = sgn
	end := len(b)
	if sgn {
		if len(b) < 5+65+64 {
			res.Err = "Code is damaged"
			return res
		}
		pub := b[end-129 : end-64]
		sig := b[end-64 : end]
		if p256Verify(pub, b[:end-129], sig) {
			res.SignatureValid = 1
		} else {
			res.SignatureValid = 0
		}
		res.SignerFingerprint = secureFingerprint(pub)
		if res.SignatureValid == 1 && trustedFps != nil {
			for _, fp := range trustedFps {
				if fp == res.SignerFingerprint {
					res.Trusted = true
				}
			}
		}
		end -= 129
		if res.SignatureValid != 1 {
			res.Err = "Signature is not valid. This code was changed or forged."
			return res
		}
	}
	if !encrypted {
		res.Bytes = append([]byte{}, b[5:end]...)
		return res
	}
	var hl int
	var salt, iv []byte
	var kdf int
	var iter, mem uint32
	var t, lanes int
	if ver == 1 {
		hl = head1
		if end < hl+16 {
			res.Err = "Code is damaged"
			return res
		}
		salt = b[5:21]
		iv = b[21:33]
		kdf = 1
		iter = be32r(b[33:37])
	} else {
		hl = head2
		if end < hl+16 {
			res.Err = "Code is damaged"
			return res
		}
		kdf = int(b[5])
		salt = b[12:28]
		iv = b[28:40]
		if kdf == 2 {
			mem = be32r(b[6:10])
			t = int(b[10])
			lanes = int(b[11])
		} else {
			iter = be32r(b[6:10])
		}
	}
	if (kdf == 1 && (iter < 100000 || iter > 5000000)) ||
		(kdf == 2 && (mem < 8192 || mem > 262144 || t < 1 || t > 12 || lanes < 1 || lanes > 4)) ||
		(kdf != 1 && kdf != 2) {
		res.Err = "Code is damaged or unsupported"
		return res
	}
	if password == "" {
		res.NeedsPassword = true
		return res
	}
	key, err := deriveKey(password, salt, kdf, iter, mem, t, lanes)
	if err != nil {
		res.Err = "Key derivation failed"
		return res
	}
	pt, ok := aes256gcmDecrypt(key, iv, b[:hl], b[hl:end-16], b[end-16:end])
	if !ok {
		res.Err = "Wrong password, or the code was changed."
		return res
	}
	res.Bytes = pt
	return res
}

// SecureGeneratePassphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
func SecureGeneratePassphrase() (string, error) {
	const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	r := make([]byte, 28)
	if _, err := rand.Read(r); err != nil {
		return "", err
	}
	var sb strings.Builder
	for g := 0; g < 7; g++ {
		if g > 0 {
			sb.WriteByte('-')
		}
		for i := 0; i < 4; i++ {
			sb.WriteByte(alpha[r[g*4+i]&31])
		}
	}
	return sb.String(), nil
}

// SecureStrength estimates password strength; same heuristic as the site.
// Returns bits, level 0-4, label.
func SecureStrength(pw string) (int, int, string) {
	labels := []string{"weak", "weak", "fair", "good", "strong"}
	n := len(pw)
	if n == 0 {
		return 0, 0, "none"
	}
	// generated-passphrase shape
	{
		groups, ok, body := 1, true, 0
		for i := 0; i < n; i++ {
			c := pw[i]
			if c == '-' {
				groups++
				continue
			}
			if !(c >= 'A' && c <= 'Z' && c != 'I' && c != 'O') && !(c >= '2' && c <= '9') {
				ok = false
				break
			}
			body++
		}
		if groups >= 6 && ok && body >= 24 {
			return body * 5, 4, "excellent (random)"
		}
	}
	var lo, up, dig, sym bool
	for i := 0; i < n; i++ {
		c := pw[i]
		switch {
		case c >= 'a' && c <= 'z':
			lo = true
		case c >= 'A' && c <= 'Z':
			up = true
		case c >= '0' && c <= '9':
			dig = true
		default:
			sym = true
		}
	}
	pool := 0
	if lo {
		pool += 26
	}
	if up {
		pool += 26
	}
	if dig {
		pool += 10
	}
	if sym {
		pool += 33
	}
	if pool < 2 {
		pool = 2
	}
	lp := 0.0
	{
		p := pool
		for p > 1 {
			lp += 1
			p >>= 1
		}
		lp += float64(pool-(1<<uint(lp))) / float64(int(1)<<uint(lp))
	}
	uniq := 0
	for i := 0; i < n; i++ {
		seen := false
		for j := 0; j < i; j++ {
			if pw[j] == pw[i] {
				seen = true
			}
		}
		if !seen {
			uniq++
		}
	}
	capN := n
	if uniq*2 < n {
		capN = uniq * 2
	}
	bits := float64(capN) * lp
	for i := 0; i+2 < n; i++ {
		if pw[i] == pw[i+1] && pw[i] == pw[i+2] {
			bits *= 0.7
			break
		}
	}
	seqs := []string{"012", "123", "234", "345", "456", "567", "678", "789",
		"abc", "bcd", "cde", "def", "qwe", "wer", "asd", "sdf", "zxc"}
seqdone:
	for _, sq := range seqs {
		for i := 0; i+2 < n; i++ {
			if pw[i]|32 == sq[0] && pw[i+1]|32 == sq[1] && pw[i+2]|32 == sq[2] {
				bits *= 0.7
				break seqdone
			}
		}
	}
	if (lo && !up && !dig && !sym) || (dig && !lo && !up && !sym) {
		bits *= 0.8
	}
	for i := 0; i+3 < n; i++ {
		if ((pw[i] == '1' && pw[i+1] == '9') || (pw[i] == '2' && pw[i+1] == '0')) &&
			pw[i+2] >= '0' && pw[i+2] <= '9' && pw[i+3] >= '0' && pw[i+3] <= '9' {
			bits -= 8
			break
		}
	}
	common := []string{"password", "passw0rd", "qwerty", "letmein", "welcome", "admin",
		"iloveyou", "monkey", "dragon", "football", "baseball", "shalom", "israel",
		"master", "login", "abc123", "prism", "secret", "hello", "test", "summer",
		"winter", "sunshine", "princess", "trustno1", "whatever", "google", "avi",
		"1234", "asdf", "zxcv", "love", "god", "cohen", "levi"}
	low := strings.ToLower(pw)
	for _, w := range common {
		if strings.Contains(low, w) {
			if bits > 28 {
				bits = 28
			}
			if low == w {
				bits -= 8
			}
			break
		}
	}
	ibits := int(bits)
	if ibits < 0 {
		ibits = 0
	}
	level := 0
	switch {
	case ibits < 40:
		level = 0
	case ibits < 60:
		level = 1
	case ibits < 80:
		level = 2
	case ibits < 100:
		level = 3
	default:
		level = 4
	}
	return ibits, level, labels[level]
}
