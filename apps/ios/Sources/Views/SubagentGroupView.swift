import SwiftUI

/// Subagents launched together, rolled up into one row of their own: overlapping provider marks,
/// "3 subagents", the bridge's status line ("2 working · 1 done") and, while any branch is still
/// live, a timer from their launch. Tapping it lists each agent by the state of its whole branch
/// (a finished agent with a working child reads Working); each opens its own transcript.
struct SubagentGroupView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let agents: BlockRow.Agents
    /// The block's items: the launches, whose times start the timer.
    let items: [String]
    let thread: ThreadModel
    let open: (BlockRow.Agents.Entry) -> Void
    var openAll: (() -> Void)? = nil
    @State private var expanded = false
    private var live: Bool { agents.entries.contains { ["working", "waiting", "needsYou", "unresponsive"].contains($0.token) } }
    /// The most pressing branch colours the status dot.
    private var token: String {
        for key in ["needsYou", "failed", "unresponsive", "working", "waiting"] where agents.entries.contains(where: { $0.token == key }) { return key }
        return agents.entries.first?.token ?? "done"
    }
    private var launched: Double? { items.compactMap { thread.items[$0]?.row.createdAt }.min() }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() } } label: { rollup }
                .buttonStyle(.plain)
                .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("subagents.rollup")
            if expanded {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    ForEach(agents.entries) { entry in entryRow(entry) }
                    if let openAll {
                        Button(action: openAll) {
                            Text("All agents").aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityIdentifier("subagents.all")
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.md + AceTheme.Spacing.xxs)
                .overlay(alignment: .top) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
            }
        }
        .background(AceTheme.Colours.secondaryBackground, in: RoundedRectangle(cornerRadius: AceTheme.Radii.group))
    }

    private var rollup: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            HStack(spacing: -AceTheme.Spacing.sm) {
                ForEach(agents.entries.prefix(3)) { entry in
                    ProviderMark(provider: entry.provider)
                        .frame(width: AceTheme.Spacing.xxxl - AceTheme.Spacing.xxs, height: AceTheme.Spacing.xxxl - AceTheme.Spacing.xxs)
                        .background(AceTheme.Colours.fill, in: Circle())
                        .overlay(Circle().stroke(AceTheme.Colours.secondaryBackground, lineWidth: AceTheme.Spacing.xxs))
                }
            }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(agents.entries.count == 1 ? "1 subagent" : "\(agents.entries.count) subagents")
                    .aceFont(AceTheme.Typography.body, relativeTo: .body).fontWeight(.semibold)
                    .foregroundStyle(AceTheme.Colours.foreground)
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    Circle().fill(StateStyle.marker(token)).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
                    Text(agents.status).lineLimit(1)
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if live, let launched {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = max(1, Int(context.date.timeIntervalSince1970 - launched / 1000))
                    Text(Duration.seconds(seconds).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
                        .monospacedDigit()
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold))
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .padding(.horizontal, AceTheme.Spacing.md + AceTheme.Spacing.xxs).padding(.vertical, AceTheme.Spacing.md)
        .contentShape(Rectangle())
    }

    private func entryRow(_ entry: BlockRow.Agents.Entry) -> some View {
        Button { open(entry) } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                ProviderMark(provider: entry.provider)
                Text(entry.title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                if let symbol = StatusSymbol.name(entry.token) {
                    Image(systemName: symbol).font(.footnote.weight(.semibold)).foregroundStyle(StateStyle.marker(entry.token))
                }
                Text(entry.label).foregroundStyle(StateStyle.text(entry.token))
                if !entry.threadId.isEmpty || !entry.agentId.isEmpty {
                    Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(entry.threadId.isEmpty && entry.agentId.isEmpty)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("subagent.\(entry.title)")
    }
}
