# Prism Secure (envelope v2, reads v1) for the Ruby port: AES-256-GCM payload
# locking with Argon2id (128 MiB, 3 passes, via the system libargon2 through
# fiddle, with PBKDF2-SHA256 600,000 rounds as the other KDF), and ECDSA
# P-256 / SHA-256 signing with RFC 6979 deterministic nonces and P1363 r||s
# signatures, byte-compatible with the live site's prism-secure.html JS and
# the C/Go/Kotlin/Rust/PHP ports.
#
# Passwords are used as their UTF-8 bytes. The website applies Unicode NFKC
# normalization first; this port does not ship a Unicode normalizer, so
# non-ASCII passwords should already be in composed (NFC) form. ASCII
# passwords are unaffected.

require 'openssl'
require 'digest'
require 'fiddle'
require 'fiddle/import'
require 'securerandom'
require 'json'
require 'base64'

module PrismSecure
  ARGON2_MEM = 131_072
  ARGON2_T = 3
  ARGON2_P = 1
  PBKDF2_ITER = 600_000

  FLAG_ENC = 1
  FLAG_SIG = 2
  HEAD2 = 4 + 1 + 1 + 6 + 16 + 12
  HEAD1 = 4 + 1 + 16 + 12 + 4
  MAGIC = "PSC".b

  module Argon2Lib
    extend Fiddle::Importer
    begin
      begin
        dlload 'libargon2.so.1'
      rescue Fiddle::DLError
        dlload 'libargon2.so'
      end
      extern 'int argon2id_hash_raw(unsigned int, unsigned int, unsigned int, const void*, size_t, const void*, size_t, void*, size_t)'
      AVAILABLE = true
    rescue Fiddle::DLError
      AVAILABLE = false
    end
  end

  def self.argon2_available?
    Argon2Lib::AVAILABLE
  end

  def self.sha256(d)
    Digest::SHA256.digest(d)
  end

  def self.pbkdf2(pw, salt, iter, key_len)
    OpenSSL::PKCS5.pbkdf2_hmac(pw, salt, iter, key_len, 'sha256')
  end

  def self.argon2id(pw, salt, mem_kib, t, lanes, key_len)
    if mem_kib < 8192 || mem_kib > 262_144 || t < 1 || t > 12 || lanes < 1 || lanes > 4
      raise 'argon2id parameters out of range'
    end
    unless Argon2Lib::AVAILABLE
      raise 'no libargon2 on this system; use --kdf pbkdf2'
    end
    out = "\0".b * key_len
    rc = Argon2Lib.argon2id_hash_raw(t, mem_kib, lanes, pw, pw.bytesize, salt, salt.bytesize, out, key_len)
    raise "argon2id failed (rc=#{rc})" unless rc.zero?
    out
  end

  def self.aes_encrypt(key, iv, aad, pt)
    c = OpenSSL::Cipher.new('aes-256-gcm')
    c.encrypt
    c.key = key
    c.iv = iv
    c.auth_data = aad
    ct = c.update(pt) + c.final
    [ct, c.auth_tag]
  end

  def self.aes_decrypt(key, iv, aad, ct, tag)
    c = OpenSSL::Cipher.new('aes-256-gcm')
    c.decrypt
    c.key = key
    c.iv = iv
    c.auth_tag = tag
    c.auth_data = aad
    c.update(ct) + c.final
  rescue OpenSSL::Cipher::CipherError
    nil
  end

  # ------------------------------------------------------------- P-256 / RFC 6979

  P = OpenSSL::BN.new('FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF', 16).freeze
  N = OpenSSL::BN.new('FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551', 16).freeze
  A = (P - 3).freeze
  B = OpenSSL::BN.new('5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B', 16).freeze
  GX = OpenSSL::BN.new('6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296', 16).freeze
  GY = OpenSSL::BN.new('4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5', 16).freeze

  # modp reduces into [0, P): OpenSSL::BN#% keeps the dividend's sign and
  # mod_inverse of a negative operand is garbage, so every subtraction must
  # be normalized before use.
  def self.modp(x)
    x %= P
    x += P if x.negative?
    x
  end

  def self.pt_add(p, q)
    return q if p.nil?
    return p if q.nil?
    px, py = p
    qx, qy = q
    if px == qx
      return nil if py != qy
      return nil if py.zero?
      m = modp(modp(px * px * 3 + A) * modp(py * 2).mod_inverse(P))
      x = modp(m * m - px * 2)
      y = modp(m * modp(px - x) - py)
      return [x, y]
    end
    m = modp(modp(qy - py) * modp(qx - px).mod_inverse(P))
    x = modp(m * m - px - qx)
    y = modp(m * modp(px - x) - py)
    [x, y]
  end

  def self.pt_mul(k, p)
    r = nil
    while !k.zero?
      r = pt_add(r, p) if k.odd?
      p = pt_add(p, p)
      k >>= 1
    end
    r
  end

  def self.on_curve?(pt)
    l = modp(pt[1] * pt[1])
    r = modp((pt[0] * pt[0] + A) * pt[0] + B)
    l == r
  end

  def self.bn_from(b)
    OpenSSL::BN.new(b.unpack1('H*'), 16)
  end

  # rfc6979_k derives the deterministic nonce exactly like the C reference:
  # HMAC-DRBG over priv||hash (raw hash bytes, not reduced).
  def self.rfc6979_k(priv, hash)
    v = "\x01".b * 32
    k = "\x00".b * 32
    bx = priv + hash
    k = OpenSSL::HMAC.digest('sha256', k, v + "\x00".b + bx)
    v = OpenSSL::HMAC.digest('sha256', k, v)
    k = OpenSSL::HMAC.digest('sha256', k, v + "\x01".b + bx)
    v = OpenSSL::HMAC.digest('sha256', k, v)
    loop do
      v = OpenSSL::HMAC.digest('sha256', k, v)
      kk = bn_from(v)
      return kk if !kk.zero? && kk < N
      k = OpenSSL::HMAC.digest('sha256', k, v + "\x00".b)
      v = OpenSSL::HMAC.digest('sha256', k, v)
    end
  end

  def self.pad32(x)
    x.to_s(2).rjust(32, "\x00".b)[-32, 32]
  end

  # p256_sign produces a deterministic P1363 r||s signature, low-s normalized.
  def self.p256_sign(priv, msg)
    half = N >> 1
    hash = sha256(msg)
    d = bn_from(priv)
    e = bn_from(hash)
    e -= N if e >= N
    loop do
      k = rfc6979_k(priv, hash)
      pt = pt_mul(k, [GX, GY])
      next if pt.nil?
      r = pt[0] % N
      next if r.zero?
      kinv = k.mod_inverse(N)
      s = (kinv * (e + d * r)) % N
      next if s.zero?
      s = N - s if s > half
      return pad32(r) + pad32(s)
    end
  end

  def self.p256_verify(pub, msg, sig)
    return false if pub.bytesize != 65 || pub.getbyte(0) != 4 || sig.bytesize != 64
    q = [bn_from(pub[1, 32]), bn_from(pub[33, 32])]
    return false unless on_curve?(q)
    hash = sha256(msg)
    e = bn_from(hash)
    e -= N if e >= N
    r = bn_from(sig[0, 32])
    s = bn_from(sig[32, 32])
    return false if r.zero? || r >= N || s.zero? || s >= N
    w = s.mod_inverse(N)
    u1 = (e * w) % N
    u2 = (r * w) % N
    pt = pt_add(pt_mul(u1, [GX, GY]), pt_mul(u2, q))
    return false if pt.nil?
    pt[0] % N == r
  rescue OpenSSL::BNError
    false
  end

  def self.p256_keygen(priv)
    pt = pt_mul(bn_from(priv), [GX, GY])
    "\x04".b + pad32(pt[0]) + pad32(pt[1])
  end

  # ------------------------------------------------------------- secure envelope

  # fingerprint returns "XXXX-XXXX-XXXX-XXXX" for a 65-byte public key.
  def self.fingerprint(pub)
    h = sha256(pub)
    s = +''
    8.times do |i|
      s << h.getbyte(i).to_s(16).rjust(2, '0').upcase
      s << '-' if i.odd? && i < 7
    end
    s
  end

  def self.genkey
    loop do
      priv = SecureRandom.random_bytes(32)
      return [priv, p256_keygen(priv)] if priv.delete("\x00").bytesize > 0
    end
  end

  def self.derive_key(password, salt, kdf, iter, mem, t, lanes)
    if kdf == 2
      argon2id(password, salt, mem, t, lanes, 32)
    else
      pbkdf2(password, salt, iter, 32)
    end
  end

  # seal locks (password non-empty, kdf 'argon2id'|'pbkdf2') and/or signs
  # (priv present) data. At least one of the two.
  def self.seal(data, password, kdf, priv, pub)
    raise 'need a password, a signing key, or both' if password.empty? && priv.nil?
    use_a = kdf.empty? || kdf == 'argon2id'
    flags = 0
    flags |= FLAG_ENC unless password.empty?
    flags |= FLAG_SIG unless priv.nil?
    unless password.empty?
      salt = SecureRandom.random_bytes(16)
      iv = SecureRandom.random_bytes(12)
      h = MAGIC + "\x02".b + flags.chr.b
      if use_a
        h += "\x02".b + [ARGON2_MEM].pack('N') + ARGON2_T.chr.b + ARGON2_P.chr.b
      else
        h += "\x01".b + [PBKDF2_ITER].pack('N') + "\x00\x00".b
      end
      h += salt + iv
      key = derive_key(password, salt, use_a ? 2 : 1, PBKDF2_ITER, ARGON2_MEM, ARGON2_T, ARGON2_P)
      ct, tag = aes_encrypt(key, iv, h, data)
      body = h + ct + tag
    else
      body = MAGIC + "\x02".b + flags.chr.b + data
    end
    return body if priv.nil?
    body + pub + p256_sign(priv, body)
  end

  def self.secure?(b)
    b.bytesize >= 6 && b[0, 3] == MAGIC && (b.getbyte(3) == 1 || b.getbyte(3) == 2) && (b.getbyte(4) & ~3).zero?
  end

  # open returns a result hash; never returns a wrong payload.
  def self.open(b, password, trusted_fps = nil)
    res = {
      secure: false, version: 0, encrypted: false, signed: false,
      signature_valid: -1, fingerprint: '', trusted: false,
      bytes: nil, needs_password: false, error: nil,
    }
    unless secure?(b)
      res[:bytes] = b
      return res
    end
    len = b.bytesize
    ver = b.getbyte(3)
    flags = b.getbyte(4)
    encrypted = (flags & FLAG_ENC) != 0
    sgn = (flags & FLAG_SIG) != 0
    res[:secure] = true
    res[:version] = ver
    res[:encrypted] = encrypted
    res[:signed] = sgn
    finish = len
    if sgn
      if len < 5 + 65 + 64
        res[:error] = 'Code is damaged'
        return res
      end
      pub = b[finish - 129, 65]
      sig = b[finish - 64, 64]
      res[:signature_valid] = p256_verify(pub, b[0, finish - 129], sig) ? 1 : 0
      res[:fingerprint] = fingerprint(pub)
      if res[:signature_valid] == 1 && trusted_fps
        res[:trusted] = true if trusted_fps.include?(res[:fingerprint])
      end
      finish -= 129
      if res[:signature_valid] != 1
        res[:error] = 'Signature is not valid. This code was changed or forged.'
        return res
      end
    end
    unless encrypted
      res[:bytes] = b[5, finish - 5] || ''.b
      return res
    end
    if ver == 1
      hl = HEAD1
      if finish < hl + 16
        res[:error] = 'Code is damaged'
        return res
      end
      salt = b[5, 16]
      iv = b[21, 12]
      kdf = 1
      iter = b[33, 4].unpack1('N')
      mem = 0
      t = 0
      lanes = 0
    else
      hl = HEAD2
      if finish < hl + 16
        res[:error] = 'Code is damaged'
        return res
      end
      kdf = b.getbyte(5)
      salt = b[12, 16]
      iv = b[28, 12]
      if kdf == 2
        mem = b[6, 4].unpack1('N')
        t = b.getbyte(10)
        lanes = b.getbyte(11)
        iter = 0
      else
        iter = b[6, 4].unpack1('N')
        mem = 0
        t = 0
        lanes = 0
      end
    end
    if (kdf == 1 && (iter < 100_000 || iter > 5_000_000)) ||
       (kdf == 2 && (mem < 8192 || mem > 262_144 || t < 1 || t > 12 || lanes < 1 || lanes > 4)) ||
       (kdf != 1 && kdf != 2)
      res[:error] = 'Code is damaged or unsupported'
      return res
    end
    if password.empty?
      res[:needs_password] = true
      return res
    end
    begin
      key = derive_key(password, salt, kdf, iter, mem, t, lanes)
    rescue StandardError
      res[:error] = 'Key derivation failed'
      return res
    end
    pt = aes_decrypt(key, iv, b[0, hl], b[hl, finish - hl - 16], b[finish - 16, 16])
    if pt.nil?
      res[:error] = 'Wrong password, or the code was changed.'
    else
      res[:bytes] = pt
    end
    res
  end

  # generate_passphrase: 7 groups of 4 from a 32-symbol alphabet (140 bits).
  def self.passphrase
    alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    r = SecureRandom.random_bytes(28)
    s = +''
    7.times do |g|
      s << '-' if g > 0
      4.times { |i| s << alpha[r.getbyte(g * 4 + i) & 31] }
    end
    s
  end

  # strength estimates password strength; same heuristic as the site.
  # Returns [bits, level 0-4, label].
  def self.strength(pw)
    labels = %w[weak weak fair good strong]
    pb = pw.bytes
    n = pb.length
    return [0, 0, 'none'] if n.zero?
    # generated-passphrase shape
    groups = 1
    okk = true
    body = 0
    pb.each do |c|
      if c == 0x2d
        groups += 1
        next
      end
      is_up = c >= 65 && c <= 90 && c != 73 && c != 79
      is_dig = c >= 50 && c <= 57
      unless is_up || is_dig
        okk = false
        break
      end
      body += 1
    end
    return [body * 5, 4, 'excellent (random)'] if groups >= 6 && okk && body >= 24
    lo = up = dig = sym = false
    pb.each do |c|
      case c
      when 97..122 then lo = true
      when 65..90 then up = true
      when 48..57 then dig = true
      else sym = true
      end
    end
    pool = 0
    pool += 26 if lo
    pool += 26 if up
    pool += 10 if dig
    pool += 33 if sym
    pool = 2 if pool < 2
    lp = 0.0
    p = pool
    while p > 1
      lp += 1.0
      p >>= 1
    end
    base = 1 << lp.to_i
    lp += (pool - base).to_f / base
    uniq = 0
    n.times do |i|
      seen = false
      i.times { |j| seen = true if pb[j] == pb[i] }
      uniq += 1 unless seen
    end
    cap_n = n
    cap_n = uniq * 2 if uniq * 2 < n
    bits = cap_n * lp
    (0...(n - 2)).each do |i|
      if pb[i] == pb[i + 1] && pb[i] == pb[i + 2]
        bits *= 0.7
        break
      end
    end
    seqs = %w[012 123 234 345 456 567 678 789 abc bcd cde def qwe wer asd sdf zxc]
    seqs.each do |sq|
      hit = false
      sb = sq.bytes
      (0...(n - 2)).each do |i|
        if pb[i] | 32 == sb[0] && pb[i + 1] | 32 == sb[1] && pb[i + 2] | 32 == sb[2]
          bits *= 0.7
          hit = true
          break
        end
      end
      break if hit
    end
    bits *= 0.8 if (lo && !up && !dig && !sym) || (dig && !lo && !up && !sym)
    (0...(n - 3)).each do |i|
      if (pb[i] == 49 && pb[i + 1] == 57) || (pb[i] == 50 && pb[i + 1] == 48)
        if pb[i + 2] >= 48 && pb[i + 2] <= 57 && pb[i + 3] >= 48 && pb[i + 3] <= 57
          bits -= 8.0
          break
        end
      end
    end
    common = %w[password passw0rd qwerty letmein welcome admin iloveyou monkey dragon
                football baseball shalom israel master login abc123 prism secret hello
                test summer winter sunshine princess trustno1 whatever google avi 1234
                asdf zxcv love god cohen levi]
    low = pw.downcase
    common.each do |w|
      if low.include?(w)
        bits = 28.0 if bits > 28.0
        bits -= 8.0 if low == w
        break
      end
    end
    ibits = bits.to_i
    ibits = 0 if ibits < 0
    level = ibits < 40 ? 0 : ibits < 60 ? 1 : ibits < 80 ? 2 : ibits < 100 ? 3 : 4
    [ibits, level, labels[level]]
  end

  # ------------------------------------------------------------- key file

  def self.b64url(b)
    [b].pack('m0').tr('+/', '-_').delete('=')
  end

  def self.b64url_dec(s)
    Base64.urlsafe_decode64(s)
  end

  def self.save_key(path, priv, pub)
    json = '{"publicKeyHex":"' + pub.unpack1('H*') + '","privateJwk":{"crv":"P-256","d":"' +
           b64url(priv) + '","kty":"EC","x":"' + b64url(pub[1, 32]) +
           '","y":"' + b64url(pub[33, 32]) + '"}}'
    File.binwrite(path, json)
    File.chmod(0o600, path)
  end

  def self.load_key(path)
    data = File.binread(path)
    kf = JSON.parse(data)
    pub = [kf['publicKeyHex']].pack('H*')
    raise 'bad public key' if pub.bytesize != 65
    priv = b64url_dec(kf.dig('privateJwk', 'd').to_s)
    raise 'bad private key' if priv.bytesize != 32
    [priv, pub]
  rescue StandardError => e
    raise "bad key file #{path}: #{e.message}"
  end
end
