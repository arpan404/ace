import Foundation
import CoreImage

/// Encoding receives its clock and session metadata from the capture boundary.
final class JPEGEncoder {
    private let context: CIContext
    init(context: CIContext) { self.context = context }
    func packet(image: CVPixelBuffer, sessionId: String, sequence: UInt64, timestamp: Double, version: Int = 1, scale: Double = 1, dirtyRects: [CGRect]? = nil) -> Data? {
        let ciImage = CIImage(cvPixelBuffer: image)
        guard let jpeg = context.jpegRepresentation(of: ciImage, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.75]),
              jpeg.count > 0, jpeg.count <= 8 * 1024 * 1024 else { return nil }
        var header: [String: Any] = ["version": 1, "sessionId": sessionId, "sequence": sequence, "timestamp": timestamp,
                                   "width": CVPixelBufferGetWidth(image), "height": CVPixelBufferGetHeight(image), "codec": "jpeg", "bytes": jpeg.count]
        if version == 2 {
            header["version"] = 2; header["seq"] = sequence; header["ts"] = timestamp; header["scale"] = scale
            header.removeValue(forKey: "sequence"); header.removeValue(forKey: "timestamp")
            if let dirtyRects {
                let bounded = dirtyRects.count > 16 ? [dirtyRects.reduce(CGRect.null) { $0.union($1) }] : dirtyRects
                header["dirtyRects"] = bounded.map { ["x": $0.minX, "y": $0.minY, "w": $0.width, "h": $0.height] }
            }
        }
        guard let json = try? JSONSerialization.data(withJSONObject: header), json.count <= 4096 else { return nil }
        var length = UInt32(json.count).bigEndian
        var packet = Data(capacity: 4 + json.count + jpeg.count)
        withUnsafeBytes(of: &length) { packet.append(contentsOf: $0) }
        packet.append(json); packet.append(jpeg)
        return packet
    }
}
