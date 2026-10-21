import SwiftUI

/// Live work reads in order: compact groups of tools, then the agent's own prose.
/// Streaming text observes its item alone; it never copies or rebuilds the transcript.
struct WorkProgressView: View {
    let groups: [BlockRow.WorkGroup]
    let thread: ThreadModel
    var openMedia: ((TranscriptRow) -> Void)? = nil
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(groups) { group in
                WorkProgressGroup(group: group, thread: thread, openMedia: openMedia, openMessage: openMessage)
            }
        }
    }
}

struct WorkProgressGroup: View {
    let group: BlockRow.WorkGroup
    let thread: ThreadModel
    let openMedia: ((TranscriptRow) -> Void)?
    let openMessage: ((TranscriptRow) -> Void)?
    @State private var expanded = false
    var body: some View {
        if group.single {
            if let item = thread.items[group.id] {
                ItemRowView(item: item, openMedia: openMedia, openMessage: openMessage, workEnded: !group.running)
            }
        } else {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        if group.running, let active = thread.items[group.active] {
                            RunningStepLine(item: active, fallback: group.label)
                        } else {
                            Image(systemName: StepRow.symbol(group.icon)).foregroundStyle(AceTheme.Colours.decoration)
                            Text(group.label).lineLimit(2).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: AceTheme.Spacing.none)
                        Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("work.group.\(group.id)")
                if expanded {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                        ForEach(group.items, id: \.self) { id in
                            if let item = thread.items[id] { ItemRowView(item: item, openMedia: openMedia, openMessage: openMessage) }
                        }
                    }.padding(.leading, AceTheme.Spacing.lg)
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
            Label("Thinking…", systemImage: "brain")
        } else if let step = item.row.step {
            Label {
                Text([step.verb, step.target].filter { !$0.isEmpty }.joined(separator: " ")).lineLimit(1).truncationMode(.middle)
            } icon: { Image(systemName: StepRow.symbol(step.icon)) }
        } else {
            Text(fallback.isEmpty ? "Working" : fallback).lineLimit(1)
        }
    }
}

struct ThoughtRow: View {
    let row: TranscriptRow
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var workEnded = false
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Button { expanded.toggle() } label: {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Image(systemName: "brain")
                    Text(row.complete || row.step?.settled == true || workEnded ? "Thought" : "Thinking…")
                    Spacer(minLength: AceTheme.Spacing.none)
                    if !row.text.isEmpty { Image(systemName: "chevron.right").rotationEffect(.degrees(expanded ? 90 : 0)) }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(row.text.isEmpty)
            .accessibilityIdentifier("thought.\(row.id)").accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded, !row.text.isEmpty {
                MarkdownView(text: row.text).padding(.leading, AceTheme.Spacing.lg)
                if row.truncated, let openMessage { Button("Read full thought") { openMessage(row) } }
            }
        }
    }
}
