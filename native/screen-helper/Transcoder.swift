import Foundation
import CoreMedia
import VideoToolbox

/// `ace-screen-helper --transcode`: re-encodes an H.264 stream another tool already encodes (the
/// iOS Simulator's, from serve-sim, at its fixed 6 Mbit/s and native size) at the size and bit
/// rate a viewer's link carries, with the Mac's hardware decoder and encoder. The daemon uses it
/// only while a viewer needs less than the source sends; otherwise the source passes through.
///
/// stdin and stdout use the capture's packet framing: a 4-byte length, a JSON header, then
/// `bytes` of payload. In: `{"op":"frame","keyframe":k,"seq":n,"ts":ms,"bytes":b}` + Annex B
/// (parameter sets before each IDR), `{"op":"settings","bitrate":b,"maxWidth":w,"maxHeight":h}`
/// and `{"op":"keyframe"}`. Out: H.264 frame packets. End of stdin ends the process.
enum Transcoder {
    private static let queue = DispatchQueue(label: "ace.transcode")

    static func run() -> Never {
        let output = FileHandle.standardOutput
        var state: TranscodeState!
        let encoder = VideoEncoder(sessionId: "simulator", version: 2,
            publish: { packet in output.write(packet) },
            completed: { queue.async { state.completed() } }, keyframeInterval: 20)
        encoder.configure(bitrate: 6_000_000, fps: 60)
        state = TranscodeState(encoder: encoder, now: { DispatchTime.now().uptimeNanoseconds })
        let input = FileHandle.standardInput
        var pending = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty { break }
            pending.append(chunk)
            while let (header, payload, used) = packet(in: pending) {
                pending.removeSubrange(0..<used)
                queue.sync { state.handle(header, payload) }
            }
        }
        queue.sync { state.close() }
        exit(0)
    }

    /// One whole packet at the front of `data`, when it has arrived.
    private static func packet(in data: Data) -> ([String: Any], Data, Int)? {
        guard data.count >= 4 else { return nil }
        let start = data.startIndex
        let length = Int(data[start]) << 24 | Int(data[start + 1]) << 16 | Int(data[start + 2]) << 8 | Int(data[start + 3])
        guard length > 0, length <= 4096, data.count >= 4 + length,
              let header = try? JSONSerialization.jsonObject(with: data.subdata(in: start + 4..<start + 4 + length)) as? [String: Any]
        else { return nil }
        let bytes = (header["bytes"] as? NSNumber)?.intValue ?? 0
        guard bytes >= 0, bytes <= 16 * 1024 * 1024, data.count >= 4 + length + bytes else { return nil }
        let payload = data.subdata(in: start + 4 + length..<start + 4 + length + bytes)
        return (header, payload, 4 + length + bytes)
    }
}

/// What the transcoder needs of its encoder; tests stand in for the hardware one.
protocol TranscodeEncoder: AnyObject {
    var busyNow: Bool { get }
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality) -> VideoEncodeResult
    func requestKeyframe()
    func retune(bitrate: Int)
    func close()
}
extension VideoEncoder: TranscodeEncoder {}

/// A decoded picture waiting to be encoded.
struct TranscodePicture {
    let image: CVPixelBuffer
    let seq: UInt64
    let ts: Double
}

/// Decoder, scaler and encoder for one stream; used only on the transcoder's queue. While the
/// encoder is busy the newest decoded picture waits and goes in when it completes (`completed`),
/// so the last change before the Simulator goes still is never lost. A keyframe request or a new
/// size encodes the last picture again: a still screen sends nothing that would carry them.
final class TranscodeState {
    private let encoder: TranscodeEncoder
    private let now: () -> UInt64
    private var frames: LatestVideoFrames<TranscodePicture>!
    private var last: TranscodePicture?
    private var format: CMVideoFormatDescription?
    private var parameterSets: [Data] = []
    private var decoder: VTDecompressionSession?
    private var transfer: VTPixelTransferSession?
    private var pool: (pool: CVPixelBufferPool, width: Int, height: Int)?
    private var maxWidth = 3840, maxHeight = 3840
    private var decoded: (CVPixelBuffer, UInt64, Double)?

    init(encoder: TranscodeEncoder, now: @escaping () -> UInt64) {
        self.encoder = encoder
        self.now = now
        frames = LatestVideoFrames { [unowned self] picture in self.submit(picture) }
    }

    /// The encoder finished a picture (or rate control dropped it): the waiting one goes in.
    func completed() { frames.completed() }

    /// A decoded picture from serve-sim's stream.
    func picture(_ image: CVPixelBuffer, seq: UInt64, ts: Double) {
        let picture = TranscodePicture(image: image, seq: seq, ts: ts)
        last = picture
        frames.offer(picture)
    }

    func handle(_ header: [String: Any], _ payload: Data) {
        switch header["op"] as? String {
        case "settings":
            if let bitrate = (header["bitrate"] as? NSNumber)?.intValue, (128_000...40_000_000).contains(bitrate) {
                encoder.retune(bitrate: bitrate)
            }
            let box = (maxWidth, maxHeight)
            if let width = (header["maxWidth"] as? NSNumber)?.intValue, (64...3840).contains(width) { maxWidth = width }
            if let height = (header["maxHeight"] as? NSNumber)?.intValue, (64...3840).contains(height) { maxHeight = height }
            if box != (maxWidth, maxHeight) { replay() }
        case "keyframe":
            encoder.requestKeyframe()
            replay()
        case "frame":
            let seq = (header["seq"] as? NSNumber)?.uint64Value ?? 0
            let ts = (header["ts"] as? NSNumber)?.doubleValue ?? 0
            decode(payload, seq: seq, ts: ts)
        default:
            break
        }
    }

