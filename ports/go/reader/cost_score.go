package main

import (
	"math"
	"sort"
)

// cost_score.go: port of wasm2 (PrismCostWasm "score") - DistFit candidate scoring.
// See ~/work/reader/wasm/wasm2.dcmp.

// f_d: warp + homography map. a=homography(8), b=warp params(13), c=W, d=H, e=kind, f,g=point.
func warpHomMap(a [8]float64, b *[13]float64, c, d float64, e int, f, g float64) (float64, float64) {
	if e != 0 {
		i := (g+g)/d + -1.0
		j := (f+f)/c + -1.0
		if e != 2 {
			dd := 1.0 - j*j
			cc := 1.0 - i*i
			g = g + dd*b[5] + cc*(b[3]+j*b[4]) + dd*i*b[7] + cc*i*b[9]
			f = f + cc*b[2] + dd*(b[0]+i*b[1]) + dd*j*b[6] + cc*j*b[8]
		} else {
			sel := truncSatI32(b[3])
			x := j
			if sel != 0 {
				x = i
			}
			g0 := b[0]
			if g0 > 0x1.8cccccccccccdp+0 {
				g0 = 0x1.8cccccccccccdp+0
			}
			if g0 < 0x1.0624dd2f1a9fcp-10 {
				g0 = 0x1.0624dd2f1a9fcp-10
			}
			f = x * g0
			k := math.Cos(f)
			l := math.Cos(g0)
			gg := k - l
			f2 := b[2]*gg + 1.0
			if f2 < 0x1.3333333333333p-2 {
				f2 = 0x1.3333333333333p-2
			}
			k2 := (math.Sin(f)/math.Sin(g0) + gg*b[1]) / f2
			xj := i
			if sel != 0 {
				xj = j
			}
			l2 := (xj + gg*b[4]) / f2
			A := l2
			Bv := k2
			if sel != 0 {
				A = k2
				Bv = l2
			}
			djj := 1.0 - j*j
			dii := 1.0 - i*i
			g = d*0x1p-1*(A+1.0) + djj*b[9] + dii*b[10] + i*djj*b[11] + i*dii*b[12]
			f = c*0x1p-1*(Bv+1.0) + djj*b[5] + dii*b[6] + j*djj*b[7] + j*dii*b[8]
		}
	}
	den := f*a[6] + g*a[7] + 1.0
	return (a[2] + f*a[0] + g*a[1]) / den, (a[5] + f*a[3] + g*a[4]) / den
}

// bilinear sample of an f32 plane (w x h) at (x, y); exact WASM expression.
func bilinPlane(plane []float32, w int, x, y float64) float64 {
	x0 := truncSatI32(x)
	y0 := truncSatI32(y)
	fy := y - float64(y0)
	fx := x - float64(x0)
	base := w*y0 + x0
	p00 := float64(plane[base])
	p10 := float64(plane[base+1])
	p01 := float64(plane[base+w])
	p11 := float64(plane[base+w+1])
	return (1.0-fy)*((1.0-fx)*p00+fx*p10) + fy*((1.0-fx)*p01+fx*p11)
}

// costWasmScore: wasm2 score(). maps: 9 f32 planes w*h. cells: (x,y,symbol).
// extra: flat (x,y) pairs. flag: plain mean mode (rank). B: trim fraction (0.85).
func costWasmScore(hom [8]float64, warp *[13]float64, W, H float64, kind int, maps []float32, w, h int, scale float64, cells [][3]float64, extra []float64, flag bool, B float64) float64 {
	k := len(cells)
	planeSize := w * h
	r := 64.0
	if flag {
		r = 25.0
	}
	u := float64(w - 1)
	t := float64(h - 1)
	ys := make([]float64, 0, k)
	x := 0.0
	if k >= 1 {
		for _, cell := range cells {
			fx, fy := warpHomMap(hom, warp, W, H, kind, cell[0], cell[1])
			y := 144.0
			z := scale * fx
			aa := scale * fy
			if !(z < 0.0) && !(aa < 0.0) && !(z >= u) && !(aa >= t) {
				pl := truncSatI32(cell[2])
				plane := maps[pl*planeSize:]
				y = bilinPlane(plane, w, z, aa)
				y = y * y
			}
			if y > r {
				y = r
			}
			ys = append(ys, y)
			if flag {
				x += y
			}
		}
		if flag {
			return x / float64(k)
		}
	} else {
		if flag {
			return x / float64(k)
		}
	}
	sort.Float64s(ys)
	ea := truncSatI32(B * float64(k))
	if ea >= 1 {
		for i := 0; i < ea; i++ {
			x += ys[i]
		}
	}
	m := len(extra) / 2
	ga := m / 24
	var ia float64
	v := 0
	for da := 0; da < 24; da++ {
		var aa, rr float64
		if m >= 24 {
			for wc := 0; wc < ga; wc++ {
				px, py := extra[v], extra[v+1]
				fx, fy := warpHomMap(hom, warp, W, H, kind, px, py)
				y := 144.0
				z := 144.0
				u2 := scale * fx
				t2 := scale * fy
				if !(u2 < 0.0) && !(t2 < 0.0) && !(u2 >= u) && !(t2 >= t) {
					y = bilinPlane(maps[8*planeSize:], w, u2, t2)
					y = y * y
					z = bilinPlane(maps, w, u2, t2)
					z = z * z
				}
				v += 2
				if z > 36.0 {
					z = 36.0
				}
				if y > 36.0 {
					y = 36.0
				}
				rr += z
				aa += y
			}
		}
		if aa < rr {
			ia += aa
		} else {
			ia += rr
		}
	}
	return x/float64(ea) + ia/72.0*0x1.6666666666666p-2
}
