import Foundation

/// Wire framing between the ace daemon and the locked-use service: a 4-byte big-endian
/// unsigned payload length followed by that many bytes of UTF-8 JSON. Payloads must be
/// 1...65536 bytes. An invalid length poisons the stream; the connection must be closed.
public enum LockedUseFrameError: Error, Equatable { case empty, oversized(UInt32), poisoned }

public let lockedUseMaxFrame = 65_536

public func lockedUseEncodeFrame(_ payload: Data) throws -> Data {
    guard !payload.isEmpty else { throw LockedUseFrameError.empty }
    guard payload.count <= lockedUseMaxFrame else { throw LockedUseFrameError.oversized(UInt32(clamping: payload.count)) }
    var length = UInt32(payload.count).bigEndian
    var frame = Data(bytes: &length, count: 4)
    frame.append(payload)
    return frame
}

/// Incremental decoder. Buffers at most one header plus one maximum-size payload.
public struct LockedUseFrameDecoder: Sendable {
    private var buffer = Data()
    private var failed = false

    public init() {}

    public mutating func append(_ bytes: Data) throws -> [Data] {
        guard !failed else { throw LockedUseFrameError.poisoned }
        buffer.append(bytes)
        var frames: [Data] = []
        while buffer.count >= 4 {
            let header = buffer.prefix(4)
            let length = header.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
            guard length > 0 else { failed = true; throw LockedUseFrameError.empty }
            guard length <= lockedUseMaxFrame else { failed = true; throw LockedUseFrameError.oversized(length) }
            guard buffer.count >= 4 + Int(length) else { break }
            let start = buffer.startIndex + 4
            frames.append(Data(buffer[start..<start + Int(length)]))
            buffer = Data(buffer[(start + Int(length))...])
        }
        return frames
    }
}
