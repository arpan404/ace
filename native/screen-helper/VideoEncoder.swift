import Foundation
import VideoToolbox

private final class VideoFrame {
    let sequence: UInt64
    let timestamp: Double
    let scale: Double
    init(_ sequence: UInt64, _ timestamp: Double, _ scale: Double) {
        self.sequence = sequence; self.timestamp = timestamp; self.scale = scale
    }
}

/// Hardware encoder with one outstanding sample. No B frames, lookahead or raw-pixel queue.
final class VideoEncoder {
    private var session: VTCompressionSession?
    private var size = CGSize.zero
    private let lock = NSLock()
    private var busy = false
    private var keyframe = true
    private var bitrate = 4_000_000
    private var fps = 60
    private let sessionId: String
    private let version: Int
    private let publish: (Data) -> Void
    private let completed: () -> Void
    init(sessionId: String, version: Int, publish: @escaping (Data) -> Void, completed: @escaping () -> Void) {
        self.sessionId = sessionId; self.version = version; self.publish = publish; self.completed = completed
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
                guard status == noErr, let sample else { encoder.requestKeyframe(); return }
                encoder.output(sample, entry)
            }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &session)
        guard status == noErr, let session else { return false }
        size = CGSize(width: width, height: height)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: 1 as CFNumber)
        configure(bitrate: bitrate, fps: fps)
        return VTCompressionSessionPrepareToEncodeFrames(session) == noErr
    }
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double) -> VideoEncodeResult {
        lock.lock(); let occupied = busy; lock.unlock()
        if occupied { return .busy }
        guard prepare(image), let session else { return .unavailable }
        lock.lock(); let force = keyframe; keyframe = false; busy = true; lock.unlock()
        let entry = Unmanaged.passRetained(VideoFrame(sequence, timestamp, scale)).toOpaque()
        let status = VTCompressionSessionEncodeFrame(session, imageBuffer: image,
            presentationTimeStamp: CMTime(value: Int64(sequence), timescale: CMTimeScale(fps)), duration: .invalid,
            frameProperties: force ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil,
            sourceFrameRefcon: entry, infoFlagsOut: nil)
        if status != noErr {
            Unmanaged<VideoFrame>.fromOpaque(entry).release()
            lock.lock(); busy = false; keyframe = true; lock.unlock()
            return .unavailable
        }
        return .submitted
    }
    private func output(_ sample: CMSampleBuffer, _ entry: VideoFrame) {
        guard let format = sample.formatDescription, let block = sample.dataBuffer else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        var payload = Data()
        let prefix: [UInt8] = [0, 0, 0, 1]
        var codec = "avc1.42E01F"
        if key {
            for index in 0..<2 {
                var pointer: UnsafePointer<UInt8>?
                var length = 0
                guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &length, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
                    let pointer else { return }
                payload.append(contentsOf: prefix); payload.append(pointer, count: length)
                if index == 0, length >= 4 { codec = String(format: "avc1.%02X%02X%02X", pointer[1], pointer[2], pointer[3]) }
            }
        }
        var bytes = [UInt8](repeating: 0, count: CMBlockBufferGetDataLength(block))
        guard !bytes.isEmpty, bytes.count <= 8 * 1024 * 1024,
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: bytes.count, destination: &bytes) == noErr else { return }
        var offset = 0
        while offset + 4 <= bytes.count {
            let length = (0..<4).reduce(0) { ($0 << 8) | Int(bytes[offset + $1]) }
            offset += 4
            guard length > 0, length <= bytes.count - offset else { return }
            payload.append(contentsOf: prefix); payload.append(contentsOf: bytes[offset..<offset + length]); offset += length
        }
        guard offset == bytes.count, payload.count <= 8 * 1024 * 1024 else { return }
        var header: [String: Any] = ["version": version, "sessionId": sessionId, "width": Int(size.width), "height": Int(size.height),
            "codec": "h264", "keyframe": key, "bytes": payload.count, "scale": entry.scale]
        if key { header["videoCodec"] = codec }
        header[version == 1 ? "sequence" : "seq"] = entry.sequence
        header[version == 1 ? "timestamp" : "ts"] = entry.timestamp
        guard let json = try? JSONSerialization.data(withJSONObject: header), json.count <= 4096 else { return }
        var length = UInt32(json.count).bigEndian
        var packet = Data(); withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
        packet.append(json); packet.append(payload); publish(packet)
    }
    func close() {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(session) }
        session = nil; size = .zero
    }
    deinit { close() }
}
