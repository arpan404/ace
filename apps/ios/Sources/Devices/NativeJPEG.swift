import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

/// Older screen helpers publish JPEG. Validate dimensions before allocating a bounded buffer.
enum NativeJPEG {
    enum Failure: Error { case invalidPicture }
    static func decode(_ chunk: DeviceFrameChunk) throws -> CVPixelBuffer {
        guard chunk.width * chunk.height <= 4096 * 4096,
              let source = CGImageSourceCreateWithData(chunk.bytes as CFData, nil),
              let metadata = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = metadata[kCGImagePropertyPixelWidth] as? Int, width == chunk.width,
              let height = metadata[kCGImagePropertyPixelHeight] as? Int, height == chunk.height,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw Failure.invalidPicture }
        var output: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:], kCVPixelBufferCGImageCompatibilityKey as String: true, kCVPixelBufferCGBitmapContextCompatibilityKey as String: true]
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &output) == kCVReturnSuccess,
              let output else { throw Failure.invalidPicture }
        CVPixelBufferLockBaseAddress(output, [])
        defer { CVPixelBufferUnlockBaseAddress(output, []) }
        guard let base = CVPixelBufferGetBaseAddress(output),
              let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(output), space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue) else { throw Failure.invalidPicture }
        context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        return output
    }
}
