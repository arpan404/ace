import UIKit

/// A picked picture made into a project badge, as the web's chooser makes one: its centred
/// square scaled to 128 points, as a PNG data URL, else a JPEG one when the PNG is too large
/// for the project record (`ProjectIcon`, 128 KiB). Native image work; nothing else decides here.
enum ProjectBadgeImage {
    static let side: CGFloat = 128
    static let limit = 131_072

    nonisolated static func dataURL(from data: Data) -> String? {
        guard let source = UIImage(data: data), let cg = source.cgImage else { return nil }
        let width = CGFloat(cg.width), height = CGFloat(cg.height)
        let crop = min(width, height)
        guard crop >= 1, let square = cg.cropping(to: CGRect(x: (width - crop) / 2, y: (height - crop) / 2, width: crop, height: crop)) else { return nil }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { _ in
            UIImage(cgImage: square, scale: 1, orientation: source.imageOrientation).draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }
        if let png = rendered.pngData() {
            let url = "data:image/png;base64," + png.base64EncodedString()
            if url.utf8.count <= limit { return url }
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.85) else { return nil }
        let url = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        return url.utf8.count <= limit ? url : nil
    }

    nonisolated static func decode(_ url: String) -> UIImage? {
        guard url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ","),
              let data = Data(base64Encoded: String(url[url.index(after: comma)...])) else { return nil }
        return UIImage(data: data)
    }
}
