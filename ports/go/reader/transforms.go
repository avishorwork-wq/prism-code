package main

import (
	"fmt"
	"image"
	"image/png"
	"math"
	"os"
	"time"
)

// ---------- PrismRetry transforms (page side) ----------

func u8c(v float64) uint8 { return uint8(clampf(math.RoundToEven(v), 0, 255)) }

func trLift(img *ImageData) *ImageData {
	w, h, d := img.W, img.H, img.Data
	N := w * h
	var hist [256]uint32
	for i := 0; i < N; i++ {
		p := i * 4
		hist[(int(d[p])*299+int(d[p+1])*587+int(d[p+2])*114)/1000]++
	}
	acc := uint32(0)
	hi := 255
	th := float64(N) * .98
	for v := 0; v < 256; v++ {
		acc += hist[v]
		if float64(acc) >= th {
			hi = v
			break
		}
	}
	g := 255 / math.Max(30, float64(hi))
	o := make([]uint8, len(d))
	for i, p := 0, 0; i < N; i, p = i+1, p+4 {
		o[p] = u8c(math.Min(255, float64(d[p])*g))
		o[p+1] = u8c(math.Min(255, float64(d[p+1])*g))
		o[p+2] = u8c(math.Min(255, float64(d[p+2])*g))
		o[p+3] = 255
	}
	return &ImageData{w, h, o}
}

func trLiftdn(img *ImageData) *ImageData {
	a := trLift(img)
	w, h, d := a.W, a.H, a.Data
	N := w * h
	tmp := make([]float32, N*3)
	wt := [5]float64{1, 4, 6, 4, 1}
	clampi := func(x, hi int) int {
		if x < 0 {
			return 0
		}
		if x > hi {
			return hi
		}
		return x
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var sr, sg, sb, sw float64
			for dx := -2; dx <= 2; dx++ {
				xx := clampi(x+dx, w-1)
				p := (y*w + xx) * 4
				w2 := wt[dx+2]
				sr += float64(d[p]) * w2
				sg += float64(d[p+1]) * w2
				sb += float64(d[p+2]) * w2
				sw += w2
			}
			q := (y*w + x) * 3
			tmp[q] = float32(sr / sw)
			tmp[q+1] = float32(sg / sw)
			tmp[q+2] = float32(sb / sw)
		}
	}
	o := make([]uint8, len(d))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var sr, sg, sb, sw float64
			for dy := -2; dy <= 2; dy++ {
				yy := clampi(y+dy, h-1)
				q := (yy*w + x) * 3
				w2 := wt[dy+2]
				sr += float64(tmp[q]) * w2
				sg += float64(tmp[q+1]) * w2
				sb += float64(tmp[q+2]) * w2
				sw += w2
			}
			p := (y*w + x) * 4
			o[p] = u8c(sr / sw)
			o[p+1] = u8c(sg / sw)
			o[p+2] = u8c(sb / sw)
			o[p+3] = 255
		}
	}
	return &ImageData{w, h, o}
}

func trZoomcrop(img *ImageData, frac, scale float64) *ImageData {
	w, h := img.W, img.H
	s := int(jsRound(float64(min(w, h)) * frac))
	x0 := int(jsRound(float64(w-s) / 2))
	y0 := int(jsRound(float64(h-s) / 2))
	S := int(jsRound(float64(s) * scale))
	return canvasResizeHigh(img, x0, y0, s, s, S, S)
}

func trUnsharp(img *ImageData, amt float64) *ImageData {
	w, h, d := img.W, img.H, img.Data
	o := make([]uint8, len(d))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			p := (y*w + x) * 4
			for c := 0; c < 3; c++ {
				blur := 0.0
				n := 0
				for dy := -1; dy <= 1; dy++ {
					for dx := -1; dx <= 1; dx++ {
						yy, xx := y+dy, x+dx
						if yy >= 0 && yy < h && xx >= 0 && xx < w {
							blur += float64(d[(yy*w+xx)*4+c])
							n++
						}
					}
				}
				blur /= float64(n)
				v := float64(d[p+c]) + amt*(float64(d[p+c])-blur)
				o[p+c] = u8c(v)
			}
			o[p+3] = 255
		}
	}
	return &ImageData{w, h, o}
}

