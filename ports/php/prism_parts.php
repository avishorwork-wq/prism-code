<?php
// Prism big files in parts (PPT1) for the PHP port, byte-compatible with
// prism-parts.js and the C/Go/Kotlin/Rust ports.
//
// Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
// total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
// name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
// byte before it). Parts are encoded at ecc level 2 (30%) in color mode.

const PARTS_ECC = 2;

function pp_overhead(int $nameLen): int {
    return 4 + 4 + 2 + 2 + 4 + 4 + 1 + $nameLen + 4;
}

// clean_name: backslash, slash and control bytes become '_', trimmed to 200 bytes.
function pp_clean_name(string $name): string {
    $src = $name === '' ? 'file' : $name;
    $out = '';
    $n = strlen($src);
    for ($i = 0; $i < $n && strlen($out) < 200; $i++) {
        $c = ord($src[$i]);
        if ($c === 0x5C || $c === 0x2F || $c < 0x20) $out .= '_';
        else $out .= $src[$i];
    }
    return $out;
}

// name_bytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
function pp_name_bytes(string $name): string {
    $clean = pp_clean_name($name);
    $n = strlen($clean);
    if ($n > 40) {
        $n = 40;
        while ($n > 0 && (ord($clean[$n]) & 0xC0) === 0x80) $n--; // back off to a lead byte
        if ($n > 0 && (ord($clean[$n]) & 0x80) !== 0) {
            $c = ord($clean[$n]);
            if (($c & 0xE0) === 0xC0) $need = 2;
            elseif (($c & 0xF0) === 0xE0) $need = 3;
            elseif (($c & 0xF8) === 0xF0) $need = 4;
            else $need = 0;
            if ($need !== 0 && $n + $need > 41) $n--;
        }
    }
    return substr($clean, 0, $n);
}

// plan_calc returns ['room'=>int,'total'=>int,'name'=>string]
function pp_plan_calc(int $length, string $name, int $codeSize): array {
    $nb = pp_name_bytes($name);
    $cap = capacity($codeSize, PARTS_ECC, 0);
    $room = $cap['payload'] - pp_overhead(strlen($nb));
    if ($room < 64) throw new Exception("part size leaves < 64 bytes of room");
    $total = intdiv($length + $room - 1, $room);
    if ($total < 1) $total = 1;
    if ($total > 65535) throw new Exception("file too big for this part size");
    return ['room' => $room, 'total' => $total, 'name' => $nb];
}

// split_file splits bytes into PPT1 part payloads.
function pp_split(string $data, string $name, int $codeSize): array {
    $plan = pp_plan_calc(strlen($data), $name, $codeSize);
    $id = random_bytes(4);
    $whole = prism_crc32($data);
    $parts = [];
    for ($nIdx = 0; $nIdx < $plan['total']; $nIdx++) {
        $off = $nIdx * $plan['room'];
        $clen = min(strlen($data) - $off, $plan['room']);
        $p = "PPT1" . $id
            . chr(($nIdx + 1) >> 8) . chr(($nIdx + 1) & 255)
            . chr($plan['total'] >> 8) . chr($plan['total'] & 255)
            . pack('N', strlen($data)) . pack('N', $whole)
            . chr(strlen($plan['name'])) . $plan['name']
            . substr($data, $off, $clen);
        $p .= pack('N', prism_crc32($p));
        $parts[] = $p;
    }
    return $parts;
}

// parse parses one part payload. Returns null = not a part; throws on damage.
function pp_parse(string $b): ?array {
    if (strlen($b) < 25 || substr($b, 0, 4) !== "PPT1") return null;
    if (prism_crc32(substr($b, 0, strlen($b) - 4)) !== unpack('N', substr($b, strlen($b) - 4))[1]) {
        throw new Exception("This part failed its own check. Scan it again.");
    }
    $id = bin2hex(substr($b, 4, 4));
    $n = (ord($b[8]) << 8) | ord($b[9]);
    $total = (ord($b[10]) << 8) | ord($b[11]);
    $len = unpack('N', substr($b, 12, 4))[1];
    $whole = unpack('N', substr($b, 16, 4))[1];
    $nl = ord($b[20]);
    if (21 + $nl + 4 > strlen($b) || $n === 0 || $n > $total) {
        throw new Exception("This part has a broken header.");
    }
    return [
        'id' => $id, 'n' => $n, 'total' => $total, 'len' => $len, 'whole' => $whole,
        'name' => substr($b, 21, $nl),
        'chunk' => substr($b, 21 + $nl, strlen($b) - 4 - (21 + $nl)),
    ];
}

// Assembler add statuses, like the site.
const PP_NOT_PART = 0;
const PP_BAD = 1;
const PP_OTHER = 2;
const PP_DUPLICATE = 3;
const PP_NEW = 4;
const PP_COMPLETE = 5;

class PpAssembler {
    public string $id = '';
    public int $total = 0;
    public int $len = 0;
    public int $whole = 0;
    public string $name = '';
    public array $chunks = [];
    public int $have = 0;
    public bool $started = false;

    // returns [status, n, message]
    public function add(string $b): array {
        try {
            $p = pp_parse($b);
        } catch (Exception $e) {
            return [PP_BAD, 0, $e->getMessage()];
        }
        if ($p === null) return [PP_NOT_PART, 0, ''];
        if (!$this->started) {
            $this->started = true;
            $this->id = $p['id'];
            $this->total = $p['total'];
            $this->len = $p['len'];
            $this->whole = $p['whole'];
            $this->name = $p['name'];
            $this->chunks = array_fill(0, $p['total'], null);
        } elseif ($p['id'] !== $this->id) {
            $nm = $p['name'] === '' ? 'unnamed' : $p['name'];
            return [PP_OTHER, 0, "That part belongs to a different file ($nm). Start over to switch."];
        } elseif ($p['total'] !== $this->total || $p['len'] !== $this->len || $p['whole'] !== $this->whole) {
            return [PP_BAD, 0, "This part does not match the others."];
        }
        if ($this->chunks[$p['n'] - 1] !== null) return [PP_DUPLICATE, $p['n'], ''];
        $this->chunks[$p['n'] - 1] = $p['chunk'];
        $this->have++;
        if ($this->have === $this->total) return [PP_COMPLETE, $p['n'], ''];
        return [PP_NEW, $p['n'], ''];
    }

    // finish rebuilds and verifies after COMPLETE. Returns [bytes, name].
    public function finish(): array {
        if ($this->have !== $this->total) throw new Exception("Parts are still missing.");
        $buf = '';
        for ($i = 0; $i < $this->total; $i++) {
            $ch = $this->chunks[$i];
            if (strlen($buf) + strlen($ch) > $this->len) {
                throw new Exception("The parts add up to more than the file size.");
            }
            $buf .= $ch;
        }
        if (strlen($buf) !== $this->len) {
            throw new Exception("The parts add up to " . strlen($buf) . " bytes, not {$this->len}.");
        }
        if (prism_crc32($buf) !== $this->whole) {
            throw new Exception("The whole-file check failed. Start over and scan the parts again.");
        }
        $name = $this->name === '' ? 'prism-file.bin' : $this->name;
        return [$buf, $name];
    }
}
