<?php
// Prism tickets and cards for the PHP port: Wi-Fi, contact card (vCard 3.0)
// and expiring ticket payload builders and parsers, payload-compatible with
// prism-cards.js and the C/Go/Kotlin/Rust ports.

function card_esc_wifi(string $s): string {
    return preg_replace('/([\\\\;,:\"\'])/', '\\\\$1', $s);
}

// wifi_build builds the common WIFI: payload other readers agree on.
function card_wifi_build(string $ssid, string $sec, string $pass, bool $hidden): string {
    $t = $sec === '' ? 'WPA' : $sec;
    $b = "WIFI:T:$t;S:" . card_esc_wifi($ssid) . ';';
    if ($t !== 'nopass') $b .= 'P:' . card_esc_wifi($pass) . ';';
    if ($hidden) $b .= 'H:true;';
    $b .= ';';
    return $b;
}

// wifi_parse returns ['ssid','sec','pass','hidden'] or null.
function card_wifi_parse(string $text): ?array {
    if (strlen($text) < 5 || strtoupper(substr($text, 0, 5)) !== 'WIFI:') return null;
    $body = substr($text, 5);
    $n = strlen($body);
    $out = ['ssid' => '', 'sec' => '', 'pass' => '', 'hidden' => false];
    $key = '';
    $val = '';
    $inKey = true;
    $haveSsid = false;
    $flush = function () use (&$key, &$val, &$out, &$haveSsid) {
        if ($key === '') return;
        $k = strtoupper($key);
        if ($k === 'S') { $out['ssid'] = $val; $haveSsid = true; }
        elseif ($k === 'T') $out['sec'] = strtoupper($val);
        elseif ($k === 'P') $out['pass'] = $val;
        elseif ($k === 'H') $out['hidden'] = strcasecmp($val, 'true') === 0;
    };
    for ($i = 0;; $i++) {
        $c = $i < $n ? $body[$i] : "\0";
        $doFlush = false;
        if ($i >= $n) $doFlush = true;
        elseif ($c === '\\' && $i + 1 < $n) {
            if ($inKey) $key .= $body[$i + 1];
            else $val .= $body[$i + 1];
            $i++;
            continue;
        } elseif ($inKey && $c === ':') { $inKey = false; continue; }
        elseif (!$inKey && $c === ';') $doFlush = true;
        elseif ($inKey) { $key .= $c; continue; }
        else { $val .= $c; continue; }
        if ($doFlush) {
            $flush();
            if ($i >= $n) break;
            $key = '';
            $val = '';
            $inKey = true;
        }
    }
    if (!$haveSsid) return null;
    if ($out['sec'] === '') $out['sec'] = 'WPA';
    return $out;
}

// ------------------------------------------------------------- vCard

function card_esc_vcard(string $s): string {
    $out = '';
    $n = strlen($s);
    for ($i = 0; $i < $n; $i++) {
        $c = $s[$i];
        if ($c === '\\' || $c === ',' || $c === ';') $out .= '\\';
        if ($c === "\n") { $out .= '\\n'; continue; }
        $out .= $c;
    }
    return $out;
}

// vcard_build builds a vCard 3.0 payload. Any field may be empty.
function card_vcard_build(string $name, string $org, string $title, string $phone,
                          string $email, string $url, string $addr, string $note): string {
    $b = "BEGIN:VCARD\r\nVERSION:3.0\r\n";
    $b .= 'FN:' . card_esc_vcard($name) . "\r\n";
    if ($name !== '') {
        $words = preg_split('/\s+/', trim($name));
        $first = $words[0];
        $rest = count($words) > 1 ? implode(' ', array_slice($words, 1)) : '-';
        $b .= 'N:' . card_esc_vcard($rest) . ';' . card_esc_vcard($first) . ";;;\r\n";
    }
    if ($org !== '') $b .= 'ORG:' . card_esc_vcard($org) . "\r\n";
    if ($title !== '') $b .= 'TITLE:' . card_esc_vcard($title) . "\r\n";
    if ($phone !== '') $b .= 'TEL;TYPE=CELL:' . card_esc_vcard($phone) . "\r\n";
    if ($email !== '') $b .= 'EMAIL:' . card_esc_vcard($email) . "\r\n";
    if ($url !== '') $b .= 'URL:' . card_esc_vcard($url) . "\r\n";
    if ($addr !== '') $b .= 'ADR;TYPE=WORK:;;' . card_esc_vcard($addr) . ";;;;\r\n";
    if ($note !== '') $b .= 'NOTE:' . card_esc_vcard($note) . "\r\n";
    $b .= 'END:VCARD';
    return $b;
}