// gradient analysis shared by zoomauto/zooman
func zoomAnalyze(img *ImageData) (x0, y0, side int) {
	w, h, d := img.W, img.H, img.Data
	gw := max(32, int(jsRound(float64(w)/8)))
	gh := max(32, int(jsRound(float64(h)/8)))
	G := make([]float64, gw*gh)
	for gy := 0; gy < gh; gy++ {
		for gx := 0; gx < gw; gx++ {
			x := min(w-2, int(jsRound(float64(gx)*float64(w)/float64(gw))))
			y := min(h-2, int(jsRound(float64(gy)*float64(h)/float64(gh))))
			p := (y*w + x) * 4
			p2 := (y*w + x + 1) * 4
			p3 := ((y+1)*w + x) * 4
			l1 := .299*float64(d[p]) + .587*float64(d[p+1]) + .114*float64(d[p+2])
			lx := .299*float64(d[p2]) + .587*float64(d[p2+1]) + .114*float64(d[p2+2])
			ly := .299*float64(d[p3]) + .587*float64(d[p3+1]) + .114*float64(d[p3+2])
			G[gy*gw+gx] = math.Abs(l1-lx) + math.Abs(l1-ly)
		}
	}
	bestNorm := -1.0
	var bgx, bgy, bsg int
	for _, sOrig := range []int{50, 80, 120, 170} {
		sg := max(3, int(jsRound(float64(sOrig)/float64(w)*float64(gw))))
		for gy := 0; gy+sg <= gh; gy += 2 {
			for gx := 0; gx+sg <= gw; gx += 2 {
				s := 0.0
				for y := gy; y < gy+sg; y++ {
					for x := gx; x < gx+sg; x++ {
						s += G[y*gw+x]
					}
				}
				norm := s / float64(sg*sg)
				if norm > bestNorm {
					bestNorm = norm
					bgx, bgy, bsg = gx, gy, sg
				}
			}
		}
	}
	px := float64(bgx) / float64(gw) * float64(w)
	py := float64(bgy) / float64(gh) * float64(h)
	ps := float64(bsg) / float64(gw) * float64(w)
	m := ps * .8
	x0 = max(0, int(jsRound(px-m)))
	y0 = max(0, int(jsRound(py-m)))
	side = min(min(w-x0, h-y0), int(jsRound(ps+2*m)))
	return
}

func trZoomauto(img *ImageData) *ImageData {
	x0, y0, side := zoomAnalyze(img)
	S := min(1200, int(jsRound(float64(side)*5)))
	r := canvasResizeHigh(img, x0, y0, side, side, S, S)
	return trUnsharp(r, 1.0)
}

func trZooman(img *ImageData) *ImageData {
	x0, y0, side := zoomAnalyze(img)
	S := min(1400, int(jsRound(float64(side)*6)))
	return canvasResizeNN(img, x0, y0, side, side, S, S)
}

func trCrplain(img *ImageData) *ImageData {
	w, h, d := img.W, img.H, img.Data
	N := w * h
	lum := make([]float32, N)
	amp := make([]float32, N)
	for i, p := 0, 0; i < N; i, p = i+1, p+4 {
		r := float64(d[p])
		g := float64(d[p+1])
		b := float64(d[p+2])
		lum[i] = float32((r + g + b) / 3)
		amp[i] = float32(math.Max(r, math.Max(g, b)) - math.Min(r, math.Min(g, b)))
	}
	R := max(4, int(jsRound(float64(min(w, h))/12)))
	tmp := make([]float32, N)
	bl := make([]float32, N)
	for y := 0; y < h; y++ {
		s := float32(0)
		for x := 0; x < w; x++ {
			if x+R < w {
				s += amp[y*w+x+R]
			}
			if x-R-1 >= 0 {
				s -= amp[y*w+x-R-1]
			}
			bl[y*w+x] = s / float32(min(w-1, x+R)-max(0, x-R-1))
		}
	}
	for x := 0; x < w; x++ {
		s := float32(0)
		for y := 0; y < h; y++ {
			if y+R < h {
				s += bl[(y+R)*w+x]
			}
			if y-R-1 >= 0 {
				s -= bl[(y-R-1)*w+x]
			}
			tmp[y*w+x] = s / float32(min(h-1, y+R)-max(0, y-R-1))
		}
	}
	o := make([]uint8, len(d))
	for i, p := 0, 0; i < N; i, p = i+1, p+4 {
		k := math.Min(6, math.Max(1, 90/math.Max(18, float64(tmp[i]))))
		l := float64(lum[i])
		if l < 190 {
			k = 1
		}
		r := l + (float64(d[p])-l)*k
		g := l + (float64(d[p+1])-l)*k
		b := l + (float64(d[p+2])-l)*k
		m2 := math.Max(r, math.Max(g, b))
		if m2 > 255 {
			s := 255 / m2
			r *= s
			g *= s
			b *= s
		}
		o[p] = u8c(r)
		o[p+1] = u8c(g)
		o[p+2] = u8c(b)
		o[p+3] = 255
	}
	return &ImageData{w, h, o}
}

