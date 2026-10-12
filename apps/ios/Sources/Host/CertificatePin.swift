import Foundation
import CryptoKit
import Security

/// Extract the original DER SubjectPublicKeyInfo, including its algorithm identifier.
/// SecKey's exported bytes alone are not SPKI and must never be hashed as a pin.
enum CertificatePin {
    static func digest(certificate: Data) throws -> String {
        let bytes = Array(certificate)
        let root = try DER.read(bytes, at: 0)
        guard root.tag == 0x30, root.end == bytes.count else { throw HostError.encoding }
        let tbs = try DER.read(bytes, at: root.content)
        guard tbs.tag == 0x30 else { throw HostError.encoding }
        var cursor = tbs.content
        if try DER.read(bytes, at: cursor).tag == 0xa0 { cursor = try DER.read(bytes, at: cursor).end }
        // Serial, signature algorithm, issuer, validity, subject, then SPKI.
        for _ in 0..<5 { cursor = try DER.read(bytes, at: cursor).end }
        let spki = try DER.read(bytes, at: cursor)
        guard spki.tag == 0x30, spki.end <= tbs.end else { throw HostError.encoding }
        return SHA256.hash(data: Data(bytes[cursor..<spki.end])).map { String(format: "%02x", $0) }.joined()
    }
}
private enum DER {
    struct Field { let tag: UInt8; let content: Int; let end: Int }
    static func read(_ bytes: [UInt8], at offset: Int) throws -> Field {
        guard offset >= 0, offset + 2 <= bytes.count else { throw HostError.encoding }
        let first = bytes[offset + 1]
        var content = offset + 2
        var length = Int(first)
        if first & 0x80 != 0 {
            let count = Int(first & 0x7f)
            guard count > 0, count <= 4, content + count <= bytes.count else { throw HostError.encoding }
            length = 0
            for byte in bytes[content..<(content + count)] { length = (length << 8) | Int(byte) }
            content += count
        }
        guard length <= bytes.count - content else { throw HostError.encoding }
        return Field(tag: bytes[offset], content: content, end: content + length)
    }
}
