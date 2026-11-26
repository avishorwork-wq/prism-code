package main

import (
	"math"
	"sort"
)

// srgbQ table for QL
var qtTable [8194]float64

func init() {
	for k := 0; k < 8194; k++ {
		qtTable[k] = srgbQ(float64(k) / 8192)
	}
}

func QL(v float64) float64 {
	if !(v < 1) {
		return srgbQ(v)
	}
	u := v * 8192
	k := int(u)
	return qtTable[k] + (qtTable[k+1]-qtTable[k])*(u-float64(k))
}

// jsRound: Math.round (half up)
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// morph oA (radius r, square 2r+1 separable); or=true -> dilate(max), false -> erode(min)
func morph(A []uint8, w, h, r int, or bool) []uint8 {
	a := make([]uint8, len(A))
	out := make([]uint8, len(A))
	clampi := func(x, lo, hi int) int {
		if x < lo {
			return lo
		}
		if x > hi {
			return hi
		}
		return x
	}
	for i := 0; i < h; i++ {
		for t := 0; t < w; t++ {
			g := uint8(1)
			if or {
				g = 0
			}
			for aa := -r; aa <= r; aa++ {
				rr := clampi(t+aa, 0, w-1)
				if or {
					if A[i*w+rr] != 0 {
						g = 1
					}
				} else {
					if A[i*w+rr] == 0 {
						g = 0
					}
				}
			}
			a[i*w+t] = g
		}
	}
	for i := 0; i < w; i++ {
		for gg := 0; gg < h; gg++ {
			l := uint8(1)
			if or {
				l = 0
			}
			for aa := -r; aa <= r; aa++ {
				rr := clampi(gg+aa, 0, h-1)
				if or {
					if a[rr*w+i] != 0 {
						l = 1
					}
				} else {
					if a[rr*w+i] == 0 {
						l = 0
					}
				}
			}
			out[gg*w+i] = l
		}
	}
	return out
}

// smooth aA (float32 box blur or max-filter), radius r
func smooth(A []float32, w, h, r int, maxMode bool) []float32 {
	a := make([]float32, len(A))
	out := make([]float32, len(A))
	clampi := func(x, lo, hi int) int {
		if x < lo {
			return lo
		}
		if x > hi {
			return hi
		}
		return x
	}
	for i := 0; i < h; i++ {
		if maxMode {
			type xv struct {
				x int
				v float32
			}
			var dq []xv
			head := 0
			for hh := -r; hh < w+r; hh++ {
				n := A[i*w+clampi(hh, 0, w-1)]
				for len(dq) > head && dq[len(dq)-1].v <= n {
					dq = dq[:len(dq)-1]
				}
				dq = append(dq, xv{hh, n})
				for dq[head].x < hh-2*r {
					head++
				}
				if hh >= r {
					a[i*w+hh-r] = dq[head].v
				}
			}
		} else {
			l := float32(0)
			for hh := -r; hh < w+r; hh++ {
				l += A[i*w+clampi(hh, 0, w-1)]
				if hh > r {
					l -= A[i*w+clampi(hh-2*r-1, 0, w-1)]
				}
				if hh >= r {
					a[i*w+hh-r] = l / float32(2*r+1)
				}
			}
		}
	}
	for i := 0; i < w; i++ {
		if maxMode {
			type yv struct {
				y int
				v float32
			}
			var dq []yv
			head := 0
			for nn := -r; nn < h+r; nn++ {
				s := a[clampi(nn, 0, h-1)*w+i]
				for len(dq) > head && dq[len(dq)-1].v <= s {
					dq = dq[:len(dq)-1]
				}
				dq = append(dq, yv{nn, s})
				for dq[head].y < nn-2*r {
					head++
				}
				if nn >= r {
					out[(nn-r)*w+i] = dq[head].v
				}
			}
		} else {
			l := float32(0)
			for nn := -r; nn < h+r; nn++ {
				l += a[clampi(nn, 0, h-1)*w+i]
				if nn > r {
					l -= a[clampi(nn-2*r-1, 0, h-1)*w+i]
				}
				if nn >= r {
					out[(nn-r)*w+i] = l / float32(2*r+1)
				}
			}
		}
	}
	return out
}

