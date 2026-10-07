import AppKit
import CoreImage

func measurementThumbnail(_ image: CVPixelBuffer, context: CIContext) -> CGImage? {
    autoreleasepool {
        let source = CIImage(cvPixelBuffer: image)
        let scale = min(1, min(400 / source.extent.width, 260 / source.extent.height))
        let small = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return context.createCGImage(small, from: small.extent)
    }
}

/// Exact pixel dimensions avoid AppKit's implicit Retina backing and TIFF copies.
@MainActor private func renderMeasurementFilmstrip(_ frames: [MeasurementCandidate], tileWidth: Int) -> Data? {
    let tileHeight = tileWidth * 3 / 4 + 24
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: tileWidth * 2, pixelsHigh: tileHeight * 4,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    defer { NSGraphicsContext.restoreGraphicsState() }
    NSColor.black.setFill(); NSRect(x: 0, y: 0, width: tileWidth * 2, height: tileHeight * 4).fill()
    for (index, frame) in frames.enumerated() {
        let column = index % 2, row = index / 2
        let x = column * tileWidth, y = (3 - row) * tileHeight
        let source = NSImage(cgImage: frame.image, size: NSSize(width: frame.image.width, height: frame.image.height))
        let scale = min(Double(tileWidth - 8) / Double(frame.image.width), Double(tileHeight - 28) / Double(frame.image.height))
        let rect = NSRect(x: Double(x + 4), y: Double(y + 24), width: Double(frame.image.width) * scale, height: Double(frame.image.height) * scale)
        source.draw(in: rect)
        if let damage = frame.damage {
            NSColor.systemYellow.setStroke()
            let outline = NSBezierPath(rect: NSRect(x: rect.minX + damage.minX * rect.width, y: rect.maxY - damage.maxY * rect.height, width: damage.width * rect.width, height: damage.height * rect.height))
            outline.lineWidth = 1; outline.stroke()
        }
        let label = String(format: "%+.0f ms%@", frame.atMs, frame.hitch ? "  HITCH" : "")
        (label as NSString).draw(at: NSPoint(x: x + 6, y: y + 4), withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .medium), .foregroundColor: frame.hitch ? NSColor.systemOrange : NSColor.white])
    }
    for quality in [0.65, 0.45, 0.25] {
        if let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: quality]), jpeg.count <= 24 * 1024 { return jpeg }
    }
    return nil
}

/// One in-memory image, with JPEG size capped to leave room in the 64 KiB reply.
@MainActor func measurementFilmstrip(_ frames: [MeasurementCandidate]) -> Data? {
    guard !frames.isEmpty else { return nil }
    for tileWidth in [400, 320, 240] {
        if let jpeg = autoreleasepool(invoking: { renderMeasurementFilmstrip(frames, tileWidth: tileWidth) }) { return jpeg }
    }
    return nil
}
