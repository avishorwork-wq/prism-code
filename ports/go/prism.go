// Prism Code - Go port of the live JavaScript encoder/decoder.
//
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// Format (as implemented by the live site):
//   Pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray coding
//   (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to 113x130 cells.
//   Filled corner gap pattern, asymmetric ring, pilot cells, triplicated
//   CRC-4 header, seeded cell shuffle, GF(256)/0x11D Reed-Solomon blocks,
//   payload CRC-32.
package main

import (
	"errors"
	"fmt"
	"math"
	"sort"
)

var S3 = math.Sqrt(3) // matches JS Math.sqrt(3) bit-for-bit
var Q = 3 * S3

type sizeWH struct{ C, R int }

var SIZES = []sizeWH{{21, 24}, {29, 33}, {41, 47}, {57, 66}, {81, 94}, {113, 130}}

var PAL = [][3]uint8{
	{0x1B, 0x1B, 0x1B}, {0x2E, 0x5B, 0xFF}, {0x00, 0xB8, 0xD9},
	{0x2D, 0xB3, 0x5A}, {0xF5, 0xC5, 0x18}, {0xF7, 0x7F, 0x00},
	{0xD7, 0x26, 0x3D}, {0xB5, 0x17, 0x9E}, {0xFF, 0xFF, 0xFF},
}

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// ---------------------------------------------------------------- rng / crc

type rng struct{ seed uint32 }

func newRng(seed uint32) *rng { return &rng{seed: seed} }

// Exact port of the JS mulberry-style rng (returns floats in [0,1)).
func (r *rng) next() float64 {
	r.seed += 0x6D2B79F5
	t := (r.seed ^ (r.seed >> 15)) * (1 | r.seed)
	t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t
	return float64((t ^ (t >> 14))) / 4294967296.0
}

var crcTable [256]uint32

func init() {
	for n := 0; n < 256; n++ {
		c := uint32(n)
		for k := 0; k < 8; k++ {
			if c&1 != 0 {
				c = 0xEDB88320 ^ (c >> 1)
			} else {
				c >>= 1
			}
		}
		crcTable[n] = c
	}
}

func crc32(data []byte) uint32 {
	c := uint32(0xFFFFFFFF)
	for _, b := range data {
		c = crcTable[(c^uint32(b))&255] ^ (c >> 8)
	}
	return c ^ 0xFFFFFFFF
}

func crc4(bits []int) int {
	r := 0
	for _, b := range bits {
		f := ((r >> 3) & 1) ^ b
		r = (r << 1) & 15
		if f != 0 {
			r ^= 3
		}
	}
	return r
}

func PADK(o int) int {
	x := (uint32(o) + 0x9E3779B9) * 0x85EBCA6B
	x ^= x >> 13
	x = x * 0xC2B2AE35
	x ^= x >> 16
	return int(x & 255)
}

// ---------------------------------------------------------------- GF(256)

var gfExp [512]int
var gfLog [256]int

func init() {
	z := 1
	for i := 0; i < 255; i++ {
		gfExp[i] = z
		gfLog[z] = i
		z <<= 1
		if z&256 != 0 {
			z ^= 0x11D
		}
	}
	for i := 255; i < 512; i++ {
		gfExp[i] = gfExp[i-255]
	}
}

func gmul(a, b int) int {
	if a != 0 && b != 0 {
		return gfExp[gfLog[a]+gfLog[b]]
	}
	return 0
}

func gdiv(a, b int) int {
	if b == 0 {
		panic("GF division by zero")
	}
	if a == 0 {
		return 0
	}
	return gfExp[(gfLog[a]+255-gfLog[b])%255]
}

func peval(p []int, x int) int {
	y := 0
	for i := len(p) - 1; i >= 0; i-- {
		y = gmul(y, x) ^ p[i]
	}
	return y
}

