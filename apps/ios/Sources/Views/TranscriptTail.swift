import SwiftUI

/// Observe stream revisions here so following the tail doesn't invalidate every transcript row.
struct TranscriptTail: View {
    /// The first row in the inverted list marks the live end.
    static let id = "tail"
    let thread: ThreadModel
    let following: Bool
    let barHeight: CGFloat
    let scroll: () -> Void

    private struct Layout: Equatable {
        let cursor: Int
        let following: Bool
        let barHeight: CGFloat
    }
    var body: some View {
        Color.clear.frame(height: AceTheme.Dimensions.border).id(Self.id).accessibilityHidden(true)
            .task(id: Layout(cursor: thread.cursor, following: following, barHeight: barHeight)) {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard following, thread.loaded, !Task.isCancelled else { return }
                scroll()
            }
    }
}
