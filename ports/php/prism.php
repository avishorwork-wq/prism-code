<?php
// Prism Code - PHP port of the live JavaScript encoder/decoder.
// Source of truth: prism.html (const Prism module) in
// https://github.com/avishorwork-wq/prism-code
//
// CLI only, PHP 8+ with zlib (gzcompress/gzuncompress). No other extensions,
// no composer packages.
//
// Format: pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray
// coding (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to
// 113x130 cells. Filled corner gap pattern, asymmetric ring, pilot cells,
// triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D
// Reed-Solomon blocks, payload CRC-32.

const S3 = 1.7320508075688772; // Math.sqrt(3), same f64 as the other ports
// Q computed in code as 3*S3.

const SIZES = [[21, 24], [29, 33], [41, 47], [57, 66], [81, 94], [113, 130]];
const PAL = [
    [0x1b, 0x1b, 0x1b], [0x2e, 0x5b, 0xff], [0x00, 0xb8, 0xd9],
    [0x2d, 0xb3, 0x5a], [0xf5, 0xc5, 0x18], [0xf7, 0x7f, 0x00],
    [0xd7, 0x26, 0x3d], [0xb5, 0x17, 0x9e], [0xff, 0xff, 0xff],
];

// ---------------------------------------------------------------- rng / crc

// 32-bit unsigned multiply (mod 2^32), exact on 64-bit PHP ints.
function mul32(int $a, int $b): int {
    $a &= 0xFFFFFFFF; $b &= 0xFFFFFFFF;
    $lo = ($a & 0xFFFF) * ($b & 0xFFFF);
    $hi = (($a >> 16) & 0xFFFF) * ($b & 0xFFFF) + ($a & 0xFFFF) * (($b >> 16) & 0xFFFF);
    return ($lo + (($hi & 0xFFFF) << 16)) & 0xFFFFFFFF;
}

class Rng {
    public int $seed;
    public function __construct(int $seed) { $this->seed = $seed & 0xFFFFFFFF; }
    // Exact port of the JS mulberry-style rng (returns floats in [0,1)).
    public function next(): float {
        $this->seed = ($this->seed + 0x6D2B79F5) & 0xFFFFFFFF;
        $t = mul32($this->seed ^ ($this->seed >> 15), (1 | $this->seed) & 0xFFFFFFFF);
        $t = (($t + mul32($t ^ ($t >> 7), (61 | $t) & 0xFFFFFFFF)) ^ $t) & 0xFFFFFFFF;
        return (($t ^ ($t >> 14)) & 0xFFFFFFFF) / 4294967296.0;
    }
}

function crc32_table(): array {
    static $t = null;
    if ($t !== null) return $t;
    $t = [];
    for ($n = 0; $n < 256; $n++) {
        $c = $n;
        for ($k = 0; $k < 8; $k++) $c = ($c & 1) ? ((0xEDB88320 ^ ($c >> 1)) & 0xFFFFFFFF) : ($c >> 1);
        $t[$n] = $c;
    }
    return $t;
}

function prism_crc32(string $data): int {
    $t = crc32_table();
    $c = 0xFFFFFFFF;
    $n = strlen($data);
    for ($i = 0; $i < $n; $i++) {
        $c = ($t[($c ^ ord($data[$i])) & 255] ^ ($c >> 8)) & 0xFFFFFFFF;
    }
    return ($c ^ 0xFFFFFFFF) & 0xFFFFFFFF;
}

function crc4(array $bits): int {
    $r = 0;
    foreach ($bits as $b) {
        $f = (($r >> 3) & 1) ^ $b;
        $r = ($r << 1) & 15;
        if ($f) $r ^= 3;
    }
    return $r;
}

function padk(int $o): int {
    $x = mul32(($o + 0x9E3779B9) & 0xFFFFFFFF, 0x85EBCA6B);
    $x ^= $x >> 13;
    $x = mul32($x, 0xC2B2AE35);
    $x ^= $x >> 16;
    return $x & 255;
}

// ---------------------------------------------------------------- GF(256)

function gf(): array {
    static $g = null;
    if ($g !== null) return $g;
    $exp = array_fill(0, 512, 0);
    $log = array_fill(0, 256, 0);
    $z = 1;
    for ($i = 0; $i < 255; $i++) {
        $exp[$i] = $z;
        $log[$z] = $i;
        $z <<= 1;
        if ($z & 256) $z ^= 0x11D;
    }
    for ($i = 255; $i < 512; $i++) $exp[$i] = $exp[$i - 255];
    $g = [$exp, $log];
    return $g;
}