function card_key_matches(string $line, string $key): ?string {
    if (strlen($line) < strlen($key) || strcasecmp(substr($line, 0, strlen($key)), $key) !== 0) return null;
    $p = substr($line, strlen($key));
    if ($p !== '' && $p[0] === ';') {
        $idx = strpos($p, ':');
        if ($idx === false) return null;
        $p = substr($p, $idx);
    }
    if ($p === '' || $p[0] !== ':') return null;
    return substr($p, 1);
}

function card_unesc_vcard(string $s): string {
    $out = '';
    $n = strlen($s);
    for ($i = 0; $i < $n; $i++) {
        if ($s[$i] === '\\' && $i + 1 < $n) {
            $c = $s[$i + 1];
            if ($c === 'n' || $c === 'N') { $out .= "\n"; $i++; continue; }
            if ($c === ',' || $c === ';' || $c === '\\') { $out .= $c; $i++; continue; }
        }
        $out .= $s[$i];
    }
    return $out;
}

// vcard_parse returns ['name','org','title','addr','note','phones','emails','urls'] or null.
function card_vcard_parse(string $text): ?array {
    if (!str_contains($text, 'BEGIN:VCARD')) return null;
    // unfold continuation lines, drop \r, split on \n
    $flat = '';
    $n = strlen($text);
    for ($i = 0; $i < $n; $i++) {
        $c = $text[$i];
        if ($c === "\r") continue;
        if ($c === "\n" && $i + 1 < $n && ($text[$i + 1] === ' ' || $text[$i + 1] === "\t")) continue;
        $flat .= $c;
    }
    $out = ['name' => '', 'org' => '', 'title' => '', 'addr' => '', 'note' => '',
            'phones' => [], 'emails' => [], 'urls' => []];
    $foundFn = false;
    foreach (explode("\n", $flat) as $line) {
        if (($v = card_key_matches($line, 'FN')) !== null) { $out['name'] = card_unesc_vcard($v); $foundFn = true; }
        elseif (($v = card_key_matches($line, 'ORG')) !== null) $out['org'] = card_unesc_vcard($v);
        elseif (($v = card_key_matches($line, 'TITLE')) !== null) $out['title'] = card_unesc_vcard($v);
        elseif (($v = card_key_matches($line, 'NOTE')) !== null) $out['note'] = card_unesc_vcard($v);
        elseif (($v = card_key_matches($line, 'ADR')) !== null) {
            $t = card_unesc_vcard($v);
            $out['addr'] = trim($t, ';');
        } elseif (($v = card_key_matches($line, 'EMAIL')) !== null) {
            if (count($out['emails']) < 8) $out['emails'][] = card_unesc_vcard($v);
        } elseif (($v = card_key_matches($line, 'TEL')) !== null) {
            if (count($out['phones']) < 8) $out['phones'][] = card_unesc_vcard($v);
        } elseif (($v = card_key_matches($line, 'URL')) !== null) {
            if (count($out['urls']) < 8) $out['urls'][] = card_unesc_vcard($v);
        }
    }
    if (!$foundFn) return null;
    return $out;
}

// ------------------------------------------------------------- ticket

// ticket_build builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
function card_ticket_build(int $expiryMs, string $text): string {
    return "PRISM-TICKET/1\nEXP:" . intdiv($expiryMs, 1000) . "\n" . trim($text);
}

// ticket_parse returns ['expiry_ms','body'] or null.
function card_ticket_parse(string $text): ?array {
    $prefix = "PRISM-TICKET/1\nEXP:";
    if (substr($text, 0, strlen($prefix)) !== $prefix) return null;
    $p = substr($text, strlen($prefix));
    if ($p === '' || !ctype_digit($p[0])) return null;
    $exp = 0;
    $i = 0;
    $n = strlen($p);
    while ($i < $n && ctype_digit($p[$i])) {
        $exp = $exp * 10 + (ord($p[$i]) - 48);
        $i++;
    }
    if ($i >= $n || $p[$i] !== "\n") return null;
    $body = rtrim(substr($p, $i + 1));
    return ['expiry_ms' => $exp * 1000, 'body' => $body];
}

// detect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
function card_detect(string $text): int {
    if ($text === '') return 0;
    if (card_ticket_parse($text) !== null) return 1;
    if (card_wifi_parse($text) !== null) return 2;
    if (card_vcard_parse($text) !== null) return 3;
    return 0;
}
