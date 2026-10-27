import ImageIO
import UniformTypeIdentifiers

/// Pictures from Photos in a type every agent sees as a picture. PNG, JPEG, GIF and WebP go as
/// they are; anything else (HEIC, HEIF, TIFF, DNG) is re-encoded as a JPEG with its orientation
/// applied, within the daemon's picture limits, since the daemon keeps other types as opaque
/// files the agent can only reach by path (ADR 0034). Pure: call it off the main thread.
enum PhotoConversion {
    /// The picture types the daemon hands every provider natively.
    nonisolated static let readable: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]
    /// The most pixels a converted picture keeps: inside the daemon's 40 MP picture cap, so it
    /// still reaches the agent as a picture.
    nonisolated static let maxArea: CGFloat = 24_000_000

    struct Picture: Sendable, Equatable {
        let data: Data
        let mimeType: String
        let fileExtension: String
    }

    /// `data`, declared as `type`, as a picture the agent reads; nil when it can't be decoded.
    nonisolated static func readable(_ data: Data, type: UTType) -> Picture? {
        if let mime = type.preferredMIMEType, readable.contains(mime) {
            return Picture(data: data, mimeType: mime, fileExtension: type.preferredFilenameExtension ?? "jpg")
        }
        guard let source = ImageDecoding.source(data),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue
        else { return nil }
        let side = ImageDecoding.longSide(width: width, height: height, area: maxArea)
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: side,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return Picture(data: output as Data, mimeType: "image/jpeg", fileExtension: "jpg")
    }
}
