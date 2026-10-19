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
