import AppKit
import CoreImage
import VideoToolbox

/*
 * Text sharpness of the live view as a viewer decodes it. Renders a window of UI text at 2x,
 * scrolls it for 30 frames (motion), then holds it still, through the helper's own encoders.
 * Every packet is decoded with VideoToolbox (what WebCodecs uses on a Mac) and compared with
 * the source: luma PSNR and the mean error on text edges (0 is pixel-identical). Built by
 * bench-stream.sh; `-D REFINE` builds the refine-on-idle step (absent before #1130).
 */
let width = 1600, height = 1000
/// Pipeline.swift's permission check names the helper's error type; the bench never throws it.
struct HelperError: Error { init(_ message: String, code: String = "internal") {} }

func pixelBuffer() -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferCGBitmapContextCompatibilityKey: true]
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
    return buffer!
}
func draw(_ buffer: CVPixelBuffer, offset: Int) {
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    let context = CGContext(data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    context.setFillColor(NSColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(NSColor(calibratedWhite: 0.93, alpha: 1).cgColor); context.fill(CGRect(x: 0, y: height - 80, width: width, height: 80))
    NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
    let text = "The quick brown fox jumps over the lazy dog 0123456789 — Settings › General › About ({[]}) ilI1|"
    for line in 0..<30 {
        let font = NSFont.systemFont(ofSize: line % 3 == 0 ? 22 : 26)
        (text as NSString).draw(at: CGPoint(x: 20, y: height - 120 - line * 30 + offset),
            withAttributes: [.font: font, .foregroundColor: line % 5 == 0 ? NSColor.systemBlue : NSColor.black])
    }
    NSGraphicsContext.current = nil
}
func luma(_ buffer: CVPixelBuffer) -> [Float] {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
    var out = [Float](repeating: 0, count: width * height)
    for y in 0..<height { for x in 0..<width {
        let pixel = base + y * stride + x * 4
        out[y * width + x] = 0.0722 * Float(pixel[0]) + 0.7152 * Float(pixel[1]) + 0.2126 * Float(pixel[2])
    } }
    return out
}
struct Quality { let psnr: Double; let textError: Double }
func compare(_ source: [Float], _ decoded: [Float]) -> Quality {
    var squared = 0.0, edge = 0.0, edges = 0
    for y in 1..<height - 1 { for x in 1..<width - 1 {
        let index = y * width + x, error = Double(abs(source[index] - decoded[index]))
        squared += error * error
        if abs(source[index + 1] - source[index - 1]) + abs(source[index + width] - source[index - width]) > 60 { edge += error; edges += 1 }
    } }
    let mse = squared / Double((width - 2) * (height - 2))
    return Quality(psnr: (10 * log10(255 * 255 / max(mse, 1e-9)) * 100).rounded() / 100, textError: (edge / Double(max(edges, 1)) * 100).rounded() / 100)
}

/// Decodes the helper's packets (u32 header length, JSON, Annex B) as a viewer would.
final class Decoder {
    private var session: VTDecompressionSession?
    private var format: CMFormatDescription?
    var latest: CVPixelBuffer?
    func decode(_ packet: Data) {
        let headerLength = Int(packet.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
        let body = [UInt8](packet.dropFirst(4 + headerLength))
        var units: [[UInt8]] = []
        var index = 0, start = -1
        while index + 3 < body.count {
            if body[index] == 0, body[index + 1] == 0, body[index + 2] == 0, body[index + 3] == 1 {
                if start >= 0 { units.append(Array(body[start..<index])) }
                index += 4; start = index
            } else { index += 1 }
        }
        if start >= 0 { units.append(Array(body[start...])) }
        let sets = units.filter { [7, 8].contains($0[0] & 0x1f) }
        if sets.count == 2 {
            var created: CMFormatDescription?
            sets[0].withUnsafeBufferPointer { sps in sets[1].withUnsafeBufferPointer { pps in
                let pointers = [sps.baseAddress!, pps.baseAddress!], sizes = [sps.count, pps.count]
                CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2, parameterSetPointers: pointers,
                    parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &created)
            } }
            if let created, format.map({ !CMFormatDescriptionEqual($0, otherFormatDescription: created) }) ?? true {
                if let session { VTDecompressionSessionInvalidate(session) }
                let attributes: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA]
                VTDecompressionSessionCreate(allocator: nil, formatDescription: created, decoderSpecification: nil,
                    imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &session)
                format = created
            }
        }
        var avcc = Data()
        for unit in units where ![7, 8].contains(unit[0] & 0x1f) {
            var length = UInt32(unit.count).bigEndian
            withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
            avcc.append(contentsOf: unit)
        }
        guard let session, let format, !avcc.isEmpty else { return }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: avcc.count, blockAllocator: nil, customBlockSource: nil,
            offsetToData: 0, dataLength: avcc.count, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        avcc.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block!, offsetIntoDestination: 0, dataLength: avcc.count) }
        var sample: CMSampleBuffer?
        var size = avcc.count
        CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0,
            sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample!, flags: [], infoFlagsOut: nil) { _, _, image, _, _ in
            if let image { self.latest = image }
        }
        VTDecompressionSessionWaitForAsynchronousFrames(session)
    }
}

