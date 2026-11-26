package main

import (
	"encoding/json"
	"math"
	"os"
	"sort"
)

var dbg2 = os.Getenv("PRISM_DEBUG2") != ""

func toJ(v interface{}) string { b, _ := json.Marshal(v); return string(b) }
func itoa(i int) string        { return toJ(i) }
func ftoa(f float64) string    { return toJ(f) }

type pointInfo struct {
	x, y       float64
	confidence float64
}

type glareSample struct {
	at int
	cv [3]float64
}

type ClassResult struct {
	header        Header
	headers       []Header
	stream        []float32
	extendedGlare []int
	glareSamples  []glareSample
	hb            []float32
	sigma         float64
	points        []pointInfo
	knownMatch    float64
}

// headerCandidates: port of the inner function in uA
func headerCandidates(hb []float32, size, mode int) []Header {
	r := make([]float32, 24)
	copy(r, hb)
	for A := 0; A < 3; A++ {
		if (size>>uint(2-A))&1 != 0 {
			r[A] = -36
		} else {
			r[A] = 36
		}
	}
	if mode != 0 {
		r[5] = -36
	} else {
		r[5] = 36
	}
	o := []int{}
	for e := 0; e < 24; e++ {
		if e != 0 && e != 1 && e != 2 && e != 5 {
			o = append(o, e)
		}
	}
	sort.SliceStable(o, func(a, b int) bool { return absf(hb[o[a]]) < absf(hb[o[b]]) })
	o = o[:12]
	ibits := make([]int, 24)
	for i, v := range r {
		if v < 0 {
			ibits[i] = 1
		}
	}
	first20 := make([]int, 20)
	copy(first20, ibits)
	last4 := 0
	for _, b := range ibits[20:] {
		last4 = last4<<1 | b
	}
	g := crc4(first20) ^ last4

	type hcand struct {
		h    Header
		cost float64
	}
	var a []hcand
	l := func(oo []int) {
		i := g
		for _, A := range oo {
			if (r[A] < 0) != (-r[A] < 0) {
				i ^= cA[A]
			}
		}
		if i != 0 {
			return
		}
		ll := append([]float32(nil), r...)
		I := 0.0
		for _, e := range oo {
			ll[e] = -ll[e]
			I += math.Abs(float64(hb[e]))
		}
		if hd, err := parseHeader(ll); err == nil {
			if hd.Size == size && hd.Mode == mode {
				a = append(a, hcand{hd, I})
			}
		}
	}
	l(nil)
	for A := 0; A < len(o); A++ {
		l([]int{o[A]})
		for e := A + 1; e < len(o); e++ {
			l([]int{o[A], o[e]})
			for t := e + 1; t < len(o); t++ {
				l([]int{o[A], o[e], o[t]})
			}
		}
	}
	sort.SliceStable(a, func(x, y int) bool { return a[x].cost < a[y].cost })
	var out []Header
	seen := map[Header]bool{}
	for _, c := range a {
		if !seen[c.h] {
			seen[c.h] = true
			out = append(out, c.h)
		}
	}
	if len(out) > 12 {
		out = out[:12]
	}
	return out
}

