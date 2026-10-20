import Foundation
import VideoToolbox

private final class VideoFrame {
    let sequence: UInt64
    let timestamp: Double
    let scale: Double
    let quality: StreamQuality
    init(_ sequence: UInt64, _ timestamp: Double, _ scale: Double, _ quality: StreamQuality) {
        self.sequence = sequence; self.timestamp = timestamp; self.scale = scale; self.quality = quality
    }
}

/// Hardware encoder with one outstanding sample. No B frames, lookahead or raw-pixel queue.
/// H.264 High at a fixed level, so a refine keyframe never changes the decoder configuration.
final class VideoEncoder {
    private var session: VTCompressionSession?
    private var size = CGSize.zero
    private let lock = NSLock()
    private var busy = false
    private var keyframe = true
    private var bitrate = 4_000_000
    private var fps = 60
    /// The QP cap the session runs with now; nil is uncapped (rate control alone).
    private var appliedQP: Int?
    private let sessionId: String
    private let version: Int
    private let publish: (Data) -> Void
    private let completed: () -> Void
    /// Rate control dropped a frame of this quality (no sample, no error).
    private let dropped: (StreamQuality) -> Void
    init(sessionId: String, version: Int, publish: @escaping (Data) -> Void, completed: @escaping () -> Void, dropped: @escaping (StreamQuality) -> Void = { _ in }) {
        self.sessionId = sessionId; self.version = version; self.publish = publish; self.completed = completed; self.dropped = dropped
    }
    func requestKeyframe() { lock.lock(); keyframe = true; lock.unlock() }
    func configure(bitrate: Int, fps: Int) {
        self.bitrate = bitrate; self.fps = fps
        if let session {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
        }
        requestKeyframe()
    }
    private func prepare(_ image: CVPixelBuffer) -> Bool {
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        if size == CGSize(width: width, height: height), session != nil { return true }
        close()
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true
        ]
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, frame, status, _, sample in
                guard let frame else { return }
                let entry = Unmanaged<VideoFrame>.fromOpaque(frame).takeRetainedValue()
                guard let context else { return }
                let encoder = Unmanaged<VideoEncoder>.fromOpaque(context).takeUnretainedValue()
                defer { encoder.lock.lock(); encoder.busy = false; encoder.lock.unlock(); encoder.completed() }
                // Rate control may drop a frame (no sample, no error); the stream stays decodable.
                // Forcing a keyframe then would overspend again and drop again, so only an
                // encoder error asks for one.
                guard status == noErr else { encoder.requestKeyframe(); return }
                guard let sample else { encoder.dropped(entry.quality); return }
                encoder.output(sample, entry)
            }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &session)
        guard status == noErr, let session else { return false }
        size = CGSize(width: width, height: height)
        appliedQP = nil
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // High (8x8 transforms, CABAC) keeps text edges at a given bitrate better than Baseline.
        // Level 5.1 covers every capture size (up to 4096×2304) and every client decoder.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_5_1)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1 as CFNumber)
        configure(bitrate: bitrate, fps: fps)
        return VTCompressionSessionPrepareToEncodeFrames(session) == noErr
    }
    /// Applies a frame's QP cap when it differs from the session's (51 is H.264's ceiling: no cap).
    private func apply(_ settings: VideoEncoderSettings, to session: VTCompressionSession) {
        guard settings.maxFrameQP != appliedQP else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: (settings.maxFrameQP ?? 51) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (settings.maxFrameQP == nil ? bitrate : 40_000_000) as CFNumber)
        appliedQP = settings.maxFrameQP
    }
    /// `at` is the capture time in uptime nanoseconds. Presentation times follow it, so rate
    /// control sees the idle time before a refine and does not drop it as over budget.
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality = .motion) -> VideoEncodeResult {
        lock.lock(); let occupied = busy; lock.unlock()
        if occupied { return .busy }
        guard prepare(image), let session else { return .unavailable }
        let settings = videoEncoderSettings(quality, bitrate: bitrate, width: Int(size.width), height: Int(size.height))
        apply(settings, to: session)
        lock.lock(); let force = keyframe || settings.keyframe; keyframe = false; busy = true; lock.unlock()
        let entry = Unmanaged.passRetained(VideoFrame(sequence, timestamp, scale, quality)).toOpaque()
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: image,
            presentationTimeStamp: CMTime(value: Int64(at / 1_000), timescale: 1_000_000), duration: .invalid,
            frameProperties: force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil,
            sourceFrameRefcon: entry, infoFlagsOut: nil)
        if status != noErr {
            Unmanaged<VideoFrame>.fromOpaque(entry).release()
            lock.lock(); busy = false; keyframe = true; lock.unlock()
            return .unavailable
        }
        return .submitted
    }
    /// One packet: length, JSON header, then Annex B (parameter sets on keyframes). The sample's
    /// 4-byte NAL lengths are rewritten to start codes in place, so the payload is copied once.
    private func output(_ sample: CMSampleBuffer, _ entry: VideoFrame) {
        guard let format = sample.formatDescription, let block = sample.dataBuffer else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        let prefix: [UInt8] = [0, 0, 0, 1]
        var parameterSets: [(UnsafePointer<UInt8>, Int)] = []
        var codec = "avc1.640033"
        if key {
            for index in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var length = 0
                guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &length, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
                    let pointer else { return }
                parameterSets.append((pointer, length))
                if index == 0, length >= 4 { codec = String(format: "avc1.%02X%02X%02X", pointer[1], pointer[2], pointer[3]) }
            }
        }
        let sampleBytes = CMBlockBufferGetDataLength(block)
        let payloadBytes = sampleBytes + parameterSets.reduce(0) { $0 + prefix.count + $1.1 }
        guard sampleBytes > 0, payloadBytes <= 8 * 1024 * 1024 else { return }
        var header: [String: Any] = ["version": version, "sessionId": sessionId, "width": Int(size.width), "height": Int(size.height),
            "codec": "h264", "keyframe": key, "bytes": payloadBytes, "scale": entry.scale]
        if key { header["videoCodec"] = codec }
        header[version == 1 ? "sequence" : "seq"] = entry.sequence
        header[version == 1 ? "timestamp" : "ts"] = entry.timestamp
        guard let json = try? JSONSerialization.data(withJSONObject: header), json.count <= 4096 else { return }
        var length = UInt32(json.count).bigEndian
        var packet = Data(capacity: 4 + json.count + payloadBytes)
        withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
        packet.append(json)
        for (pointer, count) in parameterSets { packet.append(contentsOf: prefix); packet.append(pointer, count: count) }
        let start = packet.count
        packet.count += sampleBytes
        let copied = packet.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: sampleBytes, destination: bytes.baseAddress! + start) == noErr
        }
        guard copied, Self.startCodes(&packet, from: start) else { return }
        publish(packet)
    }
    /// Rewrites each 4-byte big-endian NAL length from `start` on as a start code; false when the
    /// lengths do not tile the sample exactly.
    static func startCodes(_ packet: inout Data, from start: Int) -> Bool {
        packet.withUnsafeMutableBytes { raw -> Bool in
            let bytes = raw.bindMemory(to: UInt8.self)
            var offset = start
            while offset + 4 <= bytes.count {
                let length = (0..<4).reduce(0) { ($0 << 8) | Int(bytes[offset + $1]) }
                guard length > 0, length <= bytes.count - offset - 4 else { return false }
                bytes[offset] = 0; bytes[offset + 1] = 0; bytes[offset + 2] = 0; bytes[offset + 3] = 1
                offset += 4 + length
            }
            return offset == bytes.count
        }
    }
    func close() {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(session) }
        session = nil; size = .zero; appliedQP = nil
    }
    deinit { close() }
}