func pmul(a, b []int) []int {
	o := make([]int, len(a)+len(b)-1)
	for i, ai := range a {
		if ai != 0 {
			for j, bj := range b {
				o[i+j] ^= gmul(ai, bj)
			}
		}
	}
	return o
}

var genCache = map[int][]int{}

func rsEncode(msg []int, nsym int) []int {
	g, ok := genCache[nsym]
	if !ok {
		g = []int{1}
		for i := 0; i < nsym; i++ {
			g = pmul(g, []int{1, gfExp[i]})
		}
		genCache[nsym] = g
	}
	out := make([]int, len(msg)+nsym)
	copy(out, msg)
	for i := 0; i < len(msg); i++ {
		c := out[i]
		if c != 0 {
			for j := 1; j < len(g); j++ {
				out[i+j] ^= gmul(g[j], c)
			}
		}
	}
	copy(out, msg)
	return out
}

func syndromes(r []int, n int) []int {
	s := make([]int, n)
	for j := 0; j < n; j++ {
		y := 0
		x := gfExp[j]
		for i := 0; i < len(r); i++ {
			y = gmul(y, x) ^ r[i]
		}
		s[j] = y
	}
	return s
}

func berlekampMassey(s []int) []int {
	c := make([]int, len(s)+1)
	b := make([]int, len(s)+1)
	c[0], b[0] = 1, 1
	L, m, bb := 0, 1, 1
	for n := 0; n < len(s); n++ {
		d := s[n]
		for i := 1; i <= L; i++ {
			d ^= gmul(c[i], s[n-i])
		}
		if d == 0 {
			m++
			continue
		}
		t := append([]int(nil), c...)
		v := gdiv(d, bb)
		for i := 0; i < len(c)-m; i++ {
			c[i+m] ^= gmul(v, b[i])
		}
		if 2*L <= n {
			L = n + 1 - L
			b = t
			bb = d
			m = 1
		} else {
			m++
		}
	}
	return c[:L+1]
}

// rsDecode returns corrected bytes and number corrected.
func rsDecode(data []int, nsym int) ([]int, int, error) {
	r := append([]int(nil), data...)
	s := syndromes(r, nsym)
	allZero := true
	for _, x := range s {
		if x != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return r, 0, nil
	}
	E := berlekampMassey(s)
	if 2*(len(E)-1) > nsym {
		return nil, 0, errors.New("RS correction limit")
	}
	loc := E
	var pos []int
	for p := 0; p < len(r); p++ {
		e := len(r) - 1 - p
		if peval(loc, gfExp[(255-e)%255]) == 0 {
			pos = append(pos, p)
		}
	}
	if len(pos) != len(loc)-1 {
		return nil, 0, errors.New("RS roots")
	}
	omega := pmul(s, loc)
	if len(omega) > nsym {
		omega = omega[:nsym]
	}
	// der has max(1,len(loc)-1) entries, der[i-1] = loc[i] for odd i
	derLen := len(loc) - 1
	if derLen < 1 {
		derLen = 1
	}
	der := make([]int, derLen)
	for i := 1; i < len(loc); i += 2 {
		der[i-1] = loc[i]
	}
	for _, p := range pos {
		e := len(r) - 1 - p
		X := gfExp[e]
		xi := gfExp[(255-e)%255]
		r[p] ^= gdiv(gmul(X, peval(omega, xi)), peval(der, xi))
	}
	s2 := syndromes(r, nsym)
	for _, x := range s2 {
		if x != 0 {
			return nil, 0, errors.New("RS syndrome check")
		}
	}
	return r, len(pos), nil
}

// ---------------------------------------------------------------- layout

type cell struct {
	i, j    int
	x, y    float64
	role    string
	symbol  int
	pi, pj  int
	index   int
	header  int
}

type Layout struct {
	size, C, R int
	W, H       float64
	cells      []*cell
	headers    []*cell
	data       []*cell
	known      []*cell
	cd         []*cell
}

var layoutCache = map[int]*Layout{}

