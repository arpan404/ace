import Foundation
import VideoToolbox

enum VideoEncodeResult { case submitted, busy, unavailable }
let semaphore = DispatchSemaphore(value: 0)
var packets = Data()
let encoder = VideoEncoder(sessionId: "codec-fixture", version: 1, publish: { packets.append($0) }, completed: { semaphore.signal() }, keyframeInterval: 60)
encoder.configure(bitrate: 4_000_000, fps: 30)
for sequence in 0..<12 {
    var image: CVPixelBuffer?
    guard CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &image) == kCVReturnSuccess, let image else { fatalError("pixel buffer") }
    CVPixelBufferLockBaseAddress(image, [])
    let pointer = CVPixelBufferGetBaseAddress(image)!.assumingMemoryBound(to: UInt8.self)
    for y in 0..<64 { for x in 0..<64 {
        let offset = y * CVPixelBufferGetBytesPerRow(image) + x * 4
        pointer[offset] = UInt8((x + sequence * 3) % 256)
        pointer[offset + 1] = UInt8(y * 3)
        pointer[offset + 2] = UInt8(sequence * 15)
        pointer[offset + 3] = 255
    } }
    CVPixelBufferUnlockBaseAddress(image, [])
    guard encoder.encode(image, sequence: UInt64(sequence), timestamp: Double(sequence) * 1000 / 30, scale: 1, at: 1_000_000_000 + UInt64(sequence) * 33_333_333) == .submitted else { fatalError("encode") }
    guard semaphore.wait(timeout: .now() + 5) == .success else { fatalError("encode timeout") }
}
encoder.close()
try packets.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