// convex hull tA
func crossz(A, B, C [2]float64) float64 {
	return (B[0]-A[0])*(C[1]-A[1]) - (B[1]-A[1])*(C[0]-A[0])
}

func convexHull(pts [][2]float64) [][2]float64 {
	sort.SliceStable(pts, func(a, b int) bool {
		if pts[a][0] != pts[b][0] {
			return pts[a][0] < pts[b][0]
		}
		return pts[a][1] < pts[b][1]
	})
	var e, t [][2]float64
	for _, p := range pts {
		for len(e) > 1 && crossz(e[len(e)-2], e[len(e)-1], p) <= 0 {
			e = e[:len(e)-1]
		}
		e = append(e, p)
	}
	for i := len(pts) - 1; i >= 0; i-- {
		p := pts[i]
		for len(t) > 1 && crossz(t[len(t)-2], t[len(t)-1], p) <= 0 {
			t = t[:len(t)-1]
		}
		t = append(t, p)
	}
	if len(e) > 0 {
		e = e[:len(e)-1]
	}
	if len(t) > 0 {
		t = t[:len(t)-1]
	}
	return append(e, t...)
}

// polygon area rA
func polyArea(A [][2]float64) float64 {
	s := 0.0
	for i := range A {
		j := (i + 1) % len(A)
		s += A[i][0]*A[j][1] - A[i][1]*A[j][0]
	}
	return math.Abs(s) / 2
}

// line fit iA (PCA)
func lineFit(A [][2]float64) [3]float64 {
	var e, t float64
	for _, p := range A {
		e += p[0]
		t += p[1]
	}
	e /= float64(len(A))
	t /= float64(len(A))
	var r, o, a float64
	for _, p := range A {
		dx, dy := p[0]-e, p[1]-t
		r += dx * dx
		o += dx * dy
		a += dy * dy
	}
	i := .5 * math.Atan2(2*o, r-a)
	g := -math.Sin(i)
	l := math.Cos(i)
	return [3]float64{g, l, g*e + l*t}
}

// line intersection gA
func lineIntersect(A, B [3]float64) ([2]float64, error) {
	t := A[0]*B[1] - A[1]*B[0]
	if math.Abs(t) < 1e-6 {
		return [2]float64{}, errG("Parallel edges")
	}
	return [2]float64{(A[2]*B[1] - A[1]*B[2]) / t, (A[0]*B[2] - A[2]*B[0]) / t}, nil
}

type blob struct {
	hu       [][2]float64
	tail     int
	boundary [][2]float64
	ar       float64
}

// extract blobs from a mask (w x h); returns sorted-by-area-desc candidates
func extractBlobs(mask []uint8, w, h int) []blob {
	visited := make([]uint8, len(mask))
	queue := make([]int, len(mask))
	var out []blob
	for A := 0; A < len(mask); A++ {
		if mask[A] == 0 || visited[A] != 0 {
			continue
		}
		e, t := 0, 1
		var boundary [][2]float64
		queue[0] = A
		visited[A] = 1
		for e < t {
			cur := queue[e]
			e++
			i := cur % w
			g := cur / w
			isB := false
			nb := [4]int{-1, -1, -1, -1}
			if i > 0 {
				nb[0] = cur - 1
			}
			if i < w-1 {
				nb[1] = cur + 1
			}
			if g > 0 {
				nb[2] = cur - w
			}
			if g < h-1 {
				nb[3] = cur + w
			}
			for _, nn := range nb {
				if nn < 0 || mask[nn] == 0 {
					isB = true
				} else if visited[nn] == 0 {
					visited[nn] = 1
					queue[t] = nn
					t++
				}
			}
			if isB {
				boundary = append(boundary, [2]float64{float64(i), float64(g)})
			}
		}
		if t < 100 {
			continue
		}
		hu := convexHull(append([][2]float64(nil), boundary...))
		ar := polyArea(hu)
		var xs, ys []float64
		for _, p := range hu {
			xs = append(xs, p[0])
			ys = append(ys, p[1])
		}
		minx, maxx := xs[0], xs[0]
		miny, maxy := ys[0], ys[0]
		for _, v := range xs {
			if v < minx {
				minx = v
			}
			if v > maxx {
				maxx = v
			}
		}
		for _, v := range ys {
			if v < miny {
				miny = v
			}
			if v > maxy {
				maxy = v
			}
		}
		Q := (maxx - minx) / (maxy - miny)
		if float64(t)/ar < .04 || Q < .4 || Q > 2.5 {
			continue
		}
		out = append(out, blob{hu, t, boundary, ar})
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].ar > out[b].ar })
	return out
}

