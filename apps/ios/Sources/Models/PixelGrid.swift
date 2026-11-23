import CoreGraphics

/// Whole device pixels. A height measured as 97.67 pt and the room made for it differ by a
/// fraction of a pixel, which a scroll that holds the bottom still rounds to a whole point:
/// the room the feed keeps for the composer is the bar's height rounded up to a pixel.
enum PixelGrid {
    static func ceil(_ value: CGFloat, scale: CGFloat) -> CGFloat {
        guard scale > 0 else { return value }
        return (value * scale).rounded(.up) / scale
    }
}
