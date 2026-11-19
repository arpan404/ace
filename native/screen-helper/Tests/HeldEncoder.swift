import XCTest
import CoreVideo
@testable import ScreenHelper

/// An encoder that holds each picture until the test completes it, as a slow hardware encode does.
final class HeldEncoder: VideoEncoding {
    struct Encoded: Equatable { let seq: UInt64; let width: Int; let keyframe: Bool }
    var encoded: [Encoded] = []
    var busyNow = false
    private var keyframe = false
    func encode(_ image: CVPixelBuffer, sequence: UInt64, timestamp: Double, scale: Double, at: UInt64, quality: StreamQuality) -> VideoEncodeResult {
        if busyNow { return .busy }
        busyNow = true
        encoded.append(Encoded(seq: sequence, width: CVPixelBufferGetWidth(image), keyframe: keyframe))
        keyframe = false
        return .submitted
    }
    func requestKeyframe() { keyframe = true }
    func retune(bitrate: Int) {}
    func close() {}
    /// The encode finished, or rate control dropped it: either way the encoder is free.
    func finish(_ completed: () -> Void) { busyNow = false; completed() }
}

func blankPicture(width: Int = 640, height: Int = 1280) -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
    CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, attributes as CFDictionary, &buffer)
    return buffer!
}

