package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestJsStream(t *testing.T) {
	raw, err := os.ReadFile("/tmp/js_stream.json")
	if err != nil {
		t.Skip("no js stream")
	}
	var d struct {
		Hdr    Header    `json:"hdr"`
		Stream []float32 `json:"stream"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	res, err := decodeStream(d.Hdr, d.Stream)
	if err != nil {
		t.Fatalf("decodeStream failed: %v", err)
	}
	if res.Text != "https://ex.co/PtYgjm" {
		t.Fatalf("wrong text: %q", res.Text)
	}
	t.Logf("OK: %q variant=%s corrected=%d", res.Text, res.Variant, res.Corrected)
}
