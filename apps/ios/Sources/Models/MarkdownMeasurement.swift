import CoreGraphics

/// The last size supplied to SwiftUI. Markit also reports that size after layout;
/// only a height that SwiftUI has not already measured needs another layout.
struct MarkdownMeasurement {
    private var measured: CGSize?

    mutating func measured(height: CGFloat, at width: CGFloat) {
        measured = CGSize(width: width, height: height)
    }

    func needsLayout(height: CGFloat, at width: CGFloat) -> Bool {
        measured != CGSize(width: width, height: height)
    }
}
