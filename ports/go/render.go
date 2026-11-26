// Prism Code - Go port: rendering (same geometry as Prism.render) and PNG IO.
package main

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
)

func fillPoly(img *image.RGBA, w, h int, pts [][2]float64, rgb [3]uint8) {
	miny, maxy := math.Inf(1), math.Inf(-1)
	for _, p := range pts {
		miny = math.Min(miny, p[1])
		maxy = math.Max(maxy, p[1])
	}
	y0 := maxInt(0, int(math.Floor(miny)))
	y1 := minInt(h-1, int(math.Ceil(maxy)))
	for y := y0; y <= y1; y++ {
		yc := float64(y) + 0.5
		var xs []float64
		for k := 0; k < len(pts); k++ {
			x1, a := pts[k][0], pts[k][1]
			x2, b := pts[(k+1)%len(pts)][0], pts[(k+1)%len(pts)][1]
			if (a <= yc && b > yc) || (b <= yc && a > yc) {
				xs = append(xs, x1+(yc-a)/(b-a)*(x2-x1))
			}
		}
		sortFloats(xs)
		for k := 0; k+1 < len(xs); k += 2 {
			xa := maxInt(0, int(math.Round(xs[k]-0.5)))
			xb := minInt(w-1, int(math.Round(xs[k+1]-0.5))-1)
			for x := xa; x <= xb; x++ {
				o := (y*w + x) * 4
				img.Pix[o] = rgb[0]
				img.Pix[o+1] = rgb[1]
				img.Pix[o+2] = rgb[2]
				img.Pix[o+3] = 255
			}
		}
	}
}

func sortFloats(a []float64) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j] < a[j-1]; j-- {
			a[j], a[j-1] = a[j-1], a[j]
		}
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Render draws the code at r pixels per cell, same geometry as the JS render.
func Render(code *Code, r int) *image.RGBA {
	l := code.Lay
	w := int(math.Ceil((l.W + 2*Q) * float64(r)))
	h := int(math.Ceil((l.H + 2*Q) * float64(r)))
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	for _, c := range l.cells {
		s := code.Symbols[c.index]
		if s == 8 {
			continue
		}
		pts := make([][2]float64, 6)
		for k := 0; k < 6; k++ {
			a := float64(30+60*k) * math.Pi / 180
			pts[k] = [2]float64{(c.x + Q + 1.03*math.Cos(a)) * float64(r),
				(c.y + Q + 1.03*math.Sin(a)) * float64(r)}
		}
		fillPoly(img, w, h, pts, PAL[s])
	}
	return img
}

func WritePNG(w, h int, rgba []byte) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	copy(img.Pix, rgba)
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func EncodePNG(payload []byte, r, size, ecc, mode, typ, logo int) ([]byte, *Code, error) {
	code, err := encode(payload, size, ecc, mode, typ, logo)
	if err != nil {
		return nil, nil, err
	}
	img := Render(code, r)
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return nil, nil, err
	}
	return buf.Bytes(), code, nil
}

// ReadPNG reads any 8-bit PNG (colour types 0/2/3/4/6, all filters,
// interlaced or not) and returns width, height, RGBA bytes.
func ReadPNG(buf []byte) (int, int, []byte, error) {
	img, err := png.Decode(bytes.NewReader(buf))
	if err != nil {
		return 0, 0, nil, err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	out := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bl, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			o := (y*w + x) * 4
			out[o] = uint8(r >> 8)
			out[o+1] = uint8(g >> 8)
			out[o+2] = uint8(bl >> 8)
			out[o+3] = uint8(a >> 8)
		}
	}
	return w, h, out, nil
}

func DecodePNG(buf []byte) ([]byte, Header, error) {
	w, h, rgba, err := ReadPNG(buf)
	if err != nil {
		return nil, Header{}, err
	}
	return DecodeImage(w, h, rgba)
}

// keep imports used even if some helpers go unused in future edits
var (
	_ = zlib.NewReader
	_ = binary.BigEndian
	_ = errors.New
	_ = color.RGBA{}
)