// quadFitVariant3: polygon simplify (.7 break) + 4 longest edges + line refit + intersect
func quadFitVariant3(A *blob, scale float64) ([][2]float64, bool) {
	t := append([][2]float64(nil), A.hu...)
	for len(t) > 4 {
		best := math.Inf(1)
		bestI := 0
		for r := 0; r < len(t); r++ {
			o := t[(r+len(t)-1)%len(t)]
			a := t[(r+1)%len(t)]
			i := math.Abs(crossz(o, t[r], a)) / math.Hypot(a[0]-o[0], a[1]-o[1])
			if i < best {
				best = i
				bestI = r
			}
		}
		if best > .7 {
			break
		}
		t = append(t[:bestI], t[bestI+1:]...)
	}
	type edge struct {
		a, b [2]float64
		i    int
		len  float64
	}
	var edges []edge
	for e := 0; e < len(t); e++ {
		b := t[(e+1)%len(t)]
		edges = append(edges, edge{t[e], b, e, math.Hypot(t[e][0]-b[0], t[e][1]-b[1])})
	}
	sort.SliceStable(edges, func(x, y int) bool { return edges[x].len > edges[y].len })
	if len(edges) < 4 {
		return nil, false
	}
	edges = edges[:4]
	sort.SliceStable(edges, func(x, y int) bool { return edges[x].i < edges[y].i })
	var lines [][3]float64
	for e := 0; e < 4; e++ {
		a := edges[e].a
		b := edges[e].b
		i := b[0] - a[0]
		g := b[1] - a[1]
		l := math.Hypot(i, g)
		var pts [][2]float64
		for _, p := range A.boundary {
			if math.Abs(crossz(a, b, p))/l < 2 {
				pts = append(pts, p)
			}
		}
		if len(pts) >= 2 {
			lines = append(lines, lineFit(pts))
		} else {
			lines = append(lines, lineFit([][2]float64{a, b}))
		}
	}
	var quad [][2]float64
	for e := 0; e < 4; e++ {
		p, err := lineIntersect(lines[(e+3)%4], lines[e])
		if err != nil {
			return nil, false
		}
		quad = append(quad, [2]float64{(p[0] + .5) / scale, (p[1] + .5) / scale})
	}
	return quad, true
}

// quadFitMinAreaRect: rotating calipers over hull
func quadFitMinAreaRect(A *blob, scale float64) ([][2]float64, bool) {
	best := math.Inf(1)
	var bestQuad [][2]float64
	for o := 0; o < len(A.hu); o++ {
		a := A.hu[o]
		i := A.hu[(o+1)%len(A.hu)]
		g := i[0] - a[0]
		l := i[1] - a[1]
		I := math.Hypot(g, l)
		g /= I
		l /= I
		var hs, ns []float64
		for _, p := range A.hu {
			hs = append(hs, p[0]*g+p[1]*l)
			ns = append(ns, -p[0]*l+p[1]*g)
		}
		s, C := hs[0], hs[0]
		Q, E := ns[0], ns[0]
		for _, v := range hs {
			if v < s {
				s = v
			}
			if v > C {
				C = v
			}
		}
		for _, v := range ns {
			if v < Q {
				Q = v
			}
			if v > E {
				E = v
			}
		}
		B := (C - s) * (E - Q)
		if B < best {
			best = B
			corners := [4][2]float64{{s, Q}, {C, Q}, {C, E}, {s, E}}
			bestQuad = make([][2]float64, 4)
			for k, c := range corners {
				bestQuad[k] = [2]float64{(c[0]*g - c[1]*l + .5) / scale, (c[0]*l + c[1]*g + .5) / scale}
			}
		}
	}
	if bestQuad == nil {
		return nil, false
	}
	return bestQuad, true
}

