#!/bin/sh
# Build the Prism Code Swift CLI. Needs a Swift 6 toolchain and system zlib.
swiftc -I shim -O -o prism Prism.swift main.swift -lz
