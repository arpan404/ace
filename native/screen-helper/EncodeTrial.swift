import Foundation
import CoreVideo
import VideoToolbox

/// The hello's capture → encode report (ADR 0148, the K2 capability entry): one trial frame per
/// codec through the same kind of session live video uses, an NV12 IOSurface into a hardware
/// H.264 or HEVC session, each bounded to one second. `hardware` is what the session itself says.
enum EncodeTrial {
    /// Run once, at the first hello: H.264, then HEVC.
    static let report: [[String: Any]] = [run(.h264), run(.hevc)]
    /// A hardware HEVC encode worked, so the helper offers HEVC to ace-media's ingest.
    static var hevc: Bool { works(report[1]) }

    static func works(_ entry: [String: Any]) -> Bool { entry["state"] as? String == "ok" && entry["hardware"] as? Bool == true }

    static func entry(_ codec: VideoCodec, state: String, hardware: Bool) -> [String: Any] {
        let ok = state == "ok"
        // ScreenCaptureKit hands NV12 IOSurfaces straight to the encoder, so no picture is copied.
        return ["step": "encode", "codec": codec.fallbackString, "backend": "vt", "hardware": ok && hardware, "zeroCopy": ok,
                "state": state, "maxWidth": ok ? 3840 : 0, "maxHeight": ok ? 2160 : 0]
    }

    private final class Outcome {
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var produced = false
    }

    static func run(_ codec: VideoCodec) -> [String: Any] {
        let width: Int32 = 640, height: Int32 = 360
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        ]
        // Retained until the session is invalidated, which waits out any late callback.
        let outcome = Outcome()
        var session: VTCompressionSession?
        guard VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: codec.codecType,
            encoderSpecification: specification as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, _, status, _, sample in
                guard let context else { return }
                let outcome = Unmanaged<Outcome>.fromOpaque(context).takeUnretainedValue()
                outcome.lock.lock(); outcome.produced = status == noErr && sample != nil; outcome.lock.unlock()
                outcome.done.signal()
            }, refcon: Unmanaged.passUnretained(outcome).toOpaque(), compressionSessionOut: &session) == noErr, let session else {
            return entry(codec, state: "failed", hardware: false)
        }
        defer { VTCompressionSessionInvalidate(session); withExtendedLifetime(outcome) {} }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        var picture: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        guard CVPixelBufferCreate(nil, Int(width), Int(height), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &picture) == kCVReturnSuccess,
              let picture else { return entry(codec, state: "failed", hardware: false) }
        guard VTCompressionSessionEncodeFrame(session, imageBuffer: picture, presentationTimeStamp: CMTime(value: 0, timescale: 60), duration: .invalid,
            frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil) == noErr else { return entry(codec, state: "failed", hardware: false) }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        guard outcome.done.wait(timeout: .now() + 1) == .success else { return entry(codec, state: "timed-out", hardware: false) }
        outcome.lock.lock(); let produced = outcome.produced; outcome.lock.unlock()
        // Low-latency sessions don't report `UsingHardwareAcceleratedVideoEncoder`
        // (kVTPropertyNotSupportedErr); one that opened with hardware required is the answer.
        var hardware: CFBoolean?
        let reported = withUnsafeMutablePointer(to: &hardware) { pointer in
            VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: UnsafeMutableRawPointer(pointer))
        }

        return entry(codec, state: produced ? "ok" : "failed", hardware: reported == noErr ? hardware == kCFBooleanTrue : true)
    }
}
