package main

// Decode ladder: padVote, PLfb, decodeStream (dA/dA0/dA2), bit-erasure recovery (y).
// Ported from reader_worker.js.

import (
	"errors"
	"math"
	"sort"
	"unicode/utf8"
)

type Header struct {
	Size   int `json:"size"`
	Ecc    int `json:"ecc"`
	Mode   int `json:"mode"`
	Type   int `json:"type"`
	Length int `json:"length"`
}

type stageErr struct {
	stage string
	msg   string
}

func (e *stageErr) Error() string { return e.msg }
func nA(stage, msg string) error  { return &stageErr{stage, msg} }

type DecodeResult struct {
	Bytes     []byte
	Text      string
	Header    Header
	Corrected int
	Erasures  int
	Variant   string
}

func (l *Layout) PLcd() []*cell {
	if l.cd != nil {
		return l.cd
	}
	cx, cy := l.W/2, l.H/2
	type cb struct {
		c *cell
		k int
		b float64
	}
	arr := make([]cb, len(l.data))
	for k, c := range l.data {
		dx, dy := c.x-cx, c.y-cy
		arr[k] = cb{c, k, float64(int(math.Sqrt(dx*dx+dy*dy) / 3))}
	}
	sort.SliceStable(arr, func(i, j int) bool {
		if arr[i].b != arr[j].b {
			return arr[i].b > arr[j].b
		}
		return arr[i].k < arr[j].k
	})
	l.cd = make([]*cell, len(arr))
	for i, a := range arr {
		l.cd[i] = a.c
	}
	return l.cd
}

// padVote(h, st): st = soft bit stream (len = n*8)
func padVote(h Header, st []float32) bool {
	if h.Length <= 0 {
		return true
	}
	c, err := capacityOf(h.Size, h.Ecc, h.Mode)
	if err != nil {
		return true
	}
	by := make([]uint8, c.n)
	for i := 0; i < c.n; i++ {
		v := 0
		for k := 0; k < 8; k++ {
			v = v << 1
			if st[8*i+k] < 0 {
				v |= 1
			}
		}
		by[i] = uint8(v)
	}
	offs := []int{}
	a := 0
	for _, b := range c.blocks {
		offs = append(offs, a)
		a += b.k
	}
	maxn := 0
	for _, b := range c.blocks {
		if b.n > maxn {
			maxn = b.n
		}
	}
	at, z, q := 0, 0, 0
	for p := 0; p < maxn; p++ {
		for j, b := range c.blocks {
			if p < b.n {
				if p < b.k && offs[j]+p >= h.Length+4 {
					v := by[at]
					if v == 0 {
						z++
					}
					if v == uint8(PADK(offs[j]+p)) {
						q++
					}
				}
				at++
			}
		}
	}
	return q >= z
}

// PLfb: logo-fallback decode with centre-out reordering and erasure ladder over f in {.1,.18,.26,.34}
func PLfb(h Header, st []float32, DEC func(Header, []float32) (*DecodeResult, error)) (*DecodeResult, error) {
	lay, err := layoutOf(h.Size)
	if err != nil {
		return nil, err
	}
	cd := lay.PLcd()
	N := len(lay.data)
	m := 3
	if h.Mode != 0 {
		m = 1
	}
	if len(st) < N*m {
		return nil, errors.New("short stream")
	}
	if lay.pos == nil {
		lay.pos = map[int]int{}
		for k, c := range lay.data {
			lay.pos[c.index] = k
		}
	}
	s2 := make([]float32, N*m)
	for k := 0; k < N; k++ {
		p := lay.pos[cd[k].index]
		for j := 0; j < m; j++ {
			s2[k*m+j] = st[p*m+j]
		}
	}
	n1 := int(float64(N) * .12)
	var ga, gb, gc, gd float64
	for k := 0; k < N; k++ {
		v := 0.0
		for j := 0; j < m; j++ {
			v += math.Abs(float64(s2[k*m+j]))
		}
		if k >= N-n1 {
			ga += v
			gb++
		} else if k < N/2 {
			gc += v
			gd++
		}
	}
	if ga/float64(gb) > 0.9*gc/float64(gd) {
		return nil, errors.New("centre stream not weak")
	}
	var lastErr error
	for _, f := range []float64{.1, .18, .26, .34} {
		s3 := append([]float32(nil), s2...)
		for k := int(float64(N) * (1 - f)); k < N; k++ {
			for j := 0; j < m; j++ {
				s3[k*m+j] = 0
			}
		}
		if r, err := DEC(h, s3); err == nil {
			return r, nil
		} else {
			lastErr = err
		}
	}
	return nil, lastErr
}

// decodeStream dA(h, st): dA0 then PLfb fallback
func decodeStream(h Header, st []float32) (*DecodeResult, error) {
	r, err := dA0(h, st)
	if err == nil {
		return r, nil
	}
	if !noLogo {
		if r2, err2 := PLfb(h, st, func(a Header, b []float32) (*DecodeResult, error) { return dA0(a, b) }); err2 == nil {
			return r2, nil
		}
	}
	return nil, err
}

var noLogo = false

