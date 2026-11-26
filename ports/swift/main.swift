// Prism Code CLI (Swift port): encode / decode clean Prism Code PNGs.
import Foundation

func arg(_ a: [String], _ name: String, _ dflt: String?) -> String? {
    for i in 0..<(a.count - 1) where a[i] == "--" + name { return a[i + 1] }
    return dflt
}

let a = CommandLine.arguments
let args = Array(a.dropFirst())
guard let cmd = args.first else {
    FileHandle.standardError.write("usage: prism encode --text T | --input F --out O.png [--size -1..5] [--ecc 0..3] [--mode 0|1] [--radius N] [--type 0|1] [--logo 0|1] [--symbols J]\n       prism decode I.png [--out O]\n".data(using: .utf8)!)
    exit(2)
}

do {
    if cmd == "encode" {
        let payload: [UInt8]
        if let t = arg(args, "text", nil) { payload = Array(t.utf8) }
        else if let f = arg(args, "input", nil) { payload = Array(try Data(contentsOf: URL(fileURLWithPath: f))) }
        else { throw PrismError.tooLarge("need --text or --input") }
        let size = Int(arg(args, "size", "-1")!)!
        let ecc = Int(arg(args, "ecc", "1")!)!
        let mode = Int(arg(args, "mode", "0")!)!
        let radius = Int(arg(args, "radius", "12")!)!
        let type = Int(arg(args, "type", "0")!)!
        let logo = Int(arg(args, "logo", "0")!)!
        guard let out = arg(args, "out", nil) else { throw PrismError.tooLarge("need --out") }
        let code = try encode(payload, size: size, ecc: ecc, mode: mode, type: type, logo: logo)
        let (w, h, img) = render(code, radius)
        try Data(try writePNG(w, h, img)).write(to: URL(fileURLWithPath: out))
        if let sym = arg(args, "symbols", nil) {
            let s = "{\"size\":\(code.size),\"ecc\":\(code.ecc),\"mode\":\(code.mode),\"C\":\(code.layout!.C),\"R\":\(code.layout!.R),\"symbols\":[\(code.symbols.map(String.init).joined(separator: ","))]}"
            try s.write(toFile: sym, atomically: false, encoding: .utf8)
        }
        print("wrote \(out) (\(w)x\(h) px, grid \(code.layout!.C)x\(code.layout!.R) cells, size \(code.size), mode \(mode), ecc \(ecc), \(payload.count) payload bytes)")
        print("capacity at these settings: \(code.capacity.payload) payload bytes")
    } else if cmd == "decode" {
        let png = args[1]
        let d = try decodePNG(Array(try Data(contentsOf: URL(fileURLWithPath: png))))
        if let out = arg(args, "out", nil) {
            try Data(d.payload).write(to: URL(fileURLWithPath: out))
            print("wrote \(out) (\(d.payload.count) bytes)")
        } else {
            FileHandle.standardOutput.write(Data(d.payload))
            if !d.payload.isEmpty { print() }
        }
        FileHandle.standardError.write("header: size \(d.size), ecc \(d.ecc), mode \(d.mode == 0 ? "color" : "bw"), type \(d.type), \(d.length) payload bytes, CRC-32 OK\n".data(using: .utf8)!)
    } else {
        throw PrismError.badPNG("unknown command \(cmd)")
    }
} catch {
    FileHandle.standardError.write("error: \(error)\n".data(using: .utf8)!)
    exit(1)
}
