import SwiftUI

/// How an opened log reaches its turn's full steps: read while open, released when closed.
@MainActor struct StepsLinks {
    let model: ClientModel
    let screen: ThreadScreenModel
    /// The generation `screen` belongs to; a log closing after its thread was left releases only that one.
    let epoch: Int
}

/// A settled turn's full steps from the daemon (`turn.steps`), grouped as the web's opened log
/// groups them, on a rail: rows standing in for the steps while they load, Retry when the read
/// failed, and Load more for a turn longer than one read. Its head holds the read
/// (`WorkBlockView`), so the rows are usually here before the log opens.
struct DaemonSteps: View {
    let ordinal: Int
    let blockId: String
    let links: StepsLinks
    let thread: ThreadModel
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var body: some View {
        let steps = links.screen.steps[ordinal]
        let rows = steps?.rows ?? []
        let header = steps?.header
        Group {
            if header?.state == "failed" && rows.isEmpty {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text("Couldn't load these steps.")
                    Button("Retry") { links.model.moreSteps(ordinal: ordinal) }.accessibilityIdentifier("steps.retry")
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            } else if rows.isEmpty && header?.state != "ready" {
                StepsSkeleton().onAppear { DisclosureTrace.shared.waiting(blockId) }
            } else if rows.isEmpty {
                Text("No steps recorded.").aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            } else {
                let source = LogSource(thread: thread, fetched: Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { $1 }),
                                       ace: header?.aceSteps, background: header?.background, retried: header?.retried,
                                       thoughts: header?.thoughts, openMessage: openMessage)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    StepRail { WorkLogRows(rows: header?.log ?? rows.map { BlockRow.LogRow(kind: "step", id: $0.id) }, source: source) }
                        .onAppear { DisclosureTrace.shared.shown(blockId) }
                    if header?.more == true {
                        Button("Load more steps") { links.model.moreSteps(ordinal: ordinal) }
                            .disabled(header?.state == "loading")
                            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                            .accessibilityIdentifier("steps.more")
                    }
                }
            }
        }
    }
}

/// Rows standing in for a log's steps while they load.
private struct StepsSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach([0.62, 0.48, 0.70], id: \.self) { width in
                HStack(spacing: AceTheme.Spacing.sm) {
                    AceShape.capsule.frame(width: 14, height: 14)
                    GeometryReader { geometry in
                        AceShape.capsule.frame(width: geometry.size.width * width, height: 12)
                    }
                    .frame(height: 12)
                }
                .frame(height: 16)
            }
        }
        .foregroundStyle(AceTheme.Colours.fill)
        .padding(.vertical, AceTheme.Spacing.xs + AceTheme.Spacing.xxs).padding(.leading, AceTheme.Spacing.xs + AceTheme.Spacing.xxs)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading steps")
        .accessibilityIdentifier("steps.loading")
    }
}

/// A native subagent opened from the transcript, in its own sheet: its whole view
/// (`SubagentView`), with its own subagents pushing on top.
struct AgentLaneSheet: View {
    let entry: BlockRow.Agents.Entry
    let model: ClientModel
    let thread: ThreadModel
    let openThread: (String) -> Void
    @State private var path: [SubagentRoute] = []
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack(path: $path) {
            page(SubagentRoute(agentId: entry.agentId, title: entry.title))
                .navigationDestination(for: SubagentRoute.self) { page($0) }
        }
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
    private func page(_ route: SubagentRoute) -> some View {
        SubagentView(route: route, model: model, thread: thread, push: { path.append($0) },
                     openThread: { child in dismiss(); openThread(child) })
            .escapeCloses { dismiss() }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
}
