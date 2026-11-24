import CoreGraphics

/// The list starts at the live end. The viewport and jump code still speak in screen order.
enum TranscriptScrollAxis {
    static func row(_ physical: CGRect) -> CGRect {
        CGRect(x: physical.minX, y: -physical.maxY, width: physical.width, height: physical.height)
    }

    /// In chronological coordinates the physically first edge is the viewport's bottom.
    static func origin(offset: CGFloat, viewport: CGFloat) -> CGFloat { viewport + offset }

    static func distances(offset: CGFloat, content: CGFloat, viewport: CGFloat,
                          startInset: CGFloat) -> (older: CGFloat, live: CGFloat) {
        let live = offset + startInset
        return (content - viewport - live, live)
    }
}
