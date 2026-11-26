/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism tickets and cards, payload-compatible with prism-cards.js. */
#include "prism_cards.h"

#include <string.h>
#include <strings.h>
#include <stdio.h>
#include <ctype.h>

/* ---------- Wi-Fi ---------- */

static size_t esc_wifi(char *dst, size_t cap, const char *s) {
    size_t w = 0;
    for (; *s && w + 3 < cap; s++) {
        if (strchr("\\;,:\"'", *s)) dst[w++] = '\\';
        dst[w++] = *s;
    }
    dst[w] = 0;
    return w;
}

int prism_wifi_build(char *out, size_t cap,
                     const char *ssid, const char *sec, const char *pass, int hidden) {
    const char *t = (sec && *sec) ? sec : "WPA";
    size_t w = 0;
    w += (size_t)snprintf(out + w, cap - w, "WIFI:T:%s;S:", t);
    w += esc_wifi(out + w, cap - w, ssid ? ssid : "");
    w += (size_t)snprintf(out + w, cap - w, ";");
    if (strcmp(t, "nopass") != 0) {
        w += (size_t)snprintf(out + w, cap - w, "P:");
        w += esc_wifi(out + w, cap - w, pass ? pass : "");
        w += (size_t)snprintf(out + w, cap - w, ";");
    }
    if (hidden) w += (size_t)snprintf(out + w, cap - w, "H:true;");
    w += (size_t)snprintf(out + w, cap - w, ";");
    return w < cap ? (int)w : -1;
}

static void copy_trunc(char *dst, size_t cap, const char *src, size_t n) {
    if (n >= cap) n = cap - 1;
    memcpy(dst, src, n);
    dst[n] = 0;
}

int prism_wifi_parse(const char *text, prism_wifi *out) {
    if (!text || strncasecmp(text, "WIFI:", 5) != 0) return 0;
    const char *body = text + 5;
    char key[8] = {0}, val[520];
    size_t kl = 0, vl = 0;
    int in_key = 1, have_ssid = 0;
    memset(out, 0, sizeof *out);
    for (size_t i = 0;; i++) {
        char c = body[i];
        int flush = 0;
        if (c == 0) flush = 1;
        else if (c == '\\' && body[i + 1]) {
            if (in_key && kl + 1 < sizeof key) key[kl++] = body[i + 1];
            else if (!in_key && vl + 1 < sizeof val) val[vl++] = body[i + 1];
            i++;
            continue;
        } else if (in_key && c == ':') { in_key = 0; continue; }
        else if (!in_key && c == ';') flush = 1;
        else if (in_key && kl + 1 < sizeof key) key[kl++] = c;
        else if (!in_key && vl + 1 < sizeof val) val[vl++] = c;
        if (flush) {
            key[kl] = 0; val[vl] = 0;
            if (kl) {
                for (size_t j = 0; key[j]; j++) key[j] = (char)toupper((unsigned char)key[j]);
                if (strcmp(key, "S") == 0) { copy_trunc(out->ssid, sizeof out->ssid, val, vl); have_ssid = 1; }
                else if (strcmp(key, "T") == 0) {
                    copy_trunc(out->sec, sizeof out->sec, val, vl);
                    for (size_t j = 0; out->sec[j]; j++) out->sec[j] = (char)toupper((unsigned char)out->sec[j]);
                }
                else if (strcmp(key, "P") == 0) copy_trunc(out->pass, sizeof out->pass, val, vl);
                else if (strcmp(key, "H") == 0) out->hidden = strcasecmp(val, "true") == 0;
            }
            if (c == 0) break;
            kl = vl = 0; in_key = 1;
        }
    }
    if (!have_ssid) return 0;
    if (!out->sec[0]) strcpy(out->sec, "WPA");
    return 1;
}

/* ---------- vCard ---------- */

static size_t esc_vcard(char *dst, size_t cap, const char *s) {
    size_t w = 0;
    for (; *s && w + 3 < cap; s++) {
        if (*s == '\\' || *s == ',' || *s == ';') dst[w++] = '\\';
        if (*s == '\n') { dst[w++] = '\\'; dst[w++] = 'n'; continue; }
        dst[w++] = *s;
    }
    dst[w] = 0;
    return w;
}

static int ap(char *out, size_t cap, size_t w, const char *fmt, const char *esc) {
    int n = snprintf(out + w, cap - w, fmt, esc);
    return n > 0 && w + (size_t)n < cap ? n : -1;
}

