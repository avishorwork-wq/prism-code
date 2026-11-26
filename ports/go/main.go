// Prism Code CLI (Go port): encode / decode clean Prism Code PNGs.
package main

import (
	"fmt"
	"os"
	"strconv"
)

func arg(a []string, name, dflt string) string {
	for i := 0; i < len(a)-1; i++ {
		if a[i] == "--"+name {
			return a[i+1]
		}
	}
	return dflt
}

func hasArg(a []string, name string) bool {
	for _, s := range a {
		if s == "--"+name {
			return true
		}
	}
	return false
}

func atoiOr(s string, d int) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		return d
	}
	return v
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]
       prism decode I.png [--out O]
       prism capacity`)
	os.Exit(2)
}

func main() {
	a := os.Args[1:]
	if len(a) == 0 {
		usage()
	}
	switch a[0] {
	case "encode":
		text := arg(a, "text", "")
		input := arg(a, "input", "")
		if text == "" && input == "" {
			fatal("need --text or --input")
		}
		var payload []byte
		var err error
		if text != "" {
			payload = []byte(text)
		} else {
			payload, err = os.ReadFile(input)
			if err != nil {
				fatal(err.Error())
			}
		}
		size := atoiOr(arg(a, "size", "-1"), -1)
		ecc := atoiOr(arg(a, "ecc", "1"), 1)
		modeS := arg(a, "mode", "0")
		mode := 0
		if modeS == "1" || modeS == "bw" {
			mode = 1
		}
		radius := atoiOr(arg(a, "radius", "12"), 12)
		typ := atoiOr(arg(a, "type", "0"), 0)
		logo := atoiOr(arg(a, "logo", "0"), 0)
		out := arg(a, "out", "")
		if out == "" {
			fatal("need --out")
		}
		png, code, err := EncodePNG(payload, radius, size, ecc, mode, typ, logo)
		if err != nil {
			fatal(err.Error())
		}
		if err := os.WriteFile(out, png, 0644); err != nil {
			fatal(err.Error())
		}
		if sj := arg(a, "symbols", ""); sj != "" {
			writeSymbolsJSON(sj, code)
		}
		w, h, _, _ := ReadPNG(png)
		fmt.Printf("wrote %s (%dx%d px, grid %dx%d cells, size %d, %s, ecc %d, %d payload bytes)\n",
			out, w, h, code.Lay.C, code.Lay.R, code.size, modeName(mode), ecc, len(payload))
		fmt.Printf("capacity at these settings: %d payload bytes\n", code.Cap.payload)
	case "decode":
		if len(a) < 2 {
			usage()
		}
		pngPath := a[1]
		buf, err := os.ReadFile(pngPath)
		if err != nil {
			fatal(err.Error())
		}
		payload, hdr, err := DecodePNG(buf)
		if err != nil {
			fatal(err.Error())
		}
		if out := arg(a, "out", ""); out != "" {
			if err := os.WriteFile(out, payload, 0644); err != nil {
				fatal(err.Error())
			}
			fmt.Printf("wrote %s (%d bytes)\n", out, len(payload))
		} else {
			os.Stdout.Write(payload)
			if len(payload) > 0 {
				os.Stdout.Write([]byte("\n"))
			}
		}
		fmt.Fprintf(os.Stderr, "header: size %d, ecc %d, mode %s, type %d, %d payload bytes, CRC-32 OK\n",
			hdr.Size, hdr.Ecc, modeName(hdr.Mode), hdr.Type, hdr.Length)
	case "capacity":
		for s := 0; s < 6; s++ {
			for ecc := 0; ecc < 4; ecc++ {
				for mode := 0; mode < 2; mode++ {
					cp, _ := capacity(s, ecc, mode)
					fmt.Printf("size %d (%dx%d) ecc %d %s: %d payload bytes\n",
						s, SIZES[s].C, SIZES[s].R, ecc, modeName(mode), cp.payload)
				}
			}
		}
	default:
		usage()
	}
}

func modeName(m int) string {
	if m == 0 {
		return "color"
	}
	return "bw"
}

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, "error:", msg)
	os.Exit(1)
}

func writeSymbolsJSON(path string, code *Code) {
	f, err := os.Create(path)
	if err != nil {
		fatal(err.Error())
	}
	defer f.Close()
	fmt.Fprintf(f, "{\"size\":%d,\"ecc\":%d,\"mode\":%d,\"C\":%d,\"R\":%d,\"symbols\":[",
		code.size, code.ecc, code.mode, code.Lay.C, code.Lay.R)
	for i, s := range code.Symbols {
		if i > 0 {
			f.WriteString(",")
		}
		fmt.Fprintf(f, "%d", s)
	}
	f.WriteString("]}")
}
