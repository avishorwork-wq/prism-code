<?php
// Prism Secure (envelope v2, reads v1) for the PHP port: AES-256-GCM payload
// locking with Argon2id (128 MiB, 3 passes, via ext-sodium) or PBKDF2-SHA256
// (600,000 rounds), and ECDSA P-256 / SHA-256 signing with RFC 6979
// deterministic nonces and P1363 r||s signatures, byte-compatible with the
// live site's prism-secure.html JS and the C/Go/Kotlin/Rust ports.
//
// Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
// normalization first; this port does not ship a Unicode normalizer, so
// non-ASCII passwords should already be in composed (NFC) form. ASCII
// passwords are unaffected.

const PSEC_ARGON2_MEM = 131072;
const PSEC_ARGON2_T = 3;
const PSEC_ARGON2_P = 1;
const PSEC_PBKDF2_ITER = 600000;

const PSEC_FLAG_ENC = 1;
const PSEC_FLAG_SIG = 2;
const PSEC_HEAD2 = 4 + 1 + 1 + 6 + 16 + 12;
const PSEC_HEAD1 = 4 + 1 + 16 + 12 + 4;
const PSEC_MAGIC = "PSC";

function psec_be32w(int $n): string {
    return pack('N', $n);
}
function psec_be32r(string $b, int $off): int {
    return unpack('N', substr($b, $off, 4))[1];
}

function psec_sha256(string $d): string {
    return hash('sha256', $d, true);
}

function psec_pbkdf2(string $pw, string $salt, int $iter, int $keyLen): string {
    // hash_pbkdf2 uses the password as its exact bytes.
    return hash_pbkdf2('sha256', $pw, $salt, $iter, $keyLen, true);
}

function psec_argon2id(string $pw, string $salt, int $memKib, int $t, int $lanes, int $keyLen): string {
    if ($memKib < 8192 || $memKib > 262144 || $t < 1 || $t > 12 || $lanes < 1 || $lanes > 4) {
        throw new Exception("argon2id parameters out of range");
    }
    if (!function_exists('sodium_crypto_pwhash')) {
        throw new Exception("this PHP build has no Argon2id (needs ext-sodium); use --kdf pbkdf2");
    }
    if ($lanes !== 1) {
        throw new Exception("argon2id lanes > 1 unsupported in this build");
    }
    return sodium_crypto_pwhash(
        $keyLen, $pw, $salt, $t, $memKib * 1024, SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13
    );
}

function psec_aes_encrypt(string $key, string $iv, string $aad, string $pt): array {
    $tag = '';
    $ct = openssl_encrypt($pt, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);
    if ($ct === false) throw new Exception("AES-GCM encrypt failed");
    return [$ct, $tag];
}

function psec_aes_decrypt(string $key, string $iv, string $aad, string $ct, string $tag): ?string {
    $pt = openssl_decrypt($ct, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $aad);
    return $pt === false ? null : $pt;
}

// ------------------------------------------------------------- P-256 / RFC 6979

function gp(): GMP { return gmp_init('FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF', 16); }
function gn(): GMP { return gmp_init('FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551', 16); }
function ga(): GMP { return gmp_sub(gp(), gmp_init(3)); }
function gb(): GMP { return gmp_init('5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B', 16); }
function gg(): array {
    return [
        gmp_init('6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296', 16),
        gmp_init('4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5', 16),
    ];
}

function gmod(GMP $a, GMP $m): GMP {
    $r = gmp_mod($a, $m);
    if (gmp_sign($r) < 0) $r = gmp_add($r, $m);
    return $r;
}

function pt_add(?array $p, ?array $q): ?array {
    if ($p === null) return $q;
    if ($q === null) return $p;
    [$px, $py] = $p;
    [$qx, $qy] = $q;
    $pp = gp();
    if (gmp_cmp($px, $qx) === 0) {
        if (gmp_cmp($py, $qy) !== 0) return null;
        if (gmp_sign($py) === 0) return null;
        $m = gmod(gmp_mul(gmp_add(gmp_mul(gmp_mul($px, $px), gmp_init(3)), ga()), gmp_invert(gmp_mul($py, 2), $pp)), $pp);
        $x = gmod(gmp_sub(gmp_mul($m, $m), gmp_mul($px, 2)), $pp);
        $y = gmod(gmp_sub(gmp_mul($m, gmp_sub($px, $x)), $py), $pp);
        return [$x, $y];
    }
    $m = gmod(gmp_mul(gmp_sub($qy, $py), gmp_invert(gmod(gmp_sub($qx, $px), $pp), $pp)), $pp);
    $x = gmod(gmp_sub(gmp_sub(gmp_mul($m, $m), $px), $qx), $pp);
    $y = gmod(gmp_sub(gmp_mul($m, gmp_sub($px, $x)), $py), $pp);
    return [$x, $y];
}

