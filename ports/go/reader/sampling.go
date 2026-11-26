package main

import (
	"math"
	"sort"
)

// kd-tree sA over arbitrary items with x,y accessors
type kdNode struct {
	id          int
	axis        int
	left, right *kdNode
}

type kdTree struct {
	items []kdItem
	root  *kdNode
}

type kdItem struct {
	x, y float64
	v    interface{}
}

func buildKd(items []kdItem) *kdTree {
	t := &kdTree{items: items}
	ids := make([]int, len(items))
	for i := range ids {
		ids[i] = i
	}
	var build func(r []int, axis int) *kdNode
	build = func(r []int, axis int) *kdNode {
		if len(r) == 0 {
			return nil
		}
		sort.SliceStable(r, func(a, b int) bool {
			ia, ib := items[r[a]], items[r[b]]
			if axis == 0 {
				if ia.x != ib.x {
					return ia.x < ib.x
				}
			} else {
				if ia.y != ib.y {
					return ia.y < ib.y
				}
			}
			return r[a] < r[b]
		})
		a := len(r) >> 1
		return &kdNode{id: r[a], axis: axis, left: build(r[:a], 1-axis), right: build(r[a+1:], 1-axis)}
	}
	t.root = build(ids, 0)
	return t
}

type kdResult struct {
	v  interface{}
	d  float64
	id int
}

// query: k nearest to (r,o), excluding excludeId (-1 for none)
func (t *kdTree) query(r, o float64, a int, excludeId int) []kdResult {
	var g []kdResult
	var walk func(l *kdNode)
	walk = func(l *kdNode) {
		if l == nil {
			return
		}
		I := t.items[l.id]
		n, s := I.x-r, I.y-o
		C := n*n + s*s
		if l.id != excludeId {
			A := 0
			for A < len(g) && (g[A].d < C || (g[A].d == C && g[A].id < l.id)) {
				A++
			}
			if A < a {
				g = append(g, kdResult{})
				copy(g[A+1:], g[A:])
				g[A] = kdResult{I.v, C, l.id}
				if len(g) > a {
					g = g[:a]
				}
			}
		}
		var Q float64
		if l.axis == 1 {
			Q = o - I.y
		} else {
			Q = r - I.x
		}
		E, B := l.left, l.right
		if Q >= 0 {
			E, B = l.right, l.left
		}
		walk(E)
		if len(g) < a || Q*Q <= g[len(g)-1].d {
			walk(B)
		}
	}
	walk(t.root)
	return g
}

// mesh point for X
type meshPt struct {
	x, y, dx, dy float64
}

var meshCache = map[*[]meshPt]*kdTree{}

// X: query mesh for offset at (x,y); mesh is a slice of meshPt (nil/empty -> [0,0])
func meshQuery(mesh *[]meshPt, x, y float64) [2]float64 {
	if mesh == nil || len(*mesh) == 0 {
		return [2]float64{0, 0}
	}
	cacheMu.Lock()
	t, ok := meshCache[mesh]
	cacheMu.Unlock()
	if !ok {
		items := make([]kdItem, len(*mesh))
		for i, m := range *mesh {
			items[i] = kdItem{m.x, m.y, &(*mesh)[i]}
		}
		t = buildKd(items)
		cacheMu.Lock()
		meshCache[mesh] = t
		cacheMu.Unlock()
	}
	res := t.query(x, y, 4, -1)
	var a, i, g float64
	for _, r := range res {
		m := r.v.(*meshPt)
		e := 1 / (r.d + .05)
		a += m.dx * e
		i += m.dy * e
		g += e
	}
	return [2]float64{a / g, i / g}
}

// median n (sorts copy)
func median(A []float64) float64 {
	s := append([]float64(nil), A...)
	sort.Float64s(s)
	return s[len(s)>>1]
}

// median for float32
func median32(A []float32) float64 {
	s := make([]float64, len(A))
	for i, v := range A {
		s[i] = float64(v)
	}
	return median(s)
}

