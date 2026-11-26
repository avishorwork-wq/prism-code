// Prism Secure CLI (Swift port): seal / open / keygen / passphrase / strength.
import Foundation

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: "--" + name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: seccli seal|open|keygen|passphrase|strength ...\n".data(using: .utf8)!)
    exit(2)
}

switch args[1] {
case "seal":
    let data = [UInt8](try! Foundation.Data(contentsOf: URL(fileURLWithPath: arg("in")!)))
    var key: SigningKey? = nil
    if let kp = arg("signkey") {
        let js = String(data: try! Foundation.Data(contentsOf: URL(fileURLWithPath: kp)), encoding: .utf8)!
        key = try signingKeyFromJson(js)
    }
    let out = try prismSeal(data, password: arg("password"), signWith: key, kdf: arg("kdf"))
    try Foundation.Data(out).write(to: URL(fileURLWithPath: arg("out")!))
    print("{\"ok\":true,\"inBytes\":\(data.count),\"outBytes\":\(out.count)}")
case "open":
    let data = [UInt8](try! Foundation.Data(contentsOf: URL(fileURLWithPath: arg("in")!)))
    let trusted = arg("trusted")?.split(separator: ",").map(String.init) ?? []
    let r = try prismOpen(data, password: arg("password"), trustedFingerprints: trusted)
    if let b = r.bytes { try Foundation.Data(b).write(to: URL(fileURLWithPath: arg("out")!)) }
    func jb(_ v: Bool?) -> String { v == nil ? "null" : v! ? "true" : "false" }
    var parts = ["\"ok\":\(jb(r.bytes != nil))", "\"secure\":\(jb(r.secure))", "\"encrypted\":\(jb(r.encrypted))",
                 "\"signed\":\(jb(r.signed))", "\"signatureValid\":\(jb(r.signatureValid))",
                 "\"trusted\":\(jb(r.trusted))", "\"needsPassword\":\(jb(r.needsPassword))"]
    if let f = r.signerFingerprint { parts.append("\"fingerprint\":\"\(f)\"") }
    if let e = r.error { parts.append("\"error\":\"\(e)\"") }
    print("{" + parts.joined(separator: ",") + "}")
    if r.bytes == nil { exit(1) }
case "keygen":
    let k = generateSigningKey()
    try signingKeyToJson(k).write(toFile: arg("out")!, atomically: true, encoding: .utf8)
    print("{\"ok\":true,\"fingerprint\":\"\(fingerprint(k.publicKey))\"}")
case "passphrase":
    print(generatePassphrase())
case "strength":
    let s = passwordStrength(arg("password")!)
    let warns = (s["warnings"] as! [String]).map { "\"\($0)\"" }.joined(separator: ",")
    print("{\"bits\":\(s["bits"]!),\"level\":\(s["level"]!),\"label\":\"\(s["label"]!)\",\"warnings\":[\(warns)]}")
default:
    FileHandle.standardError.write("unknown command\n".data(using: .utf8)!)
    exit(2)
}