// gaussian kernel
func gk(sig float64) ([]float32, int) {
	r := min(16, int(math.Ceil(sig*3)))
	k := make([]float32, 2*r+1)
	s := 0.0
	for i := -r; i <= r; i++ {
		v := math.Exp(-float64(i*i) / (2 * sig * sig))
		k[i+r] = float32(v)
		s += v
	}
	for i := range k {
		k[i] /= float32(s)
	}
	return k, r
}

func cv1(src []float32, W, H int, k []float32, r int, horiz bool) []float32 {
	out := make([]float32, len(src))
	clampi := func(x, hi int) int {
		if x < 0 {
			return 0
		}
		if x > hi {
			return hi
		}
		return x
	}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			b := (y*W + x) * 3
			var a0, a1, a2 float32
			for i := -r; i <= r; i++ {
				var xx, yy int
				if horiz {
					xx = clampi(x+i, W-1)
					yy = y
				} else {
					xx = x
					yy = clampi(y+i, H-1)
				}
				w := k[i+r]
				p := (yy*W + xx) * 3
				a0 += src[p] * w
				a1 += src[p+1] * w
				a2 += src[p+2] * w
			}
			out[b] = a0
			out[b+1] = a1
			out[b+2] = a2
		}
	}
	return out
}

func gconv(src []float32, W, H int, sig float64) []float32 {
	k, r := gk(sig)
	return cv1(cv1(src, W, H, k, r, true), W, H, k, r, false)
}

func toF(img *ImageData) []float32 {
	N := img.W * img.H
	f := make([]float32, N*3)
	for i, j := 0, 0; i < len(img.Data); i, j = i+4, j+3 {
		f[j] = float32(img.Data[i])
		f[j+1] = float32(img.Data[i+1])
		f[j+2] = float32(img.Data[i+2])
	}
	return f
}

func toImg(f []float32, W, H int) *ImageData {
	o := make([]uint8, W*H*4)
	for j, i := 0, 0; j < len(f); j, i = j+3, i+4 {
		o[i] = u8c(float64(f[j]))
		o[i+1] = u8c(float64(f[j+1]))
		o[i+2] = u8c(float64(f[j+2]))
		o[i+3] = 255
	}
	return &ImageData{W, H, o}
}

func unsharpG(img *ImageData, sig, amt float64) *ImageData {
	W, H := img.W, img.H
	f := toF(img)
	bl := gconv(f, W, H, sig)
	for i := range f {
		f[i] += float32(amt) * (f[i] - bl[i])
	}
	return toImg(f, W, H)
}

func lrG(img *ImageData, sig float64, iters int) *ImageData {
	W, H := img.W, img.H
	y := toF(img)
	est := append([]float32(nil), y...)
	k, r := gk(sig)
	blur := func(e []float32) []float32 {
		return cv1(cv1(e, W, H, k, r, true), W, H, k, r, false)
	}
	for it := 0; it < iters; it++ {
		c := blur(est)
		ratio := make([]float32, len(y))
		for i := range y {
			den := c[i]
			if den < 8 {
				den = 8
			}
			ratio[i] = y[i] / den
		}
		cr := blur(ratio)
		for i := range est {
			est[i] = float32(clampf(float64(est[i]*cr[i]), 0, 255))
		}
	}
	return toImg(est, W, H)
}

