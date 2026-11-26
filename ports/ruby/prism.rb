#!/usr/bin/env ruby
# Prism Code - Ruby port of the live JavaScript encoder/decoder.
# Source of truth: prism.html (const Prism module) in
# https://github.com/avishorwork-wq/prism-code
#
# CLI only, Ruby 3.0+ with the zlib and json stdlibs. No gems.
#
# Format: pointy-top odd-row-offset hexagonal cells; 8-colour cyclic Gray
# coding (3 bits/cell) or 1-bit black/white. Six grids from 21x24 to
# 113x130 cells. Filled corner gap pattern, asymmetric ring, pilot cells,
# triplicated CRC-4 header, seeded cell shuffle, GF(256)/0x11D
# Reed-Solomon blocks, payload CRC-32.

require 'zlib'
require 'json'

S3 = 1.7320508075688772 # Math.sqrt(3), same f64 as the other ports

SIZES = [[21, 24], [29, 33], [41, 47], [57, 66], [81, 94], [113, 130]].freeze
PAL = [
  [0x1b, 0x1b, 0x1b], [0x2e, 0x5b, 0xff], [0x00, 0xb8, 0xd9],
  [0x2d, 0xb3, 0x5a], [0xf5, 0xc5, 0x18], [0xf7, 0x7f, 0x00],
  [0xd7, 0x26, 0x3d], [0xb5, 0x17, 0x9e], [0xff, 0xff, 0xff],
].freeze

# ---------------------------------------------------------------- rng / crc

# 32-bit unsigned multiply (mod 2^32), exact on Ruby integers.
def mul32(a, b)
  a &= 0xFFFFFFFF
  b &= 0xFFFFFFFF
  lo = (a & 0xFFFF) * (b & 0xFFFF)
  hi = ((a >> 16) & 0xFFFF) * (b & 0xFFFF) + (a & 0xFFFF) * ((b >> 16) & 0xFFFF)
  (lo + ((hi & 0xFFFF) << 16)) & 0xFFFFFFFF
end

class Rng
  def initialize(seed)
    @seed = seed & 0xFFFFFFFF
  end

  # Exact port of the JS mulberry-style rng (returns floats in [0,1)).
  def next
    @seed = (@seed + 0x6D2B79F5) & 0xFFFFFFFF
    t = mul32(@seed ^ (@seed >> 15), (1 | @seed) & 0xFFFFFFFF)
    t = ((t + mul32(t ^ (t >> 7), (61 | t) & 0xFFFFFFFF)) ^ t) & 0xFFFFFFFF
    ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
  end
end

def prism_crc32(data)
  Zlib.crc32(data) & 0xFFFFFFFF
end

def crc4(bits)
  r = 0
  bits.each do |b|
    f = ((r >> 3) & 1) ^ b
    r = (r << 1) & 15
    r ^= 3 if f != 0
  end
  r
end

def padk(o)
  x = mul32((o + 0x9E3779B9) & 0xFFFFFFFF, 0x85EBCA6B)
  x ^= x >> 13
  x = mul32(x, 0xC2B2AE35)
  x ^= x >> 16
  x & 255
end

# ---------------------------------------------------------------- GF(256)

def gf
  return @gf if @gf
  exp = Array.new(512, 0)
  log = Array.new(256, 0)
  z = 1
  255.times do |i|
    exp[i] = z
    log[z] = i
    z <<= 1
    z ^= 0x11D if (z & 256) != 0
  end
  (255...512).each { |i| exp[i] = exp[i - 255] }
  @gf = [exp, log]
end

def gmul(a, b)
  return 0 if a == 0 || b == 0
  e, l = gf
  e[l[a] + l[b]]
end

def gdiv(a, b)
  raise 'GF division by zero' if b == 0
  return 0 if a == 0
  e, l = gf
  e[(l[a] + 255 - l[b]) % 255]
end

def peval(p, x)
  y = 0
  (p.length - 1).downto(0) { |i| y = gmul(y, x) ^ p[i] }
  y
end