function gmul(int $a, int $b): int {
    if ($a && $b) { [$e, $l] = gf(); return $e[$l[$a] + $l[$b]]; }
    return 0;
}
function gdiv(int $a, int $b): int {
    if (!$b) throw new Exception("GF division by zero");
    if (!$a) return 0;
    [$e, $l] = gf();
    return $e[($l[$a] + 255 - $l[$b]) % 255];
}
function peval(array $p, int $x): int {
    $y = 0;
    for ($i = count($p) - 1; $i >= 0; $i--) $y = gmul($y, $x) ^ $p[$i];
    return $y;
}
function pmul(array $a, array $b): array {
    $o = array_fill(0, count($a) + count($b) - 1, 0);
    for ($i = 0; $i < count($a); $i++) {
        if ($a[$i]) for ($j = 0; $j < count($b); $j++) $o[$i + $j] ^= gmul($a[$i], $b[$j]);
    }
    return $o;
}

function rs_encode(array $msg, int $nsym): array {
    $g = [1];
    [$e] = gf();
    for ($i = 0; $i < $nsym; $i++) $g = pmul($g, [1, $e[$i]]);
    $out = array_merge($msg, array_fill(0, $nsym, 0));
    for ($i = 0; $i < count($msg); $i++) {
        $c = $out[$i];
        if ($c) for ($j = 1; $j < count($g); $j++) $out[$i + $j] ^= gmul($g[$j], $c);
    }
    for ($i = 0; $i < count($msg); $i++) $out[$i] = $msg[$i];
    return $out;
}

function syndromes(array $r, int $n): array {
    [$e] = gf();
    $s = array_fill(0, $n, 0);
    for ($j = 0; $j < $n; $j++) {
        $y = 0;
        $x = $e[$j];
        foreach ($r as $ri) $y = gmul($y, $x) ^ $ri;
        $s[$j] = $y;
    }
    return $s;
}

function bm(array $s): array {
    $c = array_fill(0, count($s) + 1, 0);
    $b = array_fill(0, count($s) + 1, 0);
    $c[0] = 1; $b[0] = 1;
    $l = 0; $m = 1; $bb = 1;
    for ($n = 0; $n < count($s); $n++) {
        $d = $s[$n];
        for ($i = 1; $i <= $l; $i++) $d ^= gmul($c[$i], $s[$n - $i]);
        if ($d === 0) { $m++; continue; }
        $t = $c;
        $v = gdiv($d, $bb);
        for ($i = 0; $i < count($c) - $m; $i++) $c[$i + $m] ^= gmul($v, $b[$i]);
        if (2 * $l <= $n) {
            $l = $n + 1 - $l;
            $b = $t;
            $bb = $d;
            $m = 1;
        } else $m++;
    }
    return array_slice($c, 0, $l + 1);
}

function rs_decode(array $data, int $nsym): array {
    [$e] = gf();
    $r = $data;
    $s = syndromes($r, $nsym);
    if (!array_filter($s)) return $r;
    $loc = bm($s);
    if (2 * (count($loc) - 1) > $nsym) throw new Exception("RS correction limit");
    $pos = [];
    for ($p = 0; $p < count($r); $p++) {
        $e_ = count($r) - 1 - $p;
        if (peval($loc, $e[(255 - $e_) % 255]) === 0) $pos[] = $p;
    }
    if (count($pos) !== count($loc) - 1) throw new Exception("RS roots");
    $omega = array_slice(pmul($s, $loc), 0, $nsym);
    $derLen = max(count($loc) - 1, 1);
    $der = array_fill(0, $derLen, 0);
    for ($i = 1; $i < count($loc); $i += 2) $der[$i - 1] = $loc[$i];
    foreach ($pos as $p) {
        $e_ = count($r) - 1 - $p;
        $x = $e[$e_];
        $xi = $e[(255 - $e_) % 255];
        $r[$p] ^= gdiv(gmul($x, peval($omega, $xi)), peval($der, $xi));
    }
    if (array_filter(syndromes($r, $nsym))) throw new Exception("RS syndrome check");
    return $r;
}

// ---------------------------------------------------------------- layout

const ROLE_DATA = 0;
const ROLE_GAP = 1;
const ROLE_RING = 2;
const ROLE_PILOT = 3;
const ROLE_HEADER = 4;

function floor_div(int $a, int $b): int {
    $q = intdiv($a, $b);
    return ($a % $b !== 0) && (($a < 0) !== ($b < 0)) ? $q - 1 : $q;
}