func getLayout(size int) (*Layout, error) {
	if l, ok := layoutCache[size]; ok {
		return l, nil
	}
	if size < 0 || size >= len(SIZES) {
		return nil, errors.New("unknown size")
	}
	C, R := SIZES[size].C, SIZES[size].R
	var cells, M, known []*cell
	for j := 0; j < R; j++ {
		for i := 0; i < C; i++ {
			role := "data"
			symbol := -1
			// python floor division (i-2)//5
			pi := floorDiv(i-2, 5)
			pj := floorDiv(j-2, 5)
			if j <= 2 && i <= 2 {
				role = "gap"
				symbol = 8
			} else if j == 0 || j == R-1 || i == 0 || i == C-1 {
				role = "ring"
				symbol = (j*5 + i*3) % 8
			} else if i%5 == 2 && j%5 == 2 {
				role = "pilot"
				symbol = (pi*2 + pj*3) % 9
			}
			c := &cell{i: i, j: j,
				x: S3 * (float64(i) + 0.5 + 0.5*float64(j&1)),
				y: 1 + 1.5*float64(j),
				role: role, symbol: symbol, pi: pi, pj: pj,
				index: len(cells), header: -1}
			cells = append(cells, c)
			if role == "data" {
				M = append(M, c)
			} else if role != "gap" {
				known = append(known, c)
			}
		}
	}
	var headers []*cell
	for n := 0; n < 72; n++ {
		c := M[int((float64(n)+0.5)*float64(len(M))/72)]
		c.role = "header"
		c.header = n
		headers = append(headers, c)
	}
	var data []*cell
	for _, c := range cells {
		if c.role == "data" {
			data = append(data, c)
		}
	}
	rnd := newRng(0x5EED ^ uint32(size))
	for i := len(data) - 1; i > 0; i-- {
		jj := int(rnd.next() * float64(i+1))
		data[i], data[jj] = data[jj], data[i]
	}
	l := &Layout{size: size, C: C, R: R,
		W: S3 * (float64(C) + 0.5), H: 2 + 1.5*float64(R-1),
		cells: cells, headers: headers, data: data, known: known}
	layoutCache[size] = l
	return l, nil
}

// PLcd returns the centre-out cell order used when a logo sits in the middle.
func (l *Layout) PLcd() []*cell {
	if l.cd != nil {
		return l.cd
	}
	cx, cy := l.W/2, l.H/2
	type ent struct {
		c *cell
		k int
		b int
	}
	a := make([]ent, len(l.data))
	for k, c := range l.data {
		dx, dy := c.x-cx, c.y-cy
		a[k] = ent{c, k, int(math.Sqrt(dx*dx+dy*dy) / 3)}
	}
	sort.SliceStable(a, func(p, q int) bool {
		if a[p].b != a[q].b {
			return a[p].b > a[q].b
		}
		return a[p].k < a[q].k
	})
	l.cd = make([]*cell, len(a))
	for i, e := range a {
		l.cd[i] = e.c
	}
	return l.cd
}

// ---------------------------------------------------------------- capacity

type blockSpec struct{ n, nsym, k int }

type Capacity struct {
	n       int
	blocks  []blockSpec
	k       int
	payload int
}

func jsround(x float64) float64 { return math.Floor(x + 0.5) }

func capacity(size, ecc, mode int) (*Capacity, error) {
	l, err := getLayout(size)
	if err != nil {
		return nil, err
	}
	bpc := 3
	if mode != 0 {
		bpc = 1
	}
	n := len(l.data) * bpc / 8
	B := (n + 254) / 255
	var blocks []blockSpec
	pcts := []float64{.1, .2, .3, .4}
	for i := 0; i < B; i++ {
		ln := n / B
		if i < n%B {
			ln++
		}
		nsym := 2 * int(jsround(float64(ln)*pcts[ecc]/2))
		if nsym < 4 {
			nsym = 4
		}
		blocks = append(blocks, blockSpec{ln, nsym, ln - nsym})
	}
	cap_ := &Capacity{n: n, blocks: blocks}
	for _, b := range blocks {
		cap_.k += b.k
	}
	cap_.payload = cap_.k - 4
	if cap_.payload < 0 {
		cap_.payload = 0
	}
	return cap_, nil
}