def pmul(a, b)
  o = Array.new(a.length + b.length - 1, 0)
  a.length.times do |i|
    next if a[i] == 0
    b.length.times { |j| o[i + j] ^= gmul(a[i], b[j]) }
  end
  o
end

def rs_encode(msg, nsym)
  g = [1]
  e, = gf
  nsym.times { |i| g = pmul(g, [1, e[i]]) }
  out = msg + Array.new(nsym, 0)
  msg.length.times do |i|
    c = out[i]
    next if c == 0
    (1...g.length).each { |j| out[i + j] ^= gmul(g[j], c) }
  end
  msg.length.times { |i| out[i] = msg[i] }
  out
end

def syndromes(r, n)
  e, = gf
  s = Array.new(n, 0)
  n.times do |j|
    y = 0
    x = e[j]
    r.each { |ri| y = gmul(y, x) ^ ri }
    s[j] = y
  end
  s
end

def bm(s)
  c = Array.new(s.length + 1, 0)
  b = Array.new(s.length + 1, 0)
  c[0] = 1
  b[0] = 1
  l = 0
  m = 1
  bb = 1
  s.length.times do |n|
    d = s[n]
    (1..l).each { |i| d ^= gmul(c[i], s[n - i]) }
    if d == 0
      m += 1
      next
    end
    t = c.dup
    v = gdiv(d, bb)
    (0...(c.length - m)).each { |i| c[i + m] ^= gmul(v, b[i]) }
    if 2 * l <= n
      l = n + 1 - l
      b = t
      bb = d
      m = 1
    else
      m += 1
    end
  end
  c[0, l + 1]
end

def rs_decode(data, nsym)
  e, = gf
  r = data.dup
  s = syndromes(r, nsym)
  return r if s.all?(&:zero?)
  loc = bm(s)
  raise 'RS correction limit' if 2 * (loc.length - 1) > nsym
  pos = []
  r.length.times do |p|
    ee = r.length - 1 - p
    pos << p if peval(loc, e[(255 - ee) % 255]) == 0
  end
  raise 'RS roots' if pos.length != loc.length - 1
  omega = pmul(s, loc)[0, nsym]
  der_len = [loc.length - 1, 1].max
  der = Array.new(der_len, 0)
  i = 1
  while i < loc.length
    der[i - 1] = loc[i]
    i += 2
  end
  pos.each do |p|
    ee = r.length - 1 - p
    x = e[ee]
    xi = e[(255 - ee) % 255]
    r[p] ^= gdiv(gmul(x, peval(omega, xi)), peval(der, xi))
  end
  raise 'RS syndrome check' unless syndromes(r, nsym).all?(&:zero?)
  r
end

# ---------------------------------------------------------------- layout

ROLE_DATA = 0
ROLE_GAP = 1
ROLE_RING = 2
ROLE_PILOT = 3
ROLE_HEADER = 4

def make_layout(size)
  c, r = SIZES[size]
  cells = []
  m_idx = []
  known = []
  r.times do |j|
    c.times do |i|
      role = ROLE_DATA
      symbol = -1
      pi = (i - 2) / 5 # Ruby integer division floors, matching the JS port
      pj = (j - 2) / 5
      if j <= 2 && i <= 2
        role = ROLE_GAP
        symbol = 8
      elsif j == 0 || j == r - 1 || i == 0 || i == c - 1
        role = ROLE_RING
        symbol = (j * 5 + i * 3) % 8
      elsif i % 5 == 2 && j % 5 == 2
        role = ROLE_PILOT
        symbol = (pi * 2 + pj * 3) % 9
      end
      idx = cells.length
      cells << {
        i: i, j: j,
        x: S3 * (i + 0.5 + 0.5 * (j & 1)),
        y: 1 + 1.5 * j,
        role: role, symbol: symbol, pi: pi, pj: pj,
        index: idx, header: -1,
      }
      if role == ROLE_DATA
        m_idx << idx
      elsif role != ROLE_GAP
        known << idx
      end
    end
  end
  headers = []
  72.times do |n|
    ci = m_idx[((n + 0.5) * m_idx.length / 72).to_i]
    cells[ci][:role] = ROLE_HEADER
    cells[ci][:header] = n
    headers << ci
  end
  data = []
  cells.each_with_index { |cell, i| data << i if cell[:role] == ROLE_DATA }
  rand = Rng.new(0x5EED ^ size)
  (data.length - 1).downto(1) do |i|
    jj = (rand.next * (i + 1)).to_i
    data[i], data[jj] = data[jj], data[i]
  end
  {
    size: size, c: c, r: r,
    w: S3 * (c + 0.5),
    h: 2 + 1.5 * (r - 1),
    cells: cells, headers: headers, data: data, known: known,
  }
