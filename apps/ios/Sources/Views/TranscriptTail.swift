import SwiftUI

/// Observe stream revisions here so following the tail doesn't invalidate every transcript row.
struct TranscriptTail: View {
    let thread: ThreadModel
    let following: Bool
    let scroll: () -> Void
    var body: some View {
        Color.clear.frame(height: AceTheme.Dimensions.border).id("tail").accessibilityHidden(true)
            .task(id: [thread.cursor, following ? 1 : 0]) {
                do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
                guard following, thread.loaded, !Task.isCancelled else { return }
                scroll()
            }
    }
}
