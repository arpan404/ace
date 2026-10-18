import SwiftUI

/// Subagents launched together: one line each, by the state of its whole branch (a finished
/// agent with a working child reads Running). Tapping opens its own transcript.
struct SubagentGroupView: View {
    let agents: BlockRow.Agents
    let open: (BlockRow.Agents.Entry) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Image(systemName: "point.3.connected.trianglepath.dotted").foregroundStyle(AceTheme.Colours.decoration)
                Text(agents.entries.count == 1 ? "1 agent" : "\(agents.entries.count) agents").foregroundStyle(AceTheme.Colours.foreground)
                Text(agents.status).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
            .padding(.vertical, AceTheme.Spacing.sm)
            ForEach(agents.entries) { entry in
                Button { open(entry) } label: {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        Circle().fill(StateStyle.marker(entry.token)).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
                        Text(entry.title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                        Spacer(minLength: AceTheme.Spacing.sm)
                        Text(entry.label).foregroundStyle(StateStyle.text(entry.token))
                        if !entry.threadId.isEmpty || !entry.agentId.isEmpty {
                            Image(systemName: "chevron.right").foregroundStyle(AceTheme.Colours.decoration)
                        }
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(entry.threadId.isEmpty && entry.agentId.isEmpty)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("subagent.\(entry.title)")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .background(AceTheme.Colours.card, in: RoundedRectangle(cornerRadius: AceTheme.Radii.group))
        .overlay(RoundedRectangle(cornerRadius: AceTheme.Radii.group).stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
    }
}

/// A native subagent's own lane: its items, in the thread's order.
struct AgentLaneSheet: View {
    let entry: BlockRow.Agents.Entry
    let thread: ThreadModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List {
                let lane = thread.order.filter { thread.items[$0]?.row.agentId == entry.agentId }
                if lane.isEmpty {
                    ContentUnavailableView("Nothing from this agent yet", systemImage: "point.3.connected.trianglepath.dotted")
                        .listRowSeparator(.hidden)
                }
                ForEach(lane, id: \.self) { id in
                    if let item = thread.items[id] { ItemRowView(item: item).listRowSeparator(.hidden) }
                }
            }
            .listStyle(.plain)
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
        .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    }
}
