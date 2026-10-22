import SwiftUI

/// What a block opens: another thread (a delegated child or a started conversation) or a
/// native subagent's own lane inside this thread.
struct TranscriptLinks {
    let openThread: (String) -> Void
    let openAgent: (BlockRow.Agents.Entry) -> Void
    /// Where a settled log reads its turn's full steps; nil shows the steps already loaded.
    var steps: StepsLinks? = nil
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openChanges: (() -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    /// The whole agent tree, from a subagent rollup.
    var openAgents: (() -> Void)? = nil
    /// The thread's own transcript: its live turn carries the thread's live line. A subagent's
    /// lane has none of its own.
    var live = false
}

/// One transcript block. Items render through their own observed rows, so streaming text
/// re-renders that row alone. Grouping is the bridge's (`@ace/ui-core/transcript-blocks`).
struct BlockView: View {
    @Bindable var block: BlockModel
    let thread: ThreadModel
    let links: TranscriptLinks
    var body: some View {
        let row = block.row
        switch row.kind {
        case "work": WorkBlockView(row: row, blockId: block.id, thread: thread, steps: links.steps, openMessage: links.openMessage)
        case "subagents": if let agents = row.agents { SubagentGroupView(agents: agents, items: row.items, thread: thread, blockId: block.id, open: open, openAll: links.openAgents) }
        case "live": if links.live { LiveLine(activity: thread.screen.activity) }
        case "end": if let ending = row.ending { EndingLine(ending: ending) }
        case "files":
            if let openChanges = links.openChanges {
                QuietLink(icon: .fileText, title: "Edited files", action: openChanges)
                    .accessibilityIdentifier("transcript.changes")
            }
        case "started":
            if let started = row.started {
                QuietLink(icon: .chatsTeardrop, title: started.title) { links.openThread(started.threadId) }
            }
        case "question": QuestionLine(interaction: thread.interactions[row.interactionId])
        case "user", "message", "event", "item":
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                ForEach(row.items, id: \.self) { id in
                    if let item = thread.items[id] { BlockItemView(item: item, block: row, links: links) }
                }
            }
            .environment(\.readMessage, reader)
        default:
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                ForEach(row.items, id: \.self) { id in
                    if let item = thread.items[id] { ItemRowView(item: item, openMedia: links.openMedia, openMessage: links.openMessage) }
                }
            }
        }
    }
    /// Where a long answer reads its whole text: the thread's own model, when the feed has one.
    private var reader: (@MainActor (String) async throws -> String)? {
        guard let model = links.steps?.model else { return nil }
        let threadId = thread.id
        return { id in
            try await model.service(["type": "native.message", "threadId": threadId, "itemId": id], as: MessageText.self).text
        }
    }
    private func open(_ entry: BlockRow.Agents.Entry) {
        if !entry.threadId.isEmpty { links.openThread(entry.threadId) }
        else if !entry.agentId.isEmpty { links.openAgent(entry) }
    }
}

/// A one-item block's item, observed on its own so streaming text re-renders this row alone: the
/// person's bubble, the agent's answer, or an event as the bridge decided it.
private struct BlockItemView: View {
    @Bindable var item: ItemModel
    let block: BlockRow
    let links: TranscriptLinks
    var body: some View {
        if let event = block.event {
            EventRowView(event: event, item: item, openMedia: links.openMedia, openMessage: links.openMessage)
        } else if block.kind == "user" {
            UserMessageRow(row: item.row)
        } else if block.kind == "message" {
            AnswerRow(row: item.row, streaming: block.streaming ?? false, openMessage: links.openMessage)
        } else {
            ItemRowView(item: item, openMedia: links.openMedia, openMessage: links.openMessage)
        }
    }
}

/// A single item: a message bubble or answer, a step, a notice, or a visualization fallback.
struct ItemRowView: View {
    @Bindable var item: ItemModel
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var workEnded = false
    var body: some View {
        let row = item.row
        switch row.type {
        case "message":
            // In a work log, what the agent says between its steps: plain prose.
            if row.role == "user" { UserMessageRow(row: row) } else { AnswerRow(row: row, between: true, openMessage: openMessage) }
        case "reasoning": ReasoningRow(row: row, openMessage: openMessage, workEnded: workEnded)
        case "html", "image":
            if let openMedia {
                QuietLink(icon: row.type == "html" ? .chartBarHorizontal : .image, title: row.text) { openMedia(row) }
                    .accessibilityIdentifier("media.\(row.id)")
            } else { VisualizationRow(row: row) }
        default:
            if let step = row.step { StepRow(step: step) }
            else { Text(row.text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
    }
}

/// `native.message`'s reply: an item's whole text.
struct MessageText: Decodable { let text: String }
