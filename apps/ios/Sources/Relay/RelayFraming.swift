import Compression
import Foundation

enum RelayFrameError: Error, Equatable {
    case invalidFragment, mixedKinds, tooLarge, inflate, encoding
}

/// A logical message the relay channel carries: daemon JSON (inflated already) or binary.
enum RelayMessage: Equatable, Sendable {
    case text(String)
    case binary(Data)
}

/// The relay channel's encrypted framing (docs/relay/README.md). Each Noise transport message
/// carries one fragment: a kind byte (0 JSON, 2 binary, 4 deflated JSON; plus 1 on a message's
/// last fragment) then a chunk. Non-final chunks are exactly `chunkSize` bytes. Each direction
/// rekeys after every 2^20 fragments. Pure: the socket feeds it ciphertext and sends its output.
struct RelaySession: Sendable {
    static let chunkSize = noiseMaxMessage - 17
    static let logicalLimit = 16 * 1024 * 1024
    static let binaryLimit = 64 * 1024 + 16
    static let rekeyInterval: UInt64 = 1 << 20

    private let rekeyEvery: UInt64
    private var transport: NoiseTransport
    private var sent: UInt64 = 0
    private var received: UInt64 = 0
    private var chunks: [Data] = []
    private var size = 0
    private var kind: UInt8?

    /// `rekeyEvery` is the protocol's 2^20; tests shorten it to reach a rekey quickly.
    init(transport: NoiseTransport, rekeyEvery: UInt64 = Self.rekeyInterval) {
        self.transport = transport; self.rekeyEvery = rekeyEvery
    }

    /// The encrypted WebSocket messages for one JSON text (kind 0/1).
    mutating func seal(text: String) throws -> [Data] { try fragments(text: text).map { try seal(plain: $0) } }
    /// The encrypted WebSocket messages for one binary message (kind 2/3).
    mutating func seal(binary: Data) throws -> [Data] {
        guard !binary.isEmpty, binary.count <= Self.binaryLimit else { throw RelayFrameError.tooLarge }
        return try Self.fragments(binary, kind: 2).map { try seal(plain: $0) }
    }
    /// The daemon's side of kind 4/5: JSON already deflated. The phone never sends it; the
    /// fixture relay host and tests do.
    mutating func seal(deflated: Data) throws -> [Data] { try Self.fragments(deflated, kind: 4).map { try seal(plain: $0) } }

    /// One JSON text's plaintext fragments, not yet encrypted: a flow-controlled sender seals
    /// each only when its window has room, so a credit can still go out ahead of them.
    func fragments(text: String) throws -> [Data] { try Self.fragments(Data(text.utf8), kind: 0) }
    private static func fragments(_ data: Data, kind: UInt8) throws -> [Data] {
        guard data.count <= Self.logicalLimit else { throw RelayFrameError.tooLarge }
        var out: [Data] = []
        out.reserveCapacity(data.count / Self.chunkSize + 1)
        var offset = data.startIndex
        repeat {
            let end = min(offset + Self.chunkSize, data.endIndex)
            var plain = Data(capacity: end - offset + 1)
            plain.append(kind + (end == data.endIndex ? 1 : 0))
            plain.append(data[offset..<end])
            out.append(plain)
            offset = end
        } while offset < data.endIndex
        return out
    }
    /// Encrypt the next fragment (data or credit), in the order it goes on the wire.
    mutating func seal(plain: Data) throws -> Data {
        let frame = try transport.send.encrypt(plain)
        sent += 1
        if sent % rekeyEvery == 0 { try transport.send.rekey() }
        return frame
    }

    /// One decrypted WebSocket message: the peer's credit, or a data fragment with its flow cost
    /// and, on a message's last fragment, the whole message.
    enum Received: Equatable {
        case credit(Int)
        case data(cost: Int, message: RelayMessage?)
    }