// O: robust median of 7 (with NaN check)
func median7(A []float64) float64 {
	nan := false
	for _, v := range A {
		if math.IsNaN(v) {
			nan = true
		}
	}
	if nan {
		return median(A)
	}
	// insertion sort in place on copy
	s := append([]float64(nil), A...)
	for e := 1; e < len(s); e++ {
		t := s[e]
		r := e - 1
		for r >= 0 && s[r] > t {
			s[r+1] = s[r]
			r--
		}
		s[r+1] = t
	}
	return s[len(s)>>1]
}

var sampleOffsets [7][2]float64

func init() {
	sampleOffsets[0] = [2]float64{0, 0}
	for e := 0; e < 6; e++ {
		sampleOffsets[e+1] = [2]float64{.45 * math.Cos(float64(e)*math.Pi/3), .45 * math.Sin(float64(e)*math.Pi/3)}
	}
}

// sample V: 7-point sampling with white balance and mesh offset; single=true -> center only
func (f *Frame) sampleCell(H *Homography, t *cell, white [3]float64, mesh *[]meshPt, single bool) [3]float64 {
	off := meshQuery(mesh, t.x, t.y)
	if single {
		p := H.mapPt(t.x+sampleOffsets[0][0], t.y+sampleOffsets[0][1])
		a := f.sample(p[0]+off[0], p[1]+off[1])
		return [3]float64{a[0] / white[0], a[1] / white[1], a[2] / white[2]}
	}
	var g [3][]float64
	for _, o := range sampleOffsets {
		p := H.mapPt(t.x+o[0], t.y+o[1])
		l := f.sample(p[0]+off[0], p[1]+off[1])
		for A := 0; A < 3; A++ {
			g[A] = append(g[A], l[A]/white[A])
		}
	}
	return [3]float64{median7(g[0]), median7(g[1]), median7(g[2])}
}

// whiteBalance j
func (f *Frame) whiteBalance(H *Homography, l *Layout) [3]float64 {
	var r [3][]float64
	for o := 0; o < 24; o++ {
		a := (float64(o) + .5) / 24
		pts := [4][2]float64{{a * l.W, -2.5}, {a * l.W, l.H + 2.5}, {-2.5, a * l.H}, {l.W + 2.5, a * l.H}}
		for _, pt := range pts {
			t := H.mapPt(pt[0], pt[1])
			if t[0] < 0 || t[1] < 0 || t[0] >= float64(f.w-1) || t[1] >= float64(f.h-1) {
				continue
			}
			a := f.sample(t[0], t[1])
			for A := 0; A < 3; A++ {
				r[A] = append(r[A], a[A])
			}
		}
	}
	var out [3]float64
	for A := 0; A < 3; A++ {
		if len(r[A]) == 0 {
			out[A] = 1
		} else {
			out[A] = median(r[A])
		}
		if out[A] < .08 {
			out[A] = .08
		}
	}
	return out
}

// nearest _
func nearestSymbolOf(A [3]float64, mode int) (int, float64) {
	t := labOf(A)
	r := -1
	o := math.Inf(1)
	for i := 0; i < 9; i++ {
		if mode != 0 && i != 0 && i != 8 {
			continue
		}
		a := hDist(t, LABC[i])
		if a < o {
			o = a
			r = i
		}
	}
	return r, math.Sqrt(o)
}

// hypothesisScore $ (JS fallback path; WASM path not ported initially)
type hypoResult struct {
	cost  float64
	score float64
}

var hypoCellsCache = map[*Layout]map[int][][3]float64{}

func hypoCellsFor(l *Layout, mode int, fast bool) [][3]float64 {
	key := mode*2 + bool2int(fast, 1, 0)
	cacheMu.Lock()
	m := hypoCellsCache[l]
	if m == nil {
		m = map[int][][3]float64{}
		hypoCellsCache[l] = m
	}
	cells, ok := m[key]
	cacheMu.Unlock()
	if ok {
		return cells
	}
	step := max(1, len(l.known)/bool2int(fast && mode == 0, 60, 120))
	for e := 0; e < len(l.known); e += step {
		k := l.known[e]
		if mode != 0 && k.role == "ring" {
			continue
		}
		cells = append(cells, [3]float64{k.x, k.y, float64(knownSymbol(k, mode))})
	}
	cacheMu.Lock()
	m[key] = cells
	cacheMu.Unlock()
	return cells
}

