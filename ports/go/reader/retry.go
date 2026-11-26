package main

import "math"

// ---------- image helpers ----------

func cloneImg(img *ImageData) *ImageData {
	d := make([]uint8, len(img.Data))
	copy(d, img.Data)
	return &ImageData{img.W, img.H, d}
}

// canvas drawImage nearest (imageSmoothingEnabled=false)
func canvasResizeNN(img *ImageData, sx, sy, sw, sh, dw, dh int) *ImageData {
	o := make([]uint8, dw*dh*4)
	for y := 0; y < dh; y++ {
		syy := sy + y*sh/dh
		if syy > img.H-1 {
			syy = img.H - 1
		}
		for x := 0; x < dw; x++ {
			sxx := sx + x*sw/dw
			if sxx > img.W-1 {
				sxx = img.W - 1
			}
			pp := (syy*img.W + sxx) * 4
			q := (y*dw + x) * 4
			copy(o[q:q+4], img.Data[pp:pp+4])
		}
	}
	return &ImageData{dw, dh, o}
}

// canvas drawImage with imageSmoothingEnabled=true quality='high'
// Skia kHigh = cubic Mitchell (B=C=1/3), separable, support scaled for minification.
func mitchell(x float64) float64 {
	const B = 1.0 / 3.0
	const C = 1.0 / 3.0
	x = math.Abs(x)
	if x < 1 {
		return ((12-9*B-6*C)*x*x*x + (-18+12*B+6*C)*x*x + (6 - 2*B)) / 6
	}
	if x < 2 {
		return ((-B-6*C)*x*x*x + (6*B+30*C)*x*x + (-12*B-48*C)*x + (8*B + 24*C)) / 6
	}
	return 0
}

func resamplePass(src []uint8, sw, sh, dw, dh int, horizontal bool) []uint8 {
	// RGBA bytes -> RGBA bytes, one direction
	dst := make([]uint8, dw*dh*4)
	// scale factor: src/dst along the resampled axis
	var scale float64
	var srcLen, dstLen int
	if horizontal {
		srcLen, dstLen = sw, dw
	} else {
		srcLen, dstLen = sh, dh
	}
	scale = float64(dstLen) / float64(srcLen)
	// filter support: cubic radius 2, widened when minifying
	support := 2.0
	fscale := 1.0
	if scale < 1 {
		fscale = 1 / scale
		support = 2 * fscale
	}
	for d := 0; d < dstLen; d++ {
		// center in src coords (canvas/Skia pixel-center convention)
		center := (float64(d)+0.5)/scale
		lo := int(math.Ceil(center - support))
		hi := int(math.Floor(center + support))
		var weights []float64
		var idxs []int
		sum := 0.0
		for s := lo; s <= hi; s++ {
			w := mitchell((center - (float64(s) + 0.5)) / fscale)
			if w == 0 {
				continue
			}
			ss := s
			if ss < 0 {
				ss = 0
			}
			if ss > srcLen-1 {
				ss = srcLen - 1
			}
			weights = append(weights, w)
			idxs = append(idxs, ss)
			sum += w
		}
		for i := range weights {
			weights[i] /= sum
		}
		if horizontal {
			for y := 0; y < sh; y++ {
				var acc [4]float64
				for k, s := range idxs {
					p := (y*sw + s) * 4
					for c := 0; c < 4; c++ {
						acc[c] += float64(src[p+c]) * weights[k]
					}
				}
				q := (y*dw + d) * 4
				for c := 0; c < 4; c++ {
					dst[q+c] = uint8(clampf(math.RoundToEven(acc[c]), 0, 255))
				}
			}
		} else {
			for x := 0; x < sw; x++ {
				var acc [4]float64
				for k, s := range idxs {
					p := (s*sw + x) * 4
					for c := 0; c < 4; c++ {
						acc[c] += float64(src[p+c]) * weights[k]
					}
				}
				q := (d*sw + x) * 4
				for c := 0; c < 4; c++ {
					dst[q+c] = uint8(clampf(math.RoundToEven(acc[c]), 0, 255))
				}
			}
		}
	}
	return dst
}