func dA0(h Header, st []float32) (*DecodeResult, error) {
	t := padVote(h, st)
	r, err := dA2(h, st, t)
	if err == nil {
		return r, nil
	}
	if r2, err2 := dA2(h, st, !t); err2 == nil {
		return r2, nil
	}
	return nil, err
}

// dA2: RS erasure ladder with per-block candidates + CRC combination search
func dA2(A Header, r []float32, PK bool) (*DecodeResult, error) {
	o, err := capacityOf(A.Size, A.Ecc, A.Mode)
	if err != nil {
		return nil, err
	}
	a := make([]uint8, o.n)
	conf := make([]float32, o.n)
	maskArr := make([]uint8, o.n)
	for i := 0; i < o.n; i++ {
		e := 0
		t := float32(12)
		for j := 0; j < 8; j++ {
			aa := r[8*i+j]
			e <<= 1
			if aa < 0 {
				e |= 1
			}
			if aa == 0 {
				maskArr[i] |= 1 << uint(7-j)
			}
			if absf(aa) < t {
				t = absf(aa)
			}
		}
		a[i] = uint8(e)
		conf[i] = t
	}
	type blockState struct {
		Block
		bytes      []uint8
		conf       []float32
		masks      []uint8
		candidates []candidate
		tried      map[int]bool
		offset     int
		order      []int
	}
	l := make([]*blockState, len(o.blocks))
	for i, b := range o.blocks {
		l[i] = &blockState{Block: b, bytes: make([]uint8, b.n), conf: make([]float32, b.n), masks: make([]uint8, b.n), tried: map[int]bool{}}
	}
	maxn := 0
	for _, e := range l {
		if e.n > maxn {
			maxn = e.n
		}
	}
	I := 0
	for i := 0; i < maxn; i++ {
		for _, e := range l {
			if i < e.n {
				e.bytes[i] = a[I]
				e.conf[i] = conf[I]
				e.masks[i] = maskArr[I]
				I++
			}
		}
	}
	s := 0
	for _, e := range l {
		e.offset = s
		for t := 0; t < e.k; t++ {
			if A.Length > 0 && s+t >= A.Length+4 {
				if PK {
					e.bytes[t] = uint8(PADK(s + t))
				} else {
					e.bytes[t] = 0
				}
				e.conf[t] = 12
				e.masks[t] = 0
			}
		}
		s += e.k
		e.order = make([]int, e.n)
		for i := range e.order {
			e.order[i] = i
		}
		conf := e.conf
		sort.SliceStable(e.order, func(x, y int) bool { return conf[e.order[x]] < conf[e.order[y]] })
	}
	h := 0
	n := 0

	var C func(e *blockState, rr int)
	C = func(e *blockState, rr int) {
		if e.tried[rr] {
			return
		}
		h++
		e.tried[rr] = true
		res, err := rsDecode(e.bytes, e.nsym, append([]int(nil), e.order[:rr]...))
		if err != nil {
			return
		}
		for t := 0; t < e.k; t++ {
			if e.offset+t >= A.Length+4 {
				exp := 0
				if PK {
					exp = PADK(e.offset + t)
				}
				if uint8(exp) != res.bytes[t] {
					return
				}
			}
		}
		n++
		datacopy := append([]uint8(nil), res.bytes[:e.k]...)
		for _, cand := range e.candidates {
			eq := true
			for i := range datacopy {
				if cand.data[i] != datacopy[i] {
					eq = false
					break
				}
			}
			if eq {
				return
			}
		}
		score := 0.0
		for i := 0; i < e.n; i++ {
			if res.bytes[i] != e.bytes[i] {
				score += .02 + float64(e.conf[i])
			}
		}
		e.candidates = append(e.candidates, candidate{data: datacopy, corrected: res.corrected, erasures: rr, score: score})
		sort.SliceStable(e.candidates, func(x, y int) bool { return e.candidates[x].score < e.candidates[y].score })
		if len(e.candidates) > 8 {
			e.candidates = e.candidates[:8]
		}
	}

	Q := func() *DecodeResult {
		for _, e := range l {
			if len(e.candidates) == 0 {
				return nil
			}
		}
		e := 0
		var rr *DecodeResult
		var t func(o int, a []uint8, i, g int)
		t = func(o int, a []uint8, i, g int) {
			if rr != nil || e >= 1024 {
				return
			}
			if o == len(l) {
				e++
				if len(a) < A.Length+4 {
					return
				}
				tt := append([]byte(nil), a[:A.Length]...)
				crc := uint32(0)
				for _, b := range a[A.Length : A.Length+4] {
					crc = crc<<8 | uint32(b)
				}
				if crc32(tt) == crc {
					text := ""
					if A.Type == 0 {
						if !utf8.Valid(tt) {
							return
						}
						text = string(tt)
					}
					rr = &DecodeResult{Bytes: tt, Text: text, Header: A, Corrected: i, Erasures: g}
				}
				return
			}
			for _, cand := range l[o].candidates {
				t(o+1, append(append([]uint8(nil), a...), cand.data...), i+cand.corrected, g+cand.erasures)
			}
		}
		t(0, nil, 0, 0)
		return rr
	}

	for _, e := range l {
		seen := map[int]bool{}
		for _, f := range []float64{0, .25, .5, .75, 1} {
			er := int(math.Round(float64(e.nsym) * f))
			if seen[er] {
				continue
			}
			seen[er] = true
			C(e, er)
			if len(e.candidates) > 0 {
				break
			}
		}
	}
	if E := Q(); E != nil {
		return E, nil
	}
	for _, e := range l {
		for er := 0; er <= e.nsym; er += 2 {
			C(e, er)
		}
	}
	if E := Q(); E != nil {
		return E, nil
	}
	if A.Size <= 1 {
		for _, t := range l {
			res, err := rsRecoverBits(t.bytes, t.nsym, t.masks)
			if err != nil {
				continue
			}
			ok := true
			for e := 0; e < t.k; e++ {
				if t.offset+e >= A.Length+4 {
					exp := 0
					if PK {
						exp = PADK(t.offset + e)
					}
					if uint8(exp) != res.bytes[e] {
						ok = false
						break
					}
				}
			}
			if !ok {
				continue
			}
			datacopy := append([]uint8(nil), res.bytes[:t.k]...)
			dup := false
			for _, cand := range t.candidates {
				eq := true
				for i := range datacopy {
					if cand.data[i] != datacopy[i] {
						eq = false
						break
					}
				}
				if eq {
					dup = true
					break
				}
			}
			if !dup {
				t.candidates = append(t.candidates, candidate{data: datacopy, corrected: res.corrected, erasures: 0, score: 0})
			}
		}
		if E := Q(); E != nil {
			return E, nil
		}
	}
	for _, e := range l {
		if len(e.candidates) == 0 {
			return nil, nA("RS", "Error correction could not recover this image")
		}
	}
	return nil, nA("CRC", "Payload checksum did not pass")
}

