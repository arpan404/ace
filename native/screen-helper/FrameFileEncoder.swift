import Foundation
import Accelerate
import CoreVideo
import Darwin

/// `ace-screen-helper --encode-frames <file>`: H.264 from pictures another process writes into
/// `file`, with the Mac's hardware encoder. An Android emulator's gRPC screenshot stream writes
/// each frame there as RGBA (shared memory), so the emulator never runs a software encoder.
///
/// Commands arrive on stdin, one JSON object per line:
/// `{"op":"frame","seq":n,"width":w,"height":h,"ts":ms}` (the file holds a new picture),
/// `{"op":"bitrate","bitrate":b}` (in place, no keyframe), `{"op":"keyframe"}` and
/// `{"op":"ingest","socket":path,"token":base64}` (send to ace-media's ingest from now on;
/// without `socket`, back to stdout). Packets go to stdout in the capture's own framing (length,
/// JSON header, Annex B), or to ace-media as MediaFrames. Each switch starts at a keyframe and is
/// reported on stderr as one JSON line, `{"event":"ingest","state":"on"|"off"|"closed",
/// "boundary":n|null}`: the last sequence the previous path took. A switch away from ace-media
/// writes every queued unit before the connection closes. Only the newest picture waits while
/// one encodes. End of stdin ends the process.
/// One picture the emulator wrote into the shared file.
struct FrameNote { let seq: UInt64; let width: Int; let height: Int; let ts: Double }

/// The encoding side of `--encode-frames`, used only on its queue. Only the newest picture waits
/// while one encodes, and goes in when it completes. A keyframe request encodes the last picture
/// again when nothing newer waits: a still emulator screen sends no picture that would carry it.
final class FrameFileState {
    private enum Waiting { case fresh(FrameNote), again(CVPixelBuffer, FrameNote) }
    private let encoder: VideoEncoding
    private let picture: (FrameNote) -> CVPixelBuffer?
    private let now: () -> UInt64
    private var frames: LatestVideoFrames<Waiting>!
    /// The last picture read from the file, as it was encoded.
    private var last: (image: CVPixelBuffer, note: FrameNote)?

    init(encoder: VideoEncoding, picture: @escaping (FrameNote) -> CVPixelBuffer?, now: @escaping () -> UInt64) {
        self.encoder = encoder; self.picture = picture; self.now = now
        frames = LatestVideoFrames { [unowned self] waiting in self.submit(waiting) }
    }
    func frame(_ note: FrameNote) { frames.offer(.fresh(note)) }
    func completed() { frames.completed() }
    func keyframe() {
        encoder.requestKeyframe()
        if !frames.waiting, let last { frames.offer(.again(last.image, last.note)) }
    }
    func bitrate(_ bitrate: Int) { encoder.retune(bitrate: bitrate) }
    func close() { frames.clear(); last = nil; encoder.close() }

    private func submit(_ waiting: Waiting) -> VideoEncodeResult {
        if encoder.busyNow { return .busy }
        let image: CVPixelBuffer, note: FrameNote
        switch waiting {
        case .fresh(let fresh):
            guard let read = picture(fresh) else { return .unavailable }
            image = read; note = fresh
            last = (read, fresh)
        case .again(let again, let previous):
            image = again; note = previous
        }
        return encoder.encode(image, sequence: note.seq, timestamp: note.ts, scale: 1, at: now(), quality: .motion)
    }
}

/// Where `--encode-frames` sends each unit: stdout, or ace-media's ingest. The route is read and
/// the unit written under one lock, so a switch has an exact boundary.
final class FrameRoute {
    private let lock = NSLock()
    private let stdout: (Data) -> Void
    private var ingest: IngestWriter?
    private var lastStdout: UInt64?
    private var lastIngest: UInt64?
    init(stdout: @escaping (Data) -> Void) { self.stdout = stdout }
    var ingesting: Bool { lock.lock(); defer { lock.unlock() }; return ingest != nil }
    func publish(_ unit: EncodedVideo) {
        lock.lock(); defer { lock.unlock() }
        if let ingest {
            guard let frame = ingestFrame(unit, now: DispatchTime.now().uptimeNanoseconds), ingest.write(frame, keyframe: unit.keyframe) else { return }
            lastIngest = unit.sequence
        } else if let packet = legacyFramePacket(unit, sessionId: "emulator", version: 2) {
            stdout(packet); lastStdout = unit.sequence
        }
    }
    /// Sends to `next` (nil: stdout) from now on; the last sequence the previous path took.
    func switchTo(_ next: IngestWriter?) -> UInt64? {
        lock.lock()
        let previous = ingest
        let boundary = previous == nil ? lastStdout : lastIngest
        ingest = next
        if next != nil { lastIngest = nil }
        lock.unlock()
        previous?.finish()
        return boundary
    }
    /// The ingest connection `failed` failed: back to stdout. Nil when it was no longer in use.
    func closed(_ failed: IngestWriter) -> UInt64?? {
        lock.lock(); defer { lock.unlock() }
        guard ingest === failed else { return nil }
        ingest = nil
        return .some(lastIngest)
    }
}

/// One `--encode-frames` event on stderr.
private func report(_ state: String, _ boundary: UInt64?) {
    let event: [String: Any] = ["event": "ingest", "state": state, "boundary": boundary.map { $0 as Any } ?? NSNull()]
    if let line = try? JSONSerialization.data(withJSONObject: event) { FileHandle.standardError.write(line + Data([10])) }
}