int prism_vcard_build(char *out, size_t cap,
                      const char *name, const char *org, const char *title,
                      const char *phone, const char *email, const char *url,
                      const char *addr, const char *note) {
    size_t w = 0;
    char e[1024], e2[1024];
    w += (size_t)snprintf(out + w, cap - w, "BEGIN:VCARD\r\nVERSION:3.0\r\n");
    w += (size_t)ap(out, cap, w, "FN:%s\r\n", e + esc_vcard(e, sizeof e, name ? name : "") * 0);
    if (name && *name) {
        /* N: like JS: name.trim().split(/\s+/); rest = words after the first
         * joined with single spaces (or '-'); first = first word. */
        const char *t = name;
        while (*t && isspace((unsigned char)*t)) t++;
        size_t tl = strlen(t);
        while (tl && isspace((unsigned char)t[tl - 1])) tl--;
        char first[256] = {0}, rest[1024] = "-";
        size_t fl = 0;
        const char *p = t, *end = t + tl;
        while (p < end && !isspace((unsigned char)*p) && fl + 1 < sizeof first) first[fl++] = *p++;
        first[fl] = 0;
        size_t rl = 0;
        while (p < end && rl + 1 < sizeof rest) {
            while (p < end && isspace((unsigned char)*p)) p++;
            if (p >= end) break;
            if (rl) rest[rl++] = ' ';
            while (p < end && !isspace((unsigned char)*p) && rl + 1 < sizeof rest) rest[rl++] = *p++;
        }
        if (rl) rest[rl] = 0; /* empty rest stays "-" like the JS || '-' */
        esc_vcard(e, sizeof e, rest);
        esc_vcard(e2, sizeof e2, first);
        {
            int n = snprintf(out + w, cap - w, "N:%s;%s;;;\r\n", e, e2);
            if (n < 0 || w + (size_t)n >= cap) return -1;
            w += (size_t)n;
        }
    }
    if (org && *org) { esc_vcard(e, sizeof e, org); w += (size_t)ap(out, cap, w, "ORG:%s\r\n", e); }
    if (title && *title) { esc_vcard(e, sizeof e, title); w += (size_t)ap(out, cap, w, "TITLE:%s\r\n", e); }
    if (phone && *phone) { esc_vcard(e, sizeof e, phone); w += (size_t)ap(out, cap, w, "TEL;TYPE=CELL:%s\r\n", e); }
    if (email && *email) { esc_vcard(e, sizeof e, email); w += (size_t)ap(out, cap, w, "EMAIL:%s\r\n", e); }
    if (url && *url) { esc_vcard(e, sizeof e, url); w += (size_t)ap(out, cap, w, "URL:%s\r\n", e); }
    if (addr && *addr) { esc_vcard(e, sizeof e, addr); w += (size_t)ap(out, cap, w, "ADR;TYPE=WORK:;;%s;;;;\r\n", e); }
    if (note && *note) { esc_vcard(e, sizeof e, note); w += (size_t)ap(out, cap, w, "NOTE:%s\r\n", e); }
    w += (size_t)snprintf(out + w, cap - w, "END:VCARD");
    return w < cap ? (int)w : -1;
}

static int key_matches(const char *line, const char *key, const char **val) {
    size_t kl = strlen(key);
    if (strncasecmp(line, key, kl) != 0) return 0;
    const char *p = line + kl;
    if (*p == ';') { while (*p && *p != ':') p++; }
    if (*p != ':') return 0;
    *val = p + 1;
    return 1;
}

static size_t unesc_vcard(char *dst, size_t cap, const char *src, size_t n) {
    size_t w = 0;
    for (size_t i = 0; i < n && w + 1 < cap; i++) {
        if (src[i] == '\\' && i + 1 < n) {
            char c = src[i + 1];
            if (c == 'n' || c == 'N') { dst[w++] = '\n'; i++; continue; }
            if (c == ',' || c == ';' || c == '\\') { dst[w++] = c; i++; continue; }
        }
        dst[w++] = src[i];
    }
    dst[w] = 0;
    return w;
}

