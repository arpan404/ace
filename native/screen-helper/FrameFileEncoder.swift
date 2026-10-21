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
/// `{"op":"bitrate","bitrate":b}` (in place, no keyframe) and `{"op":"keyframe"}`. Packets go to
/// stdout in the capture's own framing (length, JSON header, Annex B). Only the newest picture
/// waits while one encodes. End of stdin ends the process.
enum FrameFileEncoder {
    private struct Note { let seq: UInt64; let width: Int; let height: Int; let ts: Double }

    static func run(path: String) -> Never {
        let descriptor = open(path, O_RDONLY)
        guard descriptor >= 0 else { FileHandle.standardError.write(Data("cannot open frames\n".utf8)); exit(3) }
        let queue = DispatchQueue(label: "ace.frames.encode")
        let output = FileHandle.standardOutput
        var mapped: (pointer: UnsafeMutableRawPointer, length: Int)?
        var pool: (pool: CVPixelBufferPool, width: Int, height: Int)?
        var latest: LatestVideoFrames<Note>!
        let encoder = VideoEncoder(sessionId: "emulator", version: 2,
            publish: { packet in output.write(packet) },
            completed: { queue.async { latest.completed() } }, keyframeInterval: 20)
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
        func picture(_ note: Note) -> CVPixelBuffer? {
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
        latest = LatestVideoFrames<Note> { note in
            if encoder.busyNow { return .busy }
            guard let image = picture(note) else { return .unavailable }
            return encoder.encode(image, sequence: note.seq, timestamp: note.ts, scale: 1,
                at: DispatchTime.now().uptimeNanoseconds)
        }
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
                    latest.offer(Note(seq: seq, width: width, height: height, ts: ts))
                case "bitrate":
                    if let bitrate = (object["bitrate"] as? NSNumber)?.intValue, (128_000...40_000_000).contains(bitrate) {
                        encoder.retune(bitrate: bitrate)
                    }
                case "keyframe":
                    encoder.requestKeyframe()
                default: break
                }
            }
        }
        queue.sync { encoder.close() }
        exit(0)
    }
}
