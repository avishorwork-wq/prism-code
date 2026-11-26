# Prism big files in parts (PPT1) for the Ruby port, byte-compatible with
# prism-parts.js and the C/Go/Kotlin/Rust/PHP ports.
#
# Part layout (bytes): "PPT1" | file id (4) | part number (2, BE, from 1) |
# total parts (2, BE) | whole length (4, BE) | whole CRC-32 (4, BE) |
# name length (1) | name (UTF-8) | chunk | part CRC-32 (4, BE, over every
# byte before it). Parts are encoded at ecc level 2 (30%) in color mode.

require 'securerandom'

module PrismParts
  PARTS_ECC = 2

  NOT_PART = 0
  BAD = 1
  OTHER = 2
  DUPLICATE = 3
  NEW = 4
  COMPLETE = 5

  def self.overhead(name_len)
    4 + 4 + 2 + 2 + 4 + 4 + 1 + name_len + 4
  end

  # clean_name: backslash, slash and control bytes become '_', trimmed to 200 bytes.
  def self.clean_name(name)
    src = name.empty? ? 'file' : name
    out = +''.b
    src.bytes.each do |c|
      break if out.bytesize >= 200
      out << (c == 0x5C || c == 0x2F || c < 0x20 ? '_' : c.chr.b)
    end
    out
  end

  # name_bytes: UTF-8, trimmed to <= 40 bytes without splitting a character.
  def self.name_bytes(name)
    clean = clean_name(name)
    n = clean.bytesize
    if n > 40
      n = 40
      n -= 1 while n > 0 && (clean.getbyte(n) & 0xC0) == 0x80 # back off to a lead byte
      if n > 0 && (clean.getbyte(n) & 0x80) != 0
        c = clean.getbyte(n)
        need = if (c & 0xE0) == 0xC0 then 2
               elsif (c & 0xF0) == 0xE0 then 3
               elsif (c & 0xF8) == 0xF0 then 4
               else 0
               end
        n -= 1 if need != 0 && n + need > 41
      end
    end
    clean[0, n]
  end

  def self.plan(length, name, code_size)
    nb = name_bytes(name)
    cap = PrismCore.capacity(code_size, PARTS_ECC, 0)
    room = cap[:payload] - overhead(nb.bytesize)
    raise 'part size leaves < 64 bytes of room' if room < 64
    total = (length + room - 1) / room
    total = 1 if total < 1
    raise 'file too big for this part size' if total > 65_535
    { room: room, total: total, name: nb }
  end

  # split splits bytes into PPT1 part payloads.
  def self.split(data, name, code_size)
    pl = plan(data.bytesize, name, code_size)
    id = SecureRandom.random_bytes(4)
    whole = PrismCore.prism_crc32(data)
    parts = []
    pl[:total].times do |n_idx|
      off = n_idx * pl[:room]
      clen = [data.bytesize - off, pl[:room]].min
      p = "PPT1".b + id +
          ((n_idx + 1) >> 8).chr.b + ((n_idx + 1) & 255).chr.b +
          (pl[:total] >> 8).chr.b + (pl[:total] & 255).chr.b +
          [data.bytesize].pack('N') + [whole].pack('N') +
          pl[:name].bytesize.chr.b + pl[:name] +
          data[off, clen]
      p += [PrismCore.prism_crc32(p)].pack('N')
      parts << p
    end
    parts
  end

  # parse parses one part payload. Returns nil = not a part; raises on damage.
  def self.parse(b)
    return nil if b.bytesize < 25 || b[0, 4] != 'PPT1'.b
    if PrismCore.prism_crc32(b[0, b.bytesize - 4]) != b[b.bytesize - 4, 4].unpack1('N')
      raise 'This part failed its own check. Scan it again.'
    end
    id = b[4, 4].unpack1('H*')
    n = (b.getbyte(8) << 8) | b.getbyte(9)
    total = (b.getbyte(10) << 8) | b.getbyte(11)
    len = b[12, 4].unpack1('N')
    whole = b[16, 4].unpack1('N')
    nl = b.getbyte(20)
    if 21 + nl + 4 > b.bytesize || n.zero? || n > total
      raise 'This part has a broken header.'
    end
    {
      id: id, n: n, total: total, len: len, whole: whole,
      name: b[21, nl],
      chunk: b[21 + nl, b.bytesize - 4 - (21 + nl)],
    }
  end

  class Assembler
    attr_reader :id, :total, :len, :whole, :name, :have

    def initialize
      @started = false
      @id = ''
      @total = 0
      @len = 0
      @whole = 0
      @name = ''
      @chunks = []
      @have = 0
    end

    # returns [status, n, message]
    def add(b)
      begin
        p = PrismParts.parse(b)
      rescue StandardError => e
        return [BAD, 0, e.message]
      end
      return [NOT_PART, 0, ''] if p.nil?
      if !@started
        @started = true
        @id = p[:id]
        @total = p[:total]
        @len = p[:len]
        @whole = p[:whole]
        @name = p[:name]
        @chunks = Array.new(p[:total])
      elsif p[:id] != @id
        nm = p[:name].empty? ? 'unnamed' : p[:name]
        return [OTHER, 0, "That part belongs to a different file (#{nm}). Start over to switch."]
      elsif p[:total] != @total || p[:len] != @len || p[:whole] != @whole
        return [BAD, 0, 'This part does not match the others.']
      end
      return [DUPLICATE, p[:n], ''] unless @chunks[p[:n] - 1].nil?
      @chunks[p[:n] - 1] = p[:chunk]
      @have += 1
      return [COMPLETE, p[:n], ''] if @have == @total
      [NEW, p[:n], '']
    end

    # finish rebuilds and verifies after COMPLETE. Returns [bytes, name].
    def finish
      raise 'Parts are still missing.' if @have != @total
      buf = +''.b
      @total.times do |i|
        ch = @chunks[i]
        raise 'The parts add up to more than the file size.' if buf.bytesize + ch.bytesize > @len
        buf << ch
      end
      raise "The parts add up to #{buf.bytesize} bytes, not #{@len}." if buf.bytesize != @len
      if PrismCore.prism_crc32(buf) != @whole
        raise 'The whole-file check failed. Start over and scan the parts again.'
      end
      name = @name.empty? ? 'prism-file.bin' : @name
      [buf, name]
    end
  end
end
