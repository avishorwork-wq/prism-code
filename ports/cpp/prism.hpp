/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++17 port of the live Prism Code format (encoder + clean-image decoder).
 * Compatible with the live JavaScript implementation at
 * https://avishorwork-wq.github.io/prism-code/ (repo: avishorwork-wq/prism-code). */
#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace prism {

enum Mode { MODE_COLOR = 0, MODE_BW = 1 };
enum Type { TYPE_TEXT = 0, TYPE_BINARY = 1 };

/* Thrown on any encode/decode failure; what() is a human-readable reason. */
struct Error : std::runtime_error { using std::runtime_error::runtime_error; };

struct Image {
    int width = 0, height = 0;
    std::vector<uint8_t> rgba; /* width*height*4 */
};

struct DecodeResult {
    std::vector<uint8_t> bytes;
    int type = 0; /* TYPE_TEXT or TYPE_BINARY */
    int size = 0, ecc = 0, mode = 0;
};

/* Maximum payload bytes for a size (0..5), ecc level (0..3) and mode. */
int capacityPayload(int size, int ecc, int mode);

/* Encode payload bytes to an in-memory RGBA image.
 * size: -1 = automatic (grows to fit) or 0..5. ecc: 0..3 = 10/20/30/40% repair.
 * scale: pixels per cell unit (live default 12). Throws prism::Error. */
Image encode(const std::vector<uint8_t> &payload, int size = -1, int ecc = 1,
             int mode = MODE_COLOR, int type = TYPE_TEXT, int scale = 12);

/* Encode and write a PNG file. Throws prism::Error. */
void encodePng(const std::vector<uint8_t> &payload, const std::string &path,
               int size = -1, int ecc = 1, int mode = MODE_COLOR,
               int type = TYPE_TEXT, int scale = 12);

/* Decode a Prism code from a clean PNG (encoder output; not the robust camera
 * pipeline). CRC32 verified. Throws prism::Error on failure. */
DecodeResult decodePng(const std::string &path);

/* PNG helpers (8-bit RGB/RGBA/grayscale, non-interlaced). */
Image readPng(const std::string &path);
void writePng(const std::string &path, const Image &img);

} // namespace prism
