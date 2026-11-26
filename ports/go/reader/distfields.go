package main

import "math"

// PrismDistance.fields (JS fallback of the WASM path)
type DistFields struct {
	scale float64
	maps  [][]float32 // 9 maps w*h
	flatMaps []float32
	w, h  int
}

func distFields(A *ImageData) *DistFields {
	e := math.Min(1, 240/math.Max(float64(A.W), float64(A.H)))
	t := int(jsRound(float64(A.W) * e))
	r := int(jsRound(float64(A.H) * e))
	var o [3][256]uint32
	for p := 0; p < len(A.Data); p += 16 {
		for c := 0; c < 3; c++ {
			o[c][A.Data[p+c]]++
		}
	}
	a := (len(A.Data) + 15) / 16
	var lo, hi [3]int
	for c := 0; c < 3; c++ {
		acc := uint32(0)
		lo[c] = 0
		for v := 0; v < 256; v++ {
			acc += o[c][v]
			if float64(acc) >= .02*float64(a) {
				lo[c] = v
				break
			}
		}
		acc = 0
		hi[c] = 255
		for v := 0; v < 256; v++ {
			acc += o[c][v]
			if float64(acc) >= .98*float64(a) {
				hi[c] = v
				break
			}
		}
	}
	g := make([][]float32, 9)
	for i := range g {
		g[i] = make([]float32, t*r)
		for j := range g[i] {
			g[i][j] = 1e3
		}
	}
	memo := map[uint32]int{}
	for oo := 0; oo < r; oo++ {
		for rr := 0; rr < t; rr++ {
			idx := 4 * (int(float64(oo)/e)*A.W + int(float64(rr)/e))
			var I [3]float64
			for c := 0; c < 3; c++ {
				I[c] = clampf((float64(A.Data[idx+c])-float64(lo[c]))/math.Max(20, float64(hi[c]-lo[c])), 0, 1)
			}
			key := uint32(32*(32*int(jsRound(31*I[0]))+int(jsRound(31*I[1]))) + int(jsRound(31*I[2])))
			n, ok := memo[key]
			if !ok {
				lin := [3]float64{srgbLin(I[0]), srgbLin(I[1]), srgbLin(I[2])}
				n, _ = nearestSymbolOf(lin, 0)
				memo[key] = n
			}
			g[n][oo*t+rr] = 0
		}
	}
	// two-pass chamfer for each symbol map, then inverse distance + combine
	for _, A2 := range g {
		for e2 := 0; e2 < r; e2++ {
			for r2 := 0; r2 < t; r2++ {
				o2 := e2*t + r2
				av := A2[o2]
				if r2 > 0 {
					av = float32(math.Min(float64(av), float64(A2[o2-1])+1))
				}
				if e2 > 0 {
					av = float32(math.Min(float64(av), float64(A2[o2-t])+1))
				}
				if r2 > 0 && e2 > 0 {
					av = float32(math.Min(float64(av), float64(A2[o2-t-1])+1.414))
				}
				if r2 < t-1 && e2 > 0 {
					av = float32(math.Min(float64(av), float64(A2[o2-t+1])+1.414))
				}
				A2[o2] = av
			}
		}
		for e2 := r - 1; e2 >= 0; e2-- {
			for o2 := t - 1; o2 >= 0; o2-- {
				av := A2[e2*t+o2]
				if o2 < t-1 {
					av = float32(math.Min(float64(av), float64(A2[e2*t+o2+1])+1))
				}
				if e2 < r-1 {
					av = float32(math.Min(float64(av), float64(A2[(e2+1)*t+o2])+1))
				}
				if o2 < t-1 && e2 < r-1 {
					av = float32(math.Min(float64(av), float64(A2[(e2+1)*t+o2+1])+1.414))
				}
				if o2 > 0 && e2 < r-1 {
					av = float32(math.Min(float64(av), float64(A2[(e2+1)*t+o2-1])+1.414))
				}
				A2[e2*t+o2] = av
			}
		}
		// inverse field: distance from non-zero cells
		e3 := make([]float32, len(A2))
		for i, v := range A2 {
			if v == 0 {
				e3[i] = 1e3
			}
		}
		for A3 := 0; A3 < r; A3++ {
			for r2 := 0; r2 < t; r2++ {
				o2 := A3*t + r2
				av := e3[o2]
				if r2 > 0 {
					av = float32(math.Min(float64(av), float64(e3[o2-1])+1))
				}
				if A3 > 0 {
					av = float32(math.Min(float64(av), float64(e3[o2-t])+1))
				}
				if r2 > 0 && A3 > 0 {
					av = float32(math.Min(float64(av), float64(e3[o2-t-1])+1.414))
				}
				if r2 < t-1 && A3 > 0 {
					av = float32(math.Min(float64(av), float64(e3[o2-t+1])+1.414))
				}
				e3[o2] = av
			}
		}
		for A3 := r - 1; A3 >= 0; A3-- {
			for o2 := t - 1; o2 >= 0; o2-- {
				av := e3[A3*t+o2]
				if o2 < t-1 {
					av = float32(math.Min(float64(av), float64(e3[A3*t+o2+1])+1))
				}
				if A3 < r-1 {
					av = float32(math.Min(float64(av), float64(e3[(A3+1)*t+o2])+1))
				}
				if o2 < t-1 && A3 < r-1 {
					av = float32(math.Min(float64(av), float64(e3[(A3+1)*t+o2+1])+1.414))
				}
				if o2 > 0 && A3 < r-1 {
					av = float32(math.Min(float64(av), float64(e3[(A3+1)*t+o2-1])+1.414))
				}
				e3[A3*t+o2] = av
			}
		}
		for i := range A2 {
			A2[i] = A2[i]/.6 + .7*float32(math.Max(0, 1.7-float64(e3[i])/.6))
		}
	}
	return &DistFields{scale: e, maps: g, w: t, h: r}
}

func (d *DistFields) at(A int, o, a float64) float64 {
	a *= d.scale
	o *= d.scale
	if o < 0 || a < 0 || o >= float64(d.w-1) || a >= float64(d.h-1) {
		return 12
	}
	i := int(math.Floor(o))
	l := int(math.Floor(a))
	I := o - float64(i)
	h := a - float64(l)
	n := d.maps[A]
	s := l*d.w + i
	return float64(n[s])*(1-I)*(1-h) + float64(n[s+1])*I*(1-h) + float64(n[s+d.w])*(1-I)*h + float64(n[s+d.w+1])*I*h
}

// flatMaps caches the 9 planes as one contiguous f32 slice (WASM marshalling layout).
func (d *DistFields) flat() []float32 {
	if d.flatMaps == nil {
		d.flatMaps = make([]float32, 0, 9*d.w*d.h)
		for _, p := range d.maps {
			d.flatMaps = append(d.flatMaps, p...)
		}
	}
	return d.flatMaps
}