function make_layout(int $size): array {
    [$c, $r] = SIZES[$size];
    $cells = [];
    $mIdx = [];
    $known = [];
    for ($j = 0; $j < $r; $j++) {
        for ($i = 0; $i < $c; $i++) {
            $role = ROLE_DATA;
            $symbol = -1;
            $pi = floor_div($i - 2, 5);
            $pj = floor_div($j - 2, 5);
            if ($j <= 2 && $i <= 2) { $role = ROLE_GAP; $symbol = 8; }
            elseif ($j === 0 || $j === $r - 1 || $i === 0 || $i === $c - 1) {
                $role = ROLE_RING; $symbol = ($j * 5 + $i * 3) % 8;
            } elseif ($i % 5 === 2 && $j % 5 === 2) {
                $role = ROLE_PILOT; $symbol = ($pi * 2 + $pj * 3) % 9;
            }
            $cells[] = [
                'i' => $i, 'j' => $j,
                'x' => S3 * ($i + 0.5 + 0.5 * ($j & 1)),
                'y' => 1 + 1.5 * $j,
                'role' => $role, 'symbol' => $symbol, 'pi' => $pi, 'pj' => $pj,
                'index' => count($cells), 'header' => -1,
            ];
            if ($role === ROLE_DATA) $mIdx[] = count($cells) - 1;
            elseif ($role !== ROLE_GAP) $known[] = count($cells) - 1;
        }
    }
    $headers = [];
    for ($n = 0; $n < 72; $n++) {
        $ci = $mIdx[(int)(($n + 0.5) * count($mIdx) / 72)];
        $cells[$ci]['role'] = ROLE_HEADER;
        $cells[$ci]['header'] = $n;
        $headers[] = $ci;
    }
    $data = [];
    foreach ($cells as $i => $cell) if ($cell['role'] === ROLE_DATA) $data[] = $i;
    $rand = new Rng(0x5EED ^ $size);
    for ($i = count($data) - 1; $i >= 1; $i--) {
        $jj = (int)($rand->next() * ($i + 1));
        $tmp = $data[$i]; $data[$i] = $data[$jj]; $data[$jj] = $tmp;
    }
    return [
        'size' => $size, 'c' => $c, 'r' => $r,
        'w' => S3 * ($c + 0.5),
        'h' => 2 + 1.5 * ($r - 1),
        'cells' => $cells, 'headers' => $headers, 'data' => $data, 'known' => $known,
    ];
}

// Centre-out data order used when a logo sits in the middle (logo=1).
function plcd(array $l): array {
    $cx = $l['w'] / 2; $cy = $l['h'] / 2;
    $ent = [];
    foreach ($l['data'] as $k => $ci) {
        $c = $l['cells'][$ci];
        $dx = $c['x'] - $cx; $dy = $c['y'] - $cy;
        $ent[] = [$k, (int)(sqrt($dx * $dx + $dy * $dy) / 3)];
    }
    // stable sort by (-b, k)
    usort($ent, fn($a, $b) => ($b[1] <=> $a[1]) ?: ($a[0] <=> $b[0]));
    return array_map(fn($e) => $l['data'][$e[0]], $ent);
}

// ---------------------------------------------------------------- capacity

function capacity(int $size, int $ecc, int $mode): array {
    $l = make_layout($size);
    $bpc = $mode !== 0 ? 1 : 3;
    $n = intdiv(count($l['data']) * $bpc, 8);
    $nb = intdiv($n + 254, 255);
    $pcts = [0.1, 0.2, 0.3, 0.4];
    $blocks = [];
    for ($i = 0; $i < $nb; $i++) {
        $ln = intdiv($n, $nb) + ($i < $n % $nb ? 1 : 0);
        $nsym = (int)max(4.0, 2.0 * floor($ln * $pcts[$ecc] / 2.0 + 0.5));
        $blocks[] = ['n' => $ln, 'nsym' => $nsym, 'k' => $ln - $nsym];
    }
    $k = 0;
    foreach ($blocks as $b) $k += $b['k'];
    return ['n' => $n, 'blocks' => $blocks, 'k' => $k, 'payload' => max(0, $k - 4)];
}

function push_bits(array &$a, int $x, int $n): void {
    for ($k = $n - 1; $k >= 0; $k--) $a[] = ($x >> $k) & 1;
}

function header_bits(int $size, int $ecc, int $mode, int $typ, int $len): array {
    $b = [];
    push_bits($b, $size, 3);
    push_bits($b, $ecc, 2);
    push_bits($b, $mode, 1);
    push_bits($b, $typ, 1);
    push_bits($b, $len, 13);
    $c = crc4($b);
    push_bits($b, $c, 4);
    return $b;
}