// float64 variant: no intermediate rounding (Skia keeps precision between passes)
func resamplePassF(src []float64, sw, sh, dw, dh int, horizontal bool) []float64 {
	dst := make([]float64, dw*dh*4)
	var scale float64
	var srcLen, dstLen int
	if horizontal {
		srcLen, dstLen = sw, dw
	} else {
		srcLen, dstLen = sh, dh
	}
	scale = float64(dstLen) / float64(srcLen)
	support := 2.0
	fscale := 1.0
	if scale < 1 {
		fscale = 1 / scale
		support = 2 * fscale
	}
	for d := 0; d < dstLen; d++ {
		center := (float64(d) + 0.5) / scale
		lo := int(math.Ceil(center - support))
		hi := int(math.Floor(center + support))
		var weights []float64
		var idxs []int
		sum := 0.0
		for s := lo; s <= hi; s++ {
			w := mitchell((center - (float64(s) + 0.5)) / fscale)
			if w == 0 {
				continue
			}
			ss := s
			if ss < 0 {
				ss = 0
			}
			if ss > srcLen-1 {
				ss = srcLen - 1
			}
			weights = append(weights, w)
			idxs = append(idxs, ss)
			sum += w
		}
		for i := range weights {
			weights[i] /= sum
		}
		if horizontal {
			for y := 0; y < sh; y++ {
				var acc [4]float64
				for k, s := range idxs {
					p := (y*sw + s) * 4
					for c := 0; c < 4; c++ {
						acc[c] += src[p+c] * weights[k]
					}
				}
				q := (y*dw + d) * 4
				for c := 0; c < 4; c++ {
					dst[q+c] = acc[c]
				}
			}
		} else {
			for x := 0; x < sw; x++ {
				var acc [4]float64
				for k, s := range idxs {
					p := (s*sw + x) * 4
					for c := 0; c < 4; c++ {
						acc[c] += src[p+c] * weights[k]
					}
				}
				q := (d*sw + x) * 4
				for c := 0; c < 4; c++ {
					dst[q+c] = acc[c]
				}
			}
		}
	}
	return dst
}

// canvasResizeHigh: crop (sx,sy,sw,sh) then resize to (dw,dh) like canvas high quality
func canvasResizeHigh(img *ImageData, sx, sy, sw, sh, dw, dh int) *ImageData {
	// crop first
	crop := make([]uint8, sw*sh*4)
	for y := 0; y < sh; y++ {
		si := ((sy+y)*img.W + sx) * 4
		copy(crop[y*sw*4:(y+1)*sw*4], img.Data[si:si+sw*4])
	}
	// two-pass, float intermediate (matches Skia precision)
	cf := make([]float64, len(crop))
	for i, v := range crop {
		cf[i] = float64(v)
	}
	tmp := resamplePassF(cf, sw, sh, dw, sh, true)
	of := resamplePassF(tmp, dw, sh, dw, dh, false)
	out := make([]uint8, len(of))
	for i, v := range of {
		out[i] = uint8(clampf(math.RoundToEven(v), 0, 255))
	}
	return &ImageData{dw, dh, out}
}

// upNN
func upNN(img *ImageData, s float64) *ImageData {
	w, h := img.W, img.H
	W2 := int(jsRound(float64(w) * s))
	H2 := int(jsRound(float64(h) * s))
	o := make([]uint8, W2*H2*4)
	for y := 0; y < H2; y++ {
		sy := int(float64(y) / s)
		if sy > h-1 {
			sy = h - 1
		}
		for x := 0; x < W2; x++ {
			sx := int(float64(x) / s)
			if sx > w-1 {
				sx = w - 1
			}
			pp := (sy*w + sx) * 4
			q := (y*W2 + x) * 4
			copy(o[q:q+3], img.Data[pp:pp+3])
			o[q+3] = 255
		}
	}
	return &ImageData{W2, H2, o}
}

// ---------- PrismRoi ----------

type roiBox struct{ sx, sy, w, h int }

