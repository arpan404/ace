import Foundation

/// The binary stream envelope (`@ace/browser/stream`, ADR 0088): how the daemon's live pictures
/// cross the socket as binary WebSocket messages. A logical message is cut into pieces of at most
/// 64 KiB, each starting with the same 20-byte big-endian prefix:
///
///     0  u32  magic "ACES"
///     4  u8   version (1)
///     5  u8   kind (1 JPEG frame, 2 video chunk, 8 download chunk)
///     6  u16  meta length: the kind's own header at the start of the body
///     8  u32  message id, per sender
///     12 u32  body length (meta + payload)
///     16 u32  offset of this piece in the body
///
/// A sender writes one message's pieces back to back, so a receiver holds one partial message.
enum StreamWire {
    static let magic: UInt32 = 0x4143_4553
    static let version: UInt8 = 1
    static let prefixBytes = 20
    static let pieceBytes = 64 * 1024
    /// The largest logical message a receiver assembles.
    static let maxBytes = 8 * 1024 * 1024
    enum Kind { static let frame: UInt8 = 1; static let video: UInt8 = 2; static let download: UInt8 = 8 }

    /// Whether a binary message is a stream piece rather than another binary channel's frame.
    static func isPiece(_ bytes: Data) -> Bool {
        bytes.count >= prefixBytes && ByteReader(bytes).u32(0) == magic
    }
}

enum StreamEnvelopeError: Error, Equatable {
    case outOfBounds, notAPiece, unsupportedVersion, outOfOrder, emptyPiece, invalidHeader
}

/// One assembled stream message.
struct StreamEnvelope: Equatable, Sendable {
    let kind: UInt8
    let meta: Data
    let payload: Data
}

/// Puts pieces back together. A malformed piece throws (the connection is then dropped, as the
/// SDK does); a new message starting while another is partial replaces it, since its sender gave
/// up on it. Pure: no I/O, one instance per socket.
struct StreamAssembler {
    private struct Partial { let kind: UInt8; let id: UInt32; let metaLength: Int; let total: Int; var body: Data }
    private var partial: Partial?

    mutating func push(_ bytes: Data) throws -> StreamEnvelope? {
        guard bytes.count >= StreamWire.prefixBytes, bytes.count <= StreamWire.pieceBytes else { throw StreamEnvelopeError.outOfBounds }
        let reader = ByteReader(bytes)
        guard reader.u32(0) == StreamWire.magic else { throw StreamEnvelopeError.notAPiece }
        guard reader.u8(4) == StreamWire.version else { throw StreamEnvelopeError.unsupportedVersion }
        let kind = reader.u8(5)
        let metaLength = Int(reader.u16(6))
        let id = reader.u32(8)
        let total = Int(reader.u32(12))
        let offset = Int(reader.u32(16))
        let piece = reader.slice(StreamWire.prefixBytes, bytes.count - StreamWire.prefixBytes)
        guard total <= StreamWire.maxBytes, metaLength <= total, offset + piece.count <= total else { throw StreamEnvelopeError.outOfBounds }
        if offset == 0 {
            var body = Data()
            body.reserveCapacity(total)
            partial = Partial(kind: kind, id: id, metaLength: metaLength, total: total, body: body)
        }
        guard var current = partial, current.id == id, current.kind == kind, current.metaLength == metaLength,
              current.total == total, current.body.count == offset else {
            partial = nil
            throw StreamEnvelopeError.outOfOrder
        }
        current.body.append(piece)
        if current.body.count < total {
            // Only an empty piece could stall here, and offsets forbid one past the start.
            guard !piece.isEmpty else { partial = nil; throw StreamEnvelopeError.emptyPiece }
            partial = current
            return nil
        }
        partial = nil
        let body = current.body
        return StreamEnvelope(kind: kind, meta: Data(body.prefix(metaLength)), payload: Data(body.dropFirst(metaLength)))
    }
    /// Drop a partial message (the connection ended).
    mutating func reset() { partial = nil }
}

/// Big-endian reads at offsets relative to the start of `data`, whatever its indices.
struct ByteReader {
    let data: Data
    init(_ data: Data) { self.data = data }
    var count: Int { data.count }
    func u8(_ at: Int) -> UInt8 { data[data.startIndex + at] }
    func u16(_ at: Int) -> UInt16 { UInt16(u8(at)) << 8 | UInt16(u8(at + 1)) }
    func u32(_ at: Int) -> UInt32 { UInt32(u16(at)) << 16 | UInt32(u16(at + 2)) }
    func f64(_ at: Int) -> Double {
        var bits: UInt64 = 0
        for index in 0..<8 { bits = bits << 8 | UInt64(u8(at + index)) }
        return Double(bitPattern: bits)
    }
    /// A copy with its own zero-based indices.
    func slice(_ at: Int, _ length: Int) -> Data {
        let start = data.startIndex + at
        return Data(data[start..<(start + length)])
    }
}