function known_symbol(array $c, int $mode): int {
    if ($mode !== 0) {
        if ($c['role'] === ROLE_RING) return 0;
        return ($c['pi'] + $c['pj']) % 2 === 0 ? 0 : 8;
    }
    return $c['symbol'];
}

// ---------------------------------------------------------------- encode

function prism_encode(string $payload, int $sizeIn, int $ecc, int $mode, int $typ, int $logo): array {
    $plen = strlen($payload);
    if ($plen > 8191) throw new Exception("payload exceeds 8191 bytes");
    $size = $sizeIn;
    if ($size < 0) {
        $size = -1;
        for ($i = 0; $i < count(SIZES); $i++) {
            if (capacity($i, $ecc, $mode)['k'] >= $plen + 4) { $size = $i; break; }
        }
        if ($size < 0) throw new Exception("payload too large for this mode and ECC");
    }
    $cap = capacity($size, $ecc, $mode);
    if ($cap['k'] < $plen + 4) {
        throw new Exception("payload does not fit: maximum {$cap['payload']} bytes");
    }
    $msg = array_fill(0, $cap['k'], 0);
    for ($i = $plen + 4; $i < $cap['k']; $i++) $msg[$i] = padk($i);
    for ($i = 0; $i < $plen; $i++) $msg[$i] = ord($payload[$i]);
    $crc = prism_crc32($payload);
    for ($k = 0; $k < 4; $k++) $msg[$plen + $k] = ($crc >> (24 - 8 * $k)) & 255;
    $off = 0;
    $blocks = [];
    foreach ($cap['blocks'] as $b) {
        $blocks[] = rs_encode(array_slice($msg, $off, $b['k']), $b['nsym']);
        $off += $b['k'];
    }
    $maxlen = 0;
    foreach ($blocks as $x) $maxlen = max($maxlen, count($x));
    $stream = [];
    for ($p = 0; $p < $maxlen; $p++) {
        foreach ($blocks as $b) {
            if ($p < count($b)) push_bits($stream, $b[$p], 8);
        }
    }
    $rand = new Rng(0xBEEF);
    $l = make_layout($size);
    $symbols = array_fill(0, count($l['cells']), 8);
    foreach ($l['known'] as $ci) $symbols[$ci] = known_symbol($l['cells'][$ci], $mode);
    $hb = header_bits($size, $ecc, $mode, $typ, $plen);
    foreach ($l['headers'] as $ci) {
        $h = $l['cells'][$ci]['header'];
        $symbols[$ci] = $hb[$h % 24] ? 0 : 8;
    }
    foreach ($l['cells'] as $c) {
        if ($c['role'] === ROLE_GAP) {
            $symbols[$c['index']] = $mode !== 0
                ? (($c['i'] + $c['j']) % 2 !== 0 ? 0 : 8)
                : (($c['j'] * 5 + $c['i'] * 3) % 8);
        }
    }
    $at = 0;
    $order = $logo !== 0 ? plcd($l) : $l['data'];
    foreach ($order as $ci) {
        if ($mode !== 0) {
            $bit = $at < count($stream) ? $stream[$at] : ($rand->next() > 0.5 ? 1 : 0);
            $at++;
            $symbols[$ci] = $bit ? 0 : 8;
        } else {
            $b = 0;
            for ($k = 0; $k < 3; $k++) {
                $bit = $at < count($stream) ? $stream[$at] : ($rand->next() > 0.5 ? 1 : 0);
                $at++;
                $b = ($b << 1) | $bit;
            }
            $v = $b;
            $v ^= $v >> 1;
            $v ^= $v >> 2;
            $symbols[$ci] = $v;
        }
    }
    return [
        'size' => $size, 'ecc' => $ecc, 'mode' => $mode, 'typ' => $typ,
        'bytes' => $payload, 'symbols' => $symbols, 'layout' => $l, 'order' => $order,
        'cap_payload' => $cap['payload'],
    ];
}

// ---------------------------------------------------------------- render / PNG

