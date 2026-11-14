import Foundation
import CoreVideo
import VideoToolbox

/// The hello's capture → encode report (ADR 0148, the K2 capability entry): one trial frame
/// through the same kind of session live video uses, an NV12 IOSurface into a hardware H.264
/// session, bounded to one second. `hardware` is what the session itself says.
enum EncodeTrial {
    /// Run once, at the first hello.
    static let report: [[String: Any]] = [run()]

    static func entry(state: String, hardware: Bool) -> [String: Any] {
        let ok = state == "ok"
        // ScreenCaptureKit hands NV12 IOSurfaces straight to the encoder, so no picture is copied.
        return ["step": "encode", "codec": "avc1.640033", "backend": "vt", "hardware": ok && hardware, "zeroCopy": ok,
                "state": state, "maxWidth": ok ? 3840 : 0, "maxHeight": ok ? 2160 : 0]
    }

    private final class Outcome {
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var produced = false
    }

    static func run() -> [String: Any] {
        let width: Int32 = 640, height: Int32 = 360
        let specification: [CFString: Any] = [
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true,
            kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true,
        ]
        // Retained until the session is invalidated, which waits out any late callback.
        let outcome = Outcome()
        var session: VTCompressionSession?
        guard VTCompressionSessionCreate(allocator: nil, width: width, height: height, codecType: kCMVideoCodecType_H264,
            encoderSpecification: specification as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: { context, _, status, _, sample in
                guard let context else { return }
                let outcome = Unmanaged<Outcome>.fromOpaque(context).takeUnretainedValue()
                outcome.lock.lock(); outcome.produced = status == noErr && sample != nil; outcome.lock.unlock()
                outcome.done.signal()
            }, refcon: Unmanaged.passUnretained(outcome).toOpaque(), compressionSessionOut: &session) == noErr, let session else {
            return entry(state: "failed", hardware: false)
        }
        defer { VTCompressionSessionInvalidate(session); withExtendedLifetime(outcome) {} }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        var picture: CVPixelBuffer?
        let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
        guard CVPixelBufferCreate(nil, Int(width), Int(height), kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &picture) == kCVReturnSuccess,
              let picture else { return entry(state: "failed", hardware: false) }
        guard VTCompressionSessionEncodeFrame(session, imageBuffer: picture, presentationTimeStamp: CMTime(value: 0, timescale: 60), duration: .invalid,
            frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil) == noErr else { return entry(state: "failed", hardware: false) }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        guard outcome.done.wait(timeout: .now() + 1) == .success else { return entry(state: "timed-out", hardware: false) }
        outcome.lock.lock(); let produced = outcome.produced; outcome.lock.unlock()
        // Low-latency sessions don't report `UsingHardwareAcceleratedVideoEncoder`
        // (kVTPropertyNotSupportedErr); one that opened with hardware required is the answer.
        var hardware: CFBoolean?
        let reported = withUnsafeMutablePointer(to: &hardware) { pointer in
            VTSessionCopyProperty(session, key: kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder, allocator: nil, valueOut: UnsafeMutableRawPointer(pointer))
        }

        return entry(state: produced ? "ok" : "failed", hardware: reported == noErr ? hardware == kCFBooleanTrue : true)
    }
}
