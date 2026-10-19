import SwiftUI

/// How an opened log reaches its turn's full steps: read while open, released when closed.
@MainActor struct StepsLinks {
    let model: ClientModel
    let screen: ThreadScreenModel
    /// The generation `screen` belongs to; a log closing after its thread was left releases only that one.
    let epoch: Int
}

/// A settled turn's full step list from the daemon (`turn.steps`): a placeholder while it loads,
/// Retry when the read failed, and Load more for a turn longer than one read.
struct DaemonSteps: View {
    let ordinal: Int
    let blockId: String
    let links: StepsLinks
    var body: some View {
        let steps = links.screen.steps[ordinal]
        let rows = steps?.rows ?? []
        Group {
            if steps?.header?.state == "failed" && rows.isEmpty {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text("Couldn't load these steps.")
                    Button("Retry") { links.model.moreSteps(ordinal: ordinal) }.accessibilityIdentifier("steps.retry")
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            } else if rows.isEmpty && steps?.header?.state != "ready" {
                HStack(spacing: AceTheme.Spacing.sm) { ProgressView().controlSize(.mini); Text("Loading steps…") }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityIdentifier("steps.loading")
            } else if rows.isEmpty {
                Text("No steps recorded.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
            } else {
                ForEach(rows) { row in DaemonStep(row: row) }
                if steps?.header?.more == true {
                    Button("Load more steps") { links.model.moreSteps(ordinal: ordinal) }
                        .disabled(steps?.header?.state == "loading")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .accessibilityIdentifier("steps.more")
                }
            }
        }
        .onAppear { links.model.openSteps(ordinal: ordinal, block: blockId) }
        .onDisappear { links.model.closeSteps(ordinal: ordinal, epoch: links.epoch) }
    }
}

/// One step read from the daemon: its line, or what the agent said between steps.
private struct DaemonStep: View {
    let row: TranscriptRow
    var body: some View {
        if row.type == "message" {
            Text(Markdown.inline(row.text)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.foreground)
        } else if let step = row.step {
            StepRow(step: step)
        } else {
            Text(row.text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }
}

/// A native subagent's own lane, its blocks grouped like the main transcript ("Worked for" heads,
/// its own subagents, its answer), from the bridge's per-agent grouping.
struct AgentLaneSheet: View {
    let entry: BlockRow.Agents.Entry
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                let lane = thread.screen.lane
                if let lane, lane.agentId == entry.agentId, !lane.order.isEmpty {
                    let links = TranscriptLinks(openThread: { child in dismiss(); openThread(child) }, openAgent: { _ in })
                    ForEach(lane.order, id: \.self) { id in
                        if let block = lane.blocks[id] { BlockView(block: block, thread: thread, links: links).listRowSeparator(.hidden) }
                    }
                } else {
                    ContentUnavailableView("Nothing from this agent yet", systemImage: "point.3.connected.trianglepath.dotted")
                        .listRowSeparator(.hidden)
                }
            }
            .listStyle(.plain)
            .accessibilityIdentifier("lane.transcript")
            .navigationTitle(entry.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: AceTheme.Spacing.xxs) {
                        Text(entry.title).aceFont(AceTheme.Typography.title, relativeTo: .headline).lineLimit(1)
                        Text(entry.label).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(StateStyle.text(entry.token))
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
        }
        .onAppear { model.openLane(entry.agentId) }
        .onDisappear { model.closeLane(epoch: thread.epoch) }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}