function fill_poly(string &$img, int $w, int $h, array $pts, array $rgb): void {
    $c0 = chr($rgb[0]); $c1 = chr($rgb[1]); $c2 = chr($rgb[2]);
    $miny = INF; $maxy = -INF;
    foreach ($pts as $p) { $miny = min($miny, $p[1]); $maxy = max($maxy, $p[1]); }
    $y0 = max(0, (int)floor($miny));
    $y1 = min($h - 1, (int)ceil($maxy));
    if ($y1 < $y0) return;
    for ($y = $y0; $y <= $y1; $y++) {
        $yc = $y + 0.5;
        $xs = [];
        $np = count($pts);
        for ($k = 0; $k < $np; $k++) {
            [$x1, $a] = $pts[$k];
            [$x2, $b] = $pts[($k + 1) % $np];
            if (($a <= $yc && $yc < $b) || ($b <= $yc && $yc < $a)) {
                $xs[] = $x1 + ($yc - $a) / ($b - $a) * ($x2 - $x1);
            }
        }
        sort($xs);
        for ($k = 0; $k + 1 < count($xs); $k += 2) {
            $xa = max(0, (int)round($xs[$k] - 0.5));
            $xb = min($w - 1, (int)round($xs[$k + 1] - 0.5) - 1);
            if ($xb >= $xa) {
                $o = ($y * $w + $xa) * 4;
                $oend = ($y * $w + $xb) * 4;
                for ($oo = $o; $oo <= $oend; $oo += 4) {
                    $img[$oo] = $c0; $img[$oo + 1] = $c1; $img[$oo + 2] = $c2;
                }
            }
        }
    }
}

// Same geometry as Prism.render: hard-edged hexagons on white.
function prism_render(array $code, int $r): array {
    $l = $code['layout'];
    $q = 3 * S3;
    $w = (int)ceil(($l['w'] + 2 * $q) * $r);
    $h = (int)ceil(($l['h'] + 2 * $q) * $r);
    $img = str_repeat("\xFF", $w * $h * 4);
    foreach ($l['cells'] as $c) {
        $s = $code['symbols'][$c['index']];
        if ($s === 8) continue;
        $pts = [];
        for ($k = 0; $k < 6; $k++) {
            $a = (30 + 60 * $k) * M_PI / 180;
            $pts[] = [($c['x'] + $q + 1.03 * cos($a)) * $r, ($c['y'] + $q + 1.03 * sin($a)) * $r];
        }
        fill_poly($img, $w, $h, $pts, PAL[$s]);
    }
    return [$w, $h, $img];
}

function png_chunk(string $tag, string $data): string {
    return pack('N', strlen($data)) . $tag . $data . pack('N', prism_crc32($tag . $data));
}

function write_png(int $w, int $h, string $rgba): string {
    $stride = $w * 4;
    $raw = '';
    for ($y = 0; $y < $h; $y++) {
        $raw .= "\0" . substr($rgba, $y * $stride, $stride);
    }
    $idat = gzcompress($raw, 9);
    $ihdr = pack('N', $w) . pack('N', $h) . chr(8) . chr(6) . "\0\0\0";
    return "\x89PNG\r\n\x1a\n" . png_chunk('IHDR', $ihdr) . png_chunk('IDAT', $idat) . png_chunk('IEND', '');
}

function paeth(int $a, int $b, int $c): int {
    $p = $a + $b - $c;
    $pa = abs($p - $a); $pb = abs($p - $b); $pc = abs($p - $c);
    return $pa <= $pb && $pa <= $pc ? $a : ($pb <= $pc ? $b : $c);
}