int prism_vcard_parse(const char *text, prism_vcard *out) {
    if (!text || !strstr(text, "BEGIN:VCARD")) return 0;
    memset(out, 0, sizeof *out);
    /* unfold continuation lines, split on \n */
    char buf[8192];
    size_t bl = strlen(text);
    if (bl >= sizeof buf) bl = sizeof buf - 1;
    size_t w = 0;
    for (size_t i = 0; i < bl; i++) {
        char c = text[i];
        if (c == '\r') continue;
        if (c == '\n' && i + 1 < bl && (text[i + 1] == ' ' || text[i + 1] == '\t')) continue;
        if (c == '\n' && w && buf[w - 1] == 0) continue;
        buf[w++] = c ? c : ' ';
        if (c == '\n') buf[w - 1] = 0, buf[w++] = 0; /* keep, replaced below */
    }
    /* simpler: rebuild as NUL-separated lines */
    w = 0;
    for (size_t i = 0; i < bl; i++) {
        char c = text[i];
        if (c == '\r') continue;
        if (c == '\n' && i + 1 < bl && (text[i + 1] == ' ' || text[i + 1] == '\t')) continue;
        buf[w++] = (c == '\n') ? 0 : c;
    }
    buf[w] = 0;
    int found_fn = 0;
    size_t pos = 0;
    while (pos < w) {
        const char *line = buf + pos;
        size_t ll = strlen(line);
        const char *v;
        if (key_matches(line, "FN", &v)) { unesc_vcard(out->name, sizeof out->name, v, ll - (v - line)); found_fn = 1; }
        else if (key_matches(line, "ORG", &v)) unesc_vcard(out->org, sizeof out->org, v, ll - (v - line));
        else if (key_matches(line, "TITLE", &v)) unesc_vcard(out->title, sizeof out->title, v, ll - (v - line));
        else if (key_matches(line, "NOTE", &v)) unesc_vcard(out->note, sizeof out->note, v, ll - (v - line));
        else if (key_matches(line, "ADR", &v)) {
            char tmp[600];
            unesc_vcard(tmp, sizeof tmp, v, ll - (v - line));
            char *s = tmp;
            while (*s == ';') s++;
            size_t e = strlen(s);
            while (e && s[e - 1] == ';') s[--e] = 0;
            snprintf(out->addr, sizeof out->addr, "%s", s);
        }
        else if (key_matches(line, "EMAIL", &v) && out->n_emails < 8) unesc_vcard(out->emails[out->n_emails++], 128, v, ll - (v - line));
        else if (key_matches(line, "TEL", &v) && out->n_phones < 8) unesc_vcard(out->phones[out->n_phones++], 64, v, ll - (v - line));
        else if (key_matches(line, "URL", &v) && out->n_urls < 8) unesc_vcard(out->urls[out->n_urls++], 256, v, ll - (v - line));
        pos += ll + 1;
    }
    return found_fn ? 1 : 0;
}

/* ---------- ticket ---------- */

int prism_ticket_build(char *out, size_t cap, int64_t expiry_ms, const char *text) {
    /* trim trailing/leading whitespace of the free text like String.trim() */
    const char *t = text ? text : "";
    while (*t && isspace((unsigned char)*t)) t++;
    size_t tl = strlen(t);
    while (tl && isspace((unsigned char)t[tl - 1])) tl--;
    int n = snprintf(out, cap, "PRISM-TICKET/1\nEXP:%lld\n%.*s",
                     (long long)(expiry_ms / 1000), (int)tl, t);
    return n > 0 && (size_t)n < cap ? n : -1;
}

int prism_ticket_parse(const char *text, prism_ticket *out) {
    if (!text) return 0;
    const char *p = text;
    const char *prefix = "PRISM-TICKET/1\nEXP:";
    size_t pl = strlen(prefix);
    if (strncmp(p, prefix, pl) != 0) return 0;
    p += pl;
    if (!isdigit((unsigned char)*p)) return 0;
    long long exp = 0;
    while (isdigit((unsigned char)*p)) { exp = exp * 10 + (*p - '0'); p++; }
    if (*p != '\n') return 0;
    p++;
    out->expiry_ms = exp * 1000;
    size_t tl = strlen(p);
    while (tl && isspace((unsigned char)p[tl - 1])) tl--;
    if (tl >= sizeof out->body) tl = sizeof out->body - 1;
    memcpy(out->body, p, tl);
    out->body[tl] = 0;
    return 1;
}

int prism_card_detect(const char *text) {
    if (!text || !*text) return 0;
    prism_ticket t; prism_wifi w; prism_vcard v;
    if (prism_ticket_parse(text, &t)) return 1;
    if (prism_wifi_parse(text, &w)) return 2;
    if (prism_vcard_parse(text, &v)) return 3;
    return 0;
}