type candidate struct {
	data      []uint8
	corrected int
	erasures  int
	score     float64
}

func absf(x float32) float32 {
	if x < 0 {
		return -x
	}
	return x
}

// rsRecoverBits: port of y(A, t, r) - bit-level erasure recovery via GF(2) elimination
func rsRecoverBits(data []uint8, nsym int, masks []uint8) (*rsResult, error) {
	nRsRecover++
	o := append([]uint8(nil), data...)
	type pb struct{ p, bit int }
	var a []pb
	for i := range o {
		o[i] &= ^masks[i]
		for e := 0; e < 8; e++ {
			if masks[i]&(1<<uint(e)) != 0 {
				a = append(a, pb{i, e})
			}
		}
	}
	i := len(a)
	if i == 0 || i > min(512, 8*nsym) {
		return nil, errors.New("Bit erasure count")
	}
	w := (i + 1 + 31) / 32
	g := make([][]uint32, 8*nsym)
	for x := range g {
		g[x] = make([]uint32, w)
	}
	l := syndromes(o, nsym)
	for A := 0; A < nsym; A++ {
		for e := 0; e < 8; e++ {
			if l[A]&(1<<uint(e)) != 0 {
				g[8*A+e][i>>5] |= 1 << uint(31&i)
			}
		}
		for e := 0; e < i; e++ {
			t := gmul(1<<uint(a[e].bit), gfExp[(A*(len(o)-1-a[e].p))%255])
			for r := 0; r < 8; r++ {
				if t&(1<<uint(r)) != 0 {
					g[8*A+r][e>>5] |= 1 << uint(31&e)
				}
			}
		}
	}
	I := 0
	h := []int{}
	for A := 0; A < i; A++ {
		t := I
		for t < len(g) && (g[t][A>>5]>>uint(31&A))&1 == 0 {
			t++
		}
		if t == len(g) {
			return nil, errors.New("Ambiguous bit erasures")
		}
		g[t], g[I] = g[I], g[t]
		r := g[I]
		for e := I + 1; e < len(g); e++ {
			if (g[e][A>>5]>>uint(31&A))&1 != 0 {
				for tt := A >> 5; tt < len(r); tt++ {
					g[e][tt] ^= r[tt]
				}
			}
		}
		h = append(h, A)
		I++
	}
	for A := I; A < len(g); A++ {
		if (g[A][i>>5]>>uint(31&i))&1 != 0 {
			return nil, errors.New("Inconsistent bit erasures")
		}
	}
	nb := make([]uint8, i)
	for A := I - 1; A >= 0; A-- {
		e := h[A]
		t := (g[A][i>>5] >> uint(31&i)) & 1
		for r := e + 1; r < i; r++ {
			if (g[A][r>>5]>>uint(31&r))&1 != 0 {
				t ^= uint32(nb[r])
			}
		}
		nb[e] = uint8(t)
	}
	for A := 0; A < i; A++ {
		if nb[A] != 0 {
			o[a[A].p] |= 1 << uint(a[A].bit)
		}
	}
	for _, x := range syndromes(o, nsym) {
		if x != 0 {
			return nil, errors.New("Bit erasure syndrome check")
		}
	}
	corr := 0
	for x := range o {
		if o[x] != data[x] {
			corr++
		}
	}
	return &rsResult{o, corr}, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
