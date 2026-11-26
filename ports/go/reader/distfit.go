package main

import (
	"fmt"
	"os"
	"time"
	"math"
	"sort"
)

// PrismDistFit.read (JS fallbacks for WASM cost scoring)
var dbgT0 = time.Now()

func distFitRead(A *ImageData) (*ReadResult, error) {
	fields := distFields(A)
	var result *ReadResult
	r := frameOf(A)
	var a [][4][2]float64
	if q, err := detectTextureQuads(r, nil); err == nil {
		a = append(a, q...)
	}
	for _, tc := range []TextureCfg{{threshold: .5, edge: .13}, {threshold: .4, edge: .2}} {
		tc2 := tc
		if q, err := detectTextureQuads(r, &tc2); err == nil {
			a = append(a, q...)
		}
	}
	// dedupe: drop quads matching an earlier one under any rotation (sum sq dist < 100)
	var filtered [][4][2]float64
outer:
	for _, q := range a {
		for _, e := range filtered {
			for t := 0; t < 4; t++ {
				s := 0.0
				for o := 0; o < 4; o++ {
					d0 := q[o][0] - e[(o+t)%4][0]
					d1 := q[o][1] - e[(o+t)%4][1]
					s += d0*d0 + d1*d1
				}
				if s < 100 {
					continue outer
				}
			}
		}
		filtered = append(filtered, q)
	}
	// scale variants 1, 1.04, 1.08 about centroid
	a = nil
	for _, q := range filtered {
		var cx, cy float64
		for _, p := range q {
			cx += p[0]
			cy += p[1]
		}
		cx /= 4
		cy /= 4
		for _, s := range []float64{1, 1.04, 1.08} {
			var q2 [4][2]float64
			for i, p := range q {
				q2[i] = [2]float64{cx + (p[0]-cx)*s, cy + (p[1]-cy)*s}
			}
			a = append(a, q2)
		}
	}

	rank := func(H *Homography, l *Layout) hypoResult {
		step := max(1, len(l.known)/48)
		cells := make([][3]float64, 0, len(l.known)/step+1)
		for aa := 0; aa < len(l.known); aa += step {
			i := l.known[aa]
			cells = append(cells, [3]float64{i.x, i.y, float64(knownSymbol(i, 0))})
		}
		var w13 [13]float64
		kind := 0
		if H.warp != nil {
			kind = 1
			copy(w13[:], H.warp.P)
		}
		r := costWasmScore(hom8(H), &w13, l.W, l.H, kind, fields.flat(), fields.w, fields.h, fields.scale, cells, nil, true, 1)
		return hypoResult{cost: r, score: 1 / (1 + r)}
	}

	var o []distCand
	if dbg {
		fmt.Fprintf(os.Stderr, "distfit candidates=%d\n", len(a))
	}
	nc := 0
	for _, C := range a {
		if err := checkBudget(); err != nil {
			return nil, err
		}
		nc++
		if dbg && nc%50 == 0 {
			fmt.Fprintf(os.Stderr, "cand %d/%d %s\n", nc, len(a), time.Since(dbgT0))
		}
		for Q := 0; Q < 6; Q++ {
			E, err := layoutOf(Q)
			if err != nil {
				continue
			}
			for B := 0; B < 4; B++ {
				var f [4][2]float64
				for i := 0; i < 4; i++ {
					f[i] = C[(i+B)%4]
				}
				c, err := homography(corners(E), f)
				if err != nil {
					continue
				}
				w := rank(c, E)
				u := make([]float64, 10)
				for _, d := range []float64{-6, 0, 6} {
					for _, y := range []float64{-6, 0, 6} {
						for _, M := range []float64{0, 6} {
							for _, D := range []float64{0, 3} {
								c.warp = &Warp{E.W, E.H, []float64{d, 0, 0, 0, 0, y, M, D, 0, 0}}
								p := rank(c, E)
								if p.score > w.score || (p.score == w.score && p.cost < w.cost) {
									w = p
									copy(u, c.warp.P)
								}
							}
						}
					}
				}
				for _, F := range []float64{-6, 0, 6} {
					for _, k := range []float64{-6, 0, 6} {
						for _, G := range []float64{0, -3} {
							c.warp = &Warp{E.W, E.H, []float64{0, 0, F, k, 0, 0, 0, 0, G, G}}
							b := rank(c, E)
							if b.score > w.score {
								w = b
								copy(u, c.warp.P)
							}
						}
					}
				}
				c.warp = &Warp{E.W, E.H, append([]float64(nil), u...)}
				o = append(o, distCand{h: c, l: E, quad: f, cost: w.cost, score: w.score})
			}
		}
	}
	sort.SliceStable(o, func(x, y int) bool {
		if o[x].score != o[y].score {
			return o[x].score > o[y].score
		}
		return o[x].cost < o[y].cost
	})
	// dedupe candidates: same size, quad sum sq < 2, warp params within .1
	var oo []distCand
outer2:
	for _, A2 := range o {
		for _, e := range oo {
			if A2.l.size != e.l.size {
				continue
			}
			s := 0.0
			for r2 := 0; r2 < 4; r2++ {
				d0 := A2.quad[r2][0] - e.quad[r2][0]
				d1 := A2.quad[r2][1] - e.quad[r2][1]
				s += d0*d0 + d1*d1
			}
			if s < 2 {
				same := true
				for k := 0; k < 10; k++ {
					if math.Abs(A2.h.warp.P[k]-e.h.warp.P[k]) >= .1 {
						same = false
						break
					}
				}
				if same {
					continue outer2
				}
			}
		}
		oo = append(oo, A2)
	}

	var g error = errG("Nonlinear geometry did not decode")
	for _, L := range oo[:min(20, len(oo))] {
		if err := checkBudget(); err != nil {
			return nil, err
		}
		R := L.h
		S := L.l
		N := L.quad
		U := R.warp
		R.warp = U
		q := r.whiteBalance(R, S)
		// cost fn I (JS fallback)
		J := []*cell{}
		step := max(1, len(S.known)/160)
		for i, c := range S.known {
			if i%step == 0 {
				J = append(J, c)
			}
		}
		var H [24][]*cell
		for _, c := range S.headers {
			H[c.header%24] = append(H[c.header%24], c)
		}
		costI := func() float64 {
			cells := make([][3]float64, len(J))
			for i2, t := range J {
				cells[i2] = [3]float64{t.x, t.y, float64(knownSymbol(t, 0))}
			}
			var extras []float64
			for _, grp := range H {
				for _, o3 := range grp {
					extras = append(extras, o3.x, o3.y)
				}
			}
			var w13 [13]float64
			kind := 0
			if R.warp != nil {
				kind = 1
				copy(w13[:], R.warp.P)
			}
			return costWasmScore(hom8(R), &w13, S.W, S.H, kind, fields.flat(), fields.w, fields.h, fields.scale, cells, extras, false, 0.85)
		}
		W := costI()
		K := R.warp.P
		P2 := append([]float64(nil), K...)
		for _, X := range []float64{-8, -4, 0, 4, 8} {
			for _, O := range []float64{-2, 0, 3, 6, 9} {
				V := math.Abs(K[2])+math.Abs(K[3]) > math.Abs(K[0])+math.Abs(K[5])
				j := 6
				if V {
					j = 8
				}
				if V {
					K[2] = X
				} else {
					K[0] = X
				}
				if V {
					K[j] = -O
				} else {
					K[j] = O
				}
				if c := costI(); c < W {
					W = c
					copy(P2, K)
				}
			}
		}
		copy(K, P2)
		for _, dollar := range []float64{2, 1, .5, .25, .125} {
			for AA := 0; AA < 3; AA++ {
				moved := false
				for oA := 0; oA < 10; oA++ {
					aA := K[oA]
					iA := aA
					for _, gA := range []float64{-1, 1} {
						K[oA] = aA + gA*dollar
						if math.Abs(K[oA]) > 12 {
							continue
						}
						if c := costI(); c < W {
							W = c
							iA = K[oA]
							moved = true
						}
					}
					K[oA] = iA
				}
				tA := R.warp
				dd := R.mapPt2Delta(&N)
				rA := math.Hypot(dd[0], dd[1]) / S.W
				for IA := 0; IA < 4; IA++ {
					for hA := 0; hA < 2; hA++ {
						nA := N[IA][hA]
						sA := nA
						for _, CA := range []float64{-1, 1} {
							N[IA][hA] = nA + CA*dollar*rA*.35
							QA, err := homography(corners(S), N)
							if err != nil {
								continue
							}
							QA.warp = tA
							EA := R
							R = QA
							if BA := costI(); BA < W {
								W = BA
								sA = N[IA][hA]
								moved = true
							} else {
								R = EA
							}
						}
						N[IA][hA] = sA
						if R2, err := homography(corners(S), N); err == nil {
							R = R2
							R.warp = tA
						}
					}
				}
				if !moved {
					break
				}
			}
		}
		q = r.whiteBalance(R, S)
		func() {
			cA, err := classify(r, R, S, 0, q, nil)
			if err != nil {
				g = err
				return
			}
			var fA *DecodeResult
			if cA.knownMatch < .65 {
				g = errG("Weak known-cell support")
				// fall to dense-mesh path
				if cA.knownMatch < .5 || W > 3.5 {
					return
				}
				wA := buildDenseMesh(r, R, S, 0, q, nil)
				wA = buildDenseMesh(r, R, S, 0, q, wA)
				cA, err = classify(r, R, S, 0, q, wA)
				if err != nil {
					g = err
					return
				}
				if cA.knownMatch < .7 {
					g = errG("Weak mesh known-cell support")
					return
				}
			}
			cA2 := *cA
			if len(cA2.headers) > 3 {
				cA2.headers = cA2.headers[:3]
			}
			fA, err = decodeClass(&cA2)
			if err != nil {
				// retry dense mesh on decode failure
				if cA.knownMatch < .5 || W > 3.5 {
					g = err
					return
				}
				wA := buildDenseMesh(r, R, S, 0, q, nil)
				wA = buildDenseMesh(r, R, S, 0, q, wA)
				cA, err = classify(r, R, S, 0, q, wA)
				if err != nil {
					g = err
					return
				}
				if cA.knownMatch < .7 {
					g = errG("Weak mesh known-cell support")
					return
				}
				cA2 = *cA
				if len(cA2.headers) > 3 {
					cA2.headers = cA2.headers[:3]
				}
				fA, err = decodeClass(&cA2)
				if err != nil {
					g = err
					return
				}
			}
			if len(fA.Bytes) == 0 {
				g = errG("Nonlinear recovery does not accept empty payload hypotheses")
				return
			}
			dd := R.mapPt2Delta(&N)
			g = nil
			result = &ReadResult{fA, cA.knownMatch, N, R, S, cA.sigma, math.Hypot(dd[0], dd[1]) / S.W}
		}()
		if result != nil {
			return result, nil
		}
	}
	return nil, g
}


func (H *Homography) mapPt2Delta(N *[4][2]float64) [2]float64 {
	return [2]float64{N[1][0] - N[0][0], N[1][1] - N[0][1]}
}

type distCand struct {
	h     *Homography
	l     *Layout
	quad  [4][2]float64
	cost  float64
	score float64
}

// PrismFastReader.read: readImage first, then normalize + distFit (budgets disabled)
func fastRead(A *ImageData) (*ReadResult, error) {
	r, err := readImage(A)
	if err == nil {
		return r, nil
	}
	n := normalizeLocal(A)
	if isCalmed(A) {
		markCalmed(n)
		defer unmarkCalmed(n)
	}
	return distFitRead(n)
}
