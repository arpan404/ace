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
        case "work": WorkBlockView(row: row, blockId: block.id, thread: thread, steps: links.steps, openMedia: links.openMedia, openMessage: links.openMessage)
        case "subagents": if let agents = row.agents { SubagentGroupView(agents: agents, items: row.items, thread: thread, blockId: block.id, open: open, openAll: links.openAgents) }
        case "live": if links.live { LiveLine(activity: thread.screen.activity) }
        case "end": if let ending = row.ending { EndingLine(ending: ending, row: row, thread: thread) }
        case "files":
            if let files = row.files, !files.chips.isEmpty, let openChanges = links.openChanges {
                ChangedFilesRow(files: files, open: openChanges)
            }
        case "started":
            if let started = row.started {
                QuietLink(icon: .chatsTeardrop, title: started.title) { links.openThread(started.threadId) }
            }
        case "question": QuestionLine(interaction: thread.interactions[row.interactionId])
        case "event":
            ForEach(row.items, id: \.self) { id in
                if let item = thread.items[id] { EventLine(item: item) }
            }
        default:
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                ForEach(row.items, id: \.self) { id in
                    if let item = thread.items[id] { ItemRowView(item: item, openMedia: links.openMedia, openMessage: links.openMessage) }
                }
            }
        }
    }
    private func open(_ entry: BlockRow.Agents.Entry) {
        if !entry.threadId.isEmpty { links.openThread(entry.threadId) }
        else if !entry.agentId.isEmpty { links.openAgent(entry) }
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
        case "message": MessageRow(row: row, openMessage: openMessage)
        case "reasoning": ThoughtRow(row: row, openMessage: openMessage, workEnded: workEnded)
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

/// The person's words: a filled bubble on the right, at most about 85% of the column.
struct UserBubble: View {
    let text: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Spacer(minLength: AceTheme.Spacing.xxxl * 2)
            Text(text).aceFont(AceTheme.Typography.body, relativeTo: .body).textSelection(.enabled)
                .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
                .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
        }
    }
}

/// A user bubble, or the agent's bare full-width Markdown.
struct MessageRow: View {
    let row: TranscriptRow
    var openMessage: ((TranscriptRow) -> Void)? = nil
    @Environment(\.fileLinks) private var fileLinks
    var body: some View {
        let user = row.role == "user"
        VStack(alignment: user ? .trailing : .leading, spacing: AceTheme.Spacing.xs) {
            if user {
                UserBubble(text: row.text)
            } else if !row.text.isEmpty {
                MarkdownView(text: row.text).fileLinks(fileLinks, itemId: row.id)
            }
            if let attachments = row.attachments, !attachments.isEmpty {
                AttachmentChips(attachments: attachments, more: row.moreAttachments ?? 0)
            }
            if row.truncated, let openMessage {
                Button("Read full message") { openMessage(row) }.aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityIdentifier("message.full.\(row.id)")
            }
        }
        .frame(maxWidth: .infinity, alignment: user ? .trailing : .leading)
        .contextMenu {
            Button(row.truncated ? "Copy visible text" : "Copy message", ace: .copy) { UIPasteboard.general.string = row.text }
            ShareLink(item: row.text) { Label(row.truncated ? "Share visible text" : "Share message", ace: .export) }
            if row.truncated, let openMessage { Button("Read full message") { openMessage(row) } }
            Text(Date(timeIntervalSince1970: row.createdAt / 1000), format: .dateTime.month().day().hour().minute())
        }
    }
}

struct AttachmentChips: View {
    let attachments: [AttachmentLine]
    let more: Int
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                Label(attachment.name.isEmpty ? "Attachment" : attachment.name, ace: attachment.kind == "image" ? .image : attachment.kind == "pdf" ? .fileText : .file)
                    .lineLimit(1).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
                    .background(AceTheme.Colours.fill, in: Capsule())
            }
            if more > 0 { Text("+\(more)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).monospacedDigit() }
        }
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
}
