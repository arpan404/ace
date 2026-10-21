import SwiftUI

/// Each work block keeps its disclosure; inner steps never become top-level messages.
struct TranscriptFeedRow: Identifiable {
    let id: String
    let block: BlockModel
    @MainActor static func rows(_ thread: ThreadModel) -> [TranscriptFeedRow] {
        thread.screen.blockOrder.flatMap { id -> [TranscriptFeedRow] in
            guard let block = thread.screen.blocks[id] else { return [] }
            return [TranscriptFeedRow(id: "block:\(id)", block: block)]
        }
    }
}
struct TranscriptFeedRowView: View {
    let row: TranscriptFeedRow
    let thread: ThreadModel
    let links: TranscriptLinks
    var body: some View {
        BlockView(block: row.block, thread: thread, links: links)
            .padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
            .padding(.horizontal, AceTheme.Spacing.xl)
    }
}
