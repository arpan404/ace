import Foundation
import CoreImage
import Darwin

@main struct EncoderBenchmark {
    static func main() {
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, 1920, 1080, kCVPixelFormatType_32BGRA,
                                  [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &buffer) == kCVReturnSuccess,
              let image = buffer else { fatalError("Cannot allocate benchmark image") }
        CVPixelBufferLockBaseAddress(image, [])
        if let base = CVPixelBufferGetBaseAddress(image) {
            base.initializeMemory(as: UInt8.self, repeating: 128, count: CVPixelBufferGetBytesPerRow(image) * 1080)
        }
        CVPixelBufferUnlockBaseAddress(image, [])
        let encoder = JPEGEncoder(context: CIContext(options: [.cacheIntermediates: false]))
        var bytes = 0
        let start = CFAbsoluteTimeGetCurrent()
        for sequence in 0..<500 {
            autoreleasepool {
                guard let packet = encoder.packet(image: image, sessionId: "bench", sequence: UInt64(sequence), timestamp: 1000) else { fatalError("Encoding failed") }
                bytes += packet.count
            }
        }
        let elapsed = CFAbsoluteTimeGetCurrent() - start
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let result: [String: Any] = ["name": "native 1080p uniform JPEG encode and packet", "operations": 500,
                                   "opsPerSecond": Int(500 / elapsed), "microsecondsPerOperation": elapsed * 1_000_000 / 500,
                                   "peakRssMiB": Double(usage.ru_maxrss) / 1024 / 1024, "packetBytesMean": bytes / 500]
        if let json = try? JSONSerialization.data(withJSONObject: result), let text = String(data: json, encoding: .utf8) { print(text) }
    }
}