enum FrameFileEncoder {

    static func run(path: String) -> Never {
        let descriptor = open(path, O_RDONLY)
        guard descriptor >= 0 else { FileHandle.standardError.write(Data("cannot open frames\n".utf8)); exit(3) }
        let queue = DispatchQueue(label: "ace.frames.encode")
        let output = FileHandle.standardOutput
        var mapped: (pointer: UnsafeMutableRawPointer, length: Int)?
        var pool: (pool: CVPixelBufferPool, width: Int, height: Int)?
        var state: FrameFileState!
        let route = FrameRoute(stdout: { packet in output.write(packet) })
        let encoder = VideoEncoder(units: { unit in route.publish(unit) },
            completed: { queue.async { state.completed() } }, keyframeInterval: 20)
        encoder.configure(bitrate: 6_000_000, fps: 60)

        /// The shared file mapped at least `length` long (it grows when the picture does).
        func map(_ length: Int) -> UnsafeMutableRawPointer? {
            if let mapped, mapped.length >= length { return mapped.pointer }
            if let mapped { munmap(mapped.pointer, mapped.length) }
            mapped = nil
            var info = stat()
            guard fstat(descriptor, &info) == 0, Int(info.st_size) >= length else { return nil }
            let size = Int(info.st_size)
            guard let pointer = mmap(nil, size, PROT_READ, MAP_SHARED, descriptor, 0), pointer != MAP_FAILED else { return nil }
            mapped = (pointer, size)
            return pointer
        }
        /// The picture as a BGRA buffer the encoder takes: RGBA channels swapped while copying.
        func picture(_ note: FrameNote) -> CVPixelBuffer? {
            guard note.width > 0, note.height > 0, note.width <= 4096, note.height <= 4096,
                  let source = map(note.width * note.height * 4) else { return nil }
            if pool == nil || pool!.width != note.width || pool!.height != note.height {
                var created: CVPixelBufferPool?
                let attributes: [CFString: Any] = [
                    kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                    kCVPixelBufferWidthKey: note.width, kCVPixelBufferHeightKey: note.height,
                    kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
                ]
                guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &created) == kCVReturnSuccess, let created else { return nil }
                pool = (created, note.width, note.height)
            }
            var buffer: CVPixelBuffer?
            guard let current = pool?.pool, CVPixelBufferPoolCreatePixelBuffer(nil, current, &buffer) == kCVReturnSuccess, let buffer else { return nil }
            CVPixelBufferLockBaseAddress(buffer, [])
            defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
            guard let destination = CVPixelBufferGetBaseAddress(buffer) else { return nil }
            var input = vImage_Buffer(data: source, height: vImagePixelCount(note.height), width: vImagePixelCount(note.width), rowBytes: note.width * 4)
            var result = vImage_Buffer(data: destination, height: vImagePixelCount(note.height), width: vImagePixelCount(note.width), rowBytes: CVPixelBufferGetBytesPerRow(buffer))
            let order: [UInt8] = [2, 1, 0, 3]
            guard vImagePermuteChannels_ARGB8888(&input, &result, order, vImage_Flags(kvImageNoFlags)) == kvImageNoError else { return nil }
            return buffer
        }
        state = FrameFileState(encoder: encoder, picture: picture, now: { DispatchTime.now().uptimeNanoseconds })
        while let line = readLine(strippingNewline: true) {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                  let op = object["op"] as? String else { continue }
            queue.sync {
                switch op {
                case "frame":
                    guard let seq = (object["seq"] as? NSNumber)?.uint64Value,
                          let width = (object["width"] as? NSNumber)?.intValue,
                          let height = (object["height"] as? NSNumber)?.intValue else { return }
                    let ts = (object["ts"] as? NSNumber)?.doubleValue ?? Date().timeIntervalSince1970 * 1000
                    state.frame(FrameNote(seq: seq, width: width, height: height, ts: ts))
                case "bitrate":
                    if let bitrate = (object["bitrate"] as? NSNumber)?.intValue, (128_000...40_000_000).contains(bitrate) {
                        state.bitrate(bitrate)
                    }
                case "keyframe":
                    state.keyframe()
                case "ingest":
                    let socket = object["socket"] as? String
                    let token = (object["token"] as? String).flatMap { Data(base64Encoded: $0) }
                    final class Held { weak var writer: IngestWriter? }
                    let held = Held()
                    let writer = socket.flatMap { socket in token.flatMap { token in
                        try? IngestWriter(path: socket, token: token, onClosed: {
                            queue.async {
                                guard let failed = held.writer, let boundary = route.closed(failed) else { return }
                                report("closed", boundary); state.keyframe()
                            }
                        }, onKeyframe: { queue.async { state.keyframe() } })
                    } }
                    held.writer = writer
                    // A refused address leaves video where it was, and says so.
                    if socket != nil && writer == nil { report(route.ingesting ? "on" : "off", nil); return }
                    let boundary = route.switchTo(writer)
                    report(writer == nil ? "off" : "on", boundary)
                    state.keyframe()
                default: break
                }
            }
        }
        queue.sync { state.close() }
        exit(0)
    }
}