func pushBits(a *[]int, x, n int) {
	for k := n - 1; k >= 0; k-- {
		*a = append(*a, (x>>k)&1)
	}
}

func headerBits(size, ecc, mode, typ, L int) []int {
	var b []int
	pushBits(&b, size, 3)
	pushBits(&b, ecc, 2)
	pushBits(&b, mode, 1)
	pushBits(&b, typ, 1)
	pushBits(&b, L, 13)
	pushBits(&b, crc4(b), 4)
	return b
}

func knownSymbol(c *cell, mode int) int {
	if mode != 0 {
		if c.role == "ring" {
			return 0
		}
		if (c.pi+c.pj)%2 == 0 {
			return 0
		}
		return 8
	}
	return c.symbol
}

// ---------------------------------------------------------------- encode

type Code struct {
	size, ecc, mode, typ int
	Bytes                []byte
	Symbols              []int
	Lay                  *Layout
	Cap                  *Capacity
}

func encode(payload []byte, size, ecc, mode, typ, logo int) (*Code, error) {
	if len(payload) > 8191 {
		return nil, errors.New("payload exceeds 8191 bytes")
	}
	if size < 0 {
		size = -1
		for i := 0; i < len(SIZES); i++ {
			cp, err := capacity(i, ecc, mode)
			if err != nil {
				return nil, err
			}
			if cp.k >= len(payload)+4 {
				size = i
				break
			}
		}
		if size < 0 {
			return nil, errors.New("payload too large for this mode and ECC")
		}
	}
	cap_, err := capacity(size, ecc, mode)
	if err != nil {
		return nil, err
	}
	if cap_.k < len(payload)+4 {
		return nil, fmt.Errorf("payload does not fit: maximum %d bytes", cap_.payload)
	}
	msg := make([]int, cap_.k)
	for i := len(payload) + 4; i < cap_.k; i++ {
		msg[i] = PADK(i)
	}
	for i, b := range payload {
		msg[i] = int(b)
	}
	crc := crc32(payload)
	for k := 0; k < 4; k++ {
		msg[len(payload)+k] = int(crc>>uint(24-8*k)) & 255
	}
	off := 0
	var blocks [][]int
	for _, b := range cap_.blocks {
		blocks = append(blocks, rsEncode(msg[off:off+b.k], b.nsym))
		off += b.k
	}
	maxlen := 0
	for _, x := range blocks {
		if len(x) > maxlen {
			maxlen = len(x)
		}
	}
	var stream []int
	for p := 0; p < maxlen; p++ {
		for _, b := range blocks {
			if p < len(b) {
				pushBits(&stream, b[p], 8)
			}
		}
	}
	rnd := newRng(0xBEEF)
	l, _ := getLayout(size)
	symbols := make([]int, len(l.cells))
	for i := range symbols {
		symbols[i] = 8
	}
	for _, c := range l.known {
		symbols[c.index] = knownSymbol(c, mode)
	}
	hb := headerBits(size, ecc, mode, typ, len(payload))
	for _, c := range l.headers {
		if hb[c.header%24] != 0 {
			symbols[c.index] = 0
		} else {
			symbols[c.index] = 8
		}
	}
	for _, c := range l.cells {
		if c.role == "gap" {
			if mode != 0 {
				if (c.i+c.j)%2 != 0 {
					symbols[c.index] = 0
				} else {
					symbols[c.index] = 8
				}
			} else {
				symbols[c.index] = (c.j*5 + c.i*3) % 8
			}
		}
	}
	at := 0
	order := l.data
	if logo != 0 {
		order = l.PLcd()
	}
	for _, c := range order {
		if mode != 0 {
			bit := 0
			if at < len(stream) {
				bit = stream[at]
			} else if rnd.next() > 0.5 {
				bit = 1
			}
			at++
			if bit != 0 {
				symbols[c.index] = 0
			} else {
				symbols[c.index] = 8
			}
		} else {
			b := 0
			for k := 0; k < 3; k++ {
				bit := 0
				if at < len(stream) {
					bit = stream[at]
				} else if rnd.next() > 0.5 {
					bit = 1
				}
				at++
				b = (b << 1) | bit
			}
			v := b
			v ^= v >> 1
			v ^= v >> 2
			symbols[c.index] = v
		}
	}
	return &Code{size, ecc, mode, typ, payload, symbols, l, cap_}, nil
}

