// Prism Code CLI (Java port): encode / decode clean Prism Code PNGs.
import javax.imageio.ImageIO;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Paths;

public final class PrismCli {

    static String arg(String[] a, String name, String dflt) {
        for (int i = 0; i < a.length - 1; i++) if (a[i].equals("--" + name)) return a[i + 1];
        return dflt;
    }

    public static void main(String[] a) throws Exception {
        if (a.length == 0) {
            System.err.println("usage: PrismCli encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n"
                + "       PrismCli decode I.png [--out O]");
            System.exit(2);
        }
        if (a[0].equals("encode")) {
            String text = arg(a, "text", null);
            String input = arg(a, "input", null);
            if (text == null && input == null) throw new IllegalArgumentException("need --text or --input");
            byte[] payload = text != null ? text.getBytes(java.nio.charset.StandardCharsets.UTF_8)
                                          : Files.readAllBytes(Paths.get(input));
            int size = Integer.parseInt(arg(a, "size", "-1"));
            int ecc = Integer.parseInt(arg(a, "ecc", "1"));
            int mode = Integer.parseInt(arg(a, "mode", "0"));
            int radius = Integer.parseInt(arg(a, "radius", "12"));
            int type = Integer.parseInt(arg(a, "type", "0"));
            int logo = Integer.parseInt(arg(a, "logo", "0"));
            String out = arg(a, "out", null);
            if (out == null) throw new IllegalArgumentException("need --out");
            Prism.Code code = Prism.encode(payload, size, ecc, mode, type, logo);
            ImageIO.write(Prism.render(code, radius), "png", new File(out));
            String symbols = arg(a, "symbols", null);
            if (symbols != null) {
                StringBuilder sb = new StringBuilder();
                sb.append("{\"size\":").append(code.size).append(",\"ecc\":").append(code.ecc)
                  .append(",\"mode\":").append(code.mode).append(",\"C\":").append(code.layout.C)
                  .append(",\"R\":").append(code.layout.R).append(",\"symbols\":[");
                for (int i = 0; i < code.symbols.length; i++) { if (i > 0) sb.append(','); sb.append(code.symbols[i]); }
                sb.append("]}");
                Files.writeString(Paths.get(symbols), sb.toString());
            }
            var img = Prism.render(code, radius);
            System.out.println("wrote " + out + " (" + img.getWidth() + "x" + img.getHeight() + " px, grid "
                + code.layout.C + "x" + code.layout.R + " cells, size " + code.size + ", mode " + mode
                + ", ecc " + ecc + ", " + payload.length + " payload bytes)");
            System.out.println("capacity at these settings: " + code.capacity.payload + " payload bytes");
        } else if (a[0].equals("decode")) {
            String png = a[1];
            Prism.Decoded d = Prism.decodeImage(ImageIO.read(new File(png)));
            String out = arg(a, "out", null);
            if (out != null) {
                Files.write(Paths.get(out), d.payload);
                System.out.println("wrote " + out + " (" + d.payload.length + " bytes)");
            } else {
                System.out.write(d.payload);
                if (d.payload.length > 0) System.out.println();
            }
            System.err.println("header: size " + d.size + ", ecc " + d.ecc + ", mode "
                + (d.mode == 0 ? "color" : "bw") + ", type " + d.type + ", " + d.length
                + " payload bytes, CRC-32 OK");
        } else {
            throw new IllegalArgumentException("unknown command " + a[0]);
        }
    }
}
