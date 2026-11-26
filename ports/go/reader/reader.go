package main

import (
	"fmt"
	"math"
	"os"
	"sort"
)

var dbg = os.Getenv("PRISM_DEBUG") != ""

type ReadResult struct {
	*DecodeResult
	quality float64
	quad    [4][2]float64
	h       *Homography
	layout  *Layout
	sigma   float64
	radius  float64
}

type candidateH struct {
	h     *Homography
	l     *Layout
	mode  int
	quad  [4][2]float64
	white [3]float64
	rot   int
	score float64
	cost  float64
}

// inner read of readImage (mesh=true, no fusion, no known)
func readImageInner(A *ImageData) (*ReadResult, error) {
	I := frameOf(A)
	var h []candidateH
	quads, err := detectQuads(I)
	if err != nil {
		return nil, err
	}
	for _, e := range quads {
		for A2 := 0; A2 < 6; A2++ {
			r, err := layoutOf(A2)
			if err != nil {
				continue
			}
			for o := 0; o < 4; o++ {
				var i [4][2]float64
				for t := 0; t < 4; t++ {
					i[t] = e[(t+o)%4]
				}
				a, err := homography(corners(r), i)
				if err != nil {
					continue
				}
				g := I.whiteBalance(a, r)
				for e2 := 0; e2 < 2; e2++ {
					l := hypothesisScore(I, a, r, e2, g, true)
					h = append(h, candidateH{a, r, e2, i, g, o, l.score, l.cost})
				}
			}
		}
	}
	sort.SliceStable(h, func(x, y int) bool {
		if h[x].score != h[y].score {
			return h[x].score > h[y].score
		}
		return h[x].cost < h[y].cost
	})
	if len(h) > 4 {
		h = h[:4]
	}
	var lastErr error = nA("hypothesis", "Code pattern not recognized. Try better light or a closer photo.")
	for _, cand := range h {
		if err := checkBudget(); err != nil {
			return nil, err
		}
		res, err := tryCandidate(I, cand, false)
		if err == nil {
			return res, nil
		}
		if dbg {
			if se, ok := err.(*stageErr); ok {
				fmt.Fprintf(os.Stderr, "[cand size=%d mode=%d score=%.3f] stage=%s: %s\n", cand.l.size, cand.mode, cand.score, se.stage, se.msg)
			} else {
				fmt.Fprintf(os.Stderr, "[cand size=%d mode=%d score=%.3f] err=%v\n", cand.l.size, cand.mode, cand.score, err)
			}
		}
		lastErr = err
	}
	return nil, lastErr
}

func tryCandidate(I *Frame, cand candidateH, knownGiven bool) (*ReadResult, error) {
	h := cand.h
	n := cand.l
	s := cand.mode
	C := cand.quad
	E := cand.white
	// fast path for strong small candidates
	if !knownGiven && cand.score > .92 && s == 0 && n.size < 4 {
		if cr, err := classify(I, h, n, s, E, nil); err == nil {
			if w, err := decodeClass(cr); err == nil {
				d := h.delta(n.W/2, n.H/2, 1, 0)
				return &ReadResult{w, cand.score, C, h, n, cr.sigma, math.Hypot(d[0], d[1]) / n.W}, nil
			}
		}
	}
	if !knownGiven {
		var cost float64
		h, C, cost = refineQuad(I, h, n, s, C, E)
		_ = cost
		E = I.whiteBalance(h, n)
	}
	B := hypothesisScore(I, h, n, s, E, false).score
	minS := CFG.MinScore
	if s != 0 {
		minS = .75
	}
	if B < minS {
		return nil, nA("hypothesis", "Known cells do not match")
	}
	d1 := h.delta(n.W/2, n.H/2, 1, 0)
	d2 := h.delta(n.W/2, n.H/2, 0, 1)
	f := math.Min(math.Hypot(d1[0], d1[1]), math.Hypot(d2[0], d2[1]))
	minR := CFG.MinRadius
	if n.size >= 4 {
		minR = 2
	}
	if f < minR {
		return nil, nA("too small", "Too small. Move closer or use a larger image.")
	}
	var Q error
	var c *ClassResult
	var w *DecodeResult
	c, err := classify(I, h, n, s, E, nil)
	if err != nil {
		Q = err
	} else {
		w, err = decodeClass(c)
		if err != nil {
			Q = err
		}
	}
	if w == nil {
		m := buildMesh(I, h, n, s, E, nil)
		m = buildMesh(I, h, n, s, E, m)
		c, err = classify(I, h, n, s, E, m)
		if err != nil {
			Q = err
		} else {
			w, err = decodeClass(c)
			if err != nil {
				Q = err
			}
		}
	}
	if w != nil {
		return &ReadResult{w, B, C, h, n, c.sigma, f}, nil
	}
	if Q == nil {
		Q = nA("hypothesis", "Code pattern not recognized. Try better light or a closer photo.")
	}
	return nil, Q
}

// readImage (exportFallback always false in the worker fast path)
func readImage(A *ImageData) (*ReadResult, error) {
	r, err := readImageInner(A)
	if err != nil {
		return nil, err
	}
	if len(r.Bytes) == 0 && r.quality < .8 {
		return nil, nA("hypothesis", "Empty result lacks a strong code-pattern match")
	}
	return r, nil
}