// quadFitVariant2: simplify-to-4 (no .7 break) + per-edge refit along hull chain + area check
func quadFitVariant2(A *blob, scale float64) (quads [][2]float64, extra [][2]float64, hasExtra bool) {
	o := append([][2]float64(nil), A.hu...)
	for len(o) > 4 {
		best := math.Inf(1)
		bestI := 0
		for t := 0; t < len(o); t++ {
			r := o[(t+len(o)-1)%len(o)]
			a := o[(t+1)%len(o)]
			i := math.Abs(crossz(r, o[t], a)) / math.Max(.1, math.Hypot(a[0]-r[0], a[1]-r[1]))
			if i < best {
				best = i
				bestI = t
			}
		}
		o = append(o[:bestI], o[bestI+1:]...)
	}
	if len(o) != 4 {
		return nil, nil, false
	}
	quads = make([][2]float64, 4)
	for i, p := range o {
		quads[i] = [2]float64{(p[0] + .5) / scale, (p[1] + .5) / scale}
	}
	// extra: refit lines along hull chain between the 4 corners
	var lines [][3]float64
	for e := 0; e < 4; e++ {
		r := o[e]
		a := o[(e+1)%4]
		fi, gj := -1, -1
		for k, p := range A.hu {
			if p[0] == r[0] && p[1] == r[1] {
				fi = k
			}
			if p[0] == a[0] && p[1] == a[1] {
				gj = k
			}
		}
		if fi < 0 || gj < 0 {
			return quads, nil, false
		}
		var lp [2][2]float64
		I := 0.0
		found := false
		for e2 := fi; e2 != gj; e2 = (e2 + 1) % len(A.hu) {
			t := A.hu[e2]
			r2 := A.hu[(e2+1)%len(A.hu)]
			oo := math.Hypot(t[0]-r2[0], t[1]-r2[1])
			if oo > I {
				I = oo
				lp = [2][2]float64{t, r2}
				found = true
			}
		}
		h, n := r, a
		if found {
			h, n = lp[0], lp[1]
		}
		var pts [][2]float64
		for _, p := range A.boundary {
			if math.Abs(crossz(h, n, p))/math.Max(1, I) < 2 {
				pts = append(pts, p)
			}
		}
		if len(pts) > 2 {
			lines = append(lines, lineFit(pts))
		} else {
			lines = append(lines, lineFit([][2]float64{h, n}))
		}
	}
	var quad [][2]float64
	ok := true
	for e := 0; e < 4; e++ {
		p, err := lineIntersect(lines[(e+3)%4], lines[e])
		if err != nil {
			ok = false
			break
		}
		quad = append(quad, p)
	}
	if ok {
		ar := polyArea(quad)
		if ar > .6*A.ar && ar < 1.5*A.ar {
			extra = make([][2]float64, 4)
			for i, p := range quad {
				extra[i] = [2]float64{(p[0] + .5) / scale, (p[1] + .5) / scale}
			}
			hasExtra = true
		}
	}
	return quads, extra, hasExtra
}