func roiBBox(img *ImageData) *roiBox {
	W, H, d := img.W, img.H, img.Data
	g := max(1, int(math.Floor(float64(max(W, H))/200)))
	gw := (W + g - 1) / g
	gh := (H + g - 1) / g
	type rgb [3]int
	px := make([]rgb, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			i := ((y*g)*W + x*g) * 4
			px[y*gw+x] = rgb{int(d[i]), int(d[i+1]), int(d[i+2])}
		}
	}
	med := func(c int) int {
		a := make([]int, len(px))
		for i, p := range px {
			a[i] = p[c]
		}
		for i := 1; i < len(a); i++ {
			v := a[i]
			j := i - 1
			for j >= 0 && a[j] > v {
				a[j+1] = a[j]
				j--
			}
			a[j+1] = v
		}
		return a[len(a)>>1]
	}
	m := rgb{med(0), med(1), med(2)}
	out := make([]uint8, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			p := px[y*gw+x]
			if absi(p[0]-m[0])+absi(p[1]-m[1])+absi(p[2]-m[2]) > 90 {
				out[y*gw+x] = 1
			}
		}
	}
	den := make([]uint8, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if out[y*gw+x] == 0 {
				continue
			}
			n := 0
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					yy, xx := y+dy, x+dx
					if yy >= 0 && yy < gh && xx >= 0 && xx < gw && out[yy*gw+xx] != 0 {
						n++
					}
				}
			}
			if n >= 3 {
				den[y*gw+x] = 1
			}
		}
	}
	lab := make([]int, gw*gh)
	for i := range lab {
		lab[i] = -1
	}
	var sizes []int
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if den[y*gw+x] == 0 || lab[y*gw+x] >= 0 {
				continue
			}
			id := len(sizes)
			sz := 0
			st := [][2]int{{x, y}}
			lab[y*gw+x] = id
			for len(st) > 0 {
				c := st[len(st)-1]
				st = st[:len(st)-1]
				sz++
				for _, dd := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					xx, yy := c[0]+dd[0], c[1]+dd[1]
					if xx >= 0 && xx < gw && yy >= 0 && yy < gh && den[yy*gw+xx] != 0 && lab[yy*gw+xx] < 0 {
						lab[yy*gw+xx] = id
						st = append(st, [2]int{xx, yy})
					}
				}
			}
			sizes = append(sizes, sz)
		}
	}
	if len(sizes) == 0 {
		return nil
	}
	best := 0
	for i := 1; i < len(sizes); i++ {
		if sizes[i] > sizes[best] {
			best = i
		}
	}
	if sizes[best] < 16 {
		return nil
	}
	x0, x1, y0, y1 := gw, 0, gh, 0
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if lab[y*gw+x] == best {
				if x < x0 {
					x0 = x
				}
				if x > x1 {
					x1 = x
				}
				if y < y0 {
					y0 = y
				}
				if y > y1 {
					y1 = y
				}
			}
		}
	}
	w := (x1 - x0 + 1) * g
	h := (y1 - y0 + 1) * g
	mg := int(jsRound(float64(max(w, h)) * .25))
	cx := float64(x0*g) + float64(w)/2
	cy := float64(y0*g) + float64(h)/2
	s := float64(max(w, h)) + 2*float64(mg)
	sx := max(0, int(jsRound(cx-s/2)))
	sy := max(0, int(jsRound(cy-s/2)))
	ex := min(W, int(jsRound(cx+s/2)))
	ey := min(H, int(jsRound(cy+s/2)))
	if (ex-sx)*(ey-sy)*100 > 40*W*H {
		return nil
	}
	return &roiBox{sx, sy, ex - sx, ey - sy}
}

func absi(x int) int {
	if x < 0 {
		return -x
	}
	return x
}

func roiCrop(img *ImageData, b *roiBox) *ImageData {
	o := make([]uint8, b.w*b.h*4)
	for y := 0; y < b.h; y++ {
		si := ((b.sy+y)*img.W + b.sx) * 4
		copy(o[y*b.w*4:(y+1)*b.w*4], img.Data[si:si+b.w*4])
	}
	return &ImageData{b.w, b.h, o}
}