function read_png(string $buf): array {
    if (strlen($buf) < 8 || substr($buf, 0, 8) !== "\x89PNG\r\n\x1a\n") throw new Exception("not a png");
    $pos = 8;
    $ihdr = null;
    $idats = [];
    $plte = null;
    $n = strlen($buf);
    while ($pos + 12 <= $n) {
        $ln = unpack('N', substr($buf, $pos, 4))[1];
        $tag = substr($buf, $pos + 4, 4);
        if ($pos + 12 + $ln > $n) break;
        $data = substr($buf, $pos + 8, $ln);
        if ($tag === 'IHDR') $ihdr = $data;
        elseif ($tag === 'IDAT') $idats[] = $data;
        elseif ($tag === 'PLTE') $plte = $data;
        elseif ($tag === 'IEND') break;
        $pos += 12 + $ln;
    }
    if ($ihdr === null) throw new Exception("no IHDR");
    $w = unpack('N', substr($ihdr, 0, 4))[1];
    $h = unpack('N', substr($ihdr, 4, 4))[1];
    $depth = ord($ihdr[8]);
    $ctype = ord($ihdr[9]);
    if ($depth !== 8) throw new Exception("unsupported bit depth $depth");
    $ch = match ($ctype) { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4, default => -1 };
    if ($ch < 0) throw new Exception("unsupported colour type $ctype");
    $packed = implode('', $idats);
    $raw = gzuncompress($packed);
    if ($raw === false) $raw = gzinflate($packed);
    if ($raw === false) throw new Exception("zlib inflate failed");
    $stride = $w * $ch;
    $out = str_repeat("\0", $w * $h * 4);
    $prev = str_repeat("\0", $stride);
    for ($y = 0; $y < $h; $y++) {
        $f = ord($raw[$y * ($stride + 1)]);
        $line = substr($raw, $y * ($stride + 1) + 1, $stride);
        if ($f !== 0) {
            for ($x = 0; $x < $stride; $x++) {
                $a = $x >= $ch ? ord($line[$x - $ch]) : 0;
                $b = ord($prev[$x]);
                $c = $x >= $ch ? ord($prev[$x - $ch]) : 0;
                $v = match ($f) {
                    1 => ord($line[$x]) + $a,
                    2 => ord($line[$x]) + $b,
                    3 => ord($line[$x]) + (($a + $b) >> 1),
                    4 => ord($line[$x]) + paeth($a, $b, $c),
                    default => throw new Exception("bad filter $f"),
                };
                $line[$x] = chr($v & 255);
            }
        }
        for ($x = 0; $x < $w; $x++) {
            $o = ($y * $w + $x) * 4;
            if ($ctype === 6) {
                $out[$o] = $line[$x * 4]; $out[$o + 1] = $line[$x * 4 + 1]; $out[$o + 2] = $line[$x * 4 + 2]; $out[$o + 3] = $line[$x * 4 + 3];
            } elseif ($ctype === 2) {
                $out[$o] = $line[$x * 3]; $out[$o + 1] = $line[$x * 3 + 1]; $out[$o + 2] = $line[$x * 3 + 2]; $out[$o + 3] = "\xFF";
            } elseif ($ctype === 0) {
                $out[$o] = $line[$x]; $out[$o + 1] = $line[$x]; $out[$o + 2] = $line[$x]; $out[$o + 3] = "\xFF";
            } elseif ($ctype === 4) {
                $out[$o] = $line[$x * 2]; $out[$o + 1] = $line[$x * 2]; $out[$o + 2] = $line[$x * 2]; $out[$o + 3] = $line[$x * 2 + 1];
            } else {
                if ($plte === null) throw new Exception("palette missing");
                $pi = ord($line[$x]) * 3;
                $out[$o] = $plte[$pi]; $out[$o + 1] = $plte[$pi + 1]; $out[$o + 2] = $plte[$pi + 2]; $out[$o + 3] = "\xFF";
            }
        }
        $prev = $line;
    }
    return [$w, $h, $out];
}

// ---------------------------------------------------------------- decode (clean images)

function symbol_bits(int $sym, int $mode): array {
    if ($mode !== 0) return [$sym === 0 ? 1 : 0];
    $t = $sym ^ ($sym >> 1);
    return [($t >> 2) & 1, ($t >> 1) & 1, $t & 1];
}

function nearest_symbol(int $r, int $g, int $b): int {
    $best = 0; $bestd = PHP_INT_MAX;
    foreach (PAL as $i => $p) {
        $dr = $r - $p[0]; $dg = $g - $p[1]; $db = $b - $p[2];
        $d = $dr * $dr + $dg * $dg + $db * $db;
        if ($d < $bestd) { $bestd = $d; $best = $i; }
    }
    return $best;
}

function decode_symbols(array $symbols, array $l, ?array $order): array {
    $hb = array_fill(0, 24, 0);
    for ($n = 0; $n < 24; $n++) {
        $votes = 0;
        for ($rep = 0; $rep < 3; $rep++) {
            if ($symbols[$l['headers'][$n + 24 * $rep]] === 0) $votes++;
        }
        $hb[$n] = $votes >= 2 ? 1 : 0;
    }
    $at = 0;
    $rd = function (int $n) use (&$at, $hb): int {
        $v = 0;
        for ($i = 0; $i < $n; $i++) { $v = ($v << 1) | $hb[$at]; $at++; }
        return $v;
    };
    $size = $rd(3);
    $ecc = $rd(2);
    $mode = $rd(1);
    $typ = $rd(1);
    $len = $rd(13);
    $hcrc = $rd(4);
    if (crc4(array_slice($hb, 0, 20)) !== $hcrc || $size > 5 || $size !== $l['size']) {
        throw new Exception("header checksum failed");
    }
    $cap = capacity($size, $ecc, $mode);
    if ($len > $cap['payload']) throw new Exception("invalid length");
    $cellsOrder = $order !== null ? $order : $l['data'];
    $stream = [];
    foreach ($cellsOrder as $ci) {
        foreach (symbol_bits($symbols[$ci], $mode) as $bit) $stream[] = $bit;
    }
    $nbytes = $cap['n'];
    $bts = array_fill(0, $nbytes, 0);
    for ($i = 0; $i < $nbytes; $i++) {
        $v = 0;
        for ($k = 0; $k < 8; $k++) $v = ($v << 1) | $stream[8 * $i + $k];
        $bts[$i] = $v;
    }
    $blocks = [];
    foreach ($cap['blocks'] as $b) $blocks[] = array_fill(0, $b['n'], 0);
    $at2 = 0;
    $maxn = 0;
    foreach ($cap['blocks'] as $b) $maxn = max($maxn, $b['n']);
    for ($p = 0; $p < $maxn; $p++) {
        foreach ($cap['blocks'] as $bi => $b) {
            if ($p < $b['n']) {
                $blocks[$bi][$p] = $bts[$at2];
                $at2++;
            }
        }
    }
    $msg = [];
    foreach ($cap['blocks'] as $bi => $b) {
        $dec = rs_decode($blocks[$bi], $b['nsym']);
        for ($i = 0; $i < $b['k']; $i++) $msg[] = $dec[$i];
    }
    $payload = '';
    for ($i = 0; $i < $len; $i++) $payload .= chr($msg[$i]);
    $got = ((($msg[$len] << 24) | ($msg[$len + 1] << 16) | ($msg[$len + 2] << 8) | $msg[$len + 3]) & 0xFFFFFFFF);
    if (prism_crc32($payload) !== $got) throw new Exception("payload CRC-32 failed");
    return [$payload, ['size' => $size, 'ecc' => $ecc, 'mode' => $mode, 'typ' => $typ, 'length' => $len]];
}