let frames = (0..<30).map { step -> CVPixelBuffer in let buffer = pixelBuffer(); draw(buffer, offset: step * 3); return buffer }
let still = luma(frames[frames.count - 1])
var report: [String: Any] = ["frame": "\(width)x\(height) dense UI text at 2x, 30 scrolled frames then still"]

for bitrate in [1_200_000, 2_500_000, 6_000_000] {
    var packets: [Data] = []
    let lock = NSLock(), done = DispatchSemaphore(value: 0)
    var drops = 0
    #if REFINE
    let encoder = VideoEncoder(sessionId: "bench", version: 2, publish: { packet in lock.lock(); packets.append(packet); lock.unlock() },
        completed: { done.signal() }, dropped: { _ in drops += 1 })
    #else
    let encoder = VideoEncoder(sessionId: "bench", version: 2, publish: { packet in lock.lock(); packets.append(packet); lock.unlock() }, completed: { done.signal() })
    #endif
    encoder.configure(bitrate: bitrate, fps: 60)
    var sequence: UInt64 = 0
    // Simulated capture clock: frames 1/60 s apart, the refine after the 300 ms idle.
    var clock: UInt64 = 1_000_000_000
    func submit(_ image: CVPixelBuffer, refine: Bool) -> Double {
        clock += refine ? 300_000_000 : 16_666_667
        let started = DispatchTime.now().uptimeNanoseconds
        #if REFINE
        guard encoder.encode(image, sequence: sequence, timestamp: 0, scale: 2, at: clock, quality: refine ? .refine : .motion) == .submitted else { return 0 }
        #else
        guard encoder.encode(image, sequence: sequence, timestamp: 0, scale: 2) == .submitted else { return 0 }
        #endif
        sequence += 1
        done.wait()
        return Double(DispatchTime.now().uptimeNanoseconds - started) / 1e6
    }
    let decoder = Decoder()
    var encodeMs: [Double] = []
    for frame in frames { encodeMs.append(submit(frame, refine: false)) }
    let motionBytes = packets.reduce(0) { $0 + $1.count }
    for packet in packets { decoder.decode(packet) }
    let motion = decoder.latest.map { compare(still, luma($0)) }
    var entry: [String: Any] = [
        "motionKbPerFrame": motionBytes / max(packets.count, 1) / 1024, "encodedFrames": packets.count,
        "encodeMsMean": (encodeMs.reduce(0, +) / Double(encodeMs.count) * 10).rounded() / 10,
        "stillAfterMotion": ["psnr": motion?.psnr ?? 0, "textError": motion?.textError ?? 0],
    ]
    #if REFINE
    packets.removeAll()
    // As the capture does: a dropped refine is retried after another idle interval.
    var refine = RefineOnIdle()
    refine.changed(at: clock)
    var refineMs = 0.0, attempts = 0
    while refine.due(at: clock + 300_000_000) {
        let before = drops
        refineMs = submit(frames[frames.count - 1], refine: true)
        refine.sent(); attempts += 1
        if drops > before { refine.dropped(at: clock) }
    }
    for packet in packets { decoder.decode(packet) }
    let refined = decoder.latest.map { compare(still, luma($0)) }
    entry["stillAfterRefine"] = ["psnr": refined?.psnr ?? 0, "textError": refined?.textError ?? 0,
        "refineKb": packets.reduce(0) { $0 + $1.count } / 1024, "encodeMs": (refineMs * 10).rounded() / 10, "attempts": attempts]
    #endif
    report["h264 \(Double(bitrate) / 1e6) Mbps"] = entry
    encoder.close()
}

let jpeg = JPEGEncoder(context: CIContext(options: [.cacheIntermediates: false]))
func jpegQualityReport(_ packet: Data?) -> [String: Any] {
    guard let packet else { return [:] }
    let headerLength = Int(packet.prefix(4).reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
    let image = NSBitmapImageRep(data: packet.dropFirst(4 + headerLength))!.cgImage!
    let decoded = pixelBuffer()
    CVPixelBufferLockBaseAddress(decoded, [])
    CGContext(data: CVPixelBufferGetBaseAddress(decoded), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(decoded),
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        .draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    CVPixelBufferUnlockBaseAddress(decoded, [])
    let quality = compare(still, luma(decoded))
    return ["kb": packet.count / 1024, "psnr": quality.psnr, "textError": quality.textError]
}
report["jpeg motion"] = jpegQualityReport(jpeg.packet(image: frames[frames.count - 1], sessionId: "bench", sequence: 0, timestamp: 0))
#if REFINE
report["jpeg refine"] = jpegQualityReport(jpeg.packet(image: frames[frames.count - 1], sessionId: "bench", sequence: 0, timestamp: 0, quality: jpegQuality(.refine)))
#endif
let json = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: json, as: UTF8.self))
