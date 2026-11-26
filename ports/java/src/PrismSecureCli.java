// Prism Secure CLI (Java port): seal / open / keygen / passphrase.
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Base64;

public final class PrismSecureCli {
    static String arg(String[] a, String name, String dflt) {
        for (int i = 0; i < a.length - 1; i++) if (a[i].equals("--" + name)) return a[i + 1];
        return dflt;
    }

    // key file JSON: {"publicKey":[...],"privateScalar":[...]} or JS-style {"publicKey":{...},"privateJwk":{...}}
    static PrismSecure.SigningKey loadKey(String path) throws Exception {
        String j = Files.readString(Paths.get(path)).trim();
        PrismSecure.SigningKey k = new PrismSecure.SigningKey();
        k.publicKey = parseByteArray(j, "publicKey");
        try { k.privateScalar = parseByteArray(j, "privateScalar"); } catch (Exception e) { k.privateScalar = null; }
        if (k.privateScalar == null && j.contains("\"privateJwk\"") && j.contains("\"d\""))
            k.privateScalar = Base64.getUrlDecoder().decode(j.replaceAll("(?s).*\"d\"\\s*:\\s*\"([^\"]+)\".*", "$1"));
        return k;
    }

    static byte[] parseByteArray(String j, String field) {
        String m = j.replaceAll("(?s).*\\\"" + field + "\\\"\\s*:\\s*\\{([^}]*)\\}.*", "$1");
        if (!m.equals(j)) { // object with numeric keys: {"0":4,"1":149,...}
            java.util.regex.Matcher mm = java.util.regex.Pattern.compile("\\\"(\\d+)\\\"\\s*:\\s*(-?\\d+)").matcher(m);
            java.util.TreeMap<Integer, Integer> vals = new java.util.TreeMap<>();
            while (mm.find()) vals.put(Integer.parseInt(mm.group(1)), Integer.parseInt(mm.group(2)));
            byte[] out = new byte[vals.size()];
            int i = 0;
            for (int v : vals.values()) out[i++] = (byte) v;
            return out;
        }
        m = j.replaceAll("(?s).*\\\"" + field + "\\\"\\s*:\\s*\\[([^]]*)\\].*", "$1");
        if (m.equals(j)) throw new IllegalArgumentException("no " + field);
        String[] parts = m.split(",");
        byte[] out = new byte[parts.length];
        for (int i = 0; i < parts.length; i++) out[i] = (byte) Integer.parseInt(parts[i].trim());
        return out;
    }

    public static void main(String[] a) throws Exception {
        if (a.length == 0) {
            System.err.println("usage: PrismSecureCli seal --in F --out O [--password P] [--kdf argon2id|pbkdf2] [--signkey K.json]\n"
                + "       PrismSecureCli open --in F --out O [--password P] [--trusted F1,F2]\n"
                + "       PrismSecureCli keygen --out K.json\n"
                + "       PrismSecureCli passphrase");
            System.exit(2);
        }
        switch (a[0]) {
            case "seal": {
                byte[] data = Files.readAllBytes(Paths.get(arg(a, "in", null)));
                String pw = arg(a, "password", null);
                String kdf = arg(a, "kdf", null);
                PrismSecure.SigningKey key = arg(a, "signkey", null) != null ? loadKey(arg(a, "signkey", null)) : null;
                byte[] out = PrismSecure.seal(data, pw, key, kdf);
                Files.write(Paths.get(arg(a, "out", null)), out);
                System.out.println("sealed " + data.length + " -> " + out.length + " bytes");
                break;
            }
            case "open": {
                byte[] data = Files.readAllBytes(Paths.get(arg(a, "in", null)));
                String pw = arg(a, "password", null);
                String[] trusted = arg(a, "trusted", null) != null ? arg(a, "trusted", null).split(",") : new String[0];
                PrismSecure.OpenResult r = PrismSecure.open(data, pw, trusted);
                if (r.bytes != null) Files.write(Paths.get(arg(a, "out", null)), r.bytes);
                System.out.println("{\"ok\":" + (r.bytes != null) + ",\"secure\":" + r.secure + ",\"encrypted\":" + r.encrypted
                    + ",\"signed\":" + r.signed + ",\"signatureValid\":" + r.signatureValid
                    + (r.signerFingerprint != null ? ",\"fingerprint\":\"" + r.signerFingerprint + "\"" : "")
                    + ",\"trusted\":" + r.trusted + ",\"needsPassword\":" + r.needsPassword
                    + (r.error != null ? ",\"error\":\"" + r.error + "\"" : "") + "}");
                if (r.bytes == null) System.exit(1);
                break;
            }
            case "keygen": {
                PrismSecure.SigningKey k = PrismSecure.generateSigningKey();
                StringBuilder sb = new StringBuilder("{\"publicKey\":[");
                for (int i = 0; i < k.publicKey.length; i++) { if (i > 0) sb.append(','); sb.append(k.publicKey[i] & 255); }
                sb.append("],\"privateScalar\":[");
                for (int i = 0; i < k.privateScalar.length; i++) { if (i > 0) sb.append(','); sb.append(k.privateScalar[i] & 255); }
                sb.append("]}");
                Files.writeString(Paths.get(arg(a, "out", null)), sb.toString());
                System.out.println("{\"ok\":true,\"fingerprint\":\"" + PrismSecure.fingerprint(k.publicKey) + "\"}");
                break;
            }
            case "passphrase":
                System.out.println(PrismSecure.generatePassphrase());
                break;
            default:
                throw new IllegalArgumentException("unknown command " + a[0]);
        }
    }
}