// ---------------------------------------------------------------- decode (clean images)

func symbolBits(sym, mode int) []int {
	if mode != 0 {
		if sym == 0 {
			return []int{1}
		}
		return []int{0}
	}
	t := sym ^ (sym >> 1)
	return []int{(t >> 2) & 1, (t >> 1) & 1, t & 1}
}

func nearestSymbol(r, g, b int) int {
	best, bestd := 0, int64(1)<<62
	for i, p := range PAL {
		dr, dg, db := int64(r-int(p[0])), int64(g-int(p[1])), int64(b-int(p[2]))
		d := dr*dr + dg*dg + db*db
		if d < bestd {
			bestd = d
			best = i
		}
	}
	return best
}

type Header struct {
	Size, Ecc, Mode, Type, Length int
}

func decodeSymbols(symbols []int, l *Layout, order []*cell) ([]byte, Header, error) {
	var hdr Header
	headers := l.headers
	hb := make([]int, 24)
	for n := 0; n < 24; n++ {
		votes := 0
		for rep := 0; rep < 3; rep++ {
			c := headers[n+24*rep]
			if symbols[c.index] == 0 {
				votes++
			}
		}
		if votes >= 2 {
			hb[n] = 1
		}
	}
	at := 0
	rd := func(n int) int {
		v := 0
		for k := 0; k < n; k++ {
			v = (v << 1) | hb[at]
			at++
		}
		return v
	}
	size := rd(3)
	ecc := rd(2)
	mode := rd(1)
	typ := rd(1)
	L := rd(13)
	hcrc := rd(4)
	if crc4(hb[:20]) != hcrc || size > 5 || size != l.size {
		return nil, hdr, errors.New("header checksum failed")
	}
	cap_, err := capacity(size, ecc, mode)
	if err != nil {
		return nil, hdr, err
	}
	if L > cap_.payload {
		return nil, hdr, errors.New("invalid length")
	}
	cells := order
	if cells == nil {
		cells = l.data
	}
	var stream []int
	for _, c := range cells {
		stream = append(stream, symbolBits(symbols[c.index], mode)...)
	}
	nbytes := cap_.n
	bts := make([]int, nbytes)
	for i := 0; i < nbytes; i++ {
		v := 0
		for k := 0; k < 8; k++ {
			v = (v << 1) | stream[8*i+k]
		}
		bts[i] = v
	}
	blocks := make([][]int, len(cap_.blocks))
	for bi, b := range cap_.blocks {
		blocks[bi] = make([]int, b.n)
	}
	at = 0
	maxn := 0
	for _, b := range cap_.blocks {
		if b.n > maxn {
			maxn = b.n
		}
	}
	for p := 0; p < maxn; p++ {
		for bi, b := range cap_.blocks {
			if p < b.n {
				blocks[bi][p] = bts[at]
				at++
			}
		}
	}
	var msg []int
	for bi, b := range cap_.blocks {
		dec, _, err := rsDecode(blocks[bi], b.nsym)
		if err != nil {
			return nil, hdr, err
		}
		msg = append(msg, dec[:b.k]...)
	}
	payload := make([]byte, L)
	for i := 0; i < L; i++ {
		payload[i] = byte(msg[i])
	}
	got := uint32(msg[L])<<24 | uint32(msg[L+1])<<16 | uint32(msg[L+2])<<8 | uint32(msg[L+3])
	if crc32(payload) != got {
		return nil, hdr, errors.New("payload CRC-32 failed")
	}
	hdr = Header{size, ecc, mode, typ, L}
	return payload, hdr, nil
}

