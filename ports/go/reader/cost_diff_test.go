package main

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestCostWasmDiff(t *testing.T) {
	raw, err := os.ReadFile("/tmp/wasm2_vectors.json")
	if err != nil {
		t.Skip(err)
	}
	var rawv []map[string]json.RawMessage
	if err := json.Unmarshal(raw, &rawv); err != nil {
		t.Fatal(err)
	}
	bad := 0
	for i, rv := range rawv {
		get := func(name string, out interface{}) { json.Unmarshal(rv[name], out) }
		var w, h, kind int
		var W, H, scale, B, result float64
		var hom [8]float64
		var warp [13]float64
		var cellsF, extra []float64
		var flag bool
		var b64 string
		get("w", &w)
		get("h", &h)
		get("W", &W)
		get("H", &H)
		get("kind", &kind)
		get("scale", &scale)
		get("B", &B)
		get("result", &result)
		get("hom", &hom)
		get("warp", &warp)
		get("cells", &cellsF)
		get("extra", &extra)
		get("flag", &flag)
		get("mapsB64", &b64)
		pb, _ := base64.StdEncoding.DecodeString(b64)
		maps := make([]float32, len(pb)/4)
		for j := range maps {
			maps[j] = math.Float32frombits(uint32(pb[4*j]) | uint32(pb[4*j+1])<<8 | uint32(pb[4*j+2])<<16 | uint32(pb[4*j+3])<<24)
		}
		cells := make([][3]float64, len(cellsF)/3)
		for j := range cells {
			copy(cells[j][:], cellsF[3*j:3*j+3])
		}
		got := costWasmScore(hom, &warp, W, H, kind, maps, w, h, scale, cells, extra, flag, B)
		if math.Abs(got-result) > 1e-9*(1+math.Abs(result)) {
			bad++
			t.Errorf("vec %d: got %v want %v", i, got, result)
		}
	}
	if bad == 0 {
		t.Logf("all %d vectors match", len(rawv))
	}
}
