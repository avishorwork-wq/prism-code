/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ wrapper over the C Prism cards core. */
#include "prism_cards.hpp"
#include "prism.hpp" // prism::Error
extern "C" {
#include "prism_cards.h"
}

namespace prism {

std::string wifiPayload(const WifiFields& f) {
    char buf[1024];
    int n = prism_wifi_build(buf, sizeof buf, f.ssid.c_str(), f.sec.c_str(), f.pass.c_str(), f.hidden ? 1 : 0);
    if (n < 0) throw Error("Wi-Fi payload too long");
    return std::string(buf, (size_t)n);
}

bool wifiParse(const std::string& text, WifiFields& out) {
    prism_wifi w;
    if (!prism_wifi_parse(text.c_str(), &w)) return false;
    out.ssid = w.ssid; out.sec = w.sec; out.pass = w.pass; out.hidden = w.hidden != 0;
    return true;
}

std::string vcardPayload(const std::string& name, const std::string& org,
                         const std::string& title, const std::string& phone,
                         const std::string& email, const std::string& url,
                         const std::string& addr, const std::string& note) {
    char buf[8192];
    int n = prism_vcard_build(buf, sizeof buf, name.c_str(), org.c_str(), title.c_str(),
                              phone.c_str(), email.c_str(), url.c_str(), addr.c_str(), note.c_str());
    if (n < 0) throw Error("vCard payload too long");
    return std::string(buf, (size_t)n);
}

bool vcardParse(const std::string& text, VcardFields& out) {
    prism_vcard v;
    if (!prism_vcard_parse(text.c_str(), &v)) return false;
    out.name = v.name; out.org = v.org; out.title = v.title; out.addr = v.addr; out.note = v.note;
    out.phones.assign(v.phones, v.phones + v.n_phones);
    out.emails.assign(v.emails, v.emails + v.n_emails);
    out.urls.assign(v.urls, v.urls + v.n_urls);
    return true;
}

std::string ticketPayload(int64_t expiryMs, const std::string& text) {
    char buf[4096];
    int n = prism_ticket_build(buf, sizeof buf, expiryMs, text.c_str());
    if (n < 0) throw Error("Ticket payload too long");
    return std::string(buf, (size_t)n);
}

bool ticketParse(const std::string& text, TicketFields& out) {
    prism_ticket t;
    if (!prism_ticket_parse(text.c_str(), &t)) return false;
    out.expiryMs = t.expiry_ms;
    out.body = t.body;
    return true;
}

CardType cardDetect(const std::string& text) {
    switch (prism_card_detect(text.c_str())) {
        case 1: return CardType::Ticket;
        case 2: return CardType::Wifi;
        case 3: return CardType::Vcard;
        default: return CardType::None;
    }
}

} // namespace prism