// saliencyCrop (marginFrac, reject >60% area) - like roiBBox but crops directly
func saliencyCrop(img *ImageData, marginFrac float64) *ImageData {
	W, H, d := img.W, img.H, img.Data
	g := max(1, int(math.Floor(float64(max(W, H))/200)))
	gw := (W + g - 1) / g
	gh := (H + g - 1) / g
	type rgb [3]int
	px := make([]rgb, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			i := ((y*g)*W + x*g) * 4
			px[y*gw+x] = rgb{int(d[i]), int(d[i+1]), int(d[i+2])}
		}
	}
	med := func(c int) int {
		a := make([]int, len(px))
		for i, p := range px {
			a[i] = p[c]
		}
		for i := 1; i < len(a); i++ {
			v := a[i]
			j := i - 1
			for j >= 0 && a[j] > v {
				a[j+1] = a[j]
				j--
			}
			a[j+1] = v
		}
		return a[len(a)>>1]
	}
	m := rgb{med(0), med(1), med(2)}
	out := make([]uint8, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			p := px[y*gw+x]
			if absi(p[0]-m[0])+absi(p[1]-m[1])+absi(p[2]-m[2]) > 90 {
				out[y*gw+x] = 1
			}
		}
	}
	den := make([]uint8, gw*gh)
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if out[y*gw+x] == 0 {
				continue
			}
			n := 0
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					yy, xx := y+dy, x+dx
					if yy >= 0 && yy < gh && xx >= 0 && xx < gw && out[yy*gw+xx] != 0 {
						n++
					}
				}
			}
			if n >= 3 {
				den[y*gw+x] = 1
			}
		}
	}
	lab := make([]int, gw*gh)
	for i := range lab {
		lab[i] = -1
	}
	var sizes []int
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if den[y*gw+x] == 0 || lab[y*gw+x] >= 0 {
				continue
			}
			id := len(sizes)
			sz := 0
			st := [][2]int{{x, y}}
			lab[y*gw+x] = id
			for len(st) > 0 {
				c := st[len(st)-1]
				st = st[:len(st)-1]
				sz++
				for _, dd := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
					xx, yy := c[0]+dd[0], c[1]+dd[1]
					if xx >= 0 && xx < gw && yy >= 0 && yy < gh && den[yy*gw+xx] != 0 && lab[yy*gw+xx] < 0 {
						lab[yy*gw+xx] = id
						st = append(st, [2]int{xx, yy})
					}
				}
			}
			sizes = append(sizes, sz)
		}
	}
	if len(sizes) == 0 {
		return nil
	}
	best := 0
	for i := 1; i < len(sizes); i++ {
		if sizes[i] > sizes[best] {
			best = i
		}
	}
	if sizes[best] < 16 {
		return nil
	}
	x0, x1, y0, y1 := gw, 0, gh, 0
	for y := 0; y < gh; y++ {
		for x := 0; x < gw; x++ {
			if lab[y*gw+x] == best {
				if x < x0 {
					x0 = x
				}
				if x > x1 {
					x1 = x
				}
				if y < y0 {
					y0 = y
				}
				if y > y1 {
					y1 = y
				}
			}
		}
	}
	w := (x1 - x0 + 1) * g
	h := (y1 - y0 + 1) * g
	mg := int(jsRound(float64(max(w, h)) * marginFrac))
	cx := float64(x0*g) + float64(w)/2
	cy := float64(y0*g) + float64(h)/2
	s := float64(max(w, h)) + 2*float64(mg)
	sx := max(0, int(jsRound(cx-s/2)))
	sy := max(0, int(jsRound(cy-s/2)))
	ex := min(W, int(jsRound(cx+s/2)))
	ey := min(H, int(jsRound(cy+s/2)))
	if (ex-sx)*(ey-sy)*100 > 60*W*H {
		return nil
	}
	return roiCrop(img, &roiBox{sx, sy, ex - sx, ey - sy})
}