end

# Centre-out data order used when a logo sits in the middle (logo=1).
def plcd(l)
  cx = l[:w] / 2
  cy = l[:h] / 2
  ent = []
  l[:data].each_with_index do |ci, k|
    c = l[:cells][ci]
    dx = c[:x] - cx
    dy = c[:y] - cy
    ent << [k, (Math.sqrt(dx * dx + dy * dy) / 3).to_i]
  end
  ent.sort_by { |e| [-e[1], e[0]] }.map { |e| l[:data][e[0]] }
end

# ---------------------------------------------------------------- capacity

def capacity(size, ecc, mode)
  l = make_layout(size)
  bpc = mode != 0 ? 1 : 3
  n = l[:data].length * bpc / 8
  nb = (n + 254) / 255
  pcts = [0.1, 0.2, 0.3, 0.4]
  blocks = []
  nb.times do |i|
    ln = n / nb + (i < n % nb ? 1 : 0)
    nsym = [4.0, 2.0 * (ln * pcts[ecc] / 2.0 + 0.5).floor].max.to_i
    blocks << { n: ln, nsym: nsym, k: ln - nsym }
  end
  k = blocks.sum { |b| b[:k] }
  { n: n, blocks: blocks, k: k, payload: [0, k - 4].max }
end

def push_bits(a, x, n)
  (n - 1).downto(0) { |k| a << ((x >> k) & 1) }
end

def header_bits(size, ecc, mode, typ, len)
  b = []
  push_bits(b, size, 3)
  push_bits(b, ecc, 2)
  push_bits(b, mode, 1)
  push_bits(b, typ, 1)
  push_bits(b, len, 13)
  c = crc4(b)
  push_bits(b, c, 4)
  b
end

def known_symbol(c, mode)
  if mode != 0
    return 0 if c[:role] == ROLE_RING
    return (c[:pi] + c[:pj]) % 2 == 0 ? 0 : 8
  end
  c[:symbol]
end

# ---------------------------------------------------------------- encode

def prism_encode(payload, size_in, ecc, mode, typ, logo)
  plen = payload.bytesize
  raise 'payload exceeds 8191 bytes' if plen > 8191
  size = size_in
  if size < 0
    size = -1
    SIZES.length.times do |i|
      if capacity(i, ecc, mode)[:k] >= plen + 4
        size = i
        break
      end
    end
    raise 'payload too large for this mode and ECC' if size < 0
  end
  cap = capacity(size, ecc, mode)
  raise "payload does not fit: maximum #{cap[:payload]} bytes" if cap[:k] < plen + 4
  msg = Array.new(cap[:k], 0)
  (plen + 4...cap[:k]).each { |i| msg[i] = padk(i) }
  plen.times { |i| msg[i] = payload.getbyte(i) }
  crc = prism_crc32(payload)
  4.times { |k| msg[plen + k] = (crc >> (24 - 8 * k)) & 255 }
  off = 0
  blocks = []
  cap[:blocks].each do |b|
    blocks << rs_encode(msg[off, b[:k]], b[:nsym])
    off += b[:k]
  end
  maxlen = blocks.map(&:length).max
  stream = []
  maxlen.times do |p|
    blocks.each do |b|
      push_bits(stream, b[p], 8) if p < b.length
    end
  end
  rand = Rng.new(0xBEEF)
  l = make_layout(size)
  symbols = Array.new(l[:cells].length, 8)
  l[:known].each { |ci| symbols[ci] = known_symbol(l[:cells][ci], mode) }
  hb = header_bits(size, ecc, mode, typ, plen)
  l[:headers].each do |ci|
    h = l[:cells][ci][:header]
    symbols[ci] = hb[h % 24] != 0 ? 0 : 8
  end
  l[:cells].each do |c|
    next unless c[:role] == ROLE_GAP
    symbols[c[:index]] = if mode != 0
                           (c[:i] + c[:j]) % 2 != 0 ? 0 : 8
                         else
                           (c[:j] * 5 + c[:i] * 3) % 8
                         end
  end
  at = 0
  order = logo != 0 ? plcd(l) : l[:data]
  order.each do |ci|
    if mode != 0
      bit = at < stream.length ? stream[at] : (rand.next > 0.5 ? 1 : 0)
      at += 1
      symbols[ci] = bit != 0 ? 0 : 8
    else
      b = 0
      3.times do
        bit = at < stream.length ? stream[at] : (rand.next > 0.5 ? 1 : 0)
        at += 1
        b = (b << 1) | bit
      end
      v = b
      v ^= v >> 1
      v ^= v >> 2
      symbols[ci] = v
    end
  end
  {
    size: size, ecc: ecc, mode: mode, typ: typ,
    bytes: payload, symbols: symbols, layout: l, order: order,
    cap_payload: cap[:payload],
  }