// Decode a clean/perfect encoder image (any radius).
function decode_image(int $w, int $h, string $rgba): array {
    $xmin = $w; $ymin = $h; $xmax = -1; $ymax = -1;
    for ($y = 0; $y < $h; $y++) {
        $rowWhite = true;
        for ($x = 0; $x < $w; $x++) {
            $o = ($y * $w + $x) * 4;
            if (ord($rgba[$o]) < 250 || ord($rgba[$o + 1]) < 250 || ord($rgba[$o + 2]) < 250) { $rowWhite = false; break; }
        }
        if ($rowWhite) continue;
        for ($x = 0; $x < $w; $x++) {
            $o = ($y * $w + $x) * 4;
            if (ord($rgba[$o]) < 250 || ord($rgba[$o + 1]) < 250 || ord($rgba[$o + 2]) < 250) {
                if ($x < $xmin) $xmin = $x;
                if ($x > $xmax) $xmax = $x;
                if ($y < $ymin) $ymin = $y;
                if ($y > $ymax) $ymax = $y;
            }
        }
    }
    if ($xmax < 0) throw new Exception("no code found");
    $HEXHW = 1.03 * 0.8660254037844386;
    $HEXHH = 1.03;
    $lastErr = "unknown";
    for ($size = 0; $size < 6; $size++) {
        $l = make_layout($size);
        $mincx = INF; $maxcx = -INF; $mincy = INF; $maxcy = -INF;
        foreach ($l['known'] as $ci) {
            $c = $l['cells'][$ci];
            if ($c['role'] === ROLE_RING) {
                $mincx = min($mincx, $c['x']); $maxcx = max($maxcx, $c['x']);
                $mincy = min($mincy, $c['y']); $maxcy = max($maxcy, $c['y']);
            }
        }
        $mincx -= $HEXHW; $maxcx += $HEXHW; $mincy -= $HEXHH; $maxcy += $HEXHH;
        $rx = ($xmax - $xmin + 1) / ($maxcx - $mincx);
        $ry = ($ymax - $ymin + 1) / ($maxcy - $mincy);
        if (abs($rx - $ry) / max($rx, $ry) > 0.05) continue;
        $symbols = array_fill(0, count($l['cells']), 8);
        foreach ($l['cells'] as $c) {
            $px = $xmin + ($c['x'] - $mincx) * $rx;
            $py = $ymin + ($c['y'] - $mincy) * $ry;
            $sr = 0; $sg = 0; $sb = 0; $n = 0;
            for ($dy = -1; $dy <= 1; $dy++) {
                for ($dx = -1; $dx <= 1; $dx++) {
                    $xx = max(0, min($w - 1, (int)($px + $dx * $rx * 0.15)));
                    $yy = max(0, min($h - 1, (int)($py + $dy * $ry * 0.15)));
                    $o = ($yy * $w + $xx) * 4;
                    $sr += ord($rgba[$o]); $sg += ord($rgba[$o + 1]); $sb += ord($rgba[$o + 2]); $n++;
                }
            }
            $symbols[$c['index']] = nearest_symbol((int)($sr / $n), (int)($sg / $n), (int)($sb / $n));
        }
        try {
            return decode_symbols($symbols, $l, null);
        } catch (Exception $e1) {
            try {
                return decode_symbols($symbols, $l, plcd($l));
            } catch (Exception $e2) {
                $lastErr = $e2->getMessage();
            }
        }
    }
    throw new Exception("decode failed: $lastErr");
}

