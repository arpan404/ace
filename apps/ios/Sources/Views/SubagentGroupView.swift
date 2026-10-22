import SwiftUI

/// A launch's subagents in the transcript, as plain rows on the page. One subagent is just its
/// row: its provider's mark, its name, its status word. Several fold into one row led by their
/// providers' marks: "2 subagents", each status count in its tone ("2 working"), how long they
/// have run, opening to their rows under a hairline rail. The counts carry the state, so the
/// group never reads done while any branch works or waits. Words and states are the bridge's.
struct SubagentGroupView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let agents: BlockRow.Agents
    /// The block's items: the launches, whose times start the timer.
    let items: [String]
    let thread: ThreadModel
    /// The block this group is, so its open state outlives the row's view.
    let blockId: String
    let open: (BlockRow.Agents.Entry) -> Void
    var openAll: (() -> Void)? = nil
    private var expanded: Bool { thread.screen.openGroups.contains(blockId) }
    private func toggle() {
        if expanded { thread.screen.openGroups.remove(blockId) } else { thread.screen.openGroups.insert(blockId) }
    }
    private var live: Bool { agents.entries.contains { ["working", "waiting", "needsYou", "unresponsive"].contains($0.token) } }
    private var launched: Double? { items.compactMap { thread.items[$0]?.row.createdAt }.min() }

    var body: some View {
        if agents.entries.count == 1, let only = agents.entries.first {
            SubagentRow(entry: only, open: open)
        } else {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { toggle() } } label: { rollup }
                    .buttonStyle(TranscriptRowButtonStyle())
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                    .accessibilityIdentifier("subagents.rollup")
                if expanded {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        ForEach(agents.entries) { entry in SubagentRow(entry: entry, open: open) }
                        if let openAll {
                            Button("All agents", action: openAll)
                                .buttonStyle(TranscriptRowButtonStyle())
                                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                                .accessibilityIdentifier("subagents.all")
                        }
                    }
                    .padding(.leading, AceTheme.Spacing.lg)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                            .padding(.leading, AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
                    }
                }
            }
        }
    }

    private var rollup: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            HStack(spacing: -AceTheme.Spacing.xs) {
                ForEach(agents.entries.prefix(3)) { entry in ProviderMark(provider: entry.provider) }
            }
            .accessibilityHidden(true)
            (Text(agents.entries.count == 1 ? "1 subagent" : "\(agents.entries.count) subagents").fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
             + counts)
                .lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.sm)
            if live, let launched {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(Elapsed.words(since: launched, now: context.date)).monospacedDigit()
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            AceIcon(.caretRight, size: 12, relativeTo: .caption)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
    }
    /// "  2 working · 1 done", each count in its own tone; the bridge's line when it sends no parts.
    private var counts: Text {
        let parts = agents.counts ?? [BlockRow.Agents.Count(text: agents.status, token: "")]
        return parts.enumerated().reduce(Text("  ")) { line, part in
            let separator = part.offset > 0 ? Text(" · ").foregroundStyle(AceTheme.Colours.subtleForeground) : Text(verbatim: "")
            return line + separator + Text(part.element.text).foregroundStyle(StateStyle.text(part.element.token))
        }
        .font(.footnote)
    }
}

/// One subagent: its provider's mark, its name, and its status word in the status colour at the
/// right. It opens the agent's own transcript (or its delegated thread).
private struct SubagentRow: View {
    let entry: BlockRow.Agents.Entry
    let open: (BlockRow.Agents.Entry) -> Void
    var body: some View {
        Button { open(entry) } label: {
            HStack(spacing: AceTheme.Spacing.md) {
                ProviderMark(provider: entry.provider)
                Text(entry.title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Text(entry.label).foregroundStyle(StateStyle.text(entry.token)).lineLimit(1)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
        }
        .buttonStyle(TranscriptRowButtonStyle())
        .disabled(entry.threadId.isEmpty && entry.agentId.isEmpty)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("subagent.\(entry.title)")
    }
}

/// A transcript row you can press: no box at rest, the soft `--active` fill at radius 8 while
/// pressed, a full-width touch target.
struct TranscriptRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm, alignment: .leading)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: RoundedRectangle(cornerRadius: AceTheme.Radii.md, style: .continuous))
            .padding(.horizontal, -AceTheme.Spacing.sm)
            .contentShape(Rectangle())
    }
}
