import Foundation
import Darwin

/// MediaFrame v1, ace-media's ingest framing (docs/media/plan.md, "Ingest framing"). Big endian.
struct MediaFrameFields {
    var kind: UInt8
    var flags: UInt32 = 0
    var ageUs: UInt32 = 0
    var width: UInt16 = 0
    var height: UInt16 = 0
    var displayWidth: UInt16 = 0
    var displayHeight: UInt16 = 0
    var scale: UInt16 = 1000
    var rotation: UInt8 = 0
    var codec: UInt8 = 0
    var encode: UInt32 = 0
    var epoch: UInt32 = 0
    var codecString: [UInt8] = []
    var description: [UInt8] = []
    var extensionBytes: [UInt8] = []
}

enum MediaFrameKind {
    static let video: UInt8 = 1
    static let hello: UInt8 = 5
}
enum MediaFrameCodec { static let h264AnnexB: UInt8 = 1 }
let mediaFrameKeyframe: UInt32 = 1

/// The header of one MediaFrame, with room reserved for its payload. Nil when it can't be framed.
func mediaFrameHeader(_ fields: MediaFrameFields, payloadBytes: Int) -> Data? {
    let length = 44 + fields.codecString.count + fields.description.count + fields.extensionBytes.count
    guard length <= 4096, payloadBytes >= 0, payloadBytes <= 8 * 1024 * 1024, fields.codecString.allSatisfy({ $0 < 128 }) else { return nil }
    var data = Data(capacity: length + payloadBytes)
    func u8(_ value: UInt8) { data.append(value) }
    func u16(_ value: UInt16) { data.append(UInt8(value >> 8)); data.append(UInt8(value & 0xff)) }
    func u32(_ value: UInt32) { u16(UInt16(value >> 16)); u16(UInt16(value & 0xffff)) }
    u32(0x4143_454d); u8(1); u8(fields.kind); u16(UInt16(length)); u32(UInt32(payloadBytes))
    u32(fields.flags); u32(fields.ageUs)
    u16(fields.width); u16(fields.height); u16(fields.displayWidth); u16(fields.displayHeight)
    u16(fields.scale); u8(fields.rotation); u8(fields.codec)
    u32(fields.encode); u32(fields.epoch)
    u16(UInt16(fields.codecString.count)); u16(UInt16(fields.description.count))
    data.append(contentsOf: fields.codecString); data.append(contentsOf: fields.description); data.append(contentsOf: fields.extensionBytes)
    return data
}

/// The producer stamp, a header extension (docs/media/plan.md, "Producer stamp"): tag 1, length
/// 24, the helper's own frame sequence, its capture time in Unix milliseconds and its exact
/// pixels-per-point scale. The daemon rebuilds today's frame header from it after egress.
func producerStamp(sequence: UInt64, timestamp: Double, scale: Double) -> [UInt8] {
    var bytes: [UInt8] = [0, 1, 0, 24]
    for value in [sequence, timestamp.bitPattern, scale.bitPattern] {
        for shift in stride(from: 56, through: 0, by: -8) { bytes.append(UInt8((value >> UInt64(shift)) & 0xff)) }
    }
    return bytes
}

/// One encoded video unit as a MediaFrame. `now` is uptime nanoseconds, for the unit's age.
func ingestFrame(_ unit: EncodedVideo, now: UInt64) -> Data? {
    guard unit.width > 0, unit.height > 0, unit.width <= 0xffff, unit.height <= 0xffff, unit.scale > 0, unit.scale.isFinite else { return nil }
    let display = { (pixels: Int) in UInt16(min(0xffff, max(1, Int((Double(pixels) / unit.scale).rounded())))) }
    let fields = MediaFrameFields(kind: MediaFrameKind.video, flags: unit.keyframe ? mediaFrameKeyframe : 0,
        ageUs: UInt32(min(UInt64(UInt32.max), now > unit.capturedAt ? (now - unit.capturedAt) / 1_000 : 0)),
        width: UInt16(unit.width), height: UInt16(unit.height), displayWidth: display(unit.width), displayHeight: display(unit.height),
        scale: UInt16(min(65_535, max(1, (unit.scale * 1000).rounded()))), codec: MediaFrameCodec.h264AnnexB, epoch: unit.epoch,
        codecString: Array((unit.codec ?? "").utf8), extensionBytes: producerStamp(sequence: unit.sequence, timestamp: unit.timestamp, scale: unit.scale))
    guard let header = mediaFrameHeader(fields, payloadBytes: unit.payloadBytes) else { return nil }
    return unit.packet(header)
}