// segMask: shared downscale + saturation/darkness segmentation (detect & detectCurved)
func segMask(A *Frame) ([]uint8, int, int, float64) {
	e := math.Min(1, CFG.DetectionWidth/math.Max(float64(A.w), float64(A.h)))
	r := int(jsRound(float64(A.w) * e))
	o := int(jsRound(float64(A.h) * e))
	a := make([]float32, r*o)
	i := make([]float32, r*o)
	P := A.p
	W3 := 3 * A.w
	XM := float64(A.w - 1)
	YM := float64(A.h - 1)
	for t := 0; t < o; t++ {
		Y := float64(t) / e
		for oo := 0; oo < r; oo++ {
			X := float64(oo) / e
			var l, I float64
			if X < 0 || Y < 0 || X >= XM || Y >= YM {
				l = 1
				I = 1
			} else {
				x0 := int(math.Floor(X))
				y0 := int(math.Floor(Y))
				fx := X - float64(x0)
				fy := Y - float64(y0)
				b := 3 * (y0*A.w + x0)
				c0 := (float64(P[b])*(1-fx) + float64(P[b+3])*fx) * (1 - fy)
				c0 += (float64(P[b+W3])*(1-fx) + float64(P[b+W3+3])*fx) * fy
				c1 := (float64(P[b+1])*(1-fx) + float64(P[b+4])*fx) * (1 - fy)
				c1 += (float64(P[b+W3+1])*(1-fx) + float64(P[b+W3+4])*fx) * fy
				c2 := (float64(P[b+2])*(1-fx) + float64(P[b+5])*fx) * (1 - fy)
				c2 += (float64(P[b+W3+2])*(1-fx) + float64(P[b+W3+5])*fx) * fy
				l = math.Max(c0, math.Max(c1, c2))
				I = math.Min(c0, math.Min(c1, c2))
				ql := QL(l)
				if I == l {
					I = ql
				} else {
					I = QL(I)
				}
				l = ql
			}
			a[t*r+oo] = float32(l)
			if l != 0 {
				i[t*r+oo] = float32((l - I) / l)
			}
		}
	}
	g := smooth(smooth(a, r, o, 7, true), r, o, 15, false)
	I := make([]uint8, r*o)
	for k := 0; k < len(I); k++ {
		if (i[k] > float32(CFG.Saturation) && a[k] > .15) || a[k] < float32(CFG.Darkness)*float32(math.Max(float64(g[k]), .4)) {
			I[k] = 1
		}
	}
	I = morph(morph(I, r, o, 2, true), r, o, 2, false)
	return I, r, o, e
}

// detect lA
func detectQuads(A *Frame) ([][4][2]float64, error) {
	mask, r, o, e := segMask(A)
	_ = r
	_ = o
	blobs := extractBlobs(mask, r, o)
	if len(blobs) == 0 {
		return nil, nA("detect", "No code found. Use a plain background with a wide white margin.")
	}
	var C [][4][2]float64
	for bi := 0; bi < len(blobs) && bi < 3; bi++ {
		b := &blobs[bi]
		if q, ok := quadFitVariant3(b, e); ok {
			var qq [4][2]float64
			copy(qq[:], q)
			C = append(C, qq)
		}
	}
	if len(C) == 0 {
		return nil, nA("detect", "Could not fit four edges")
	}
	return C, nil
}

// detectCurved
func detectCurvedQuads(A *Frame) ([][4][2]float64, error) {
	mask, r, o, e := segMask(A)
	blobs := extractBlobs(mask, r, o)
	if len(blobs) == 0 {
		return nil, nA("detect", "No code found. Use a plain background with a wide white margin.")
	}
	var C [][4][2]float64
	for bi := 0; bi < len(blobs) && bi < 3; bi++ {
		b := &blobs[bi]
		if q, ok := quadFitMinAreaRect(b, e); ok {
			var qq [4][2]float64
			copy(qq[:], q)
			C = append(C, qq)
		}
		if q, extra, hasExtra := quadFitVariant2(b, e); q != nil {
			var qq [4][2]float64
			copy(qq[:], q)
			C = append(C, qq)
			if hasExtra {
				var eq [4][2]float64
				copy(eq[:], extra)
				C = append(C, eq)
			}
		}
		if q, ok := quadFitVariant3(b, e); ok {
			var qq [4][2]float64
			copy(qq[:], q)
			C = append(C, qq)
		}
	}
	if len(C) == 0 {
		return nil, nA("detect", "Could not fit four edges")
	}
	return C, nil
}

// detectTexture with TextureConfig {threshold, edge, radius}
type TextureCfg struct {
	threshold float64
	edge      float64
	radius    int
}

var DefaultTextureCfg = TextureCfg{.33, .13, 4}

