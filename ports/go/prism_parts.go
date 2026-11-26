// Prism big files in parts (PPT1), byte-compatible with prism-parts.js.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.
package main

import (
	"crypto/rand"
	"fmt"
	"strings"
)

const PartsECC = 2

func ppOverhead(nameLen int) int { return 4 + 4 + 2 + 2 + 4 + 4 + 1 + nameLen + 4 }

// cleanName: backslash, slash and control bytes become '_', trimmed to 200 chars.
func cleanName(name string) string {
	if name == "" {
		name = "file"
	}
	var b strings.Builder
	for _, c := range []byte(name) {
		if b.Len() >= 200 {
			break
		}
		if c == '\\' || c == '/' || c < 0x20 {
			b.WriteByte('_')
		} else {
			b.WriteByte(c)
		}
	}
	return b.String()
}

// nameBytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
func nameBytes(name string) []byte {
	clean := []byte(cleanName(name))
	n := len(clean)
	if n > 40 {
		n = 40
		for n > 0 && (clean[n]&0xC0) == 0x80 {
			n-- // back off to a lead byte
		}
		if n > 0 && (clean[n]&0x80) != 0 {
			need := 0
			c := clean[n]
			if (c & 0xE0) == 0xC0 {
				need = 2
			} else if (c & 0xF0) == 0xE0 {
				need = 3
			} else if (c & 0xF8) == 0xF0 {
				need = 4
			}
			if need != 0 && n+need > 41 {
				n--
			}
		}
	}
	return clean[:n]
}

type PartsPlan struct {
	Room  int
	Total int
	Name  string
}

func PartsPlanCalc(length int, name string, codeSize int) (*PartsPlan, error) {
	nb := nameBytes(name)
	cap_, err := capacity(codeSize, PartsECC, 0)
	if err != nil {
		return nil, err
	}
	room := cap_.payload - ppOverhead(len(nb))
	if room < 64 {
		return nil, fmt.Errorf("part size leaves < 64 bytes of room")
	}
	total := (length + room - 1) / room
	if total < 1 {
		total = 1
	}
	if total > 65535 {
		return nil, fmt.Errorf("file too big for this part size")
	}
	return &PartsPlan{Room: room, Total: total, Name: string(nb)}, nil
}

// PartsSplitFile splits bytes into PPT1 part payloads.
func PartsSplitFile(data []byte, name string, codeSize int) ([][]byte, error) {
	plan, err := PartsPlanCalc(len(data), name, codeSize)
	if err != nil {
		return nil, err
	}
	nb := []byte(plan.Name)
	id := make([]byte, 4)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	whole := crc32(data)
	parts := make([][]byte, plan.Total)
	for n := 0; n < plan.Total; n++ {
		off := n * plan.Room
		clen := len(data) - off
		if clen > plan.Room {
			clen = plan.Room
		}
		plen := ppOverhead(len(nb)) + clen
		p := make([]byte, 0, plen)
		p = append(p, 'P', 'P', 'T', '1')
		p = append(p, id...)
		p = append(p, byte((n+1)>>8), byte(n+1))
		p = append(p, byte(plan.Total>>8), byte(plan.Total))
		var tmp [4]byte
		be32w(tmp[:], uint32(len(data)))
		p = append(p, tmp[:]...)
		be32w(tmp[:], whole)
		p = append(p, tmp[:]...)
		p = append(p, byte(len(nb)))
		p = append(p, nb...)
		p = append(p, data[off:off+clen]...)
		be32w(tmp[:], crc32(p))
		p = append(p, tmp[:]...)
		parts[n] = p
	}
	return parts, nil
}

type PartInfo struct {
	ID       string
	N, Total int
	Len      uint32
	Whole    uint32
	Name     string
	Chunk    []byte
}

// PartsParse parses one part payload. ok=false,bad="" = not a part;
// bad set = damaged part.
func PartsParse(b []byte) (info *PartInfo, bad string, ok bool) {
	if len(b) < 25 || string(b[:4]) != "PPT1" {
		return nil, "", false
	}
	if crc32(b[:len(b)-4]) != be32r(b[len(b)-4:]) {
		return nil, "This part failed its own check. Scan it again.", false
	}
	info = &PartInfo{}
	for i := 0; i < 4; i++ {
		info.ID += fmt.Sprintf("%02x", b[4+i])
	}
	info.N = int(b[8])<<8 | int(b[9])
	info.Total = int(b[10])<<8 | int(b[11])
	info.Len = be32r(b[12:16])
	info.Whole = be32r(b[16:20])
	nl := int(b[20])
	if 21+nl+4 > len(b) || info.N == 0 || info.N > info.Total {
		return nil, "This part has a broken header.", false
	}
	info.Name = string(b[21 : 21+nl])
	info.Chunk = b[21+nl : len(b)-4]
	return info, "", true
}

// PartAdd statuses, like the site.
const (
	PartNotPart   = 0
	PartBad       = 1
	PartOther     = 2
	PartDuplicate = 3
	PartNew       = 4
	PartComplete  = 5
)

type Assembler struct {
	ID        string
	Total     int
	Len       uint32
	Whole     uint32
	Name      string
	chunks    [][]byte
	Have      int
	Started   bool
}

func (a *Assembler) Reset() { *a = Assembler{} }

func (a *Assembler) Add(b []byte) (status int, partN int, msg string) {
	p, bad, ok := PartsParse(b)
	if !ok && bad == "" {
		return PartNotPart, 0, ""
	}
	if bad != "" {
		return PartBad, 0, bad
	}
	if !a.Started {
		a.Started = true
		a.ID = p.ID
		a.Total = p.Total
		a.Len = p.Len
		a.Whole = p.Whole
		a.Name = p.Name
		a.chunks = make([][]byte, p.Total)
	} else if p.ID != a.ID {
		nm := p.Name
		if nm == "" {
			nm = "unnamed"
		}
		return PartOther, 0, fmt.Sprintf("That part belongs to a different file (%s). Start over to switch.", nm)
	} else if p.Total != a.Total || p.Len != a.Len || p.Whole != a.Whole {
		return PartBad, 0, "This part does not match the others."
	}
	if a.chunks[p.N-1] != nil {
		return PartDuplicate, p.N, ""
	}
	cp := make([]byte, len(p.Chunk))
	copy(cp, p.Chunk)
	a.chunks[p.N-1] = cp
	a.Have++
	if a.Have == a.Total {
		return PartComplete, p.N, ""
	}
	return PartNew, p.N, ""
}

// Finish rebuilds and verifies after PartComplete.
func (a *Assembler) Finish() ([]byte, string, error) {
	if a.Have != a.Total {
		return nil, "", fmt.Errorf("Parts are still missing.")
	}
	var buf []byte
	for i := 0; i < a.Total; i++ {
		if len(buf)+len(a.chunks[i]) > int(a.Len) {
			return nil, "", fmt.Errorf("The parts add up to more than the file size.")
		}
		buf = append(buf, a.chunks[i]...)
	}
	if len(buf) != int(a.Len) {
		return nil, "", fmt.Errorf("The parts add up to %d bytes, not %d.", len(buf), a.Len)
	}
	if crc32(buf) != a.Whole {
		return nil, "", fmt.Errorf("The whole-file check failed. Start over and scan the parts again.")
	}
	name := a.Name
	if name == "" {
		name = "prism-file.bin"
	}
	return buf, name, nil
}