end

# ---------------------------------------------------------------- render / PNG

# Rows are binary strings (RGBA); fixed-length in-place span writes.
def fill_poly(rows, w, pts, rgb)
  unit = rgb.pack('C3') + "\xFF".b
  miny = pts.map { |p| p[1] }.min
  maxy = pts.map { |p| p[1] }.max
  y0 = [0, miny.floor].max
  y1 = [rows.length - 1, maxy.ceil].min
  return if y1 < y0
  (y0..y1).each do |y|
    yc = y + 0.5
    xs = []
    np = pts.length
    np.times do |k|
      x1, a = pts[k]
      x2, b = pts[(k + 1) % np]
      next unless (a <= yc && yc < b) || (b <= yc && yc < a)
      xs << x1 + (yc - a) / (b - a) * (x2 - x1)
    end
    xs.sort!
    k = 0
    while k + 1 < xs.length
      xa = [0, (xs[k] - 0.5).round].max
      xb = [w - 1, (xs[k + 1] - 0.5).round - 1].min
      if xb >= xa
        npix = xb - xa + 1
        rows[y][xa * 4, npix * 4] = unit * npix
      end
      k += 2
    end
  end
end

# Same geometry as Prism.render: hard-edged hexagons on white.
def prism_render(code, r)
  l = code[:layout]
  q = 3 * S3
  w = ((l[:w] + 2 * q) * r).ceil
  h = ((l[:h] + 2 * q) * r).ceil
  white_row = "\xFF".b * (w * 4)
  rows = Array.new(h) { white_row.dup }
  l[:cells].each do |c|
    s = code[:symbols][c[:index]]
    next if s == 8
    pts = []
    6.times do |k|
      a = (30 + 60 * k) * Math::PI / 180
      pts << [(c[:x] + q + 1.03 * Math.cos(a)) * r, (c[:y] + q + 1.03 * Math.sin(a)) * r]
    end
    fill_poly(rows, w, pts, PAL[s])
  end
  [w, h, rows]
end

def png_chunk(tag, data)
  [data.bytesize].pack('N') + tag + data + [prism_crc32(tag + data)].pack('N')
end

def write_png(w, h, rows)
  raw = rows.map { |row| "\0".b + row }.join
  idat = Zlib::Deflate.deflate(raw, 9)
  ihdr = [w, h].pack('N2') + "\x08\x06\x00\x00\x00".b
  "\x89PNG\r\n\x1a\n".b + png_chunk('IHDR', ihdr) + png_chunk('IDAT', idat) + png_chunk('IEND', ''.b)
end

def paeth(a, b, c)
  p = a + b - c
  pa = (p - a).abs
  pb = (p - b).abs
  pc = (p - c).abs
  pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
end

def inflate_any(packed)
  Zlib::Inflate.inflate(packed)