function pt_mul(GMP $k, ?array $p): ?array {
    $r = null;
    while (gmp_sign($k) !== 0) {
        if (gmp_testbit($k, 0)) $r = pt_add($r, $p);
        $p = pt_add($p, $p);
        $k = gmp_div_q($k, 2);
    }
    return $r;
}

function is_on_curve(array $pt): bool {
    $pp = gp();
    $l = gmod(gmp_mul($pt[1], $pt[1]), $pp);
    $r = gmod(gmp_add(gmp_mul(gmp_add(gmp_mul($pt[0], $pt[0]), ga()), $pt[0]), gb()), $pp);
    return gmp_cmp($l, $r) === 0;
}

function bi_from(string $b): GMP {
    $h = bin2hex($b);
    if ($h === '') $h = '0';
    return gmp_init($h, 16);
}

// rfc6979_k derives the deterministic nonce exactly like the C reference:
// HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
function rfc6979_k(string $priv, string $hash): GMP {
    $nn = gn();
    $v = str_repeat("\x01", 32);
    $k = str_repeat("\x00", 32);
    $bx = $priv . $hash;
    $k = hash_hmac('sha256', $v . "\x00" . $bx, $k, true);
    $v = hash_hmac('sha256', $v, $k, true);
    $k = hash_hmac('sha256', $v . "\x01" . $bx, $k, true);
    $v = hash_hmac('sha256', $v, $k, true);
    for (;;) {
        $v = hash_hmac('sha256', $v, $k, true);
        $kk = bi_from($v);
        if (gmp_sign($kk) !== 0 && gmp_cmp($kk, $nn) < 0) return $kk;
        $k = hash_hmac('sha256', $v . "\x00", $k, true);
        $v = hash_hmac('sha256', $v, $k, true);
    }
}

function pad32(GMP $x): string {
    $b = gmp_export($x);
    if (strlen($b) > 32) $b = substr($b, -32);
    return str_pad($b, 32, "\x00", STR_PAD_LEFT);
}

// p256_sign produces a deterministic P1363 r||s signature, low-s normalized.
function p256_sign(string $priv, string $msg): string {
    $nn = gn();
    $half = gmp_div_q($nn, 2);
    $hash = psec_sha256($msg);
    $d = bi_from($priv);
    $e = bi_from($hash);
    if (gmp_cmp($e, $nn) >= 0) $e = gmp_sub($e, $nn);
    for (;;) {
        $k = rfc6979_k($priv, $hash);
        $pt = pt_mul($k, gg());
        if ($pt === null) continue;
        $r = gmod($pt[0], $nn);
        if (gmp_sign($r) === 0) continue;
        $kinv = gmp_invert($k, $nn);
        $s = gmod(gmp_mul($kinv, gmp_add($e, gmp_mul($d, $r))), $nn);
        if (gmp_sign($s) === 0) continue;
        if (gmp_cmp($s, $half) > 0) $s = gmp_sub($nn, $s);
        return pad32($r) . pad32($s);
    }
}

function p256_verify(string $pub, string $msg, string $sig): bool {
    if (strlen($pub) !== 65 || $pub[0] !== "\x04" || strlen($sig) !== 64) return false;
    $nn = gn();
    $q = [bi_from(substr($pub, 1, 32)), bi_from(substr($pub, 33, 32))];
    if (!is_on_curve($q)) return false;
    $hash = psec_sha256($msg);
    $e = bi_from($hash);
    if (gmp_cmp($e, $nn) >= 0) $e = gmp_sub($e, $nn);
    $r = bi_from(substr($sig, 0, 32));
    $s = bi_from(substr($sig, 32, 32));
    if (gmp_sign($r) === 0 || gmp_cmp($r, $nn) >= 0 || gmp_sign($s) === 0 || gmp_cmp($s, $nn) >= 0) return false;
    $w = @gmp_invert($s, $nn);
    if ($w === false) return false;
    $u1 = gmod(gmp_mul($e, $w), $nn);
    $u2 = gmod(gmp_mul($r, $w), $nn);
    $pt = pt_add(pt_mul($u1, gg()), pt_mul($u2, $q));
    if ($pt === null) return false;
    return gmp_cmp(gmod($pt[0], $nn), $r) === 0;
}