    /// Decrypt one WebSocket message. Returns a logical message once its last fragment arrives;
    /// a credit fragment returns nil. Any error is fatal for the channel: the caller closes it.
    mutating func open(_ ciphertext: Data) throws -> RelayMessage? {
        guard case .data(_, let message) = try receive(ciphertext) else { return nil }
        return message
    }
    /// Decrypt one WebSocket message, credit fragments included. Any error is fatal.
    mutating func receive(_ ciphertext: Data) throws -> Received {
        let plain = try transport.receive.decrypt(ciphertext)
        received += 1
        if received % rekeyEvery == 0 { try transport.receive.rekey() }
        if plain.first == RelayFlow.creditTag {
            guard let amount = RelayFlow.readCredit(plain) else { throw RelayFrameError.invalidFragment }
            return .credit(amount)
        }
        return .data(cost: RelayFlow.cost(plain.count), message: try assemble(plain))
    }
    private mutating func assemble(_ plain: Data) throws -> RelayMessage? {
        guard plain.count >= 2, let flag = plain.first, flag <= 5 else { throw RelayFrameError.invalidFragment }
        // Only a message's last fragment may be short.
        if flag % 2 == 0 && plain.count != noiseMaxMessage - 16 { throw RelayFrameError.invalidFragment }
        let fragmentKind = flag - flag % 2
        if let kind, kind != fragmentKind { throw RelayFrameError.mixedKinds }
        kind = fragmentKind
        size += plain.count - 1
        if size > (fragmentKind == 2 ? Self.binaryLimit : Self.logicalLimit) { throw RelayFrameError.tooLarge }
        chunks.append(plain.dropFirst())
        guard flag % 2 == 1 else { return nil }
        var data = Data(capacity: size)
        for chunk in chunks { data.append(chunk) }
        chunks.removeAll(keepingCapacity: false); size = 0; kind = nil
        switch fragmentKind {
        case 2: return .binary(data)
        case 4: return .text(try Self.text(try RawDeflate.inflate(data, limit: Self.logicalLimit)))
        default: return .text(try Self.text(data))
        }
    }
    private static func text(_ data: Data) throws -> String {
        guard let text = String(data: data, encoding: .utf8) else { throw RelayFrameError.encoding }
        return text
    }
}

/// Raw DEFLATE (RFC 1951, no zlib header), what the daemon's `deflateRawSync` writes.
/// Apple's `COMPRESSION_ZLIB` is exactly raw DEFLATE.
enum RawDeflate {
    static func inflate(_ data: Data, limit: Int) throws -> Data {
        guard !data.isEmpty else { throw RelayFrameError.inflate }
        var stream = compression_stream(dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!, dst_size: 0,
                                        src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!, src_size: 0, state: nil)
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else {
            throw RelayFrameError.inflate
        }
        defer { compression_stream_destroy(&stream) }
        let bufferSize = 64 * 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        var output = Data()
        return try data.withUnsafeBytes { (source: UnsafeRawBufferPointer) -> Data in
            guard let base = source.bindMemory(to: UInt8.self).baseAddress else { throw RelayFrameError.inflate }
            stream.src_ptr = base
            stream.src_size = source.count
            while true {
                stream.dst_ptr = buffer
                stream.dst_size = bufferSize
                let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = bufferSize - stream.dst_size
                if output.count + produced > limit { throw RelayFrameError.tooLarge }
                output.append(buffer, count: produced)
                switch status {
                case COMPRESSION_STATUS_END: return output
                case COMPRESSION_STATUS_OK:
                    // Input spent and nothing more produced: a truncated stream.
                    if produced == 0 && stream.src_size == 0 { throw RelayFrameError.inflate }
                default: throw RelayFrameError.inflate
                }
            }
        }
    }
    /// For tests and the fixture relay: the matching raw DEFLATE encoder.
    static func deflate(_ data: Data) throws -> Data {
        let capacity = data.count + 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        defer { buffer.deallocate() }
        let count = data.withUnsafeBytes { source in
            compression_encode_buffer(buffer, capacity, source.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
        }
        guard count > 0 else { throw RelayFrameError.inflate }
        return Data(bytes: buffer, count: count)
    }
}