func detectTextureQuads(A *Frame, cfg *TextureCfg) ([][4][2]float64, error) {
	edge := .13
	threshold := .33
	radius := 4
	if cfg != nil {
		if cfg.edge != 0 {
			edge = cfg.edge
		}
		if cfg.threshold != 0 {
			threshold = cfg.threshold
		}
		if cfg.radius != 0 {
			radius = cfg.radius
		}
	}
	t := math.Min(1, 320/math.Max(float64(A.w), float64(A.h)))
	i := int(jsRound(float64(A.w) * t))
	g := int(jsRound(float64(A.h) * t))
	l := A.texSrgb
	ok := l != nil
	if !ok {
		l = make([]float32, i*g*3)
		for rr := 0; rr < g; rr++ {
			for oo := 0; oo < i; oo++ {
				a := float64(oo) / t
				gg := float64(rr) / t
				I := 3 * (rr*i + oo)
				if a < 0 || gg < 0 || a >= float64(A.w-1) || gg >= float64(A.h-1) {
					l[I] = float32(srgbQ(1))
					l[I+1] = float32(srgbQ(1))
					l[I+2] = float32(srgbQ(1))
					continue
				}
				h := int(math.Floor(a))
				n := int(math.Floor(gg))
				s := a - float64(h)
				C := gg - float64(n)
				Q := 3 * (n*A.w + h)
				for e2 := 0; e2 < 3; e2++ {
					v := (float64(A.p[Q+e2])*(1-s) + float64(A.p[Q+3+e2])*s) * (1 - C)
					v += (float64(A.p[Q+3*A.w+e2])*(1-s) + float64(A.p[Q+3*A.w+3+e2])*s) * C
					l[I+e2] = float32(srgbQ(v))
				}
			}
		}
		A.texSrgb = l
	}
	I := make([]float32, i*g)
	for A2 := 1; A2 < g-1; A2++ {
		for e2 := 1; e2 < i-1; e2++ {
			t2 := 3 * (A2*i + e2)
			r2 := 0.0
			for k := 0; k < 2; k++ {
				var ee int
				if k == 1 {
					ee = t2 + 3*i
				} else {
					ee = t2 + 3
				}
				o2 := 0.0
				for c := 0; c < 3; c++ {
					d := float64(l[t2+c] - l[ee+c])
					o2 += d * d
				}
				r2 = math.Max(r2, math.Sqrt(o2))
			}
			if r2 > edge {
				I[A2*i+e2] = 1
			}
		}
	}
	// integral image
	h2 := make([]float64, (i+1)*(g+1))
	for A2 := 0; A2 < g; A2++ {
		e2 := 0.0
		for t2 := 0; t2 < i; t2++ {
			e2 += float64(I[A2*i+t2])
			h2[(A2+1)*(i+1)+t2+1] = h2[A2*(i+1)+t2+1] + e2
		}
	}
	h := make([]uint8, i*g)
	n := radius
	for A2 := 0; A2 < g; A2++ {
		for e2 := 0; e2 < i; e2++ {
			t2 := max(0, e2-n)
			r2 := min(i, e2+n+1)
			o2 := max(0, A2-n)
			a2 := min(g, A2+n+1)
			sum := h2[a2*(i+1)+r2] - h2[o2*(i+1)+r2] - h2[a2*(i+1)+t2] + h2[o2*(i+1)+t2]
			if sum/float64((r2-t2)*(a2-o2)) > threshold {
				h[A2*i+e2] = 1
			}
		}
	}
	h = morph(morph(h, i, g, 1, true), i, g, 1, false)
	blobs := extractBlobs(h, i, g)
	if len(blobs) == 0 {
		return nil, nA("detect", "No code found. Use a plain background with a wide white margin.")
	}
	var E [][4][2]float64
	for bi := 0; bi < len(blobs) && bi < 3; bi++ {
		b := &blobs[bi]
		if q, ok := quadFitMinAreaRect(b, t); ok {
			var qq [4][2]float64
			copy(qq[:], q)
			E = append(E, qq)
		}
		if q, extra, hasExtra := quadFitVariant2(b, t); q != nil {
			var qq [4][2]float64
			copy(qq[:], q)
			E = append(E, qq)
			if hasExtra {
				var eq [4][2]float64
				copy(eq[:], extra)
				E = append(E, eq)
			}
		}
		if q, ok := quadFitVariant3(b, t); ok {
			var qq [4][2]float64
			copy(qq[:], q)
			E = append(E, qq)
		}
	}
	if len(E) == 0 {
		return nil, nA("detect", "Could not fit four edges")
	}
	return E, nil
}
