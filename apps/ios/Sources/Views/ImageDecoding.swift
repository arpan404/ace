import ImageIO
import UIKit

/// Images decoded through ImageIO, so only a bounded bitmap is ever held and never the full-size
/// picture. Call these off the main thread.
enum ImageDecoding {
    /// The most pixels a viewed image keeps in all: sharp when zoomed on a phone, and a long
    /// scrolling screenshot keeps its full width, without holding a camera original's bitmap.
    nonisolated static let viewedArea: CGFloat = 24_000_000

    /// A small preview at most `pixels` on its long side. A file's own embedded thumbnail is used
    /// when it has one.
    nonisolated static func preview(_ source: CGImageSource, pixels: CGFloat) -> UIImage? {
        image(source, longSide: pixels, from: kCGImageSourceCreateThumbnailFromImageIfAbsent)
    }

    /// The picture for viewing, from the full image, at most `viewedArea` pixels in all.
    nonisolated static func viewed(_ source: CGImageSource) -> UIImage? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue
        else { return nil }
        let side = longSide(width: width, height: height, area: viewedArea)
        return image(source, longSide: side, from: kCGImageSourceCreateThumbnailFromImageAlways)
    }

    /// The long side an image keeps when shrunk, keeping its shape, to at most `area` pixels.
    nonisolated static func longSide(width: CGFloat, height: CGFloat, area: CGFloat) -> CGFloat {
        guard width > 0, height > 0 else { return 1 }
        let scale = min(1, (area / (width * height)).squareRoot())
        return max(1, (max(width, height) * scale).rounded(.down))
    }

    nonisolated static func source(_ data: Data) -> CGImageSource? {
        CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary)
    }
    nonisolated static func source(at url: URL) -> CGImageSource? {
        CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary)
    }

    private nonisolated static func image(_ source: CGImageSource, longSide: CGFloat, from: CFString) -> UIImage? {
        let options = [
            from: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, longSide),
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// Composer previews, decoded one at a time so eight picked photos never decode at once.
actor PreviewDecoder {
    static let shared = PreviewDecoder()
    func preview(at url: URL, pixels: CGFloat) -> UIImage? {
        ImageDecoding.source(at: url).flatMap { ImageDecoding.preview($0, pixels: pixels) }
    }
}
