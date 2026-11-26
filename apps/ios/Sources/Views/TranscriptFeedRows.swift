import SwiftUI

/// Each work block keeps its disclosure; inner steps never become top-level messages.
struct TranscriptFeedRow: Identifiable {
    let id: String
    let block: BlockModel
    /// The room under it, before applying the chosen transcript density.
    let room: CGFloat
    var readingPriority: Double = 0
    @MainActor static func rows(_ thread: ThreadModel) -> [TranscriptFeedRow] {
        let blocks = thread.screen.blockOrder.compactMap { id in thread.screen.blocks[id].map { (id, $0) } }
        return blocks.enumerated().map { index, entry in
            let next = index + 1 < blocks.count ? blocks[index + 1].1.kind : nil
            let room = entry.1.kind == "user" || next == "user" || next == "message"
                ? AceDesign.Space.turnGap : AceDesign.Space.feedGap
            return TranscriptFeedRow(id: "block:\(entry.0)", block: entry.1, room: room, readingPriority: Double(blocks.count - index))
        }
    }

    @MainActor static func block(_ id: String, in thread: ThreadModel) -> BlockModel? {
        guard id.hasPrefix("block:") else { return nil }
        return thread.screen.blocks[String(id.dropFirst(6))]
    }
}
/// The feed's rows in the stack `TranscriptStackChoice` picked: a plain one that lays every row
/// out (a short window), or the lazy one that lays out the rows near the screen (a long one).
/// Changing `stack` lays every row out again (ADR 0157).
struct TranscriptRowsStack<Content: View>: View {
    let stack: TranscriptStackChoice.Stack
    /// Between rows; the transcript's rows carry their own room.
    var spacing: CGFloat = AceTheme.Spacing.none
    @ViewBuilder let content: () -> Content
    var body: some View {
        switch stack {
        case .eager: VStack(alignment: .leading, spacing: spacing, content: content)
        case .lazy: LazyVStack(alignment: .leading, spacing: spacing, content: content)
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
    /// The block draws nothing now (a live subagent group or command left to the pill): it takes
    /// no gap either, so hidden rows leave no space above the composer.
    @State private var empty = false
    var body: some View {
        let _ = PerfCounters.bump("row.body")
        BlockView(block: row.block, thread: thread, links: links)
            .environment(\.markdownOwner, row.block.id)
            .onGeometryChange(for: Bool.self) { $0.size.height < 1 } action: { empty = $0 }
            .padding(.bottom, empty ? AceTheme.Spacing.none : row.room * AceTheme.density(densityId).transcriptRoom)
            .padding(.horizontal, ReadingColumn.bar(sizeClass).text)
    }
}