rescue Zlib::DataError
  # raw deflate fallback (some encoders write headerless streams)
  zi = Zlib::Inflate.new(-Zlib::MAX_WBITS)
  begin
    zi.inflate(packed)
  ensure
    zi.close
  end
end

def read_png(buf)
  raise 'not a png' if buf.bytesize < 8 || buf[0, 8] != "\x89PNG\r\n\x1a\n".b
  pos = 8
  ihdr = nil
  idats = []
  plte = nil
  n = buf.bytesize
  while pos + 12 <= n
    ln = buf[pos, 4].unpack1('N')
    tag = buf[pos + 4, 4]
    break if pos + 12 + ln > n
    data = buf[pos + 8, ln]
    case tag
    when 'IHDR' then ihdr = data
    when 'IDAT' then idats << data
    when 'PLTE' then plte = data
    when 'IEND' then break
    end
    pos += 12 + ln
  end
  raise 'no IHDR' if ihdr.nil?
  w = ihdr[0, 4].unpack1('N')
  h = ihdr[4, 4].unpack1('N')
  depth = ihdr.getbyte(8)
  ctype = ihdr.getbyte(9)
  raise "unsupported bit depth #{depth}" if depth != 8
  ch = { 0 => 1, 2 => 3, 3 => 1, 4 => 2, 6 => 4 }[ctype]
  raise "unsupported colour type #{ctype}" if ch.nil?
  raw = inflate_any(idats.join)
  stride = w * ch
  out = "\xFF".b * (w * h * 4) # alpha defaults to 255; RGB overwritten below
  prev = "\0".b * stride
  h.times do |y|
    f = raw.getbyte(y * (stride + 1))
    line = raw[y * (stride + 1) + 1, stride].dup
    if f != 0
      stride.times do |x|
        a = x >= ch ? line.getbyte(x - ch) : 0
        b = prev.getbyte(x)
        c = x >= ch ? prev.getbyte(x - ch) : 0
        v = case f
            when 1 then line.getbyte(x) + a
            when 2 then line.getbyte(x) + b
            when 3 then line.getbyte(x) + ((a + b) >> 1)
            when 4 then line.getbyte(x) + paeth(a, b, c)
            else raise "bad filter #{f}"
            end
        line.setbyte(x, v & 255)
      end
    end
    w.times do |x|
      o = (y * w + x) * 4
      case ctype
      when 6
        out[o, 4] = line[x * 4, 4]
      when 2
        out[o, 3] = line[x * 3, 3]
      when 0
        out[o] = line[x]
        out[o + 1] = line[x]
        out[o + 2] = line[x]
      when 4
        out[o] = line[x * 2]
        out[o + 1] = line[x * 2]
        out[o + 2] = line[x * 2]
        out[o + 3] = line[x * 2 + 1]
      else
        raise 'palette missing' if plte.nil?
        pi = line.getbyte(x) * 3
        out[o, 3] = plte[pi, 3]
      end
    end
    prev = line
  end
  [w, h, out]
end

# ---------------------------------------------------------------- decode (clean images)

def symbol_bits(sym, mode)
  return [sym == 0 ? 1 : 0] if mode != 0
  t = sym ^ (sym >> 1)
  [(t >> 2) & 1, (t >> 1) & 1, t & 1]
end

def nearest_symbol(r, g, b)
  best = 0
  bestd = 1 << 62
  PAL.each_with_index do |p, i|
    dr = r - p[0]
    dg = g - p[1]
    db = b - p[2]
    d = dr * dr + dg * dg + db * db
    if d < bestd
      bestd = d
      best = i
    end
  end
  best
end

