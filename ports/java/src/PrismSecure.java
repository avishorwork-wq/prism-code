// Prism Secure - Java 17 port of the live JavaScript encryption/signing layer.
// Source of truth: prism-secure.html (PrismSecure module) in
// https://github.com/avishorwork-wq/prism-code
//
// Prism Code by Avi Shor. Free to use, with or without credit. No warranty.
//
// Envelope v2: "PSC" 0x02 | flags | body
//   flags bit0 = encrypted, bit1 = signed
//   encrypted body: kdf(1) kdfParams(6) salt(16) iv(12) ciphertext+tag(16)
//     kdf 2 = Argon2id: memKiB(4, BE) passes(1) lanes(1)   (default 128 MiB, 3 passes)
//     kdf 1 = PBKDF2-SHA256: iterations(4, BE) + 2 unused  (600,000 rounds)
//   signed: appended pubkey(65, P-256 raw) + signature(64) over everything before it
// Encryption: AES-256-GCM, header authenticated as additional data.
// v1 codes (PBKDF2 only) still open.

import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.interfaces.ECPrivateKey;
import java.security.interfaces.ECPublicKey;
import java.security.spec.*;
import java.util.Arrays;

public final class PrismSecure {
    static final byte[] MAGIC = {0x50, 0x53, 0x43};
    static final int F_ENC = 1, F_SIG = 2;
    static final int PBKDF2_ITER = 600000;
    static final int A2_MEM = 131072, A2_T = 3, A2_P = 1;
    static final int MAX_MEM = 262144, MAX_T = 12;
    static final int HEAD2 = 4 + 1 + 1 + 6 + 16 + 12, HEAD1 = 4 + 1 + 16 + 12 + 4;

    static final SecureRandom RND = new SecureRandom();

