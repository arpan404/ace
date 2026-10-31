import SwiftUI

/// Geometry observed by the I/O shell. The viewport controller owns the semantic
/// anchor and computes alignment from the row's current size when restoring it.
@MainActor final class TranscriptReadingAnchor {
    var frames: [String: CGRect] = [:]
}
