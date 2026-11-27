import Foundation

/// One encoded chunk of a tab's sound (stream kind 3, ADR 0088 › Audio), sent only while this
/// view's pane report has `audio` on. Header, big-endian:
///
///     0  f64  sequence (never acked)
///     8  f64  timestamp (ms, on the video chunks' clock)
///     16 u32  sample rate (Hz)
///     20 u8   channels
///     21 u8   codec length, then its ASCII (`opus`)
///     ..  u16  thread id length, then its UTF-8
///     ..  u16  tab id length (0: none), then its UTF-8
///
/// The payload is one Opus packet.
struct BrowserAudioChunk: Equatable, Sendable {
    let threadId: String
    let sequence: Int
    let timestamp: Double
    let sampleRate: Int
    let channels: Int
    let codec: String
    let tabId: String?
    let bytes: Data
}

extension BrowserAudioChunk {
    /// A stream message's audio chunk; nil for any other kind. A malformed audio header throws.
    static func decode(_ envelope: StreamEnvelope) throws -> BrowserAudioChunk? {
        guard envelope.kind == StreamWire.Kind.audio else { return nil }
        let meta = envelope.meta
        let reader = ByteReader(meta)
        guard meta.count >= 26 else { throw StreamEnvelopeError.invalidHeader }
        let codecLength = Int(reader.u8(21))
        var at = 22 + codecLength
        var parts: [Data] = []
        for _ in 0..<2 {
            guard at + 2 <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            let length = Int(reader.u16(at))
            guard at + 2 + length <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            parts.append(reader.slice(at + 2, length))
            at += 2 + length
        }
        guard at == meta.count, !envelope.payload.isEmpty else { throw StreamEnvelopeError.invalidHeader }
        guard let codec = String(data: reader.slice(22, codecLength), encoding: .utf8), (1...64).contains(codec.count),
              codec.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == ".") }),
              let threadId = String(data: parts[0], encoding: .utf8), !threadId.isEmpty,
              let tab = String(data: parts[1], encoding: .utf8), tab.utf16.count <= 128 else { throw StreamEnvelopeError.invalidHeader }
        let sequence = reader.f64(0), timestamp = reader.f64(8)
        let sampleRate = Int(reader.u32(16)), channels = Int(reader.u8(20))
        guard sequence.isFinite, sequence >= 0, sequence.rounded() == sequence, sequence <= 9_007_199_254_740_991,
              timestamp.isFinite, (8_000...192_000).contains(sampleRate), (1...8).contains(channels)
        else { throw StreamEnvelopeError.invalidHeader }
        return BrowserAudioChunk(threadId: threadId, sequence: Int(sequence), timestamp: timestamp, sampleRate: sampleRate,
                                 channels: channels, codec: codec, tabId: tab.isEmpty ? nil : tab, bytes: envelope.payload)
    }
}