function p256_keygen(string $priv): string {
    $pt = pt_mul(bi_from($priv), gg());
    return "\x04" . pad32($pt[0]) . pad32($pt[1]);
}

// ------------------------------------------------------------- secure envelope

// fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
function psec_fingerprint(string $pub): string {
    $h = psec_sha256($pub);
    $s = '';
    for ($i = 0; $i < 8; $i++) {
        $s .= strtoupper(bin2hex($h[$i]));
        if ($i % 2 === 1 && $i < 7) $s .= '-';
    }
    return $s;
}

function psec_genkey(): array {
    for (;;) {
        $priv = random_bytes(32);
        if (trim($priv, "\x00") !== '') return [$priv, p256_keygen($priv)];
    }
}

function psec_derive_key(string $password, string $salt, int $kdf, int $iter, int $mem, int $t, int $lanes): string {
    if ($kdf === 2) return psec_argon2id($password, $salt, $mem, $t, $lanes, 32);
    return psec_pbkdf2($password, $salt, $iter, 32);
}

// seal locks (password !== '', kdf 'argon2id'|'pbkdf2') and/or signs
// (priv present) data. At least one of the two.
function psec_seal(string $data, string $password, string $kdf, ?string $priv, ?string $pub): string {
    if ($password === '' && $priv === null) throw new Exception("need a password, a signing key, or both");
    $useA = $kdf === '' || $kdf === 'argon2id';
    $flags = 0;
    if ($password !== '') $flags |= PSEC_FLAG_ENC;
    if ($priv !== null) $flags |= PSEC_FLAG_SIG;
    if ($password !== '') {
        $salt = random_bytes(16);
        $iv = random_bytes(12);
        $h = PSEC_MAGIC . "\x02" . chr($flags);
        if ($useA) {
            $h .= "\x02" . psec_be32w(PSEC_ARGON2_MEM) . chr(PSEC_ARGON2_T) . chr(PSEC_ARGON2_P);
        } else {
            $h .= "\x01" . psec_be32w(PSEC_PBKDF2_ITER) . "\x00\x00";
        }
        $h .= $salt . $iv;
        $key = psec_derive_key($password, $salt, $useA ? 2 : 1, PSEC_PBKDF2_ITER, PSEC_ARGON2_MEM, PSEC_ARGON2_T, PSEC_ARGON2_P);
        [$ct, $tag] = psec_aes_encrypt($key, $iv, $h, $data);
        $body = $h . $ct . $tag;
    } else {
        $body = PSEC_MAGIC . "\x02" . chr($flags) . $data;
    }
    if ($priv === null) return $body;
    $sig = p256_sign($priv, $body);
    return $body . $pub . $sig;
}

function psec_is_secure(string $b): bool {
    return strlen($b) >= 6 && substr($b, 0, 3) === PSEC_MAGIC
        && ($b[3] === "\x01" || $b[3] === "\x02") && (ord($b[4]) & ~3) === 0;
}

