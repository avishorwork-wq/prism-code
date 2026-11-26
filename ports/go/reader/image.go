package main

import (
	"math"
)

// ImageData equivalent
type ImageData struct {
	W, H int
	Data []uint8 // RGBA, len 4*W*H
}

type CFGT struct {
	DetectionWidth float64
	Saturation     float64
	Darkness       float64
	MinScore       float64
	RefineStop     float64
	MeshRadius     float64
	SigmaFloor     float64
	LlrClamp       float64
	MinRadius      float64
	GlareThreshold float64
}

var CFG = CFGT{320, .25, .55, .5, .03, .6, 6, 12, 4, .90}

func clampf(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// srgb -> linear
func srgbLin(c float64) float64 {
	if c <= .04045 {
		return c / 12.92
	}
	return math.Pow((c+.055)/1.055, 2.4)
}

// linear -> srgb
func srgbQ(c float64) float64 {
	if c <= .0031308 {
		return 12.92 * c
	}
	return 1.055*math.Pow(c, 1/2.4) - .055
}

var linTable [256]float64

func init() {
	for i := 0; i < 256; i++ {
		linTable[i] = srgbLin(float64(i) / 255)
	}
}

// PAL: linear palette colors
var PAL [9][3]float64
var LABC [9][3]float64

func init() {
	for i, hx := range HEX {
		for k := 0; k < 3; k++ {
			var v int
			fmtSscanf(hx[1+2*k:3+2*k], &v)
			PAL[i][k] = srgbLin(float64(v) / 255)
		}
		LABC[i] = labOf(PAL[i])
	}
}

func fmtSscanf(s string, v *int) {
	// hex byte parse
	n := 0
	for _, c := range s {
		n <<= 4
		switch {
		case c >= '0' && c <= '9':
			n |= int(c - '0')
		case c >= 'a' && c <= 'f':
			n |= int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			n |= int(c-'A') + 10
		}
	}
	*v = n
}

// lab U: linear rgb -> LAB
func labOf(c [3]float64) [3]float64 {
	e := (.4124564*c[0] + .3575761*c[1] + .1804375*c[2]) / .95047
	t := .2126729*c[0] + .7151522*c[1] + .072175*c[2]
	r := (.0193339*c[0] + .119192*c[1] + .9503041*c[2]) / 1.08883
	o := func(x float64) float64 {
		if x > .008856 {
			return math.Cbrt(x)
		}
		return 7.787*x + 16.0/116
	}
	a, i := o(e), o(t)
	return [3]float64{116*i - 16, 500 * (a - i), 200 * (i - o(r))}
}

func hDist(a, b [3]float64) float64 {
	d0, d1, d2 := a[0]-b[0], a[1]-b[1], a[2]-b[2]
	return d0*d0 + d1*d1 + d2*d2
}

// frame T
type Frame struct {
	w, h    int
	p       []float32 // 3*w*h linear
	image   *ImageData
	calmed  bool
	texSrgb []float32 // lazy srgb downscale cache for detectTexture (JS WeakMap hA)
}

func frameOf(img *ImageData) *Frame {
	o := make([]float32, img.W*img.H*3)
	j := 0
	for i := 0; i < len(img.Data); i += 4 {
		o[j] = float32(linTable[img.Data[i]])
		o[j+1] = float32(linTable[img.Data[i+1]])
		o[j+2] = float32(linTable[img.Data[i+2]])
		j += 3
	}
	return &Frame{w: img.W, h: img.H, p: o, image: img, calmed: isCalmed(img)}
}

// sample Z: bilinear in linear space; out of bounds -> [1,1,1]
func (f *Frame) sample(t, r float64) [3]float64 {
	if t < 0 || r < 0 || t >= float64(f.w-1) || r >= float64(f.h-1) {
		return [3]float64{1, 1, 1}
	}
	o := int(math.Floor(t))
	a := int(math.Floor(r))
	fi := t - float64(o)
	g := r - float64(a)
	l := 3 * (a*f.w + o)
	p := f.p
	w3 := 3 * f.w
	c0 := (float64(p[l+0])*(1-fi) + float64(p[l+3])*fi) * (1 - g)
	c0 += (float64(p[l+w3+0])*(1-fi) + float64(p[l+w3+3])*fi) * g
	c1 := (float64(p[l+1])*(1-fi) + float64(p[l+4])*fi) * (1 - g)
	c1 += (float64(p[l+w3+1])*(1-fi) + float64(p[l+w3+4])*fi) * g
	c2 := (float64(p[l+2])*(1-fi) + float64(p[l+5])*fi) * (1 - g)
	c2 += (float64(p[l+w3+2])*(1-fi) + float64(p[l+w3+5])*fi) * g
	return [3]float64{c0, c1, c2}
}

// geometry: W solve, K homography, P map, Y corners, EA

func solveW(A [][]float64, b []float64) ([]float64, error) {
	t := len(b)
	r := make([][]float64, t)
	for i := range A {
		r[i] = append(append([]float64(nil), A[i]...), b[i])
	}
	for a := 0; a < t; a++ {
		e := a
		for o := a + 1; o < t; o++ {
			if math.Abs(r[o][a]) > math.Abs(r[e][a]) {
				e = o
			}
		}
		if math.Abs(r[e][a]) < 1e-10 {
			return nil, errSingular
		}
		r[a], r[e] = r[e], r[a]
		o := r[a][a]
		for e := a; e <= t; e++ {
			r[a][e] /= o
		}
		for e := 0; e < t; e++ {
			if e != a {
				o = r[e][a]
				for aa := a; aa <= t; aa++ {
					r[e][aa] -= o * r[a][aa]
				}
			}
		}
	}
	out := make([]float64, t)
	for i := range r {
		out[i] = r[i][t]
	}
	return out, nil
}

type errG string

func (e errG) Error() string { return string(e) }

var errSingular = errG("Singular geometry")

type Warp struct {
	W, H float64
	P    []float64 // 10 params
}

// homography is an 8-element projective transform with optional warp
type Homography struct {
	h    []float64 // 8
	warp *Warp
}

func corners(l *Layout) [4][2]float64 {
	return [4][2]float64{{0, 0}, {l.W, 0}, {l.W, l.H}, {0, l.H}}
}

func homography(A [4][2]float64, e [4][2]float64) (*Homography, error) {
	var t [][]float64
	var r []float64
	for o := 0; o < 4; o++ {
		a, i := A[o][0], A[o][1]
		g, l := e[o][0], e[o][1]
		t = append(t, []float64{a, i, 1, 0, 0, 0, -g * a, -g * i})
		t = append(t, []float64{0, 0, 0, a, i, 1, -l * a, -l * i})
		r = append(r, g, l)
	}
	h, err := solveW(t, r)
	if err != nil {
		return nil, err
	}
	return &Homography{h: h}, nil
}

func (H *Homography) mapPt(t, r float64) [2]float64 {
	if H.warp != nil {
		e, o := H.warp.W, H.warp.H
		a := H.warp.P
		i := 2*t/e - 1
		g := 2*r/o - 1
		t += (1-i*i)*(a[0]+a[1]*g) + a[2]*(1-g*g) + aval(a, 6)*i*(1-i*i) + aval(a, 8)*i*(1-g*g)
		r += (1-g*g)*(a[3]+a[4]*i) + a[5]*(1-i*i) + aval(a, 7)*g*(1-i*i) + aval(a, 9)*g*(1-g*g)
	}
	h := H.h
	o := h[6]*t + h[7]*r + 1
	return [2]float64{(h[0]*t + h[1]*r + h[2]) / o, (h[3]*t + h[4]*r + h[5]) / o}
}

func aval(a []float64, i int) float64 {
	if i < len(a) {
		return a[i]
	}
	return 0
}

// EA: mapped delta
func (H *Homography) delta(e, t, r, o float64) [2]float64 {
	a := H.mapPt(e, t)
	i := H.mapPt(e+r, t+o)
	return [2]float64{i[0] - a[0], i[1] - a[1]}
}

// hom8 copies the 8 homography coefficients (WASM marshalling layout).
func hom8(H *Homography) [8]float64 {
	var o [8]float64
	copy(o[:], H.h)
	return o
}
