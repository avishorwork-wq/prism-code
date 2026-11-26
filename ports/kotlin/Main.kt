// Prism Code CLI (Kotlin port): encode / decode clean Prism Code PNGs.
import java.io.File
import javax.imageio.ImageIO

private fun arg(a: Array<String>, name: String, dflt: String?): String? {
    for (i in 0 until a.size - 1) if (a[i] == "--$name") return a[i + 1]
    return dflt
}

private fun modeName(m: Int) = if (m == 0) "color" else "bw"

fun main(a: Array<String>) {
    if (a.isEmpty()) {
        System.err.println("""usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1|color|bw] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]
       prism decode I.png [--out O]
       prism capacity""")
        System.exit(2)
    }
    when (a[0]) {
        "encode" -> {
            val text = arg(a, "text", null)
            val input = arg(a, "input", null)
            require(text != null || input != null) { "need --text or --input" }
            val payload = text?.toByteArray(Charsets.UTF_8) ?: File(input!!).readBytes()
            val size = (arg(a, "size", "-1") ?: "-1").toInt()
            val ecc = (arg(a, "ecc", "1") ?: "1").toInt()
            val modeS = arg(a, "mode", "0") ?: "0"
            val mode = if (modeS == "1" || modeS == "bw") 1 else 0
            val radius = (arg(a, "radius", "12") ?: "12").toInt()
            val type = (arg(a, "type", "0") ?: "0").toInt()
            val logo = (arg(a, "logo", "0") ?: "0").toInt()
            val out = arg(a, "out", null) ?: throw IllegalArgumentException("need --out")
            val code = Prism.encode(payload, size, ecc, mode, type, logo)
            ImageIO.write(Prism.render(code, radius), "png", File(out))
            arg(a, "symbols", null)?.let { path ->
                val sb = StringBuilder()
                sb.append("{\"size\":").append(code.size).append(",\"ecc\":").append(code.ecc)
                    .append(",\"mode\":").append(code.mode).append(",\"C\":").append(code.layout.C)
                    .append(",\"R\":").append(code.layout.R).append(",\"symbols\":[")
                for (i in code.symbols.indices) { if (i > 0) sb.append(','); sb.append(code.symbols[i]) }
                sb.append("]}")
                File(path).writeText(sb.toString())
            }
            val img = Prism.render(code, radius)
            println("wrote $out (${img.width}x${img.height} px, grid ${code.layout.C}x${code.layout.R} cells, size ${code.size}, ${modeName(mode)}, ecc $ecc, ${payload.size} payload bytes)")
            println("capacity at these settings: ${code.capacity.payload} payload bytes")
        }
        "decode" -> {
            require(a.size >= 2) { "need png path" }
            val d = Prism.decodeImage(ImageIO.read(File(a[1])))
            val out = arg(a, "out", null)
            if (out != null) {
                File(out).writeBytes(d.payload)
                println("wrote $out (${d.payload.size} bytes)")
            } else {
                System.out.write(d.payload)
                if (d.payload.isNotEmpty()) println()
            }
            System.err.println("header: size ${d.size}, ecc ${d.ecc}, mode ${modeName(d.mode)}, type ${d.type}, ${d.length} payload bytes, CRC-32 OK")
        }
        "capacity" -> {
            for (s in 0 until 6) for (ecc in 0 until 4) for (mode in 0 until 2) {
                val cap = Prism.capacity(s, ecc, mode)
                println("size $s (${Prism.SIZES[s][0]}x${Prism.SIZES[s][1]}) ecc $ecc ${modeName(mode)}: ${cap.payload} payload bytes")
            }
        }
        else -> throw IllegalArgumentException("unknown command ${a[0]}")
    }
}
