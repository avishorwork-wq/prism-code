package main

import "sync"

// Build 118 "calmedon": from the calmedon step to the end of the read, the worker
// calibration uses the median of the 10 nearest residuals instead of the 1/(d+.05)
// weighted mean of 6. Per-image mark (not a global) so concurrent scenes cannot interfere.
var calmedSet sync.Map

func markCalmed(img *ImageData)    { calmedSet.Store(img, true) }
func unmarkCalmed(img *ImageData)  { calmedSet.Delete(img) }
func isCalmed(img *ImageData) bool { _, ok := calmedSet.Load(img); return ok }
