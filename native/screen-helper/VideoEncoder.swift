import Foundation
import VideoToolbox

private final class VideoFrame {
    let sequence: UInt64
    let timestamp: Double
    let scale: Double
    let quality: StreamQuality
    let epoch: UInt32
    let capturedAt: UInt64
    init(_ sequence: UInt64, _ timestamp: Double, _ scale: Double, _ quality: StreamQuality, epoch: UInt32, capturedAt: UInt64) {
        self.sequence = sequence; self.timestamp = timestamp; self.scale = scale; self.quality = quality
        self.epoch = epoch; self.capturedAt = capturedAt
    }
}

/// One encoded picture, before it is framed for the daemon's socket or ace-media's ingest.
/// `packet` appends the Annex B payload (parameter sets first on keyframes) to a header in one
/// allocation, so either framing copies the sample once.
struct EncodedVideo {
    let keyframe: Bool
    /// The WebCodecs codec string, from the SPS; keyframes only.
    let codec: String?
    /// What the payload is; HEVC only ever goes to ace-media's ingest.
    var format: VideoCodec = .h264
    let width: Int
    let height: Int
    let scale: Double
    let sequence: UInt64
    let timestamp: Double
    /// The privacy epoch stamped when the picture was captured.
    let epoch: UInt32
    /// Capture time in uptime nanoseconds.
    let capturedAt: UInt64
    let payloadBytes: Int
    let packet: (Data) -> Data?
}

/// Hardware encoder with one outstanding sample. No B frames, lookahead or raw-pixel queue.
/// H.264 High at a fixed level, so a refine keyframe never changes the decoder configuration;
/// HEVC Main for ace-media's ingest when the daemon asks for it.
final class VideoEncoder {
    private var session: VTCompressionSession?
    private var codec = VideoCodec.h264
    private var size = CGSize.zero
    private let lock = NSLock()
    private var busy = false
    private var keyframe = true
    private var bitrate = 4_000_000
    private var fps = 60
    /// The QP cap the session runs with now; nil is uncapped (rate control alone).
    private var appliedQP: Int?
    private let units: (EncodedVideo) -> Void
    private let completed: () -> Void
    /// Rate control dropped a frame of this quality (no sample, no error).
    private let dropped: (StreamQuality) -> Void
    /// Longest stretch between keyframes, in seconds. A capture's refine keyframes want 1 s; a
    /// pass-through stream (an emulator's) leaves keyframes to viewers
    /// that ask, as a keyframe is many deltas big on the thin links these run on.
    private let keyframeInterval: Double
    /// Units as they leave the encoder, for the caller to frame (as `MediaFrame`s for ace-media).
    init(units: @escaping (EncodedVideo) -> Void, completed: @escaping () -> Void, dropped: @escaping (StreamQuality) -> Void = { _ in }, keyframeInterval: Double = 1) {
        self.units = units; self.completed = completed; self.dropped = dropped
        self.keyframeInterval = keyframeInterval
    }
    /// Delivers submitted units before their output route changes. The session stays open.
    func drain() {
        if let session { VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }
    }

