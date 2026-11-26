<?php
// Prism verified issuers for the PHP port: identify signed Prism Secure
// payloads and look the signer up in an issuer list, same semantics as
// prism-issuers.js and the C/Go/Kotlin/Rust ports.

require_once __DIR__ . '/prism_secure.php';

// identify inspects decoded payload bytes. Returns null for plain or
// unsigned payloads. Never decrypts.
// Returns ['signature_valid'=>bool,'fingerprint'=>string,'encrypted'=>bool,
//          'message'=>string,'has_message'=>bool]
function issuer_identify(string $b): ?array {
    if (strlen($b) < 5 + 65 + 64) return null;
    if ($b[0] !== 'P' || $b[1] !== 'S' || $b[2] !== 'C') return null;
    if ($b[3] !== "\x01" && $b[3] !== "\x02") return null;
    if ((ord($b[4]) & 2) === 0) return null;
    $end = strlen($b);
    $pub = substr($b, $end - 129, 65);
    $sig = substr($b, $end - 64, 64);
    $body = substr($b, 0, $end - 129);
    $out = [
        'signature_valid' => p256_verify($pub, $body, $sig),
        'fingerprint' => psec_fingerprint($pub),
        'encrypted' => (ord($b[4]) & 1) !== 0,
        'message' => '',
        'has_message' => false,
    ];
    if ($out['signature_valid'] && !$out['encrypted'] && strlen($body) >= 5) {
        $m = substr($body, 5);
        if (preg_match('//u', $m) === 1) {
            $out['message'] = $m;
            $out['has_message'] = true;
        }
    }
    return $out;
}

// load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
function issuers_load(string $path): array {
    $data = @file_get_contents($path);
    if ($data === false || strlen($data) > 1 << 20) return [];
    $doc = json_decode($data, true);
    if (!is_array($doc) || !isset($doc['issuers']) || !is_array($doc['issuers'])) return [];
    $out = [];
    foreach ($doc['issuers'] as $it) {
        if (is_array($it) && isset($it['name'], $it['fingerprint'])) {
            $out[] = ['name' => (string)$it['name'], 'fingerprint' => (string)$it['fingerprint']];
        }
    }
    return $out;
}

function issuer_norm_fp(string $fp): string {
    $b = '';
    $n = strlen($fp);
    for ($i = 0; $i < $n && strlen($b) < 15; $i++) {
        $c = $fp[$i];
        if (ctype_xdigit($c)) $b .= strtoupper($c);
    }
    return $b;
}

// find_index: normalized fingerprint match (case-insensitive, separators ignored).
function issuers_find(array $list, string $fingerprint): int {
    $want = issuer_norm_fp($fingerprint);
    foreach ($list as $i => $it) {
        if (issuer_norm_fp($it['fingerprint']) === $want) return $i;
    }
    return -1;
}