def decode_symbols(symbols, l, order)
  hb = Array.new(24, 0)
  24.times do |n|
    votes = 0
    3.times do |rep|
      votes += 1 if symbols[l[:headers][n + 24 * rep]] == 0
    end
    hb[n] = votes >= 2 ? 1 : 0
  end
  at = 0
  rd = lambda do |n|
    v = 0
    n.times do
      v = (v << 1) | hb[at]
      at += 1
    end
    v
  end
  size = rd.call(3)
  ecc = rd.call(2)
  mode = rd.call(1)
  typ = rd.call(1)
  len = rd.call(13)
  hcrc = rd.call(4)
  if crc4(hb[0, 20]) != hcrc || size > 5 || size != l[:size]
    raise 'header checksum failed'
  end
  cap = capacity(size, ecc, mode)
  raise 'invalid length' if len > cap[:payload]
  cells_order = order.nil? ? l[:data] : order
  stream = []
  cells_order.each do |ci|
    symbol_bits(symbols[ci], mode).each { |bit| stream << bit }
  end
  nbytes = cap[:n]
  bts = Array.new(nbytes, 0)
  nbytes.times do |i|
    v = 0
    8.times { |k| v = (v << 1) | stream[8 * i + k] }
    bts[i] = v
  end
  blocks = cap[:blocks].map { |b| Array.new(b[:n], 0) }
  at2 = 0
  maxn = cap[:blocks].map { |b| b[:n] }.max
  maxn.times do |p|
    cap[:blocks].each_with_index do |b, bi|
      if p < b[:n]
        blocks[bi][p] = bts[at2]
        at2 += 1
      end
    end
  end
  msg = []
  cap[:blocks].each_with_index do |b, bi|
    dec = rs_decode(blocks[bi], b[:nsym])
    b[:k].times { |i| msg << dec[i] }
  end
  payload = msg[0, len].pack('C*')
  got = ((msg[len] << 24) | (msg[len + 1] << 16) | (msg[len + 2] << 8) | msg[len + 3]) & 0xFFFFFFFF
  raise 'payload CRC-32 failed' if prism_crc32(payload) != got
  [payload, { size: size, ecc: ecc, mode: mode, typ: typ, length: len }]
end

COLORED = /[\x00-\xf9]/n

# Decode a clean/perfect encoder image (any radius).
def decode_image(w, h, rgba)
  stride = w * 4
  # Bounding box of non-white content, C-speed row scans. Conservative by
  # one pixel on each side, which the sampler tolerates.
  xmin = w
  ymin = h
  xmax = -1
  ymax = -1
  h.times do |y|
    row = rgba[y * stride, stride]
    first = row.index(COLORED)
    next if first.nil?
    last = row.rindex(COLORED)
    fx = first / 4 - 1
    lx = last / 4 + 1
    xmin = fx if fx < xmin
    xmax = lx if lx > xmax
    ymin = y if y < ymin
    ymax = y if y > ymax
  end
  raise 'no code found' if xmax < 0
  hexhw = 1.03 * 0.8660254037844386
  hexhh = 1.03
  last_err = 'unknown'
  6.times do |size|
    l = make_layout(size)
    mincx = Float::INFINITY
    maxcx = -Float::INFINITY
    mincy = Float::INFINITY
    maxcy = -Float::INFINITY
    l[:known].each do |ci|
      c = l[:cells][ci]
      next unless c[:role] == ROLE_RING
      mincx = c[:x] if c[:x] < mincx
      maxcx = c[:x] if c[:x] > maxcx
      mincy = c[:y] if c[:y] < mincy
      maxcy = c[:y] if c[:y] > maxcy
    end
    mincx -= hexhw
    maxcx += hexhw
    mincy -= hexhh
    maxcy += hexhh
    rx = (xmax - xmin + 1) / (maxcx - mincx)
    ry = (ymax - ymin + 1) / (maxcy - mincy)
    next if (rx - ry).abs / [rx, ry].max > 0.05
    symbols = Array.new(l[:cells].length, 8)
    l[:cells].each do |c|
      px = xmin + (c[:x] - mincx) * rx
      py = ymin + (c[:y] - mincy) * ry
      sr = 0
      sg = 0
      sb = 0
      n = 0
      (-1..1).each do |dy|
        (-1..1).each do |dx|
          xx = [[0, (px + dx * rx * 0.15).to_i].max, w - 1].min
          yy = [[0, (py + dy * ry * 0.15).to_i].max, h - 1].min
          o = (yy * w + xx) * 4
          sr += rgba.getbyte(o)
          sg += rgba.getbyte(o + 1)
          sb += rgba.getbyte(o + 2)
          n += 1
        end
      end
      symbols[c[:index]] = nearest_symbol(sr / n, sg / n, sb / n)
    end
    begin
      return decode_symbols(symbols, l, nil)
    rescue StandardError
      begin
        return decode_symbols(symbols, l, plcd(l))
      rescue StandardError => e2
        last_err = e2.message
      end
    end
  end
  raise "decode failed: #{last_err}"