// classify uA
func classify(f *Frame, H *Homography, l *Layout, mode int, white [3]float64, mesh *[]meshPt) (*ClassResult, error) {
	g := calibrate(f, H, l, mode, white, mesh)
	hb := make([]float32, 24)
	for _, t := range l.headers {
		r := f.sampleCell(H, t, white, mesh, false)
		o := g.correction(r, t)
		hb[t.header%24] += float32(llrOf(o, 1, g.sigma, false)[0])
	}
	n := headerCandidates(hb, l.size, mode)
	// filter: length-0 headers must match direct parse
	var filtered []Header
	for _, A := range n {
		if A.Length != 0 {
			filtered = append(filtered, A)
			continue
		}
		e, err := parseHeader(hb)
		if err == nil && e == A {
			filtered = append(filtered, A)
		}
	}
	n = filtered
	if len(n) == 0 {
		return nil, nA("header", "Header checksum did not pass")
	}
	s := n[0]
	if s.Size != l.size || s.Mode != mode {
		return nil, nA("header", "Header conflicts with geometry")
	}
	mm := 3
	if mode != 0 {
		mm = 1
	}
	C := make([]float32, 0, len(l.data)*mm)
	var Q []int
	var E []glareSample
	var B []pointInfo
	fidx := 0
	for _, t := range l.data {
		I := f.sampleCell(H, t, white, mesh, false)
		h := g.correction(I, t)
		glare := true
		for _, v := range I {
			if v <= CFG.GlareThreshold {
				glare = false
			}
		}
		ss := llrOf(h, mode, g.sigma, glare)
		if mode == 0 && l.size <= 1 && !glare {
			all := true
			for _, v := range I {
				if v <= .7 {
					all = false
				}
			}
			if all {
				Q = append(Q, fidx)
			}
		}
		if glare && l.size <= 1 {
			E = append(E, glareSample{at: fidx, cv: h})
		}
		for _, v := range ss {
			C = append(C, float32(v))
		}
		mn := math.Abs(ss[0])
		for _, v := range ss {
			if math.Abs(v) < mn {
				mn = math.Abs(v)
			}
		}
		B = append(B, pointInfo{x: t.x, y: t.y, confidence: mn / 12})
		fidx += len(ss)
	}
	c := 0
	for _, A := range g.refs {
		corr := g.correction(A.o, A.c)
		sym, _ := nearestSymbolOf(corr, mode)
		if sym == knownSymbol(A.c, mode) {
			c++
		}
	}
	return &ClassResult{
		header: s, headers: n, stream: C,
		extendedGlare: Q, glareSamples: E, hb: hb,
		sigma: g.sigma, points: B,
		knownMatch: float64(c) / float64(len(g.refs)),
	}, nil
}

// wA: try decodeStream over header candidates, original then generator-whitened variant
func tryHeaders(cr *ClassResult) (*DecodeResult, error) {
	headers := cr.headers
	if len(headers) == 0 {
		headers = []Header{cr.header}
	}
	if dbg2 {
		hdr := cr.header
		if len(headers) > 0 {
			hdr = headers[0]
		}
		st := make([]float64, 0, 64)
		for i := 0; i < len(cr.stream) && i < 64; i++ {
			st = append(st, float64(cr.stream[i]))
		}
		println("GODUMP hdr", toJ(hdr), "streamLen", itoa(len(cr.stream)), "knownMatch", ftoa(cr.knownMatch), "sigma", ftoa(cr.sigma))
		println("GODUMP stream", toJ(st))
		hb := make([]float64, 0, 24)
		for _, v := range cr.hb {
			hb = append(hb, float64(v))
		}
		println("GODUMP hb", toJ(hb))
	}
	var lastErr error
	for _, r := range headers {
		for o := 0; o < 2; o++ {
			a := cr.stream
			if o == 1 {
				rnd := newRng(49374)
				a = make([]float32, len(cr.stream))
				for i, v := range cr.stream {
					if rnd.next() < .5 {
						a[i] = -v
					} else {
						a[i] = v
					}
				}
			}
			res, err := decodeStream(r, a)
			if err == nil {
				if o == 1 {
					res.Variant = "generator-whitened"
				} else {
					res.Variant = "original"
				}
				return res, nil
			}
			lastErr = err
		}
	}
	if lastErr == nil {
		lastErr = nA("header", "Header checksum did not pass")
	}
	return nil, lastErr
}

// decodeClass mA: glare-aware retry wrapper
func decodeClass(cr *ClassResult) (*DecodeResult, error) {
	res, err := tryHeadersGlare(cr)
	if err == nil {
		return res, nil
	}
	if len(cr.extendedGlare) == 0 || cr.knownMatch < .85 {
		return nil, err
	}
	r := append([]float32(nil), cr.stream...)
	for _, e := range cr.extendedGlare {
		for A := 0; A < 3; A++ {
			if e+A < len(r) {
				r[e+A] = 0
			}
		}
	}
	cr2 := *cr
	cr2.stream = r
	cr2.glareSamples = nil
	return tryHeaders(&cr2)
}

func tryHeadersGlare(cr *ClassResult) (*DecodeResult, error) {
	res, err := tryHeaders(cr)
	if err == nil {
		return res, nil
	}
	if len(cr.glareSamples) == 0 || cr.knownMatch < .85 {
		return nil, err
	}
	r := append([]float32(nil), cr.stream...)
	for _, e := range cr.glareSamples {
		t := llrOf(e.cv, 0, cr.sigma, false)
		for A := 0; A < len(t) && e.at+A < len(r); A++ {
			r[e.at+A] = float32(.001 * t[A])
		}
	}
	cr2 := *cr
	cr2.stream = r
	cr2.glareSamples = nil
	return tryHeaders(&cr2)
}
