# Prism tickets and cards for the Ruby port: Wi-Fi, contact card (vCard 3.0)
# and expiring ticket payload builders and parsers, payload-compatible with
# prism-cards.js and the C/Go/Kotlin/Rust/PHP ports.

module PrismCards
  WIFI_ESC = /([\\;,:,"'])/

  def self.esc_wifi(s)
    s.gsub(WIFI_ESC) { '\\' + Regexp.last_match(1) }
  end

  # wifi_build builds the common WIFI: payload other readers agree on.
  def self.wifi_build(ssid, sec, pass, hidden)
    t = sec.empty? ? 'WPA' : sec
    b = "WIFI:T:#{t};S:#{esc_wifi(ssid)};"
    b += "P:#{esc_wifi(pass)};" if t != 'nopass'
    b += 'H:true;' if hidden
    b + ';'
  end

  # wifi_parse returns {ssid:, sec:, pass:, hidden:} or nil.
  def self.wifi_parse(text)
    return nil if text.bytesize < 5 || text[0, 5].upcase != 'WIFI:'
    body = text[5..]
    n = body.bytesize
    out = { ssid: '', sec: '', pass: '', hidden: false }
    key = +''
    val = +''
    in_key = true
    have_ssid = false
    flush = lambda do
      unless key.empty?
        k = key.upcase
        case k
        when 'S' then out[:ssid] = val; have_ssid = true
        when 'T' then out[:sec] = val.upcase
        when 'P' then out[:pass] = val
        when 'H' then out[:hidden] = val.casecmp('true').zero?
        end
      end
    end
    i = 0
    loop do
      c = i < n ? body[i] : nil
      do_flush = false
      if i >= n
        do_flush = true
      elsif c == '\\' && i + 1 < n
        if in_key then key << body[i + 1]
        else val << body[i + 1]
        end
        i += 2
        next
      elsif in_key && c == ':'
        in_key = false
        i += 1
        next
      elsif !in_key && c == ';'
        do_flush = true
      elsif in_key
        key << c
        i += 1
        next
      else
        val << c
        i += 1
        next
      end
      if do_flush
        flush.call
        break if i >= n
        key = +''
        val = +''
        in_key = true
        i += 1
      end
    end
    return nil unless have_ssid
    out[:sec] = 'WPA' if out[:sec].empty?
    out
  end

  # ------------------------------------------------------------- vCard

  def self.esc_vcard(s)
    out = +''
    s.each_char do |c|
      out << '\\' if c == '\\' || c == ',' || c == ';'
      if c == "\n"
        out << '\\n'
        next
      end
      out << c
    end
    out
  end

  # vcard_build builds a vCard 3.0 payload. Any field may be empty.
  def self.vcard_build(name, org, title, phone, email, url, addr, note)
    b = "BEGIN:VCARD\r\nVERSION:3.0\r\n"
    b += "FN:#{esc_vcard(name)}\r\n"
    unless name.empty?
      words = name.strip.split(/\s+/)
      first = words[0] || ''
      rest = words.length > 1 ? words[1..].join(' ') : '-'
      b += "N:#{esc_vcard(rest)};#{esc_vcard(first)};;;\r\n"
    end
    b += "ORG:#{esc_vcard(org)}\r\n" unless org.empty?
    b += "TITLE:#{esc_vcard(title)}\r\n" unless title.empty?
    b += "TEL;TYPE=CELL:#{esc_vcard(phone)}\r\n" unless phone.empty?
    b += "EMAIL:#{esc_vcard(email)}\r\n" unless email.empty?
    b += "URL:#{esc_vcard(url)}\r\n" unless url.empty?
    b += "ADR;TYPE=WORK:;;#{esc_vcard(addr)};;;;\r\n" unless addr.empty?
    b += "NOTE:#{esc_vcard(note)}\r\n" unless note.empty?
    b + 'END:VCARD'
  end

  def self.key_matches(line, key)
    return nil if line.length < key.length || line[0, key.length].downcase != key.downcase
    p = line[key.length..]
    if p.start_with?(';')
      idx = p.index(':')
      return nil if idx.nil?
      p = p[idx..]
    end
    return nil unless p.start_with?(':')
    p[1..]
  end

  def self.unesc_vcard(s)
    out = +''
    i = 0
    while i < s.length
      if s[i] == '\\' && i + 1 < s.length
        c = s[i + 1]
        if c == 'n' || c == 'N'
          out << "\n"
          i += 2
          next
        end
        if c == ',' || c == ';' || c == '\\'
          out << c
          i += 2
          next
        end
      end
      out << s[i]
      i += 1
    end
    out
  end

  # vcard_parse returns {name:, org:, title:, addr:, note:, phones:, emails:, urls:} or nil.
  def self.vcard_parse(text)
    return nil unless text.include?('BEGIN:VCARD')
    # unfold continuation lines, drop \r, split on \n
    flat = +''
    i = 0
    while i < text.length
      c = text[i]
      if c == "\r"
        i += 1
        next
      end
      if c == "\n" && i + 1 < text.length && (text[i + 1] == ' ' || text[i + 1] == "\t")
        i += 1
        next
      end
      flat << c
      i += 1
    end
    out = { name: '', org: '', title: '', addr: '', note: '', phones: [], emails: [], urls: [] }
    found_fn = false
    flat.split("\n").each do |line|
      if (v = key_matches(line, 'FN'))
        out[:name] = unesc_vcard(v)
        found_fn = true
      elsif (v = key_matches(line, 'ORG'))
        out[:org] = unesc_vcard(v)
      elsif (v = key_matches(line, 'TITLE'))
        out[:title] = unesc_vcard(v)
      elsif (v = key_matches(line, 'NOTE'))
        out[:note] = unesc_vcard(v)
      elsif (v = key_matches(line, 'ADR'))
        out[:addr] = unesc_vcard(v).sub(/\A;+/, '').sub(/;+\z/, '')
      elsif (v = key_matches(line, 'EMAIL'))
        out[:emails] << unesc_vcard(v) if out[:emails].length < 8
      elsif (v = key_matches(line, 'TEL'))
        out[:phones] << unesc_vcard(v) if out[:phones].length < 8
      elsif (v = key_matches(line, 'URL'))
        out[:urls] << unesc_vcard(v) if out[:urls].length < 8
      end
    end
    return nil unless found_fn
    out
  end

  # ------------------------------------------------------------- ticket

  # ticket_build builds "PRISM-TICKET/1\nEXP:<unix seconds>\n<text>".
  def self.ticket_build(expiry_ms, text)
    "PRISM-TICKET/1\nEXP:#{expiry_ms / 1000}\n#{text.strip}"
  end

  # ticket_parse returns {expiry_ms:, body:} or nil.
  def self.ticket_parse(text)
    prefix = "PRISM-TICKET/1\nEXP:"
    return nil unless text.start_with?(prefix)
    p = text[prefix.length..]
    return nil if p.empty? || p[0] !~ /\d/
    exp = 0
    i = 0
    while i < p.length && p[i] =~ /\d/
      exp = exp * 10 + p[i].to_i
      i += 1
    end
    return nil if i >= p.length || p[i] != "\n"
    { expiry_ms: exp * 1000, body: p[(i + 1)..].rstrip }
  end

  # detect: 1 ticket, 2 wifi, 3 vcard, 0 none (site order).
  def self.detect(text)
    return 0 if text.empty?
    return 1 if ticket_parse(text)
    return 2 if wifi_parse(text)
    return 3 if vcard_parse(text)
    0
  end
end