func lrLine(img *ImageData, L int, angDeg float64, iters int) *ImageData {
	W, H := img.W, img.H
	y := toF(img)
	a := angDeg * math.Pi / 180
	dx := math.Cos(a)
	dy := math.Sin(a)
	type pt struct{ x, y int }
	var offs []pt
	for t := -(L - 1) / 2; t <= (L-1)/2; t++ {
		ox := int(jsRound(dx * float64(t)))
		oy := int(jsRound(dy * float64(t)))
		found := false
		for _, o := range offs {
			if o.x == ox && o.y == oy {
				found = true
				break
			}
		}
		if !found {
			offs = append(offs, pt{ox, oy})
		}
	}
	kw := float32(1) / float32(len(offs))
	clampi := func(x, hi int) int {
		if x < 0 {
			return 0
		}
		if x > hi {
			return hi
		}
		return x
	}
	conv := func(e []float32) []float32 {
		o := make([]float32, len(e))
		for yy := 0; yy < H; yy++ {
			for xx := 0; xx < W; xx++ {
				var a0, a1, a2 float32
				for _, off := range offs {
					x2 := clampi(xx+off.x, W-1)
					y2 := clampi(yy+off.y, H-1)
					p := (y2*W + x2) * 3
					a0 += e[p]
					a1 += e[p+1]
					a2 += e[p+2]
				}
				b := (yy*W + xx) * 3
				o[b] = a0 * kw
				o[b+1] = a1 * kw
				o[b+2] = a2 * kw
			}
		}
		return o
	}
	est := append([]float32(nil), y...)
	for it := 0; it < iters; it++ {
		c := conv(est)
		ratio := make([]float32, len(y))
		for i := range y {
			den := c[i]
			if den < 8 {
				den = 8
			}
			ratio[i] = y[i] / den
		}
		cr := conv(ratio)
		for i := range est {
			est[i] = float32(clampf(float64(est[i]*cr[i]), 0, 255))
		}
	}
	return toImg(est, W, H)
}

// glare maker __glmk(blk, sm, gam)
func glmk(blk, sm, gam int) func(*ImageData) *ImageData {
	return func(img *ImageData) *ImageData {
		w, h, d := img.W, img.H, img.Data
		N := w * h
		mn := make([]float32, N)
		for i, p := 0, 0; i < N; i, p = i+1, p+4 {
			m := d[p]
			if d[p+1] < m {
				m = d[p+1]
			}
			if d[p+2] < m {
				m = d[p+2]
			}
			mn[i] = float32(m)
		}
		gw := (w + blk - 1) / blk
		gh := (h + blk - 1) / blk
		bm := make([]float32, gw*gh)
		for i := range bm {
			bm[i] = 255
		}
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				k := (y/blk)*gw + (x / blk)
				if mn[y*w+x] < bm[k] {
					bm[k] = mn[y*w+x]
				}
			}
		}
		g := bm
		for it := 0; it < 2; it++ {
			t := make([]float32, gw*gh)
			for y := 0; y < gh; y++ {
				for x := 0; x < gw; x++ {
					s := float32(0)
					c := 0
					for dy := -sm; dy <= sm; dy++ {
						for dx := -sm; dx <= sm; dx++ {
							yy, xx := y+dy, x+dx
							if yy >= 0 && yy < gh && xx >= 0 && xx < gw {
								s += g[yy*gw+xx]
								c++
							}
						}
					}
					t[y*gw+x] = s / float32(c)
				}
			}
			g = t
		}
		o := make([]uint8, len(d))
		for y := 0; y < h; y++ {
			fy := math.Min(float64(gh-1), math.Max(0, float64(y)/float64(blk)-.5))
			y0 := int(math.Floor(fy))
			y1 := min(gh-1, y0+1)
			ty := fy - float64(y0)
			for x := 0; x < w; x++ {
				fx := math.Min(float64(gw-1), math.Max(0, float64(x)/float64(blk)-.5))
				x0 := int(math.Floor(fx))
				x1 := min(gw-1, x0+1)
				tx := fx - float64(x0)
				B := (float64(g[y0*gw+x0])*(1-tx) + float64(g[y0*gw+x1])*tx) * (1 - ty)
				B += (float64(g[y1*gw+x0])*(1-tx) + float64(g[y1*gw+x1])*tx) * ty
				Bc := math.Max(0, B-float64(gam))
				sc := 255 / math.Max(40, 255-Bc)
				p := (y*w + x) * 4
				o[p] = u8c((float64(d[p]) - Bc) * sc)
				o[p+1] = u8c((float64(d[p+1]) - Bc) * sc)
				o[p+2] = u8c((float64(d[p+2]) - Bc) * sc)
				o[p+3] = 255
			}
		}
		return &ImageData{w, h, o}
	}
}