/// A connection to ace-media's ingest socket. Every unit is written in order; none is coalesced.
/// Past `limit` queued bytes deltas are dropped to the next keyframe, and one is asked for, so
/// a stalled reader never grows the helper and the stream stays decodable. A connection that
/// fails or that ace-media closes is reported once through `onClosed`; it never ends the helper.
final class IngestWriter {
    static let limit = 4 * 1024 * 1024
    private let fd: Int32
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "ace.screen.ingest")
    private var pending: [Data] = []
    private var head = 0
    private var offset = 0
    private var queuedBytes = 0
    private var skipping = false
    private var finishing = false
    private var closed = false
    private var suspended = true
    private let writable: DispatchSourceWrite
    private let readable: DispatchSourceRead
    private let onClosed: () -> Void
    private let onKeyframe: () -> Void

    /// Connects and queues the hello, whose payload is the source's single-use 32-byte token.
    init(path: String, token: Data, onClosed: @escaping () -> Void, onKeyframe: @escaping () -> Void) throws {
        guard token.count == 32 else { throw HelperError("Ingest token must be 32 bytes", code: "bounds") }
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperError("Cannot create ingest socket") }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { Darwin.close(fd); throw HelperError("Ingest socket path exceeds limit", code: "bounds") }
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in buffer.copyBytes(from: bytes) }
        let socketFd = fd
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(socketFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { Darwin.close(fd); throw HelperError("Cannot connect ingest socket", code: "target_gone") }
        _ = fcntl(fd, F_SETFL, O_NONBLOCK)
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        self.onClosed = onClosed; self.onKeyframe = onKeyframe
        writable = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
        readable = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        writable.setEventHandler { [weak self] in self?.flush() }
        // ace-media never writes on ingest: readable means it closed the connection.
        readable.setEventHandler { [weak self] in self?.drainReads() }
        // The descriptor closes once neither source can touch it.
        let sources = DispatchGroup(), descriptor = fd
        sources.enter(); sources.enter()
        writable.setCancelHandler { sources.leave() }
        readable.setCancelHandler { sources.leave() }
        sources.notify(queue: queue) { Darwin.close(descriptor) }
        readable.resume()
        guard var hello = mediaFrameHeader(MediaFrameFields(kind: MediaFrameKind.hello), payloadBytes: 32) else { throw HelperError("Cannot frame hello") }
        hello.append(token)
        enqueue(hello)
    }

    /// Queues one unit. False once the connection is closed or finishing.
    @discardableResult func write(_ frame: Data, keyframe: Bool) -> Bool {
        lock.lock()
        guard !closed, !finishing else { lock.unlock(); return false }
        if queuedBytes > Self.limit, !skipping { skipping = true; lock.unlock(); onKeyframe(); lock.lock() }
        if skipping && !keyframe { lock.unlock(); return true }
        skipping = false
        lock.unlock()
        enqueue(frame)
        return true
    }

    /// Bytes of units not yet fully written.
    var queued: Int { lock.lock(); defer { lock.unlock() }; return queuedBytes }
    /// Bytes of payloads the writer still holds, written or not.
    var held: Int { lock.lock(); defer { lock.unlock() }; return pending.reduce(0) { $0 + $1.count } }
    var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

    /// No more units: what is queued is still written, then the connection closes.
    func finish() {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        finishing = true
        if head == pending.count { shut() }
    }

    private func enqueue(_ frame: Data) {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        pending.append(frame); queuedBytes += frame.count
        if suspended { suspended = false; writable.resume() }
    }

    private func flush() {
        lock.lock()
        var failed = false
        while !closed {
            guard head < pending.count else {
                pending.removeAll(keepingCapacity: true); head = 0
                if finishing { shut() } else { suspended = true; writable.suspend() }
                break
            }
            let frame = pending[head]
            let written = frame.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return Darwin.write(fd, base.advanced(by: offset), frame.count - offset)
            }
            if written < 0 {
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                failed = true; shut(); break
            }
            if written == 0 { break }
            offset += written
            if offset == frame.count {
                // A written unit is freed at once, so `limit` bounds what the writer holds.
                queuedBytes -= frame.count; offset = 0
                pending[head] = Data(); head += 1
                if head >= 64 { pending.removeFirst(head); head = 0 }
            }
        }
        lock.unlock()
        if failed { onClosed() }
    }

    private func drainReads() {
        var buffer = [UInt8](repeating: 0, count: 64)
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count > 0 || (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { return }
        lock.lock(); let wasOpen = !closed && !finishing; if !closed { shut() }; lock.unlock()
        if wasOpen { onClosed() }
    }

    /// Under the lock.
    private func shut() {
        guard !closed else { return }
        closed = true
        pending.removeAll(); head = 0; queuedBytes = 0
        if suspended { suspended = false; writable.resume() }
        writable.cancel(); readable.cancel()
    }

    /// Closes at once, dropping what is queued.
    func close() { lock.lock(); shut(); lock.unlock() }
    deinit { close() }
}
