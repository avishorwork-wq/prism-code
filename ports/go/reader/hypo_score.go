package main

import "math"

// hypo_wasm.go: port of wasm0 (PrismHypo422 "score"). See ~/work/reader/wasm/wasm0.dcmp.
// Per known cell: sample 7 taps (or 1 when fast) via homography, per-channel median,
// RGB->Lab, distance to palette. Returns cost = mean min(sqrt(d2_expected)/30,1),
// score = fraction of cells whose nearest palette color == expected symbol.

func truncSatI32(x float64) int {
	if x != x {
		return 0
	}
	if x >= 2147483647 {
		return 2147483647
	}
	if x <= -2147483648 {
		return -2147483648
	}
	return int(x)
}

func hypoWasmScore(pix []float32, w, h int, hom [8]float64, white [3]float64, cells [][3]float64, lab [27]float64, off [14]float64, fast bool, mode int) (float64, float64) {
	g := len(cells)
	var o, n float64
	if g < 1 {
		return o / float64(g), n / float64(g) // NaN like WASM
	}
	zw := float64(w - 1)
	zh := float64(h - 1)
	taps := 7
	if fast {
		taps = 1
	}
	for _, cell := range cells {
		var m [21]float64
		for t := 0; t < taps; t++ {
			X := cell[0] + off[2*t]
			Y := cell[1] + off[2*t+1]
			den := X*hom[6] + Y*hom[7] + 1.0
			wa := (hom[2] + X*hom[0] + Y*hom[1]) / den
			ta := (hom[5] + X*hom[3] + Y*hom[4]) / den
			sa, va, ua := 1.0, 1.0, 1.0 // B, G, R
			if !(wa < 0) && !(ta < 0) && !(wa >= zw) && !(ta >= zh) {
				x0 := truncSatI32(wa)
				y0 := truncSatI32(ta)
				ya := ta - float64(y0) // fracY
				za := 1 - ya
				fx := wa - float64(x0)
				ux := 1 - fx
				base := 3 * (y0*w + x0)
				row2 := base + 3*w
				p := func(off int) float64 { return float64(pix[off]) }
				sa = za*(ux*p(base+2)+fx*p(base+5)) + ya*(ux*p(row2+2)+fx*p(row2+5))
				va = za*(ux*p(base+1)+fx*p(base+4)) + ya*(ux*p(row2+1)+fx*p(row2+4))
				ua = za*(ux*p(base+0)+fx*p(base+3)) + ya*(ux*p(row2+0)+fx*p(row2+3))
			}
			m[t] = ua / white[0]
			m[7+t] = va / white[1]
			m[14+t] = sa / white[2]
		}
		var r, gg, b float64
		if fast {
			r, gg, b = m[0], m[7], m[14]
		} else {
			insSort7(m[0:7])
			insSort7(m[7:14])
			insSort7(m[14:21])
			r, gg, b = m[3], m[10], m[17]
		}
		wa := 0x1.b38dd971f6bd6p-3*r + 0x1.6e286ddd532cdp-1*gg + 0x1.27a0f9096bb99p-4*b
		va := 0x1.3cc4410d1089cp-6*r + 0x1.e835dedf1e083p-4*gg + 0x1.e68e424d8269dp-1*b
		ta := (0x1.a65af8741a841p-2*r + 0x1.6e286ddd532cdp-2*gg + 0x1.7189374bc6a7fp-3*b) / 0x1.e6a400fba8827p-1
		f := func(q float64) float64 {
			if q > 0x1.2231832fcac8ep-7 {
				return cbrtV8(q)
			}
			return q*0x1.f25e353f7ced9p+2 + 0x1.1a7b9611a7b96p-3
		}
		ua := f(ta)
		wa = f(wa)
		sa := f(va / 0x1.16bd9018e7579p+0)
		L := wa*116.0 - 16.0
		A := (ua - wa) * 500.0
		B := (wa - sa) * 200.0
		dist := func(i int) float64 {
			d0 := L - lab[3*i]
			d1 := A - lab[3*i+1]
			d2 := B - lab[3*i+2]
			return d0*d0 + d1*d1 + d2*d2
		}
		sa = dist(0)
		c := 0
		vb := sa
		if !(sa < math.Inf(1)) {
			c = -1
			vb = math.Inf(1)
		}
		exp := truncSatI32(cell[2])
		if exp != 0 {
			sa = 0.0
		}
		if mode == 0 {
			best, bi := vb, c
			for i := 1; i <= 7; i++ {
				if d := dist(i); d < best {
					best, bi = d, i
				}
			}
			c, vb = bi, best
			if exp >= 1 && exp <= 7 {
				sa = dist(exp)
			}
		}
		d8 := dist(8)
		if exp == 8 {
			sa = d8
		}
		ua = math.Sqrt(sa) / 30.0
		if ua < 1.0 {
			o += ua
		} else {
			o += 1.0
		}
		cf := c
		if d8 < vb {
			cf = 8
		}
		if cf == exp {
			n += 1.0
		}
	}
	return o / float64(g), n / float64(g)
}

// insertion sort, NaN-tolerant like the WASM compare network (NaN stops the scan)
func insSort7(s []float64) {
	for i := 1; i < len(s); i++ {
		v := s[i]
		j := i - 1
		for j >= 0 && s[j] > v {
			s[j+1] = s[j]
			j--
		}
		s[j+1] = v
	}
}