func hypothesisScore(f *Frame, H *Homography, l *Layout, mode int, white [3]float64, coarse bool) hypoResult {
	if !coarse && H.warp == nil && len(f.p)*4 <= 33554432 {
		fin := true
		for _, v := range H.h {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				fin = false
			}
		}
		for _, v := range white {
			if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
				fin = false
			}
		}
		if fin {
			var lab27 [27]float64
			for i := 0; i < 9; i++ {
				copy(lab27[3*i:3*i+3], LABC[i][:])
			}
			var off14 [14]float64
			for i := 0; i < 7; i++ {
				off14[2*i], off14[2*i+1] = sampleOffsets[i][0], sampleOffsets[i][1]
			}
			cost, score := hypoWasmScore(f.p, f.w, f.h, [8]float64(H.h), white, hypoCellsFor(l, mode, coarse), lab27, off14, coarse, mode)
			if !math.IsNaN(cost) && !math.IsInf(cost, 0) && !math.IsNaN(score) && !math.IsInf(score, 0) {
				return hypoResult{cost: cost, score: score}
			}
		}
	}
	var g, l_, I float64
	step := max(1, len(l.known)/bool2int(coarse && mode == 0, 60, 120))
	for e := 0; e < len(l.known); e += step {
		h := l.known[e]
		if mode != 0 && h.role == "ring" {
			continue
		}
		n := f.sampleCell(H, h, white, nil, coarse)
		s := knownSymbol(h, mode)
		lab := labOf(n)
		Qd := math.Sqrt(hDist(lab, LABC[s]))
		g += math.Min(Qd/30, 1)
		if sym, _ := nearestSymbolOf(n, mode); sym == s {
			I++
		}
		l_++
	}
	return hypoResult{cost: g / l_, score: I / l_}
}

func bool2int(b bool, t, f int) int {
	if b {
		return t
	}
	return f
}

// refine AA
func refineQuad(f *Frame, H *Homography, l *Layout, mode int, quad [4][2]float64, white [3]float64) (*Homography, [4][2]float64, float64) {
	i := quad
	g := math.Hypot(i[1][0]-i[0][0], i[1][1]-i[0][1]) / l.W
	I := .5 * g
	h := hypothesisScore(f, H, l, mode, white, false).cost
	for ; I > g*CFG.RefineStop; I *= .5 {
		for o := 0; o < 2; o++ {
			moved := false
			for gg := 0; gg < 4; gg++ {
				for ll := 0; ll < 2; ll++ {
					n := i[gg][ll]
					s := n
					for _, C := range []float64{-1, 1} {
						i[gg][ll] = n + C*I
						Q, err := homography(corners(l), i)
						if err != nil {
							continue
						}
						E := hypothesisScore(f, Q, l, mode, white, false).cost
						if E < h {
							h = E
							s = i[gg][ll]
							H = Q
							moved = true
						}
					}
					i[gg][ll] = s
				}
			}
			if !moved {
				break
			}
		}
	}
	return H, i, h
}

// calibrate CA
type calibRef struct {
	c   *cell
	o   [3]float64
	E   [3]float64
	res [3]float64
}

type Calibration struct {
	sigma float64
	refs  []calibRef
	M     [][]float64
	tree  *kdTree
}

func (cal *Calibration) correction(rgb [3]float64, c *cell) [3]float64 {
	t := cal.apply(rgb)
	res := cal.tree.query(c.x, c.y, 6, -1)
	var o float64
	var a [3]float64
	for _, rr := range res {
		ref := rr.v.(*calibRef)
		w := 1 / (rr.d + .05)
		o += w
		for A := 0; A < 3; A++ {
			a[A] += w * ref.res[A]
		}
	}
	var out [3]float64
	for A := 0; A < 3; A++ {
		out[A] = clampf(t[A]+a[A]/o, 0, 1)
	}
	return out
}

func (cal *Calibration) apply(rgb [3]float64) [3]float64 {
	var out [3]float64
	for e := 0; e < 3; e++ {
		out[e] = cal.M[e][0]*rgb[0] + cal.M[e][1]*rgb[1] + cal.M[e][2]*rgb[2] + cal.M[e][3]
	}
	return out
}

