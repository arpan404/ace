import SwiftUI

/// What a block opens: another thread (a delegated child or a started conversation) or a
/// native subagent's own lane inside this thread.
struct TranscriptLinks {
    let openThread: (String) -> Void
    let openAgent: (BlockRow.Agents.Entry) -> Void
}

/// One transcript block. Items render through their own observed rows, so streaming text
/// re-renders that row alone.
struct BlockView: View {
    @Bindable var block: BlockModel
    let thread: ThreadModel
    let links: TranscriptLinks
    var body: some View {
        let row = block.row
        switch row.kind {
        case "work": WorkBlockView(row: row, thread: thread)
        case "subagents": if let agents = row.agents { SubagentGroupView(agents: agents, open: open) }
        case "live": LiveLine(thread: thread)
        case "end": if let ending = row.ending { EndingLine(ending: ending) }
        case "started":
            if let started = row.started {
                LinkRow(icon: "bubble.left.and.text.bubble.right", title: started.title, detail: "Conversation") { links.openThread(started.threadId) }
            }
        case "question": QuestionLine(interaction: thread.interactions[row.interactionId])
        case "event":
            ForEach(row.items, id: \.self) { id in
                if let item = thread.items[id] { EventLine(item: item) }
            }
        default:
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                ForEach(row.items, id: \.self) { id in
                    if let item = thread.items[id] { ItemRowView(item: item) }
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
    var body: some View {
        let row = item.row
        switch row.type {
        case "message": MessageRow(row: row)
        case "html": VisualizationRow(row: row)
        default:
            if let step = row.step { StepRow(step: step) }
            else { Text(row.text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }
    }
}

struct MessageRow: View {
    let row: TranscriptRow
    var body: some View {
        let user = row.role == "user"
        VStack(alignment: user ? .trailing : .leading, spacing: AceTheme.Spacing.xs) {
            if user {
                Text(row.text).aceFont(AceTheme.Typography.body, relativeTo: .body).textSelection(.enabled)
                    .padding(AceTheme.Spacing.md)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.bubble))
            } else if !row.text.isEmpty {
                MarkdownView(text: row.text)
            }
            if let attachments = row.attachments, !attachments.isEmpty {
                AttachmentChips(attachments: attachments, more: row.moreAttachments ?? 0)
            }
            if row.truncated { Text("Showing a bounded preview").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground) }
        }.frame(maxWidth: .infinity, alignment: user ? .trailing : .leading)
    }
}

struct AttachmentChips: View {
    let attachments: [AttachmentLine]
    let more: Int
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, attachment in
                Label(attachment.name.isEmpty ? "Attachment" : attachment.name, systemImage: attachment.kind == "image" ? "photo" : attachment.kind == "pdf" ? "doc.richtext" : "doc")
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

/// A step's line: "Read process-owner.ts", "Ran bun test  exit 0".
struct StepRow: View {
    let step: StepLine
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Image(systemName: Self.symbol(step.icon)).frame(width: AceTheme.Spacing.lg)
                .foregroundStyle(step.failed ? AceTheme.Status.failed : step.needsYou ? AceTheme.Status.needsYou : AceTheme.Colours.decoration)
            Text(step.verb).foregroundStyle(AceTheme.Colours.foreground).layoutPriority(1)
            if !step.target.isEmpty { Text(step.target).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote).lineLimit(1).truncationMode(.middle) }
            Spacer(minLength: AceTheme.Spacing.none)
            if let added = step.added, let removed = step.removed {
                Text("+\(added)").foregroundStyle(AceTheme.StatusText.done).monospacedDigit()
                Text("−\(removed)").foregroundStyle(AceTheme.StatusText.failed).monospacedDigit()
            }
            if !step.note.isEmpty { Text(step.note).foregroundStyle(step.failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground).lineLimit(1) }
            if !step.settled { ProgressView().controlSize(.mini).accessibilityLabel("Running") }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
    static func symbol(_ icon: String) -> String {
        switch icon {
        case "read": "doc.text"
        case "search": "magnifyingglass"
        case "list": "list.bullet"
        case "shell": "terminal"
        case "edit": "pencil"
        case "web": "globe"
        case "think": "brain"
        case "note": "info.circle"
        default: "wrench.and.screwdriver"
        }
    }
}

/// A turn's work behind one line: "Worked for 4m · Explored 6 files · Ran 3 commands".
struct WorkBlockView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: BlockRow
    let thread: ThreadModel
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.xs) {
                    if let work = row.work {
                        if work.ongoing {
                            Text("Working for")
                            Text(Date(timeIntervalSince1970: work.startedAt / 1000), style: .timer).monospacedDigit()
                        } else { Text(work.label) }
                        if !work.counts.isEmpty { Text("· \(work.counts)").lineLimit(1) }
                    } else { Text("Worked") }
                    Spacer(minLength: AceTheme.Spacing.none)
                    Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(expanded ? "Hides the steps" : "Shows the steps")
            .accessibilityIdentifier("work.toggle")
            if let work = row.work, work.ongoing, !work.current.isEmpty, !expanded {
                Text(work.current).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.working).lineLimit(1)
            }
            if expanded {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    ForEach(row.items, id: \.self) { id in
                        if let item = thread.items[id] { WorkStep(item: item) }
                    }
                    if row.items.isEmpty { Text("No steps recorded.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground) }
                }
                .padding(.leading, AceTheme.Spacing.md)
                .overlay(alignment: .leading) { Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border) }
            }
        }
    }
}

/// A step inside an opened log, or what the agent said between steps.
private struct WorkStep: View {
    @Bindable var item: ItemModel
    var body: some View {
        if item.row.type == "message" {
            Text(Markdown.inline(item.row.text)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.foreground)
        } else { ItemRowView(item: item) }
    }
}

/// The newest turn's live line, shown until the daemon says its whole tree has settled.
private struct LiveLine: View {
    let thread: ThreadModel
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            ProgressView().controlSize(.mini)
            if let status = thread.metadata?.status { Text(status.label).foregroundStyle(StateStyle.text(status.token)) }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript.live")
    }
}

private struct EndingLine: View {
    let ending: BlockRow.Ending
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            Label(ending.label, systemImage: ending.label == "Turn failed" ? "exclamationmark.triangle" : "stop.circle")
                .foregroundStyle(ending.label == "Turn failed" ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
            if !ending.error.isEmpty { Text(ending.error).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3) }
        }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
    }
}

private struct EventLine: View {
    @Bindable var item: ItemModel
    var body: some View {
        Label(item.row.text, systemImage: "arrow.triangle.branch").lineLimit(2)
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}

/// A question where it was asked: open ones are answered on the card above the composer.
private struct QuestionLine: View {
    let interaction: ApprovalRow?
    var body: some View {
        if let interaction, interaction.state != "pending" {
            Label("\(interaction.title) · \(interaction.state == "resolved" ? "Answered" : interaction.state == "expired" ? "Expired" : "Cancelled")", systemImage: "questionmark.bubble")
                .lineLimit(2).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }
}

struct LinkRow: View {
    let icon: String
    let title: String
    let detail: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Image(systemName: icon).foregroundStyle(AceTheme.Colours.decoration)
                Text(title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text(detail).foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer(minLength: AceTheme.Spacing.none)
                Image(systemName: "chevron.right").foregroundStyle(AceTheme.Colours.decoration)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

/// The sandboxed renderer is desktop/web only; show what was published and where to see it.
private struct VisualizationRow: View {
    let row: TranscriptRow
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Image(systemName: "chart.bar.doc.horizontal")
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.text).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                Text(row.detail ?? "")
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }.aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .combine)
    }
}