// open returns ['secure'=>bool,'encrypted'=>bool,'signed'=>bool,
//   'signature_valid'=>-1|0|1,'fingerprint'=>string,'trusted'=>bool,
//   'bytes'=>?string,'needs_password'=>bool,'error'=>?string]
function psec_open(string $b, string $password, ?array $trustedFps = null): array {
    $res = [
        'secure' => false, 'version' => 0, 'encrypted' => false, 'signed' => false,
        'signature_valid' => -1, 'fingerprint' => '', 'trusted' => false,
        'bytes' => null, 'needs_password' => false, 'error' => null,
    ];
    if (!psec_is_secure($b)) {
        $res['bytes'] = $b;
        return $res;
    }
    $len = strlen($b);
    $ver = ord($b[3]);
    $flags = ord($b[4]);
    $encrypted = (bool)($flags & PSEC_FLAG_ENC);
    $sgn = (bool)($flags & PSEC_FLAG_SIG);
    $res['secure'] = true;
    $res['version'] = $ver;
    $res['encrypted'] = $encrypted;
    $res['signed'] = $sgn;
    $end = $len;
    if ($sgn) {
        if ($len < 5 + 65 + 64) {
            $res['error'] = "Code is damaged";
            return $res;
        }
        $pub = substr($b, $end - 129, 65);
        $sig = substr($b, $end - 64, 64);
        $res['signature_valid'] = p256_verify($pub, substr($b, 0, $end - 129), $sig) ? 1 : 0;
        $res['fingerprint'] = psec_fingerprint($pub);
        if ($res['signature_valid'] === 1 && $trustedFps !== null) {
            foreach ($trustedFps as $fp) if ($fp === $res['fingerprint']) $res['trusted'] = true;
        }
        $end -= 129;
        if ($res['signature_valid'] !== 1) {
            $res['error'] = "Signature is not valid. This code was changed or forged.";
            return $res;
        }
    }
    if (!$encrypted) {
        $res['bytes'] = substr($b, 5, $end - 5);
        return $res;
    }
    if ($ver === 1) {
        $hl = PSEC_HEAD1;
        if ($end < $hl + 16) {
            $res['error'] = "Code is damaged";
            return $res;
        }
        $salt = substr($b, 5, 16);
        $iv = substr($b, 21, 12);
        $kdf = 1;
        $iter = psec_be32r($b, 33);
        $mem = 0; $t = 0; $lanes = 0;
    } else {
        $hl = PSEC_HEAD2;
        if ($end < $hl + 16) {
            $res['error'] = "Code is damaged";
            return $res;
        }
        $kdf = ord($b[5]);
        $salt = substr($b, 12, 16);
        $iv = substr($b, 28, 12);
        if ($kdf === 2) {
            $mem = psec_be32r($b, 6);
            $t = ord($b[10]);
            $lanes = ord($b[11]);
            $iter = 0;
        } else {
            $iter = psec_be32r($b, 6);
            $mem = 0; $t = 0; $lanes = 0;
        }
    }
    if (($kdf === 1 && ($iter < 100000 || $iter > 5000000))
        || ($kdf === 2 && ($mem < 8192 || $mem > 262144 || $t < 1 || $t > 12 || $lanes < 1 || $lanes > 4))
        || ($kdf !== 1 && $kdf !== 2)) {
        $res['error'] = "Code is damaged or unsupported";
        return $res;
    }
    if ($password === '') {
        $res['needs_password'] = true;
        return $res;
    }
    try {
        $key = psec_derive_key($password, $salt, $kdf, $iter, $mem, $t, $lanes);
    } catch (Exception $e) {
        $res['error'] = "Key derivation failed";
        return $res;
    }
    $pt = psec_aes_decrypt($key, $iv, substr($b, 0, $hl), substr($b, $hl, $end - $hl - 16), substr($b, $end - 16, 16));
    if ($pt === null) {
        $res['error'] = "Wrong password, or the code was changed.";
    } else {
        $res['bytes'] = $pt;
    }
    return $res;
}

// generate_passphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
function psec_passphrase(): string {
    $alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    $r = random_bytes(28);
    $s = '';
    for ($g = 0; $g < 7; $g++) {
        if ($g) $s .= '-';
        for ($i = 0; $i < 4; $i++) $s .= $alpha[ord($r[$g * 4 + $i]) & 31];
    }
    return $s;
}