func trGs3a2(img *ImageData) *ImageData  { return unsharpG(img, 3, 2) }
func trDeblkS(img *ImageData) *ImageData { return unsharpG(img, 1.2, 1.5) }

func trZoomw(img *ImageData) *ImageData {
	w, h := img.W, img.H
	s := int(jsRound(float64(min(w, h)) * .6))
	x0 := int(jsRound(float64(w-s) / 2))
	y0 := int(jsRound(float64(h-s) / 2))
	S := int(jsRound(float64(s) * 2.5))
	return canvasResizeHigh(img, x0, y0, s, s, S, S)
}

func trLr2(img *ImageData) *ImageData {
	c := saliencyCrop(img, .15)
	if c == nil {
		c = img
	}
	return lrG(c, 2, 6)
}

func trMl(img *ImageData, ang float64) *ImageData {
	c := saliencyCrop(img, .15)
	if c == nil {
		c = img
	}
	return lrLine(c, 19, ang, 8)
}

// the Build 112 chain
var chainOrder = []struct {
	name string
	fn   func(*ImageData) *ImageData
}{
	{"liftdn", trLiftdn},
	{"crplain", trCrplain},
	{"zoom", func(i *ImageData) *ImageData { return trZoomcrop(i, .45, 3) }},
	{"zoomauto", trZoomauto},
	{"zooman", trZooman},
	{"gl5", glmk(20, 2, 10)},
	{"gl3", glmk(16, 2, 10)},
	{"gl6", glmk(12, 3, 10)},
	{"gs3a2", trGs3a2},
	{"deblkS", trDeblkS},
	{"zoomw", trZoomw},
	{"lr2", trLr2},
	{"ml45", func(i *ImageData) *ImageData { return trMl(i, 45) }},
	{"ml0", func(i *ImageData) *ImageData { return trMl(i, 0) }},
	{"ml90", func(i *ImageData) *ImageData { return trMl(i, 90) }},
	{"ml135", func(i *ImageData) *ImageData { return trMl(i, 135) }},
}

// roiRead
func roiRead(img *ImageData) (*ReadResult, error) {
	var firstErr error
	if img != nil && img.Data != nil {
		if b := roiBBox(img); b != nil {
			c := roiCrop(img, b)
			m := max(c.W, c.H)
			if m < 400 {
				c = upNN(c, math.Min(6, 400/float64(m)))
			}
			if dumpDir != "" {
				dumpStepPNG(dumpDir, curStep+"_roi", c)
			}
			r, err := fastRead(c)
			if err == nil {
				return r, nil
			}
			firstErr = err
		}
	}
	r, err := fastRead(img)
	if err != nil && firstErr != nil {
		return nil, firstErr
	}
	return r, err
}

// AsyncPrismReader.read
func chainRead(img *ImageData) (*ReadResult, string, error) {
	t0 := time.Now()
	curStep = "direct"
	r, err := roiRead(img)
	if err == nil {
		return r, "direct", nil
	}
	if dbg {
		fmt.Fprintf(os.Stderr, "chain direct: %v (%s)\n", err, time.Since(t0))
	}
	for _, step := range chainOrder {
		if err := checkBudget(); err != nil {
			return nil, "", err
		}
		ts := time.Now()
		curStep = step.name
		im2 := step.fn(img)
		if im2 == nil {
			continue
		}
		if dumpDir != "" {
			dumpStepPNG(dumpDir, step.name, im2)
		}
		if r, err := roiRead(im2); err == nil {
			return r, step.name, nil
		} else if dbg {
			fmt.Fprintf(os.Stderr, "chain %s: %v (%s)\n", step.name, err, time.Since(ts))
		}
	}
	return nil, "", err
}

var dumpDir = os.Getenv("PRISM_DUMP_STEPS")

// debug-only: name of the chain step currently running (single-scene debug runs)
var curStep = "unknown"

func dumpStepPNG(dir, name string, im *ImageData) {
	os.MkdirAll(dir, 0755)
	m := image.NewRGBA(image.Rect(0, 0, im.W, im.H))
	copy(m.Pix, im.Data)
	f, err := os.Create(dir + "/" + name + ".png")
	if err != nil {
		return
	}
	defer f.Close()
	png.Encode(f, m)
}
