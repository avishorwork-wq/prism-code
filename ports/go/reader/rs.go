package main

// GF(256) tables, RS encode/decode with erasure support, bit-erasure recovery.
// Ported from reader_worker.js (w, u, d, y) - JS fallback paths (no WASM).

var gfExp [512]uint8
var gfLog [256]uint8

func init() {
	q := 1
	for i := 0; i < 255; i++ {
		gfExp[i] = uint8(q)
		gfLog[q] = uint8(i)
		q <<= 1
		if q&256 != 0 {
			q ^= 285
		}
	}
	for i := 255; i < 512; i++ {
		gfExp[i] = gfExp[i-255]
	}
}

func gmul(a, b uint8) uint8 {
	nGmul++
	if a == 0 || b == 0 {
		return 0
	}
	return gfExp[int(gfLog[a])+int(gfLog[b])]
}

func gdiv(a, b uint8) uint8 {
	if b == 0 {
		panic("GF division by zero")
	}
	if a == 0 {
		return 0
	}
	return gfExp[(int(gfLog[a])+255-int(gfLog[b]))%255]
}

func peval(p []uint8, x uint8) uint8 {
	t := uint8(0)
	for i := len(p) - 1; i >= 0; i-- {
		t = gmul(t, x) ^ p[i]
	}
	return t
}

func pmul(a, b []uint8) []uint8 {
	t := make([]uint8, len(a)+len(b)-1)
	for i := range a {
		for j := range b {
			t[i+j] ^= gmul(a[i], b[j])
		}
	}
	return t
}

var rsGenCache = map[int][]uint8{}

func rsGen(nsym int) []uint8 {
	cacheMu.Lock()
	t, ok := rsGenCache[nsym]
	cacheMu.Unlock()
	if ok {
		return t
	}
	t = []uint8{1}
	for i := 0; i < nsym; i++ {
		t = pmul(t, []uint8{1, gfExp[i]})
	}
	cacheMu.Lock()
	rsGenCache[nsym] = t
	cacheMu.Unlock()
	return t
}

func syndromes(r []uint8, n int) []uint8 {
	t := make([]uint8, n)
	for i := 0; i < n; i++ {
		e := uint8(0)
		for j := 0; j < len(r); j++ {
			e = gmul(e, gfExp[i]) ^ r[j]
		}
		t[i] = e
	}
	return t
}

type rsResult struct {
	bytes     []uint8
	corrected int
}

// rsDecode: port of d(A, e, t): data, nsym, erasure positions.
var nRsDecode, nRsRecover, nGmul int64

var synCacheKey uint64
var synCacheNsym int
var synCacheVal []uint8

func synFingerprint(d []uint8) uint64 {
	h := uint64(1469598103934665603)
	for _, b := range d {
		h = (h ^ uint64(b)) * 1099511628211
	}
	return h
}

func rsDecode(data []uint8, nsym int, erasures []int) (*rsResult, error) {
	nRsDecode++
	r := append([]uint8(nil), data...)
	fp := synFingerprint(r)
	cacheMu.Lock()
	var o []uint8
	if fp == synCacheKey && nsym == synCacheNsym {
		o = synCacheVal
	}
	cacheMu.Unlock()
	if o == nil {
		o = syndromes(r, nsym)
		cacheMu.Lock()
		synCacheKey, synCacheNsym, synCacheVal = fp, nsym, o
		cacheMu.Unlock()
	}
	allZero := true
	for _, x := range o {
		if x != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		return &rsResult{r, 0}, nil
	}
	if len(erasures) > nsym {
		return nil, errRS("Too many erasures")
	}
	a := []uint8{1}
	i := append([]uint8(nil), o...)
	for _, pos := range erasures {
		if pos < 0 || pos >= len(r) {
			return nil, errRS("Erasure index")
		}
		e := gfExp[len(r)-1-pos]
		a = pmul(a, []uint8{1, e})
		for k := 0; k < len(i)-1; k++ {
			i[k] = gmul(i[k], e) ^ i[k+1]
		}
		i = i[:len(i)-1]
	}
	// Berlekamp-Massey
	g := bm(i)
	if 2*(len(g)-1)+len(erasures) > nsym {
		return nil, errRS("RS correction limit")
	}
	l := pmul(a, g)
	var pos []int
	for p := 0; p < len(r); p++ {
		e := len(r) - 1 - p
		if peval(l, gfExp[(255-e)%255]) == 0 {
			pos = append(pos, p)
		}
	}
	if len(pos) != len(l)-1 {
		return nil, errRS("RS roots")
	}
	h := pmul(o, l)
	if len(h) > nsym {
		h = h[:nsym]
	}
	derLen := len(l) - 1
	if derLen < 1 {
		derLen = 1
	}
	der := make([]uint8, derLen)
	for k := 1; k < len(l); k += 2 {
		der[k-1] = l[k]
	}
	for _, p := range pos {
		e := len(r) - 1 - p
		X := gfExp[e]
		xi := gfExp[(255-e)%255]
		r[p] ^= gdiv(gmul(X, peval(h, xi)), peval(der, xi))
	}
	for _, x := range syndromes(r, nsym) {
		if x != 0 {
			return nil, errRS("RS syndrome check")
		}
	}
	return &rsResult{r, len(pos)}, nil
}

// bm: Berlekamp-Massey over syndrome sequence (port of inner g in d).
func bm(s []uint8) []uint8 {
	e := make([]uint8, len(s)+1)
	t := make([]uint8, len(s)+1)
	e[0], t[0] = 1, 1
	r, o := 0, 1
	a := uint8(1)
	for i := 0; i < len(s); i++ {
		g := s[i]
		for k := 1; k <= r; k++ {
			g ^= gmul(e[k], s[i-k])
		}
		if g == 0 {
			o++
			continue
		}
		l := append([]uint8(nil), e...)
		I := gdiv(g, a)
		for k := 0; k+o < len(e); k++ {
			e[k+o] ^= gmul(I, t[k])
		}
		if 2*r <= i {
			r = i + 1 - r
			t = l
			a = g
			o = 1
		} else {
			o++
		}
	}
	return e[:r+1]
}

type errRS string

func (e errRS) Error() string { return string(e) }
