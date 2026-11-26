package main

import (
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"runtime"
	"runtime/pprof"
	"sync"
	"time"
)

func loadJPEG(path string) (*ImageData, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	im, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	b := im.Bounds()
	w, h := b.Dx(), b.Dy()
	data := make([]uint8, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bl, a := im.At(b.Min.X+x, b.Min.Y+y).RGBA()
			// JPEG is opaque; Go's RGBA() returns 16-bit premultiplied; a=65535
			_ = a
			i := (y*w + x) * 4
			data[i] = uint8(r >> 8)
			data[i+1] = uint8(g >> 8)
			data[i+2] = uint8(bl >> 8)
			data[i+3] = 255
		}
	}
	return &ImageData{w, h, data}, nil
}

type outLine struct {
	File string `json:"file"`
	OK   bool   `json:"ok"`
	Text string `json:"text,omitempty"`
	Err  string `json:"err,omitempty"`
	Step string `json:"step,omitempty"`
	Ms   int64  `json:"ms"`
}

var cacheMu sync.Mutex

func main() {
	if pf := os.Getenv("PRISM_PROF"); pf != "" {
		f, _ := os.Create(pf)
		pprof.StartCPUProfile(f)
		defer pprof.StopCPUProfile()
	}
	paths := os.Args[1:]
	jobs := make(chan int)
	results := make([]outLine, len(paths))
	var wg sync.WaitGroup
	nw := runtime.NumCPU()
	if nw < 1 {
		nw = 1
	}
	for wk := 0; wk < nw; wk++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				results[i] = readOne(paths[i])
			}
		}()
	}
	for i := range paths {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	enc := json.NewEncoder(os.Stdout)
	for _, ol := range results {
		enc.Encode(ol)
	}
}

func readOne(path string) outLine {
	t0 := time.Now()
	beginDecode(300 * time.Second)
	ol := outLine{File: path}
	img, err := loadJPEG(path)
	if err != nil {
		ol.Err = err.Error()
	} else {
		res, step, err := chainRead(img)
		if err == nil && res != nil {
			ol.OK = true
			ol.Text = res.Text
			ol.Step = step
		} else if err != nil {
			ol.Err = err.Error()
		}
	}
	ol.Ms = time.Since(t0).Milliseconds()
	return ol
}