    func requestKeyframe() { lock.lock(); keyframe = true; lock.unlock() }
    /// The codec of the next picture. A change closes the session, so the next picture opens one
    /// at a keyframe with the new codec's parameter sets.
    func use(_ next: VideoCodec) {
        guard next != codec else { return }
        close(); codec = next; requestKeyframe()
    }
    var running: VideoCodec { codec }
    /// A sample is being encoded: the next one would be refused as busy.
    var busyNow: Bool { lock.lock(); defer { lock.unlock() }; return busy }
    /// A new bit rate for the running session from its next frame: no new session and no
    /// keyframe, so a live view can follow its link. A capped refine frame keeps its own rate.
    func retune(bitrate: Int) {
        self.bitrate = bitrate
        guard let session else { return }
        limitDataRate(session)
        if appliedQP == nil {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
        }
    }
    func configure(bitrate: Int, fps: Int) {
        self.bitrate = bitrate; self.fps = fps
        if let session {
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
            limitDataRate(session)
        }
        requestKeyframe()
    }
    /// Keyframes, refines included, stay within half a second of the bitrate (ADR 0149 §3).
    private func limitDataRate(_ session: VTCompressionSession) {
        let limits = keyframeDataRateLimits(bitrate: bitrate).map { $0 as CFNumber } as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }
    private func prepare(_ image: CVPixelBuffer) -> Bool {
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        if size == CGSize(width: width, height: height), session != nil { return true }
        close()
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true
        ]
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height), codecType: codec.codecType,
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
        // Level 5.1 covers every capture size (up to 4096×2304) and every client decoder. HEVC
        // Main is 8-bit 4:2:0, what ScreenCaptureKit's NV12 is; its level follows the size.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,
            value: codec == .h264 ? kVTProfileLevel_H264_High_5_1 : kVTProfileLevel_HEVC_Main_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: keyframeInterval as CFNumber)
        configure(bitrate: bitrate, fps: fps)
        return VTCompressionSessionPrepareToEncodeFrames(session) == noErr
    }
    /// Applies a frame's QP cap when it differs from the session's (51 is the ceiling of both
    /// H.264 and HEVC: no cap).
    private func apply(_ settings: VideoEncoderSettings, to session: VTCompressionSession) {
        guard settings.maxFrameQP != appliedQP else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxAllowedFrameQP, value: (settings.maxFrameQP ?? 51) as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: (settings.maxFrameQP == nil ? bitrate : 40_000_000) as CFNumber)
        appliedQP = settings.maxFrameQP
    }
    /// `at` is the capture time in uptime nanoseconds. Presentation times follow it, so rate
    /// control sees the idle time before a refine and does not drop it as over budget.
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality = .motion) -> VideoEncodeResult {
        encode(image, sequence: sequence, timestamp: timestamp, scale: scale, at: at, quality: quality, epoch: 0, capturedAt: at)
    }
    /// `epoch` and `capturedAt` (uptime nanoseconds) are the picture's, from its capture callback.
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality, epoch: UInt32, capturedAt: UInt64) -> VideoEncodeResult {
        lock.lock(); let occupied = busy; lock.unlock()
        if occupied { return .busy }
        guard prepare(image), let session else { return .unavailable }
        let settings = videoEncoderSettings(quality, bitrate: bitrate, width: Int(size.width), height: Int(size.height))
        apply(settings, to: session)
        lock.lock(); let force = keyframe || settings.keyframe; keyframe = false; busy = true; lock.unlock()
        let entry = Unmanaged.passRetained(VideoFrame(sequence, timestamp, scale, quality, epoch: epoch, capturedAt: capturedAt)).toOpaque()
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
    /// One unit: Annex B with parameter sets on keyframes. The sample's 4-byte NAL lengths are
    /// rewritten to start codes in place, so the payload is copied once, after its header.
    private func output(_ sample: CMSampleBuffer, _ entry: VideoFrame) {
        guard let format = sample.formatDescription, let block = sample.dataBuffer else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
        let key = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
        let prefix: [UInt8] = [0, 0, 0, 1]
        var parameterSets: [(UnsafePointer<UInt8>, Int)] = []
        let produced = self.codec
        var codec = produced.fallbackString
        if key {
            guard let sets = Self.parameterSets(format, produced) else { return }
            parameterSets = sets
            if produced == .h264, let (sps, length) = sets.first, length >= 4 {
                codec = String(format: "avc1.%02X%02X%02X", sps[1], sps[2], sps[3])
            } else if produced == .hevc, let (sps, length) = sets.first(where: { $0.1 > 0 && hevcNALType($0.0[0]) == 33 }),
                      let named = hevcCodecString(sps: Array(UnsafeBufferPointer(start: sps, count: length))) {
                codec = named
            }
        }
        let sampleBytes = CMBlockBufferGetDataLength(block)
        let payloadBytes = sampleBytes + parameterSets.reduce(0) { $0 + prefix.count + $1.1 }
        guard sampleBytes > 0, payloadBytes <= 8 * 1024 * 1024 else { return }
        // The parameter set pointers belong to `format`, which `sample` keeps alive for this call.
        let packet: (Data) -> Data? = { header in
            var packet = header
            packet.reserveCapacity(header.count + payloadBytes)
            for (pointer, count) in parameterSets { packet.append(contentsOf: prefix); packet.append(pointer, count: count) }
            let start = packet.count
            packet.count += sampleBytes
            let copied = packet.withUnsafeMutableBytes { bytes in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: sampleBytes, destination: bytes.baseAddress! + start) == noErr
            }
            guard copied, Self.startCodes(&packet, from: start) else { return nil }
            return packet
        }
        units(EncodedVideo(keyframe: key, codec: key ? codec : nil, format: produced, width: Int(size.width), height: Int(size.height), scale: entry.scale,
            sequence: entry.sequence, timestamp: entry.timestamp, epoch: entry.epoch, capturedAt: entry.capturedAt,
            payloadBytes: payloadBytes, packet: packet))
    }
    /// A keyframe's parameter sets in order: SPS and PPS for H.264, VPS, SPS and PPS for HEVC.
    private static func parameterSets(_ format: CMFormatDescription, _ codec: VideoCodec) -> [(UnsafePointer<UInt8>, Int)]? {
        var sets: [(UnsafePointer<UInt8>, Int)] = []
        var count = codec == .h264 ? 2 : 3
        var index = 0
        while index < count {
            var pointer: UnsafePointer<UInt8>?
            var length = 0, total = 0
            let status = codec == .h264
                ? CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &length, parameterSetCountOut: &total, nalUnitHeaderLengthOut: nil)
                : CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                    parameterSetSizeOut: &length, parameterSetCountOut: &total, nalUnitHeaderLengthOut: nil)
            guard status == noErr, let pointer, length > 0 else { return nil }
            sets.append((pointer, length))
            if index == 0 { count = max(count, min(total, 8)) }
            index += 1
        }
        return sets
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
