package main

// PrismLocal.normalize JS fallback: per-channel (v - p2) / (erosion - p2)
import "math"
func normalizeLocal(A *ImageData) *ImageData {
	e, t := A.W, A.H
	r := A.Data
	var o [3][256]uint32
	a := make([][]float32, 3)
	for c := 0; c < 3; c++ {
		a[c] = make([]float32, e*t)
	}
	for p := 0; p < len(r); p += 4 {
		for c := 0; c < 3; c++ {
			o[c][r[p+c]]++
			a[c][p/4] = float32(r[p+c])
		}
	}
	var ii [3]int
	for c := 0; c < 3; c++ {
		acc := uint32(0)
		for v := 0; v < 256; v++ {
			acc += o[c][v]
			if float64(acc) > float64(e*t)*.02 {
				ii[c] = v
				break
			}
		}
	}
	rad := int(jsRound(.035 * float64(min(e, t))))
	erode := func(A []float32) []float32 {
		// two-pass min filter, radius rad, clamped borders (JS deque version)
		o := make([]float32, len(A))
		out := make([]float32, len(A))
		n := max(e, t) + 2*rad + 1
		g := make([]int, n)
		l := make([]float32, n)
		clampi := func(x, lo, hi int) int {
			if x < lo {
				return lo
			}
			if x > hi {
				return hi
			}
			return x
		}
		for a2 := 0; a2 < t; a2++ {
			head, tail := 0, 0
			I := a2 * e
			for aa := -rad; aa < e+rad; aa++ {
				h := A[I+clampi(aa, 0, e-1)]
				for tail > head && l[tail-1] <= h {
					tail--
				}
				g[tail] = aa
				l[tail] = h
				tail++
				for g[head] < aa-2*rad {
					head++
				}
				if aa >= rad {
					o[I+aa-rad] = l[head]
				}
			}
		}
		for A2 := 0; A2 < e; A2++ {
			head, tail := 0, 0
			for h2 := -rad; h2 < t+rad; h2++ {
				n := o[clampi(h2, 0, t-1)*e+A2]
				for tail > head && l[tail-1] <= n {
					tail--
				}
				g[tail] = h2
				l[tail] = n
				tail++
				for g[head] < h2-2*rad {
					head++
				}
				if h2 >= rad {
					out[(h2-rad)*e+A2] = l[head]
				}
			}
		}
		return out
	}
	g := make([][]float32, 3)
	for c := 0; c < 3; c++ {
		g[c] = erode(a[c])
	}
	out := &ImageData{W: e, H: t, Data: make([]uint8, 4*e*t)}
	for p := 0; p < e*t; p++ {
		for c := 0; c < 3; c++ {
			den := float64(g[c][p]) - float64(ii[c])
			if den < 30 {
				den = 30
			}
			v := 255 * (float64(a[c][p]) - float64(ii[c])) / den
			out.Data[4*p+c] = uint8(clampf(math.RoundToEven(v), 0, 255))
		}
		out.Data[4*p+3] = 255
	}
	return out
}
