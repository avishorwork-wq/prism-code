package main

import (
	"errors"
	"fmt"
	"os"
	"sync/atomic"
	"time"
)

var errBudget = errors.New("scene budget reached")

// Store time.Time (monotonic-carrying); UnixNano wall values jump across
// sandbox freezes, time.Since uses the monotonic reading and does not.
var sceneStart atomic.Value // time.Time
var capNanos atomic.Int64

func beginDecode(d time.Duration) {
	sceneStart.Store(time.Now())
	capNanos.Store(int64(d))
}

func checkBudget() error {
	v := sceneStart.Load()
	if v == nil {
		return nil
	}
	if time.Since(v.(time.Time)) > time.Duration(capNanos.Load()) {
		if dbg {
			fmt.Fprintf(os.Stderr, "budget fired after %s\n", time.Since(v.(time.Time)))
		}
		return errBudget
	}
	return nil
}
