package main

import "math"

// fdlibm/musl cbrt - matches V8 Math.cbrt bit-exactly.
func cbrtV8(x float64) float64 {
	const (
		B1 = 715094163
		B2 = 696219795
		C  = 5.42857142857142815906e-01
		D  = -7.05306122448979611050e-01
		E  = 1.41428571428571436819e+00
		F  = 1.60714285714285720630e+00
		G  = 3.57142857142857150787e-01
	)
	if x != x || math.IsInf(x, 0) {
		return x + x
	}
	if x == 0 {
		return x
	}
	neg := math.Signbit(x)
	ax := math.Abs(x)
	u := math.Float64bits(ax)
	hx := uint32(u >> 32)
	var t float64
	if hx < 0x00100000 {
		u = math.Float64bits(ax * 0x1p54)
		hx = uint32(u >> 32)
		u = uint64(hx/3+B2) << 32
	} else {
		u = uint64(hx/3+B1) << 32
	}
	t = math.Float64frombits(u)

	r := t * t / ax
	s := C + r*t
	t *= G + F/(s+E+D/s)

	// chop to 20 bits and make it larger than cbrt(x)
	u = math.Float64bits(t)
	u = (u >> 32 << 32) + 1<<32
	t = math.Float64frombits(u)

	s = t * t
	r = ax / s
	w := t + t
	r = (r - t) / (w + r)
	t = t + t*r
	if neg {
		t = -t
	}
	return t
}
