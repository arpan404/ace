import SwiftUI

/// Work reads in order: groups of tools as one sentence ("Read 4 files and searched 2 times ›"),
/// single steps as their own quiet row, and the agent's own prose between them. Streaming text
/// observes its item alone; it never copies or rebuilds the transcript.
struct WorkProgressView: View {
    let groups: [BlockRow.WorkGroup]
    let thread: ThreadModel
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            ForEach(groups) { group in
                WorkProgressGroup(group: group, thread: thread, openMedia: openMedia, openMessage: openMessage)
            }
        }
    }
}

struct WorkProgressGroup: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let group: BlockRow.WorkGroup
    let thread: ThreadModel
    let openMedia: ((TranscriptRow) -> Void)?
    let openMessage: ((TranscriptRow) -> Void)?
    @State private var expanded = false
    var body: some View {
        if group.single {
            if let item = thread.items[group.id] {
                ItemRowView(item: item, openMedia: openMedia, openMessage: openMessage, workEnded: !group.running)
                    .stepNarration(item.row.type == "message")
            }
        } else {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() } } label: {
                    HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                        Group {
                            if group.running, let active = thread.items[group.active] {
                                RunningStepLine(item: active, fallback: group.label)
                            } else {
                                Text(group.label).lineLimit(2).multilineTextAlignment(.leading)
                            }
                        }
                        .shimmer(group.running)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                        Spacer(minLength: AceTheme.Spacing.none)
                    }
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("work.group.\(group.id)")
                if expanded {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        ForEach(group.items, id: \.self) { id in
                            if let item = thread.items[id] { ItemRowView(item: item, openMedia: openMedia, openMessage: openMessage) }
                        }
                    }
                }
            }
        }
    }
}

private struct RunningStepLine: View {
    @Bindable var item: ItemModel
    let fallback: String
    var body: some View {
        if item.row.type == "reasoning" {
            Text("Thinking…")
        } else if let step = item.row.step {
            Text([step.verb, step.target].filter { !$0.isEmpty }.joined(separator: " ")).lineLimit(1).truncationMode(.middle)
        } else {
            Text(fallback.isEmpty ? "Working" : fallback).lineLimit(1)
        }
    }
}

/// The agent's reasoning, folded to one quiet row; it shimmers while the agent still thinks.
struct ThoughtRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let row: TranscriptRow
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var workEnded = false
    @State private var expanded = false
    var body: some View {
        let settled = row.complete || row.step?.settled == true || workEnded
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() } } label: {
                QuietRow(icon: "brain") {
                    Text(settled ? "Thought" : "Thinking…").shimmer(!settled)
                    if !row.text.isEmpty {
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                    }
                    Spacer(minLength: AceTheme.Spacing.none)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(row.text.isEmpty)
            .accessibilityIdentifier("thought.\(row.id)").accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded, !row.text.isEmpty {
                MarkdownView(text: row.text).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(.leading, AceTheme.Spacing.xxl + AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
                if row.truncated, let openMessage { Button("Read full thought") { openMessage(row) } }
            }
        }
    }
}