func calibrate(f *Frame, H *Homography, l *Layout, mode int, white [3]float64, mesh *[]meshPt) *Calibration {
	var refs []calibRef
	for _, t := range l.known {
		o := f.sampleCell(H, t, white, mesh, false)
		glare := true
		for _, v := range o {
			if v <= CFG.GlareThreshold {
				glare = false
			}
		}
		if knownSymbol(t, mode) == 8 || !glare {
			refs = append(refs, calibRef{c: t, o: o, E: PAL[knownSymbol(t, mode)]})
		}
	}
	g := make([][]float64, 4)
	h := make([][]float64, 3)
	for i := range g {
		g[i] = make([]float64, 4)
	}
	for i := range h {
		h[i] = make([]float64, 4)
	}
	for _, A := range refs {
		e := []float64{A.o[0], A.o[1], A.o[2], 1}
		for t := 0; t < 4; t++ {
			for B := 0; B < 4; B++ {
				g[t][B] += e[t] * e[B]
			}
			for r := 0; r < 3; r++ {
				h[r][t] += e[t] * A.E[r]
			}
		}
	}
	for A := 0; A < 4; A++ {
		g[A][A] += .001
	}
	s := make([][]float64, 3)
	for i := 0; i < 3; i++ {
		s[i], _ = solveW(g, h[i])
	}
	for i := range refs {
		e := [3]float64{}
		for k := 0; k < 3; k++ {
			e[k] = s[k][0]*refs[i].o[0] + s[k][1]*refs[i].o[1] + s[k][2]*refs[i].o[2] + s[k][3]
		}
		for t := 0; t < 3; t++ {
			refs[i].res[t] = refs[i].E[t] - e[t]
		}
	}
	items := make([]kdItem, len(refs))
	for i := range refs {
		items[i] = kdItem{refs[i].c.x, refs[i].c.y, &refs[i]}
	}
	tree := buildKd(items)
	var B []float64
	for _, A := range refs {
		if A.c.role == "pilot" {
			cal := &Calibration{M: s, tree: tree}
			corr := cal.correction(A.o, A.c)
			B = append(B, math.Sqrt(hDist(labOf(corr), labOf(A.E))))
		}
	}
	sig := CFG.SigmaFloor
	if len(B) > 0 {
		v := 1.4 * median(B)
		if v > sig {
			sig = v
		}
	} else {
		v := 1.4 * median([]float64{6})
		if v > sig {
			sig = v
		}
	}
	return &Calibration{sigma: sig, refs: refs, M: s, tree: tree}
}

// llr BA
func llrOf(A [3]float64, mode int, sigma float64, glare bool) []float64 {
	if glare {
		if mode != 0 {
			return []float64{0}
		}
		return []float64{0, 0, 0}
	}
	o := labOf(A)
	var a []int
	if mode != 0 {
		a = []int{0, 8}
	} else {
		a = []int{0, 1, 2, 3, 4, 5, 6, 7}
	}
	iArr := make([]float64, len(a))
	for k, sym := range a {
		iArr[k] = -hDist(o, LABC[sym]) / (2 * sigma * sigma)
	}
	g := iArr[0]
	for _, v := range iArr {
		if v > g {
			g = v
		}
	}
	h := make([]float64, len(a))
	for k := range iArr {
		h[k] = math.Exp(iArr[k] - g)
	}
	nBits := 3
	if mode != 0 {
		nBits = 1
	}
	n := make([]float64, nBits)
	for A := 0; A < nBits; A++ {
		t, r := 1e-6, 1e-6
		for o := 0; o < len(a); o++ {
			i := a[o]
			var bit1 bool
			if mode != 0 {
				bit1 = (i == 0)
			} else {
				bit1 = (((i ^ (i >> 1)) >> uint(2-A)) & 1) != 0
			}
			if bit1 {
				t += h[o]
			} else {
				r += h[o]
			}
		}
		n[A] = clampf(math.Log(r/t), -CFG.LlrClamp, CFG.LlrClamp)
	}
	return n
}
