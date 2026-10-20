import Foundation

/// One picture of a simulator's or emulator's screen (stream kind 4, `@ace/browser`'s
/// `stream-picture.ts`): one H.264 access unit in Annex B with its parameter sets in front of
/// every keyframe, or a JPEG still (a screenshot). Live views are H.264 at 60 fps only; a view
/// draws `isLiveVideo` pictures and never a JPEG. Header, big-endian:
///
///     0  f64  sequence (per capture, acked cumulatively)
///     8  f64  timestamp (ms)
///     16 u16  width (the picture's pixels)
///     18 u16  height
///     20 f32  scale (picture pixels per device point)
///     24 u16  rotation (degrees clockwise that show the picture upright)
///     26 u8   flags: bit 0 keyframe (every JPEG is one); bit 1 still (a screenshot, never acked)
///     27 u8   codec length, then its ASCII (`jpeg` or `avc1.PPCCLL`)
///     ..  u16  source id length, then its UTF-8 (the device id)
///     ..  u16  stream id length, then its UTF-8 (the capture)
struct DeviceFrameChunk: Equatable, Sendable {
    let deviceId: String
    let streamId: String
    let sequence: Int
    let timestamp: Double
    let width: Int
    let height: Int
    let scale: Double
    let rotation: DeviceRotation
    let codec: String
    let key: Bool
    let bytes: Data
    /// A one-shot screenshot, outside the live view's ack window.
    var still = false

    var isJPEG: Bool { codec == "jpeg" }
    /// A picture a live view draws: H.264 that isn't a still. A JPEG live picture (an older
    /// daemon's) is never drawn.
    var isLiveVideo: Bool { !isJPEG && !still }

    /// A device picture from its envelope's header and payload; throws on anything malformed,
    /// as the daemon's own reader does.
    static func decode(_ meta: Data, _ payload: Data) throws -> DeviceFrameChunk {
        let reader = ByteReader(meta)
        guard meta.count >= 32, !payload.isEmpty else { throw StreamEnvelopeError.invalidHeader }
        let codecLength = Int(reader.u8(27))
        var at = 28 + codecLength
        var parts: [Data] = []
        for _ in 0..<2 {
            guard at + 2 <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            let length = Int(reader.u16(at))
            guard at + 2 + length <= meta.count else { throw StreamEnvelopeError.invalidHeader }
            parts.append(reader.slice(at + 2, length))
            at += 2 + length
        }
        guard at == meta.count else { throw StreamEnvelopeError.invalidHeader }
        let codec = try ascii(reader.slice(28, codecLength))
        guard codec == "jpeg" || isAVC(codec) else { throw StreamEnvelopeError.invalidHeader }
        let width = Int(reader.u16(16)), height = Int(reader.u16(18))
        guard (1...8192).contains(width), (1...8192).contains(height) else { throw StreamEnvelopeError.invalidHeader }
        // An f32 has fewer digits than the scale the daemon meant; its shortest form is that scale.
        guard let scale = Double(reader.f32(20).description), scale.isFinite, scale > 0, scale <= 64,
              let rotation = DeviceRotation(rawValue: Int(reader.u16(24))) else { throw StreamEnvelopeError.invalidHeader }
        let sequence = reader.f64(0), timestamp = reader.f64(8)
        guard sequence.isFinite, sequence >= 0, sequence.rounded() == sequence, sequence <= 9_007_199_254_740_991,
              timestamp.isFinite, timestamp >= 0 else { throw StreamEnvelopeError.invalidHeader }
        let deviceId = try text(parts[0]), streamId = try text(parts[1])
        guard isDeviceId(deviceId), isStreamId(streamId) else { throw StreamEnvelopeError.invalidHeader }
        return DeviceFrameChunk(
            deviceId: deviceId, streamId: streamId, sequence: Int(sequence), timestamp: timestamp,
            width: width, height: height, scale: scale, rotation: rotation, codec: codec,
            key: codec == "jpeg" || reader.u8(26) & 1 == 1, bytes: payload, still: reader.u8(26) & 2 == 2)
    }

    private static func text(_ bytes: Data) throws -> String {
        guard let value = String(data: bytes, encoding: .utf8) else { throw StreamEnvelopeError.invalidHeader }
        return value
    }
    private static func ascii(_ bytes: Data) throws -> String {
        guard bytes.allSatisfy({ $0 < 0x80 }) else { throw StreamEnvelopeError.invalidHeader }
        return try text(bytes)
    }
    private static func isHex(_ character: Character) -> Bool { character.isASCII && character.isHexDigit }
    private static func isWord(_ character: Character) -> Bool {
        character.isASCII && (character.isLetter || character.isNumber || character == "_" || character == "-")
    }
    /// `avc1.` and six hex digits (profile, constraints, level).
    private static func isAVC(_ codec: String) -> Bool {
        codec.hasPrefix("avc1.") && codec.count == 11 && codec.dropFirst(5).allSatisfy(isHex)
    }
    /// `ios:` and a simulator UDID, or `android:` and an adb serial (`AppDeviceId`).
    private static func isDeviceId(_ id: String) -> Bool {
        if id.hasPrefix("ios:") {
            let udid = id.dropFirst(4)
            return udid.count == 36 && udid.allSatisfy { isHex($0) || $0 == "-" }
        }
        guard id.hasPrefix("android:") else { return false }
        let serial = id.dropFirst(8)
        return (1...200).contains(serial.count) && serial.allSatisfy { isWord($0) || $0 == "." }
    }
    /// A capture id (`ScreenId`).
    private static func isStreamId(_ id: String) -> Bool { (1...64).contains(id.count) && id.allSatisfy(isWord) }
}

/// Degrees clockwise that show a device picture upright.
enum DeviceRotation: Int, Sendable, CaseIterable {
    case none = 0, quarter = 90, half = 180, threeQuarters = 270

    /// Whether the upright picture's sides are the encoded picture's, swapped.
    var swapsSides: Bool { self == .quarter || self == .threeQuarters }
}
