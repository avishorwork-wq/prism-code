package main
import ("math";"testing";"strconv")
func TestCbrt(t *testing.T){
	for _, x := range []float64{0.5, 0.008856, 123.456, 1e-9, 0.2, 7.7, 1e6, 1e-30, 2.0} {
		t.Log(strconv.FormatFloat(cbrtV8(x),'g',20,64), math.Cbrt(x), x)
	}
}
