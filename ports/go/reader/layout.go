package main

import (
	"errors"
	"math"
)

var SIZES = [][2]int{{21, 24}, {29, 33}, {41, 47}, {57, 66}, {81, 94}, {113, 130}}

var HEX = []string{"#1B1B1B", "#2E5BFF", "#00B8D9", "#2DB35A", "#F5C518", "#F77F00", "#D7263D", "#B5179E", "#FFFFFF"}

var S3 = math.Sqrt(3)

func floorDiv(a, b int) int {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

type rng struct{ seed uint32 }

func newRng(seed uint32) *rng { return &rng{seed: seed} }

// JS: A=(A|0)+1831565813|0; e=imul(A^A>>>15,1|A); e=(e+imul(e^e>>>7,61|e))^e; ((e^e>>>14)>>>0)/2^32
func (r *rng) next() float64 {
	a := int32(r.seed) + 1831565813
	r.seed = uint32(a)
	e := imul(a^int32(uint32(a)>>15), 1|a)
	e = e + imul(e^int32(uint32(e)>>7), 61|e) ^ e
	return float64(uint32(e ^ int32(uint32(e)>>14))) / 4294967296
}

func imul(a, b int32) int32 { return int32(uint32(a) * uint32(b)) }

type cell struct {
	i, j   int
	x, y   float64
	role   string
	symbol int
	pi, pj int
	index  int
	header int
}

type Layout struct {
	size, C, R int
	W, H       float64
	cells      []*cell
	headers    []*cell
	data       []*cell
	known      []*cell
	cd         []*cell
	pos        map[int]int
}

var layoutCache = map[int]*Layout{}

func layoutOf(size int) (*Layout, error) {
	cacheMu.Lock()
	l, ok := layoutCache[size]
	cacheMu.Unlock()
	if ok {
		return l, nil
	}
	if size < 0 || size >= len(SIZES) {
		return nil, errors.New("Unknown size")
	}
	C, R := SIZES[size][0], SIZES[size][1]
	var cells, M, known []*cell
	for j := 0; j < R; j++ {
		for i := 0; i < C; i++ {
			role := "data"
			symbol := -1
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
	rnd := newRng(24301 ^ uint32(size))
	for i := len(data) - 1; i > 0; i-- {
		jj := int(rnd.next() * float64(i+1))
		data[i], data[jj] = data[jj], data[i]
	}
	l = &Layout{size: size, C: C, R: R,
		W: S3 * (float64(C) + 0.5), H: 2 + 1.5*float64(R-1),
		cells: cells, headers: headers, data: data, known: known}
	cacheMu.Lock()
	layoutCache[size] = l
	cacheMu.Unlock()
	return l, nil
}

// knownSymbol R(c, mode)
func knownSymbol(c *cell, mode int) int {
	if mode != 0 {
		if c.role == "ring" || (c.pi+c.pj)%2 == 0 {
			return 0
		}
		return 8
	}
	return c.symbol
}

// capacity b(size, ecc, mode)
type Block struct {
	n, nsym, k int
}
type Capacity struct {
	n, k, payload int
	blocks        []Block
}

func capacityOf(size, ecc, mode int) (*Capacity, error) {
	l, err := layoutOf(size)
	if err != nil {
		return nil, err
	}
	mm := 3
	if mode != 0 {
		mm = 1
	}
	o := len(l.data) * mm / 8
	a := (o + 254) / 255
	var blocks []Block
	for i := 0; i < a; i++ {
		t := o/a
		if i < o%a {
			t++
		}
		r := 2 * int(math.Round(float64(t)*[]float64{.1, .2, .3, .4}[ecc]/2))
		if r < 4 {
			r = 4
		}
		blocks = append(blocks, Block{t, r, t - r})
	}
	k := 0
	for _, b := range blocks {
		k += b.k
	}
	return &Capacity{n: o, blocks: blocks, k: k, payload: max(0, k-4)}, nil
}

var crcTable [256]uint32

func init() {
	for e := 0; e < 256; e++ {
		v := uint32(e)
		for i := 0; i < 8; i++ {
			if v&1 != 0 {
				v = 3988292384 ^ (v >> 1)
			} else {
				v >>= 1
			}
		}
		crcTable[e] = v
	}
}

func crc32(data []byte) uint32 {
	e := uint32(4294967295)
	for _, t := range data {
		e = crcTable[uint8(e)^t] ^ (e >> 8)
	}
	return ^e
}

func crc4(bits []int) int {
	e := 0
	for _, t := range bits {
		a := (e >> 3 & 1) ^ t
		e = e << 1 & 15
		if a != 0 {
			e ^= 3
		}
	}
	return e
}

func PADK(o int) int {
	x := int32(uint32(o+0x9E3779B9) * 0x85EBCA6B)
	x ^= int32(uint32(x) >> 13)
	x = int32(uint32(x) * 0xC2B2AE35)
	x ^= int32(uint32(x) >> 16)
	return int(uint32(x) & 255)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
