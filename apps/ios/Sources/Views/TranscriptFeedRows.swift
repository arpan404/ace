import SwiftUI

/// Each work block keeps its disclosure; inner steps never become top-level messages.
struct TranscriptFeedRow: Identifiable {
    let id: String
    let block: BlockModel
    /// The room under it: the larger of its own `after` and the next block's `before`, as the
    /// web's feed lays the shared row-room values.
    let room: CGFloat
    @MainActor static func rows(_ thread: ThreadModel) -> [TranscriptFeedRow] {
        let blocks = thread.screen.blockOrder.compactMap { id in thread.screen.blocks[id].map { (id, $0) } }
        return blocks.enumerated().map { index, entry in
            let after = entry.1.room?.after ?? 8
            let before = index + 1 < blocks.count ? blocks[index + 1].1.room?.before ?? 8 : 8
            return TranscriptFeedRow(id: "block:\(entry.0)", block: entry.1, room: max(after, before))
        }
    }
}
struct TranscriptFeedRowView: View {
    let row: TranscriptFeedRow
    let thread: ThreadModel
    let links: TranscriptLinks
    var body: some View {
        // The web's rhythm: 8 between rows, 16 around a bubble or card, 24 after an answer.
        BlockView(block: row.block, thread: thread, links: links)
            .padding(.bottom, row.room)
            .padding(.horizontal, AceTheme.Spacing.xl)
    }
}
