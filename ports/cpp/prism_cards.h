/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * Prism tickets and cards: Wi-Fi, contact card (vCard 3.0) and expiring
 * ticket payload builders and parsers, compatible with prism-cards.js. */
#ifndef PRISM_CARDS_H
#define PRISM_CARDS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Every function below writes into caller buffers and returns the length
 * written, or -1 when the buffer is too small. Strings are NUL-terminated. */

/* Wi-Fi card payload (the common WIFI: format other readers agree on). */
int prism_wifi_build(char *out, size_t cap,
                     const char *ssid, const char *sec /* "WPA","WEP","nopass" */,
                     const char *pass, int hidden);

typedef struct {
    char ssid[129], sec[17], pass[129];
    int hidden;
} prism_wifi;
int prism_wifi_parse(const char *text, prism_wifi *out); /* 1 wifi, 0 not */

/* Contact card payload (vCard 3.0). Any field may be NULL/empty. */
int prism_vcard_build(char *out, size_t cap,
                      const char *name, const char *org, const char *title,
                      const char *phone, const char *email, const char *url,
                      const char *addr, const char *note);

typedef struct {
    char name[256], org[256], title[256], addr[512], note[1024];
    char phones[8][64]; int n_phones;
    char emails[8][128]; int n_emails;
    char urls[8][256]; int n_urls;
} prism_vcard;
int prism_vcard_parse(const char *text, prism_vcard *out); /* 1 vcard, 0 not */

/* Expiring ticket payload: "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>". */
int prism_ticket_build(char *out, size_t cap, int64_t expiry_ms, const char *text);

typedef struct {
    int64_t expiry_ms;
    char body[2048];
} prism_ticket;
int prism_ticket_parse(const char *text, prism_ticket *out); /* 1 ticket, 0 not */

/* Detects a card payload: 1 ticket, 2 wifi, 3 vcard, 0 none (site order). */
int prism_card_detect(const char *text);

#ifdef __cplusplus
}
#endif

#endif
