# Prism verified issuers for the Ruby port: identify signed Prism Secure
# payloads and look the signer up in an issuer list, same semantics as
# prism-issuers.js and the C/Go/Kotlin/Rust/PHP ports.

require 'json'
require_relative 'prism_secure'

module PrismIssuers
  # identify inspects decoded payload bytes. Returns nil for plain or
  # unsigned payloads. Never decrypts.
  def self.identify(b)
    return nil if b.bytesize < 5 + 65 + 64
    return nil unless b[0] == 'P' && b[1] == 'S' && b[2] == 'C'
    v = b.getbyte(3)
    return nil unless v == 1 || v == 2
    return nil if b.getbyte(4) & 2 == 0
    finish = b.bytesize
    pub = b[finish - 129, 65]
    sig = b[finish - 64, 64]
    body = b[0, finish - 129]
    out = {
      signature_valid: PrismSecure.p256_verify(pub, body, sig),
      fingerprint: PrismSecure.fingerprint(pub),
      encrypted: b.getbyte(4) & 1 != 0,
      message: '',
      has_message: false,
    }
    if out[:signature_valid] && !out[:encrypted] && body.bytesize >= 5
      m = body[5..]
      if m.force_encoding(Encoding::UTF_8).valid_encoding?
        out[:message] = m
        out[:has_message] = true
      end
    end
    out
  end

  # load reads an issuers.json file ({"issuers":[{name, fingerprint}]}).
  def self.load(path)
    data = File.binread(path)
    return [] if data.bytesize > 1 << 20
    doc = JSON.parse(data)
    return [] unless doc.is_a?(Hash) && doc['issuers'].is_a?(Array)
    doc['issuers'].filter_map do |it|
      next unless it.is_a?(Hash) && it['name'] && it['fingerprint']
      { name: it['name'].to_s, fingerprint: it['fingerprint'].to_s }
    end
  rescue StandardError
    []
  end

  def self.norm_fp(fp)
    b = +''
    fp.each_char do |c|
      break if b.length >= 15
      b << c.upcase if c =~ /[0-9a-fA-F]/
    end
    b
  end

  # find_index: normalized fingerprint match (case-insensitive, separators ignored).
  def self.find_index(list, fingerprint)
    want = norm_fp(fingerprint)
    list.each_with_index do |it, i|
      return i if norm_fp(it[:fingerprint]) == want
    end
    -1
  end
end
