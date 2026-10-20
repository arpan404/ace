import Foundation

/// One encoded video chunk (stream kind 2, ADR 0088). Header, big-endian:
///
///     0  f64  sequence (acked cumulatively)
///     8  f64  timestamp (ms)
///     16 u32  width (CSS pixels: input coordinates map to these)
///     20 u32  height
///     24 u16  coded width (the decoded picture's pixels)
///     26 u16  coded height
///     28 u8   flags: bit 0 keyframe
///     29 u8   codec length, then its ASCII (a WebCodecs codec string)
///     ..  u16  decoder description length (0: none; H.264's avcC on keyframes), then its bytes
///     ..  u16  thread id length, then its UTF-8
///     ..  u16  tab id length (0: none), then its UTF-8
struct BrowserVideoChunk: Equatable, Sendable {
    let threadId: String
    let sequence: Int
    let timestamp: Double
    let width: Int
    let height: Int
    let codedWidth: Int
    let codedHeight: Int
    let codec: String
    let key: Bool
    /// The decoder description (H.264's avcC), on keyframes that need one.
    let description: Data?
    let tabId: String?
    let bytes: Data
}

extension BrowserVideoChunk {
    /// A stream message's video chunk; nil for any other kind, which the live view doesn't draw
    /// (JPEG frames, downloads, and kinds a newer daemon adds) and skips unread. A malformed
    /// video header throws.
    static func decode(_ envelope: StreamEnvelope) throws -> BrowserVideoChunk? {
        guard envelope.kind == StreamWire.Kind.video else { return nil }
        return try video(envelope.meta, envelope.payload)
    }

    private static func video(_ meta: Data, _ payload: Data) throws -> BrowserVideoChunk {
        let reader = ByteReader(meta)
        guard meta.count >= 36 else { throw StreamEnvelopeError.invalidHeader }
        let codecLength = Int(reader.u8(29))
        var at = 30 + codecLength
        var parts: [Data] = []
        for _ in 0..<3 {
            guard at + 2 <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            let length = Int(reader.u16(at))
            guard at + 2 + length <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            parts.append(reader.slice(at + 2, length))
            at += 2 + length
        }
        guard at == meta.count, !payload.isEmpty else { throw StreamEnvelopeError.invalidHeader }
        guard let codec = String(data: reader.slice(30, codecLength), encoding: .utf8), (1...64).contains(codec.count),
              codec.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == ".") }) else { throw StreamEnvelopeError.invalidHeader }
        let codedWidth = Int(reader.u16(24)), codedHeight = Int(reader.u16(26))
        guard (2...8192).contains(codedWidth), (2...8192).contains(codedHeight) else { throw StreamEnvelopeError.invalidHeader }
        return BrowserVideoChunk(
            threadId: try threadId(parts[1]),
            sequence: try sequence(reader.f64(0)),
            timestamp: try finite(reader.f64(8)),
            width: try cssSide(reader.u32(16)),
            height: try cssSide(reader.u32(20)),
            codedWidth: codedWidth, codedHeight: codedHeight, codec: codec,
            key: reader.u8(28) & 1 == 1,
            description: parts[0].isEmpty ? nil : parts[0],
            tabId: try tabId(parts[2]),
            bytes: payload)
    }

    private static func text(_ bytes: Data) throws -> String {
        guard let value = String(data: bytes, encoding: .utf8) else { throw StreamEnvelopeError.invalidHeader }
        return value
    }
    private static func threadId(_ bytes: Data) throws -> String {
        let value = try text(bytes)
        guard !value.isEmpty else { throw StreamEnvelopeError.invalidHeader }
        return value
    }
    private static func tabId(_ bytes: Data) throws -> String? {
        let value = try text(bytes)
        if value.isEmpty { return nil }
        // The protocol bounds tab ids in UTF-16 units.
        guard value.utf16.count <= 256 else { throw StreamEnvelopeError.invalidHeader }
        return value
    }
    private static func sequence(_ value: Double) throws -> Int {
        guard value.isFinite, value >= 0, value.rounded() == value, value <= 9_007_199_254_740_991 else { throw StreamEnvelopeError.invalidHeader }
        return Int(value)
    }
    private static func finite(_ value: Double) throws -> Double {
        guard value.isFinite else { throw StreamEnvelopeError.invalidHeader }
        return value
    }
    private static func cssSide(_ value: UInt32) throws -> Int {
        guard (100...4096).contains(value) else { throw StreamEnvelopeError.invalidHeader }
        return Int(value)
    }
}