// strength estimates password strength; same heuristic as the site.
// Returns [bits, level 0-4, label].
function psec_strength(string $pw): array {
    $labels = ["weak", "weak", "fair", "good", "strong"];
    $pb = array_values(unpack('C*', $pw));
    $n = count($pb);
    if ($n === 0) return [0, 0, "none"];
    // generated-passphrase shape
    $groups = 1;
    $okk = true;
    $bodyCnt = 0;
    foreach ($pb as $c) {
        if ($c === 0x2d) { $groups++; continue; }
        $isUp = $c >= 65 && $c <= 90 && $c !== 73 && $c !== 79;
        $isDig = $c >= 50 && $c <= 57;
        if (!$isUp && !$isDig) { $okk = false; break; }
        $bodyCnt++;
    }
    if ($groups >= 6 && $okk && $bodyCnt >= 24) {
        return [$bodyCnt * 5, 4, "excellent (random)"];
    }
    $lo = $up = $dig = $sym = false;
    foreach ($pb as $c) {
        if ($c >= 97 && $c <= 122) $lo = true;
        elseif ($c >= 65 && $c <= 90) $up = true;
        elseif ($c >= 48 && $c <= 57) $dig = true;
        else $sym = true;
    }
    $pool = 0;
    if ($lo) $pool += 26;
    if ($up) $pool += 26;
    if ($dig) $pool += 10;
    if ($sym) $pool += 33;
    if ($pool < 2) $pool = 2;
    $lp = 0.0;
    $p = $pool;
    while ($p > 1) { $lp += 1.0; $p >>= 1; }
    $base = 1 << ((int)$lp);
    $lp += ($pool - $base) / $base;
    $uniq = 0;
    for ($i = 0; $i < $n; $i++) {
        $seen = false;
        for ($j = 0; $j < $i; $j++) if ($pb[$j] === $pb[$i]) $seen = true;
        if (!$seen) $uniq++;
    }
    $capN = $n;
    if ($uniq * 2 < $n) $capN = $uniq * 2;
    $bits = $capN * $lp;
    for ($i = 0; $i + 2 < $n; $i++) {
        if ($pb[$i] === $pb[$i + 1] && $pb[$i] === $pb[$i + 2]) { $bits *= 0.7; break; }
    }
    $seqs = ["012","123","234","345","456","567","678","789","abc","bcd","cde","def","qwe","wer","asd","sdf","zxc"];
    foreach ($seqs as $sq) {
        $hit = false;
        for ($i = 0; $i + 2 < $n; $i++) {
            if (($pb[$i] | 32) === ord($sq[0]) && ($pb[$i + 1] | 32) === ord($sq[1]) && ($pb[$i + 2] | 32) === ord($sq[2])) {
                $bits *= 0.7;
                $hit = true;
                break;
            }
        }
        if ($hit) break;
    }
    if (($lo && !$up && !$dig && !$sym) || ($dig && !$lo && !$up && !$sym)) $bits *= 0.8;
    for ($i = 0; $i + 3 < $n; $i++) {
        if (($pb[$i] === 49 && $pb[$i + 1] === 57) || ($pb[$i] === 50 && $pb[$i + 1] === 48)) {
            if ($pb[$i + 2] >= 48 && $pb[$i + 2] <= 57 && $pb[$i + 3] >= 48 && $pb[$i + 3] <= 57) {
                $bits -= 8.0;
                break;
            }
        }
    }
    $common = ["password","passw0rd","qwerty","letmein","welcome","admin","iloveyou","monkey","dragon",
        "football","baseball","shalom","israel","master","login","abc123","prism","secret","hello",
        "test","summer","winter","sunshine","princess","trustno1","whatever","google","avi","1234",
        "asdf","zxcv","love","god","cohen","levi"];
    $low = strtolower($pw);
    foreach ($common as $w) {
        if (str_contains($low, $w)) {
            if ($bits > 28.0) $bits = 28.0;
            if ($low === $w) $bits -= 8.0;
            break;
        }
    }
    $ibits = (int)$bits;
    if ($ibits < 0) $ibits = 0;
    $level = $ibits < 40 ? 0 : ($ibits < 60 ? 1 : ($ibits < 80 ? 2 : ($ibits < 100 ? 3 : 4)));
    return [$ibits, $level, $labels[$level]];
}

// ------------------------------------------------------------- key file

function psec_b64url(string $b): string {
    return rtrim(strtr(base64_encode($b), '+/', '-_'), '=');
}
function psec_b64url_dec(string $s): string {
    return base64_decode(strtr($s, '-_', '+/'));
}

function psec_save_key(string $path, string $priv, string $pub): void {
    $json = '{"publicKeyHex":"' . bin2hex($pub) . '","privateJwk":{"crv":"P-256","d":"'
        . psec_b64url($priv) . '","kty":"EC","x":"' . psec_b64url(substr($pub, 1, 32))
        . '","y":"' . psec_b64url(substr($pub, 33, 32)) . '"}}';
    if (file_put_contents($path, $json) === false) throw new Exception("cannot write $path");
    @chmod($path, 0600);
}

function psec_load_key(string $path): array {
    $data = @file_get_contents($path);
    if ($data === false) throw new Exception("cannot read $path");
    $kf = json_decode($data, true);
    if (!is_array($kf) || !isset($kf['publicKeyHex'], $kf['privateJwk']['d'])) {
        throw new Exception("bad key file $path");
    }
    $pub = hex2bin($kf['publicKeyHex']);
    if ($pub === false || strlen($pub) !== 65) throw new Exception("bad public key in $path");
    $priv = psec_b64url_dec($kf['privateJwk']['d']);
    if (strlen($priv) !== 32) throw new Exception("bad private key in $path");
    return [$priv, $pub];
}
