/* Prism Code, Copyright (c) 2026 Avi Shor. Free to use, with or without credit.
 * C++ API over the C core of Prism tickets and cards.
 * Payload-compatible with prism-cards.js. */
#ifndef PRISM_CARDS_HPP
#define PRISM_CARDS_HPP

#include <cstdint>
#include <string>
#include <vector>

namespace prism {

struct WifiFields {
    std::string ssid, sec = "WPA", pass;
    bool hidden = false;
};
std::string wifiPayload(const WifiFields& f);
bool wifiParse(const std::string& text, WifiFields& out); // false = not a Wi-Fi card

struct VcardFields {
    std::string name, org, title, addr, note;
    std::vector<std::string> phones, emails, urls;
};
// Build takes single phone/email/url values like the site form.
std::string vcardPayload(const std::string& name, const std::string& org = "",
                         const std::string& title = "", const std::string& phone = "",
                         const std::string& email = "", const std::string& url = "",
                         const std::string& addr = "", const std::string& note = "");
bool vcardParse(const std::string& text, VcardFields& out); // false = not a vCard

struct TicketFields {
    int64_t expiryMs = 0;
    std::string body;
};
std::string ticketPayload(int64_t expiryMs, const std::string& text);
bool ticketParse(const std::string& text, TicketFields& out); // false = not a ticket

enum class CardType { None, Ticket, Wifi, Vcard };
CardType cardDetect(const std::string& text); // site order: ticket, wifi, vcard

} // namespace prism

#endif
