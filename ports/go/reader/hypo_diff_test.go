package main

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestHypoWasmDiff(t *testing.T) {
	raw, err := os.ReadFile("/tmp/wasm0_vectors.json")
	if err != nil {
		t.Skip(err)
	}
	var vs []struct {
		K      int        `json:"k"`
		W, H   int        `json:"w"`
		Hom    []float64  `json:"hom"`
		White  []float64  `json:"white"`
		Cells  []float64  `json:"cells"`
		Lab    []float64  `json:"lab"`
		Off    []float64  `json:"off"`
		Fast   bool       `json:"fast"`
		Mode   int        `json:"mode"`
		Cost   float64    `json:"cost"`
		Score  float64    `json:"score"`
		PixB64 string     `json:"pixB64"`
	}
	// fix H field collision: re-unmarshal manually
	var rawv []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawv); err != nil {
		t.Fatal(err)
	}
	_ = vs
	bad := 0
	for i, rv := range rawv {
		get := func(name string, out interface{}) { json.Unmarshal(rv[name], out) }
		var w, h int
		var hom [8]float64
		var white [3]float64
		var cellsF []float64
		var lab [27]float64
		var off [14]float64
		var fast bool
		var mode int
		var cost, score float64
		var p64 string
		get("w", &w)
		var hh int
		get("h", &hh)
		h = hh
		get("hom", &hom)
		get("white", &white)
		get("cells", &cellsF)
		get("lab", &lab)
		get("off", &off)
		get("fast", &fast)
		get("mode", &mode)
		get("cost", &cost)
		get("score", &score)
		get("pixB64", &p64)
		pb, _ := base64.StdEncoding.DecodeString(p64)
		pix := make([]float32, len(pb)/4)
		for j := range pix {
			pix[j] = math.Float32frombits(uint32(pb[4*j]) | uint32(pb[4*j+1])<<8 | uint32(pb[4*j+2])<<16 | uint32(pb[4*j+3])<<24)
		}
		cells := make([][3]float64, len(cellsF)/3)
		for j := range cells {
			copy(cells[j][:], cellsF[3*j:3*j+3])
		}
		gc, gs := hypoWasmScore(pix, w, h, hom, white, cells, lab, off, fast, mode)
		d1 := math.Abs(gc - cost)
		d2 := math.Abs(gs - score)
		if d1 > 1e-9 || d2 > 1e-9 {
			bad++
			t.Errorf("vec %d: got (%v,%v) want (%v,%v)", i, gc, gs, cost, score)
		}
	}
	if bad == 0 {
		t.Logf("all %d vectors match", len(rawv))
	}
}