    /// Annex B → NAL units, without their start codes.
    private func units(_ data: Data) -> [Data] {
        var result: [Data] = []
        let bytes = [UInt8](data)
        var index = 0, start = -1
        while index + 3 <= bytes.count {
            let three = bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 2] == 1
            let four = index + 4 <= bytes.count && bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 2] == 0 && bytes[index + 3] == 1
            if three || four {
                if start >= 0 { result.append(Data(bytes[start..<index])) }
                index += four ? 4 : 3
                start = index
            } else { index += 1 }
        }
        if start >= 0, start < bytes.count { result.append(Data(bytes[start..<bytes.count])) }
        return result.filter { !$0.isEmpty }
    }

    private func decode(_ payload: Data, seq: UInt64, ts: Double) {
        let nals = units(payload)
        let sets = nals.filter { [7, 8].contains($0.first.map { Int($0 & 0x1f) } ?? 0) }
        if sets.count >= 2, sets != parameterSets { configureDecoder(sets) }
        guard let format, let decoder else { return }
        // The sample: every slice NAL with a 4-byte length; parameter sets and delimiters stay out.
        var sample = Data()
        for nal in nals where ![7, 8, 9].contains(Int(nal.first.map { $0 & 0x1f } ?? 0)) {
            var length = UInt32(nal.count).bigEndian
            withUnsafeBytes(of: &length) { sample.append(contentsOf: $0) }
            sample.append(nal)
        }
        guard !sample.isEmpty else { return }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: sample.count, blockAllocator: nil,
            customBlockSource: nil, offsetToData: 0, dataLength: sample.count, flags: 0, blockBufferOut: &block) == noErr, let block else { return }
        let copied = sample.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: sample.count) }
        guard copied == noErr else { return }
        var buffer: CMSampleBuffer?
        var sizes = [sample.count]
        guard CMSampleBufferCreateReady(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: 1,
            sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 1, sampleSizeArray: &sizes,
            sampleBufferOut: &buffer) == noErr, let buffer else { return }
        decoded = nil
        // Synchronous: the picture is ready when this returns, still on the transcoder's queue.
        let status = VTDecompressionSessionDecodeFrame(decoder, sampleBuffer: buffer, flags: [], infoFlagsOut: nil) { [weak self] status, _, image, _, _ in
            guard status == noErr, let image, let self else { return }
            self.decoded = (image, seq, ts)
        }
        if status != noErr { encoder.requestKeyframe(); return }
        if let (image, seq, ts) = decoded { picture(image, seq: seq, ts: ts) }
    }

    private func configureDecoder(_ sets: [Data]) {
        if let decoder { VTDecompressionSessionInvalidate(decoder) }
        decoder = nil; format = nil
        let pointers = sets.map { [UInt8]($0) }
        var created: CMFormatDescription?
        let status = pointers[0].withUnsafeBufferPointer { sps in
            pointers[1].withUnsafeBufferPointer { pps in
                let list = [sps.baseAddress!, pps.baseAddress!]
                let sizes = [sps.count, pps.count]
                return CMVideoFormatDescriptionCreateFromH264ParameterSets(allocator: nil, parameterSetCount: 2,
                    parameterSetPointers: list, parameterSetSizes: sizes, nalUnitHeaderLength: 4, formatDescriptionOut: &created)
            }
        }
        guard status == noErr, let created else { return }
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        let specification: [CFString: Any] = [kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: true]
        var session: VTDecompressionSession?
        guard VTDecompressionSessionCreate(allocator: nil, formatDescription: created, decoderSpecification: specification as CFDictionary,
            imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &session) == noErr, let session else { return }
        VTSessionSetProperty(session, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        format = created; decoder = session; parameterSets = sets
        encoder.requestKeyframe()
    }

    /// The last picture again, for a keyframe or a new size that no new picture may bring.
    private func replay() {
        if let last { frames.offer(last) }
    }

    /// The picture fitted inside the viewer's box (never larger than it came), then encoded.
    private func submit(_ next: TranscodePicture) -> VideoEncodeResult {
        if encoder.busyNow { return .busy }
        let image = next.image
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        let scale = min(1, Double(maxWidth) / Double(width), Double(maxHeight) / Double(height))
        let target = (width: max(64, Int(Double(width) * scale) & ~1), height: max(64, Int(Double(height) * scale) & ~1))
        var picture = image
        if target.width != width || target.height != height, let scaled = fitted(image, to: target) { picture = scaled }
        return encoder.encode(picture, sequence: next.seq, timestamp: next.ts, scale: 1, at: now(), quality: .motion)
    }

    private func fitted(_ image: CVPixelBuffer, to size: (width: Int, height: Int)) -> CVPixelBuffer? {
        if transfer == nil {
            var created: VTPixelTransferSession?
            guard VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &created) == noErr else { return nil }
            transfer = created
        }
        if pool == nil || pool!.width != size.width || pool!.height != size.height {
            var created: CVPixelBufferPool?
            let attributes: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: size.width, kCVPixelBufferHeightKey: size.height,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &created) == kCVReturnSuccess, let created else { return nil }
            pool = (created, size.width, size.height)
        }
        var out: CVPixelBuffer?
        guard let transfer, let current = pool?.pool, CVPixelBufferPoolCreatePixelBuffer(nil, current, &out) == kCVReturnSuccess, let out,
              VTPixelTransferSessionTransferImage(transfer, from: image, to: out) == noErr else { return nil }
        return out
    }

    func close() {
        frames.clear()
        last = nil
        if let decoder { VTDecompressionSessionInvalidate(decoder) }
        if let transfer { VTPixelTransferSessionInvalidate(transfer) }
        encoder.close()
    }
}