end

def decode_png(buf)
  w, h, rgba = read_png(buf)
  decode_image(w, h, rgba)
end

# ---------------------------------------------------------------- CLI

def arg_opt(a, name, dflt)
  (0...(a.length - 1)).each do |i|
    return a[i + 1] if a[i] == "--#{name}" || a[i] == "-#{name}"
  end
  dflt
end

def mode_name(m)
  m == 0 ? 'color' : 'bw'
end

def fail(msg)
  warn "error: #{msg}"
  exit 1
end

def usage
  warn "usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]"
  warn "       prism decode I.png [--out O]"
  warn "       prism capacity"
  exit 2
end

def cli_main(argv)
  usage if argv.empty?
  case argv[0]
  when 'encode'
    text = arg_opt(argv, 'text', nil)
    input = arg_opt(argv, 'input', nil)
    fail 'need --text or --input' if text.nil? && input.nil?
    payload = text ? text.b : File.binread(input)
    size = arg_opt(argv, 'size', '-1').to_i
    ecc = arg_opt(argv, 'ecc', '1').to_i
    mode_s = arg_opt(argv, 'mode', '0')
    mode = (mode_s == '1' || mode_s == 'bw') ? 1 : 0
    radius = arg_opt(argv, 'radius', '12').to_i
    typ = arg_opt(argv, 'type', '0').to_i
    logo = arg_opt(argv, 'logo', '0').to_i
    out = arg_opt(argv, 'out', nil)
    fail 'need --out' if out.nil?
    begin
      code = prism_encode(payload, size, ecc, mode, typ, logo)
    rescue StandardError => e
      fail e.message
    end
    w, h, rows = prism_render(code, radius)
    File.binwrite(out, write_png(w, h, rows))
    sj = arg_opt(argv, 'symbols', nil)
    if sj
      File.write(sj, JSON.generate({
        size: code[:size], ecc: code[:ecc], mode: code[:mode],
        C: code[:layout][:c], R: code[:layout][:r],
        symbols: code[:symbols],
      }))
    end
    lay = code[:layout]
    puts "wrote #{out} (#{w}x#{h} px, grid #{lay[:c]}x#{lay[:r]} cells, size #{code[:size]}, #{mode_name(mode)}, ecc #{ecc}, #{payload.bytesize} payload bytes)"
    puts "capacity at these settings: #{code[:cap_payload]} payload bytes"
  when 'decode'
    fail 'need png path' if argv.length < 2
    begin
      buf = File.binread(argv[1])
    rescue SystemCallError
      fail "cannot read #{argv[1]}"
    end
    begin
      payload, hdr = decode_png(buf)
    rescue StandardError => e
      fail e.message
    end
    out = arg_opt(argv, 'out', nil)
    if out
      File.binwrite(out, payload)
      puts "wrote #{out} (#{payload.bytesize} bytes)"
    else
      $stdout.write(payload)
      $stdout.write("\n") if payload.bytesize > 0
    end
    warn "header: size #{hdr[:size]}, ecc #{hdr[:ecc]}, mode #{mode_name(hdr[:mode])}, type #{hdr[:typ]}, #{hdr[:length]} payload bytes, CRC-32 OK"
  when 'capacity'
    6.times do |s|
      4.times do |ecc|
        2.times do |mode|
          cap = capacity(s, ecc, mode)
          puts "size #{s} (#{SIZES[s][0]}x#{SIZES[s][1]}) ecc #{ecc} #{mode_name(mode)}: #{cap[:payload]} payload bytes"
        end
      end
    end
  else
    fail "unknown command #{argv[0]}"
  end
end

cli_main(ARGV)
