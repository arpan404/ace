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
    /// The certificate's notBefore/notAfter window, read from the same TBSCertificate.
    static func validity(certificate: Data) throws -> ClosedRange<Date> {
        let bytes = Array(certificate)
        let root = try DER.read(bytes, at: 0)
        guard root.tag == 0x30, root.end == bytes.count else { throw HostError.encoding }
        let tbs = try DER.read(bytes, at: root.content)
        guard tbs.tag == 0x30 else { throw HostError.encoding }
        var cursor = tbs.content
        if try DER.read(bytes, at: cursor).tag == 0xa0 { cursor = try DER.read(bytes, at: cursor).end }
        // Serial, signature algorithm and issuer precede validity.
        for _ in 0..<3 { cursor = try DER.read(bytes, at: cursor).end }
        let validity = try DER.read(bytes, at: cursor)
        guard validity.tag == 0x30, validity.end <= tbs.end else { throw HostError.encoding }
        let start = try DER.read(bytes, at: validity.content)
        let end = try DER.read(bytes, at: start.end)
        guard end.end <= validity.end else { throw HostError.encoding }
        let notBefore = try time(bytes, start), notAfter = try time(bytes, end)
        guard notBefore <= notAfter else { throw HostError.encoding }
        return notBefore...notAfter
    }
    private static func time(_ bytes: [UInt8], _ field: DER.Field) throws -> Date {
        let text = String(decoding: bytes[field.content..<field.end], as: UTF8.self)
        let values = Array(text.utf8.dropLast())
        guard text.hasSuffix("Z"), values.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { throw HostError.encoding }
        func number(_ from: Int, _ count: Int) -> Int { values[from..<(from + count)].reduce(0) { $0 * 10 + Int($1 - 0x30) } }
        var parts = DateComponents()
        let offset: Int
        switch (field.tag, values.count) {
        case (0x17, 12): // UTCTime: RFC 5280 maps YY < 50 to 20YY.
            let year = number(0, 2)
            parts.year = year < 50 ? 2000 + year : 1900 + year
            offset = 2
        case (0x18, 14): parts.year = number(0, 4); offset = 4
        default: throw HostError.encoding
        }
        parts.month = number(offset, 2); parts.day = number(offset + 2, 2)
        parts.hour = number(offset + 4, 2); parts.minute = number(offset + 6, 2); parts.second = number(offset + 8, 2)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        parts.calendar = calendar
        parts.timeZone = calendar.timeZone
        guard parts.isValidDate, let date = parts.date else { throw HostError.encoding }
        return date
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