    static byte[] cat(byte[]... parts) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        for (byte[] p : parts) o.write(p, 0, p.length);
        return o.toByteArray();
    }
    static byte[] be32(long n) {
        return new byte[]{(byte)(n >>> 24), (byte)(n >>> 16), (byte)(n >>> 8), (byte) n};
    }
    static long rd32(byte[] b, int i) {
        return ((b[i] & 255L) << 24) | ((b[i+1] & 255L) << 16) | ((b[i+2] & 255L) << 8) | (b[i+3] & 255L);
    }
    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(Character.forDigit((x >> 4) & 15, 16)).append(Character.forDigit(x & 15, 16));
        return sb.toString();
    }
    public static boolean ctEqual(byte[] a, byte[] b) {
        int d = a.length ^ b.length;
        int n = Math.max(a.length, b.length);
        for (int i = 0; i < n; i++) d |= (i < a.length ? a[i] : 0) ^ (i < b.length ? b[i] : 0);
        return d == 0;
    }

    // ---------------------------------------------------------------- Argon2id (RFC 9106)

    private static long fBlaMka(long x, long y) { return x + y + 2L * (x & 0xFFFFFFFFL) * (y & 0xFFFFFFFFL); }

    private static void gRound(long[] v, int a, int b, int c, int d) {
        v[a] = fBlaMka(v[a], v[b]); v[d] = Long.rotateRight(v[d] ^ v[a], 32);
        v[c] = fBlaMka(v[c], v[d]); v[b] = Long.rotateRight(v[b] ^ v[c], 24);
        v[a] = fBlaMka(v[a], v[b]); v[d] = Long.rotateRight(v[d] ^ v[a], 16);
        v[c] = fBlaMka(v[c], v[d]); v[b] = Long.rotateRight(v[b] ^ v[c], 63);
    }

    /** Argon2's P permutation: ONE message-less Blake2b round (BLAKE2_ROUND_NOMSG) over 16 words. */
    private static void permute16(long[] v, int off) {
        for (int r = 0; r < 1; r++) {
            gRound(v, off+0, off+4, off+8, off+12); gRound(v, off+1, off+5, off+9, off+13);
            gRound(v, off+2, off+6, off+10, off+14); gRound(v, off+3, off+7, off+11, off+15);
            gRound(v, off+0, off+5, off+10, off+15); gRound(v, off+1, off+6, off+11, off+12);
            gRound(v, off+2, off+7, off+8, off+13); gRound(v, off+3, off+4, off+9, off+14);
        }
    }

    /** Argon2 block compression: out = P(X xor Y) xor X xor Y (or P(X xor Y) when withXor=false into zero). */
    private static void fillBlock(long[] x, int xo, long[] y, int yo, long[] out, int oo, boolean withXor) {
        long[] r = new long[128];
        for (int i = 0; i < 128; i++) r[i] = x[xo + i] ^ y[yo + i];
        long[] z = r.clone();
        for (int row = 0; row < 8; row++) permute16(z, row * 16);
        // column rounds: columns are strided; copy each column into a temp 16-word slice
        long[] col = new long[16];
        for (int c = 0; c < 8; c++) {
            for (int row = 0; row < 8; row++) { col[row * 2] = z[row * 16 + c * 2]; col[row * 2 + 1] = z[row * 16 + c * 2 + 1]; }
            permute16(col, 0);
            for (int row = 0; row < 8; row++) { z[row * 16 + c * 2] = col[row * 2]; z[row * 16 + c * 2 + 1] = col[row * 2 + 1]; }
        }
        for (int i = 0; i < 128; i++) {
            long v = z[i] ^ r[i];
            if (withXor) v ^= out[oo + i];
            out[oo + i] = v;
        }
    }

    // --- Blake2b from scratch (RFC 7693) ---
    private static final long[] IV = {
        0x6a09e667f3bcc908L, 0xbb67ae8584caa73bL, 0x3c6ef372fe94f82bL, 0xa54ff53a5f1d36f1L,
        0x510e527fade682d1L, 0x9b05688c2b3e6c1fL, 0x1f83d9abfb41bd6bL, 0x5be0cd19137e2179L};
    private static final byte[][] SIGMA = {
        {0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15},
        {14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3},
        {11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4},
        {7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8},
        {9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13},
        {2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9},
        {12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11},
        {13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10},
        {6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5},
        {10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0}};

    private static void b2G(long[] v, int a, int b, int c, int d, long x, long y) {
        v[a] = v[a] + v[b] + x; v[d] = Long.rotateRight(v[d] ^ v[a], 32);
        v[c] = v[c] + v[d]; v[b] = Long.rotateRight(v[b] ^ v[c], 24);
        v[a] = v[a] + v[b] + y; v[d] = Long.rotateRight(v[d] ^ v[a], 16);
        v[c] = v[c] + v[d]; v[b] = Long.rotateRight(v[b] ^ v[c], 63);
    }

    /** Blake2b hash, unkeyed. */
    static byte[] blake2b(byte[] input, int outLen) {
        long[] h = IV.clone();
        h[0] ^= 0x01010000 ^ outLen;
        int blocks = Math.max(1, (input.length + 127) / 128); // empty input still compresses one final zero block
        long t = 0;
        for (int blk = 0; blk < blocks; blk++) {
            boolean last = blk == blocks - 1;
            int n = Math.min(128, input.length - blk * 128);
            t += n;
            long[] m = new long[16];
            for (int i = 0; i < n; i++) m[i >>> 3] |= (input[blk * 128 + i] & 255L) << (8 * (i & 7));
            long[] v = new long[16];
            System.arraycopy(h, 0, v, 0, 8);
            System.arraycopy(IV, 0, v, 8, 8);
            v[12] ^= t;
            if (last) v[14] = ~v[14];
            for (int r = 0; r < 12; r++) {
                byte[] s = SIGMA[r % 10];
                b2G(v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
                b2G(v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
                b2G(v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
                b2G(v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
                b2G(v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
                b2G(v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
                b2G(v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
                b2G(v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
            }
            for (int i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < outLen; i++) out.write((int) (h[i >>> 3] >>> (8 * (i & 7))) & 255);
        return out.toByteArray();
    }

    /** Argon2's variable-length hash H'. */
    private static byte[] hPrime(byte[] in, int outLen) {
        byte[] le = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(outLen).array();
        if (outLen <= 64) return blake2b(cat(le, in), outLen);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] v = blake2b(cat(le, in), 64);
        out.write(v, 0, 32);
        int remaining = outLen - 32;
        while (remaining > 64) {
            v = blake2b(v, 64);
            out.write(v, 0, 32);
            remaining -= 32;
        }
        v = blake2b(v, remaining);
        out.write(v, 0, remaining);
        return out.toByteArray();
    }

    private static long[] bytesToWords(byte[] b) {
        long[] w = new long[b.length / 8];
        for (int i = 0; i < w.length; i++)
            for (int k = 0; k < 8; k++) w[i] |= (b[i * 8 + k] & 255L) << (8 * k);
        return w;
    }

    /**
     * Argon2id key derivation (RFC 9106), matching hash-wasm's argon2id.
     * @param memKiB memory in kibibytes, @param passes t, @param lanes p (1 supported by format)
     */
    public static byte[] argon2id(byte[] password, byte[] salt, int memKiB, int passes, int lanes, int outLen) {
        if (lanes != 1) throw new IllegalArgumentException("only p=1 supported");
        int mPrime = (memKiB / 4) * 4;              // blocks (p=1)
        int laneLen = mPrime, segLen = laneLen / 4;
        long[] mem = new long[mPrime * 128];
        // H0
        ByteArrayOutputStream h0in = new ByteArrayOutputStream();
        ByteBuffer le = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN);
        int[][] head = {{lanes},{outLen},{memKiB},{passes},{0x13},{2}};
        for (int[] x : head) { le.clear(); le.putInt(x[0]); h0in.write(le.array(), 0, 4); }
        le.clear(); le.putInt(password.length); h0in.write(le.array(), 0, 4); h0in.write(password, 0, password.length);
        le.clear(); le.putInt(salt.length); h0in.write(le.array(), 0, 4); h0in.write(salt, 0, salt.length);
        le.clear(); le.putInt(0); h0in.write(le.array(), 0, 4);
        le.clear(); le.putInt(0); h0in.write(le.array(), 0, 4);
        byte[] h0 = blake2b(h0in.toByteArray(), 64);
        // first two blocks of the lane
        for (int i = 0; i < 2; i++) {
            byte[] in = cat(h0, ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putInt(i).putInt(0).array());
            System.arraycopy(bytesToWords(hPrime(in, 1024)), 0, mem, i * 128, 128);
        }
        long[] addrIn = new long[128], addrBlock = new long[128], zero = new long[128];
        for (int pass = 0; pass < passes; pass++) {
            for (int slice = 0; slice < 4; slice++) {
                boolean dataIndep = pass == 0 && slice < 2;
                if (dataIndep) {
                    Arrays.fill(addrIn, 0);
                    addrIn[0] = pass; addrIn[1] = 0; addrIn[2] = slice;
                    addrIn[3] = mPrime; addrIn[4] = passes; addrIn[5] = 2;
                    addrIn[6] = 0;
                    if (slice == 0) { // reference pre-generates the first address block for slice 0
                        addrIn[6]++;
                        fillBlock(zero, 0, addrIn, 0, addrBlock, 0, false);
                        long[] tmp = addrBlock.clone();
                        fillBlock(zero, 0, tmp, 0, addrBlock, 0, false);
                    }
                }
                int startIdx = (pass == 0 && slice == 0) ? 2 : 0;
                int blockIdx = slice * segLen + startIdx;
                int prevIdx = blockIdx == 0 ? laneLen - 1 : blockIdx - 1;
                if (pass == 0 && slice == 0 && startIdx == 2) prevIdx = 1;
                for (int idx = startIdx; idx < segLen; idx++, blockIdx++, prevIdx = (prevIdx + 1) % laneLen) {
                    long j1, j2;
                    if (dataIndep) {
                        if (idx % 128 == 0) { // slice 0 starts at idx 2 (pre-generated), so this first fires at idx 128
                            addrIn[6]++;
                            fillBlock(zero, 0, addrIn, 0, addrBlock, 0, false);
                            long[] tmp = addrBlock.clone();
                            fillBlock(zero, 0, tmp, 0, addrBlock, 0, false);
                        }
                        j1 = addrBlock[idx % 128] & 0xFFFFFFFFL; // address index is the segment index: pre-filled blocks 0,1 skip addresses 0,1
                        j2 = (addrBlock[idx % 128] >>> 32) & 0xFFFFFFFFL;
                    } else {
                        j1 = mem[prevIdx * 128] & 0xFFFFFFFFL;
                        j2 = (mem[prevIdx * 128] >>> 32) & 0xFFFFFFFFL;
                    }
                    // reference area
                    long area;
                    if (pass == 0) area = (slice == 0) ? idx - 1 : (long) slice * segLen + idx - 1;
                    else area = (long) laneLen - segLen + idx - 1;
                    long x = (j1 * j1) >>> 32;
                    long rel = area - 1 - ((area * x) >>> 32);
                    long startPos = pass == 0 ? 0 : (slice == 3 ? 0 : (long) (slice + 1) * segLen);
                    int refIdx = (int) ((startPos + rel) % laneLen);
                    fillBlock(mem, prevIdx * 128, mem, refIdx * 128, mem, blockIdx * 128, pass != 0);
                }
            }
        }
        byte[] finalBlock = new byte[1024];
        ByteBuffer fb = ByteBuffer.wrap(finalBlock).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < 128; i++) fb.putLong(mem[(laneLen - 1) * 128 + i]);
        return hPrime(finalBlock, outLen);
    }

    // ---------------------------------------------------------------- crypto pieces

    private static byte[] nfkc(String s) { return java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFKC).getBytes(StandardCharsets.UTF_8); }

    static SecretKeySpec deriveKey(String password, byte[] salt, int kdf, long iter, long mem, int t, int p) throws Exception {
        byte[] pw = nfkc(password);
        try {
            if (kdf == 2) {
                byte[] raw = argon2id(pw, salt, (int) mem, t, p, 32);
                SecretKeySpec k = new SecretKeySpec(raw, "AES");
                Arrays.fill(raw, (byte) 0);
                return k;
            }
            PBEKeySpec spec = new PBEKeySpec(new String(pw, StandardCharsets.UTF_8).toCharArray(), salt, (int) iter, 256);
            byte[] raw = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            SecretKeySpec k = new SecretKeySpec(raw, "AES");
            Arrays.fill(raw, (byte) 0);
            return k;
        } finally { Arrays.fill(pw, (byte) 0); }
    }

    // P-256 order
    private static final java.math.BigInteger N = new java.math.BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16);

    /** DER-encoded ECDSA signature <-> raw r||s (64 bytes). */
    static byte[] derToRaw(byte[] der) {
        // minimal DER parser for seq of two INTEGERs
        int i = 1; // skip 0x30
        int len = der[i++] & 255;
        if ((len & 0x80) != 0) { int nb = len & 0x7f; len = 0; for (int k = 0; k < nb; k++) len = (len << 8) | (der[i++] & 255); }
        byte[] out = new byte[64];
        for (int half = 0; half < 2; half++) {
            if (der[i++] != 0x02) throw new IllegalArgumentException("bad DER");
            int il = der[i++] & 255;
            byte[] v = Arrays.copyOfRange(der, i, i + il);
            i += il;
            int srcOff = 0;
            while (v.length - srcOff > 32 && v[srcOff] == 0) srcOff++; // strip DER sign-padding zeros
            if (v.length - srcOff > 32) throw new IllegalArgumentException("integer too long");
            int off = half * 32 + (32 - (v.length - srcOff));
            System.arraycopy(v, srcOff, out, off, v.length - srcOff);
        }
        return out;
    }

    static byte[] rawToDer(byte[] raw) {
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (int half = 0; half < 2; half++) {
            byte[] v = Arrays.copyOfRange(raw, half * 32, half * 32 + 32);
            int z = 0;
            while (z < v.length - 1 && v[z] == 0 && (v[z + 1] & 0x80) == 0) z++;
            v = Arrays.copyOfRange(v, z, v.length);
            if ((v[0] & 0x80) != 0) v = cat(new byte[]{0}, v);
            body.write(0x02);
            body.write(v.length);
            body.write(v, 0, v.length);
        }
        byte[] b = body.toByteArray();
        return cat(new byte[]{0x30, (byte) b.length}, b);
    }

    public static final class SigningKey {
        public byte[] publicKey;      // 65 bytes, uncompressed 0x04||X||Y
        public byte[] privateScalar;  // 32 bytes
    }

    public static SigningKey generateSigningKey() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"), RND);
        KeyPair kp = g.generateKeyPair();
        ECPublicKey pub = (ECPublicKey) kp.getPublic();
        ECPrivateKey priv = (ECPrivateKey) kp.getPrivate();
        SigningKey k = new SigningKey();
        k.publicKey = cat(new byte[]{4}, to32(pub.getW().getAffineX()), to32(pub.getW().getAffineY()));
        k.privateScalar = to32(priv.getS());
        return k;
    }

    private static byte[] to32(java.math.BigInteger v) {
        byte[] b = v.toByteArray();
        byte[] out = new byte[32];
        int src = Math.max(0, b.length - 32);
        System.arraycopy(b, src, out, Math.max(0, 32 - b.length + src - src), Math.min(32, b.length));
        System.arraycopy(b, src, out, 32 - Math.min(32, b.length - src), Math.min(32, b.length - src));
        return out;
    }

    private static KeyFactory ecKF() throws Exception { return KeyFactory.getInstance("EC"); }

    private static PublicKey pubFromRaw(byte[] raw) throws Exception {
        ECParameterSpec spec = ecSpec();
        java.math.BigInteger x = new java.math.BigInteger(1, Arrays.copyOfRange(raw, 1, 33));
        java.math.BigInteger y = new java.math.BigInteger(1, Arrays.copyOfRange(raw, 33, 65));
        return ecKF().generatePublic(new ECPublicKeySpec(new ECPoint(x, y), spec));
    }

    private static PrivateKey privFromScalar(byte[] s) throws Exception {
        ECParameterSpec spec = ecSpec();
        return ecKF().generatePrivate(new ECPrivateKeySpec(new java.math.BigInteger(1, s), spec));
    }

    private static ECParameterSpec ecSpec() throws Exception {
        AlgorithmParameters params = AlgorithmParameters.getInstance("EC");
        params.init(new ECGenParameterSpec("secp256r1"));
        return params.getParameterSpec(ECParameterSpec.class);
    }

    public static String fingerprint(byte[] pub) throws Exception {
        byte[] h = MessageDigest.getInstance("SHA-256").digest(pub);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 8; i++) {
            sb.append(Character.toUpperCase(Character.forDigit((h[i] >> 4) & 15, 16)))
              .append(Character.toUpperCase(Character.forDigit(h[i] & 15, 16)));
            if (i % 2 == 1 && i < 7) sb.append('-');
        }
        return sb.toString();
    }

    static final String ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    public static String generatePassphrase() {
        byte[] r = new byte[28];
        RND.nextBytes(r);
        StringBuilder sb = new StringBuilder();
        for (int g = 0; g < 7; g++) {
            if (g > 0) sb.append('-');
            for (int i = 0; i < 4; i++) sb.append(ALPHA.charAt(r[g * 4 + i] & 31));
        }
        Arrays.fill(r, (byte) 0);
        return sb.toString();
    }

    // ---------------------------------------------------------------- seal / open

    /** options: password (nullable), signing key (nullable), kdf: "argon2id" or "pbkdf2" (default argon2id) */
    public static byte[] seal(byte[] bytes, String password, SigningKey signWith, String kdf) throws Exception {
        if (password == null && signWith == null) throw new IllegalArgumentException("Give a password, a signing key, or both");
        int flags = (password != null ? F_ENC : 0) | (signWith != null ? F_SIG : 0);
        byte[] M = cat(MAGIC, new byte[]{2});
        byte[] body;
        if (password != null) {
            boolean useA = !"pbkdf2".equals(kdf);
            byte[] salt = new byte[16]; RND.nextBytes(salt);
            byte[] iv = new byte[12]; RND.nextBytes(iv);
            byte[] params = useA ? cat(be32(A2_MEM), new byte[]{(byte) A2_T, (byte) A2_P})
                                 : cat(be32(PBKDF2_ITER), new byte[]{0, 0});
            byte[] head = cat(M, new byte[]{(byte) flags}, new byte[]{(byte) (useA ? 2 : 1)}, params, salt, iv);
            SecretKeySpec key = deriveKey(password, salt, useA ? 2 : 1, PBKDF2_ITER, A2_MEM, A2_T, A2_P);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
            c.updateAAD(head);
            byte[] ct = c.doFinal(bytes);
            body = cat(head, ct);
        } else {
            body = cat(M, new byte[]{(byte) flags}, bytes);
        }
        if (signWith == null) return body;
        Signature s = Signature.getInstance("SHA256withECDSA");
        s.initSign(privFromScalar(signWith.privateScalar), RND);
        s.update(body);
        byte[] rawSig = derToRaw(s.sign());
        return cat(body, signWith.publicKey, rawSig);
    }

    public static final class OpenResult {
        public boolean secure, encrypted, signed;
        public Boolean signatureValid;
        public byte[] signerPublicKey;
        public String signerFingerprint;
        public boolean trusted;
        public byte[] bytes;
        public String error;
        public boolean needsPassword;
        public int version;
    }

    public static boolean isSecure(byte[] b) {
        return b.length >= 6 && b[0] == MAGIC[0] && b[1] == MAGIC[1] && b[2] == MAGIC[2]
            && (b[3] == 1 || b[3] == 2) && (b[4] & ~3) == 0;
    }

    public static OpenResult open(byte[] bytes, String password, String[] trustedFingerprints) throws Exception {
        OpenResult out = new OpenResult();
        if (!isSecure(bytes)) { out.secure = false; out.bytes = bytes; return out; }
        out.secure = true;
        int ver = bytes[3], flags = bytes[4];
        out.version = ver;
        out.encrypted = (flags & F_ENC) != 0;
        out.signed = (flags & F_SIG) != 0;
        int end = bytes.length;
        if (out.signed) {
            if (bytes.length < 5 + 65 + 64) throw new IllegalArgumentException("Code is damaged");
            byte[] pub = Arrays.copyOfRange(bytes, end - 129, end - 64);
            byte[] sig = Arrays.copyOfRange(bytes, end - 64, end);
            byte[] body = Arrays.copyOfRange(bytes, 0, end - 129);
            try {
                Signature s = Signature.getInstance("SHA256withECDSA");
                s.initVerify(pubFromRaw(pub));
                s.update(body);
                out.signatureValid = s.verify(rawToDer(sig));
            } catch (Exception e) { out.signatureValid = false; }
            out.signerPublicKey = pub;
            out.signerFingerprint = fingerprint(pub);
            out.trusted = out.signatureValid && trustedFingerprints != null
                && Arrays.stream(trustedFingerprints).anyMatch(f -> ctEqual(f.getBytes(StandardCharsets.UTF_8), out.signerFingerprint.getBytes(StandardCharsets.UTF_8)));
            end -= 129;
            if (!out.signatureValid) { out.bytes = null; out.error = "Signature is not valid. This code was changed or forged."; return out; }
        }
        if (!out.encrypted) { out.bytes = Arrays.copyOfRange(bytes, 5, end); return out; }
        byte[] head, salt, iv;
        int kdf, hl;
        long iter = 0, mem = 0;
        int t = 0, p = 0;
        if (ver == 1) {
            hl = HEAD1;
            if (end < hl + 16) throw new IllegalArgumentException("Code is damaged");
            salt = Arrays.copyOfRange(bytes, 5, 21);
            iv = Arrays.copyOfRange(bytes, 21, 33);
            kdf = 1;
            iter = rd32(bytes, 33);
        } else {
            hl = HEAD2;
            if (end < hl + 16) throw new IllegalArgumentException("Code is damaged");
            kdf = bytes[5];
            salt = Arrays.copyOfRange(bytes, 12, 28);
            iv = Arrays.copyOfRange(bytes, 28, 40);
            if (kdf == 2) { mem = rd32(bytes, 6); t = bytes[10]; p = bytes[11]; }
            else iter = rd32(bytes, 6);
        }
        head = Arrays.copyOfRange(bytes, 0, hl);
        if (kdf == 1 ? (iter < 100000 || iter > 5000000)
                     : kdf == 2 ? (mem < 8192 || mem > MAX_MEM || t < 1 || t > MAX_T || p < 1 || p > 4) : true)
            throw new IllegalArgumentException("Code is damaged or unsupported");
        if (password == null) { out.bytes = null; out.needsPassword = true; return out; }
        try {
            SecretKeySpec key = deriveKey(password, salt, kdf, iter, mem, t, p);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            c.updateAAD(head);
            out.bytes = c.doFinal(Arrays.copyOfRange(bytes, hl, end));
        } catch (Exception e) {
            out.bytes = null;
            out.error = "Wrong password, or the code was changed.";
        }
        return out;
    }
}
