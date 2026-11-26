package main

import "math"

// buildMesh QA: pilot-based local displacement mesh
func buildMesh(f *Frame, H *Homography, l *Layout, mode int, white [3]float64, prev *[]meshPt) *[]meshPt {
	var pilots []*cell
	for _, c := range l.known {
		if c.role == "pilot" {
			pilots = append(pilots, c)
		}
	}
	d := H.delta(l.W/2, l.H/2, 1, 0)
	g := math.Hypot(d[0], d[1])
	var pts []meshPt
	for _, t := range pilots {
		i := H.mapPt(t.x, t.y)
		I := meshQuery(prev, t.x, t.y)
		h := math.Inf(1)
		var best *meshPt
		s := knownSymbol(t, mode)
		for e := -2; e <= 2; e++ {
			for r := -2; r <= 2; r++ {
				a := I[0] + .3*float64(r)*g
				ll := I[1] + .3*float64(e)*g
				C := f.sample(i[0]+a, i[1]+ll)
				for k := 0; k < 3; k++ {
					C[k] /= white[k]
				}
				Q := hDist(labOf(C), LABC[s])
				E := .2 * (a*a + ll*ll) / (g * g)
				if Q+E < h {
					h = Q + E
					best = &meshPt{x: t.x, y: t.y, dx: a, dy: ll}
				}
			}
		}
		if best != nil {
			pts = append(pts, *best)
		}
	}
	items := make([]kdItem, len(pts))
	for i := range pts {
		items[i] = kdItem{pts[i].x, pts[i].y, &pts[i]}
	}
	tree := buildKd(items)
	var out []meshPt
	for idx := range pts {
		res := tree.query(pts[idx].x, pts[idx].y, 8, idx)
		if len(res) == 0 {
			out = append(out, pts[idx])
			continue
		}
		var dxs, dys []float64
		for _, rr := range res {
			m := rr.v.(*meshPt)
			dxs = append(dxs, m.dx)
			dys = append(dys, m.dy)
		}
		t := median(dxs)
		r := median(dys)
		if math.Hypot(pts[idx].dx-t, pts[idx].dy-r) <= .3*g {
			out = append(out, pts[idx])
		}
	}
	return &out
}

// buildDenseMesh: like buildMesh but over all known cells, filter .8*g
func buildDenseMesh(f *Frame, H *Homography, l *Layout, mode int, white [3]float64, prev *[]meshPt) *[]meshPt {
	d := H.delta(l.W/2, l.H/2, 1, 0)
	g := math.Hypot(d[0], d[1])
	var pts []meshPt
	for _, t := range l.known {
		i := H.mapPt(t.x, t.y)
		I := meshQuery(prev, t.x, t.y)
		h := math.Inf(1)
		var best *meshPt
		s := knownSymbol(t, mode)
		for e := -2; e <= 2; e++ {
			for r := -2; r <= 2; r++ {
				a := I[0] + .3*float64(r)*g
				ll := I[1] + .3*float64(e)*g
				C := f.sample(i[0]+a, i[1]+ll)
				for k := 0; k < 3; k++ {
					C[k] /= white[k]
				}
				Q := hDist(labOf(C), LABC[s])
				E := .2 * (a*a + ll*ll) / (g * g)
				if Q+E < h {
					h = Q + E
					best = &meshPt{x: t.x, y: t.y, dx: a, dy: ll}
				}
			}
		}
		if best != nil {
			pts = append(pts, *best)
		}
	}
	items := make([]kdItem, len(pts))
	for i := range pts {
		items[i] = kdItem{pts[i].x, pts[i].y, &pts[i]}
	}
	tree := buildKd(items)
	var out []meshPt
	for idx := range pts {
		res := tree.query(pts[idx].x, pts[idx].y, 8, idx)
		if len(res) == 0 {
			out = append(out, pts[idx])
			continue
		}
		var dxs, dys []float64
		for _, rr := range res {
			m := rr.v.(*meshPt)
			dxs = append(dxs, m.dx)
			dys = append(dys, m.dy)
		}
		t := median(dxs)
		r := median(dys)
		if math.Hypot(pts[idx].dx-t, pts[idx].dy-r) <= .8*g {
			out = append(out, pts[idx])
		}
	}
	return &out
}
