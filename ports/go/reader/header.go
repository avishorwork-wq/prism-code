package main

// parseHeader fA + header candidate machinery (cA table)

var cA [24]int

func init() {
	for e := 0; e < 24; e++ {
		if e >= 20 {
			cA[e] = 1 << uint(23-e)
			continue
		}
		t := make([]int, 20)
		t[e] = 1
		cA[e] = crc4(t)
	}
}

// parseHeader: soft bits (24) -> Header; negative = bit 1
func parseHeader(A []float32) (Header, error) {
	var h Header
	e := make([]int, len(A))
	for i, v := range A {
		if v < 0 {
			e[i] = 1
		}
	}
	t := 0
	r := func(n int) int {
		v := 0
		for ; n > 0; n-- {
			v = v<<1 | e[t]
			t++
		}
		return v
	}
	o := r(3)
	a := r(2)
	i := r(1)
	g := r(1)
	l := r(13)
	I := r(4)
	first20 := make([]int, 20)
	copy(first20, e)
	if crc4(first20) != I || o > 5 {
		return h, nA("header", "Header checksum did not pass")
	}
	c, err := capacityOf(o, a, i)
	if err != nil || l > c.payload {
		return h, nA("header", "Invalid length")
	}
	return Header{o, a, i, g, l}, nil
}