// DecodeImage decodes a clean/perfect encoder PNG (any radius).
func DecodeImage(w, h int, rgba []byte) ([]byte, Header, error) {
	xmin, ymin := w, h
	xmax, ymax := -1, -1
	for y := 0; y < h; y++ {
		rowAllWhite := true
		for x := 0; x < w; x++ {
			o := (y*w + x) * 4
			if rgba[o] < 250 || rgba[o+1] < 250 || rgba[o+2] < 250 {
				rowAllWhite = false
				break
			}
		}
		if rowAllWhite {
			continue
		}
		for x := 0; x < w; x++ {
			o := (y*w + x) * 4
			if rgba[o] < 250 || rgba[o+1] < 250 || rgba[o+2] < 250 {
				if x < xmin {
					xmin = x
				}
				if x > xmax {
					xmax = x
				}
				if y < ymin {
					ymin = y
				}
				if y > ymax {
					ymax = y
				}
			}
		}
	}
	if xmax < 0 {
		return nil, Header{}, errors.New("no code found")
	}
	const HEXHW = 1.03 * 0.8660254037844386 // 1.03*cos(30deg)
	const HEXHH = 1.03
	var lastErr error
	for size := 0; size < 6; size++ {
		l, err := getLayout(size)
		if err != nil {
			lastErr = err
			continue
		}
		var ring []*cell
		for _, c := range l.known {
			if c.role == "ring" {
				ring = append(ring, c)
			}
		}
		mincx, maxcx := math.Inf(1), math.Inf(-1)
		mincy, maxcy := math.Inf(1), math.Inf(-1)
		for _, c := range ring {
			mincx = math.Min(mincx, c.x)
			maxcx = math.Max(maxcx, c.x)
			mincy = math.Min(mincy, c.y)
			maxcy = math.Max(maxcy, c.y)
		}
		mincx -= HEXHW
		maxcx += HEXHW
		mincy -= HEXHH
		maxcy += HEXHH
		rx := float64(xmax-xmin+1) / (maxcx - mincx)
		ry := float64(ymax-ymin+1) / (maxcy - mincy)
		if math.Abs(rx-ry)/math.Max(rx, ry) > 0.05 {
			continue
		}
		symbols := make([]int, len(l.cells))
		for i := range symbols {
			symbols[i] = 8
		}
		for _, c := range l.cells {
			px := float64(xmin) + (c.x-mincx)*rx
			py := float64(ymin) + (c.y-mincy)*ry
			sr, sg, sb, n := 0, 0, 0, 0
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					xx := int(px + float64(dx)*rx*0.15)
					yy := int(py + float64(dy)*ry*0.15)
					if xx < 0 {
						xx = 0
					}
					if xx > w-1 {
						xx = w - 1
					}
					if yy < 0 {
						yy = 0
					}
					if yy > h-1 {
						yy = h - 1
					}
					o := (yy*w + xx) * 4
					sr += int(rgba[o])
					sg += int(rgba[o+1])
					sb += int(rgba[o+2])
					n++
				}
			}
			symbols[c.index] = nearestSymbol(sr/n, sg/n, sb/n)
		}
		pl, hdr, err := decodeSymbols(symbols, l, nil)
		if err != nil {
			pl, hdr, err = decodeSymbols(symbols, l, l.PLcd())
		}
		if err == nil {
			return pl, hdr, nil
		}
		lastErr = err
	}
	return nil, Header{}, fmt.Errorf("decode failed: %v", lastErr)
}
