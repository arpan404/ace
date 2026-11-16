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
/// The feed's rows in the stack `TranscriptStackChoice` picked: a plain one that lays every row
/// out (a short window), or the lazy one that lays out the rows near the screen (a long one).
/// Changing `stack` lays every row out again (ADR 0157).
struct TranscriptRowsStack<Content: View>: View {
    let stack: TranscriptStackChoice.Stack
    @ViewBuilder let content: () -> Content
    var body: some View {
        switch stack {
        case .eager: VStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
        case .lazy: LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none, content: content)
        }
    }
}

/// One row of the feed. Equatable, so a feed re-evaluated for any reason re-renders only rows
/// whose block, room, thread or links changed (`.equatable()` in `ConversationFeed`); what a row
/// shows from its block's own data reaches it through observation.
struct TranscriptFeedRowView: View, Equatable {
    static func == (lhs: TranscriptFeedRowView, rhs: TranscriptFeedRowView) -> Bool {
        lhs.row.id == rhs.row.id && lhs.row.block === rhs.row.block && lhs.row.room == rhs.row.room
            && lhs.thread === rhs.thread && lhs.links.key == rhs.links.key
    }
    let row: TranscriptFeedRow
    let thread: ThreadModel
    let links: TranscriptLinks
    @Environment(\.aceDensityId) private var densityId
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        let _ = PerfCounters.bump("row.body")
        // The web's rhythm: 8 between rows, 16 around a bubble or card, 24 after an answer;
        // Compact trims it (Settings › Appearance).
        BlockView(block: row.block, thread: thread, links: links)
            // The approved feed: one 14pt gap between its parts; its sides are the composer's edge.
            .padding(.bottom, AceDesign.Space.feedGap * AceTheme.density(densityId).transcriptRoom)
            .padding(.horizontal, ReadingColumn.bar(sizeClass).text)
    }
}