function decode_png(string $buf): array {
    [$w, $h, $rgba] = read_png($buf);
    return decode_image($w, $h, $rgba);
}

// ---------------------------------------------------------------- CLI

function arg_opt(array $a, string $name, ?string $dflt): ?string {
    for ($i = 0; $i < count($a) - 1; $i++) {
        if ($a[$i] === "--$name" || $a[$i] === "-$name") return $a[$i + 1];
    }
    return $dflt;
}

function mode_name(int $m): string { return $m === 0 ? "color" : "bw"; }

function fail(string $msg): never {
    fwrite(STDERR, "error: $msg\n");
    exit(1);
}

function usage(): never {
    fwrite(STDERR, "usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n"
        . "       prism decode I.png [--out O]\n"
        . "       prism capacity\n");
    exit(2);
}

function cli_main(array $argv): void {
    $a = array_slice($argv, 1);
    if (count($a) === 0) usage();
    switch ($a[0]) {
        case 'encode': {
            $text = arg_opt($a, 'text', null);
            $input = arg_opt($a, 'input', null);
            if ($text === null && $input === null) fail("need --text or --input");
            $payload = $text !== null ? $text : file_get_contents($input);
            if ($payload === false) fail("cannot read input");
            $size = (int)arg_opt($a, 'size', '-1');
            $ecc = (int)arg_opt($a, 'ecc', '1');
            $modeS = arg_opt($a, 'mode', '0');
            $mode = ($modeS === '1' || $modeS === 'bw') ? 1 : 0;
            $radius = (int)arg_opt($a, 'radius', '12');
            $typ = (int)arg_opt($a, 'type', '0');
            $logo = (int)arg_opt($a, 'logo', '0');
            $out = arg_opt($a, 'out', null);
            if ($out === null) fail("need --out");
            try {
                $code = prism_encode($payload, $size, $ecc, $mode, $typ, $logo);
            } catch (Exception $e) {
                fail($e->getMessage());
            }
            [$w, $h, $img] = prism_render($code, $radius);
            file_put_contents($out, write_png($w, $h, $img));
            $sj = arg_opt($a, 'symbols', null);
            if ($sj !== null) {
                file_put_contents($sj, json_encode([
                    'size' => $code['size'], 'ecc' => $code['ecc'], 'mode' => $code['mode'],
                    'C' => $code['layout']['c'], 'R' => $code['layout']['r'],
                    'symbols' => array_values($code['symbols']),
                ]));
            }
            $lay = $code['layout'];
            echo "wrote $out ({$w}x{$h} px, grid {$lay['c']}x{$lay['r']} cells, size {$code['size']}, " . mode_name($mode) . ", ecc $ecc, " . strlen($payload) . " payload bytes)\n";
            echo "capacity at these settings: {$code['cap_payload']} payload bytes\n";
            break;
        }
        case 'decode': {
            if (count($a) < 2) fail("need png path");
            $buf = file_get_contents($a[1]);
            if ($buf === false) fail("cannot read " . $a[1]);
            try {
                [$payload, $hdr] = decode_png($buf);
            } catch (Exception $e) {
                fail($e->getMessage());
            }
            $out = arg_opt($a, 'out', null);
            if ($out !== null) {
                file_put_contents($out, $payload);
                echo "wrote $out (" . strlen($payload) . " bytes)\n";
            } else {
                fwrite(STDOUT, $payload);
                if (strlen($payload) > 0) fwrite(STDOUT, "\n");
            }
            fwrite(STDERR, "header: size {$hdr['size']}, ecc {$hdr['ecc']}, mode " . mode_name($hdr['mode']) . ", type {$hdr['typ']}, {$hdr['length']} payload bytes, CRC-32 OK\n");
            break;
        }
        case 'capacity': {
            for ($s = 0; $s < 6; $s++) {
                for ($ecc = 0; $ecc < 4; $ecc++) {
                    for ($mode = 0; $mode < 2; $mode++) {
                        $cap = capacity($s, $ecc, $mode);
                        echo "size $s (" . SIZES[$s][0] . "x" . SIZES[$s][1] . ") ecc $ecc " . mode_name($mode) . ": {$cap['payload']} payload bytes\n";
                    }
                }
            }
            break;
        }
        default:
            fail("unknown command " . $a[0]);
    }
}

cli_main($argv);
