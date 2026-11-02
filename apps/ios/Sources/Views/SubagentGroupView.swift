import SwiftUI

/// A launch's subagents in the transcript, as the web draws them. One subagent is just its row.
/// Several fold into one quiet row led by their providers' marks (each provider once): "3
/// subagents", each status count in its tone, how long they have run, a chevron; it opens to
/// their rows under a hairline. The counts carry the state, so the group never reads done while
/// any branch works or waits. Every word, state and time is the bridge's.
struct SubagentGroupView: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    let agents: BlockRow.Agents
    let thread: ThreadModel
    /// The block this group is, so its open state outlives the row's view.
    let blockId: String
    let open: (BlockRow.Agents.Entry) -> Void
    private var expanded: Bool { thread.screen.openGroups.contains(blockId) }
    private func toggle() {
        if expanded { thread.screen.openGroups.remove(blockId) } else { thread.screen.openGroups.insert(blockId) }
    }

    var body: some View {
        if agents.entries.count == 1, let only = agents.entries.first {
            AgentRow(entry: only, open: open)
        } else {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Button { withAnimation(AceDesign.Motion.arriving(reduceMotion)) { toggle() } } label: { head }
                    .buttonStyle(TranscriptRowButtonStyle())
                    .accessibilityElement(children: .combine)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                    .accessibilityIdentifier("subagents.rollup")
                if expanded {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        ForEach(agents.entries) { entry in AgentRow(entry: entry, open: open) }
                    }
                    .padding(.leading, AceDesign.Space.margin)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                            .padding(.leading, AceDesign.Space.related)
                    }
                    .padding(.top, AceDesign.Space.tight)
                    .transition(.opacity)
                }
            }
        }
    }

    private var head: some View {
        HStack(spacing: AceDesign.Space.row) {
            if let lead = agents.lead { ProvidersLead(lead: lead) }
            (Text(agents.title).fontWeight(AceDesign.Typeface.regular).foregroundStyle(AceTheme.Colours.foreground)
             + Text(verbatim: "  ") + counts)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            AgentElapsed(since: agents.since, settled: agents.elapsed)
            AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                .rotationEffect(.degrees(expanded ? 90 : 0))
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
    }
    /// "2 working · 1 done", each count in its own tone, after "Last seen: " while stale.
    private var counts: Text {
        let parts = agents.counts ?? [BlockRow.Agents.Count(text: agents.status, token: "")]
        let first = agents.stale ? Text("Last seen: ").foregroundStyle(AceTheme.Colours.mutedForeground) : Text(verbatim: "")
        return parts.enumerated().reduce(first) { line, part in
            let separator = part.offset > 0 ? Text(" · ").foregroundStyle(AceTheme.Colours.subtleForeground) : Text(verbatim: "")
            return line + separator + Text(part.element.text).foregroundStyle(StateStyle.text(part.element.token))
        }
        .font(.footnote)
    }
}

/// A group's lead: its providers' marks, plain, each tucked a little under the one before; past
/// three providers, two marks and "+N". Named for assistive tech.
struct ProvidersLead: View {
    let lead: BlockRow.Agents.Lead
    @ScaledMetric(relativeTo: .caption) private var tuck: CGFloat = 3
    var body: some View {
        HStack(spacing: -tuck) {
            ForEach(Array(lead.providers.enumerated()), id: \.offset) { _, provider in
                ProviderMark(provider: provider, size: AceDesign.Size.icon)
                    .padding(AceTheme.Dimensions.border)
                    .background(AceTheme.Colours.background, in: Circle())
            }
            if lead.more > 0 {
                Text(verbatim: "+\(lead.more)").aceFont(AceTheme.Typography.caption, relativeTo: .caption).fontWeight(AceDesign.Typeface.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                    .padding(.leading, AceDesign.Space.tight + tuck)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(lead.label)
    }
}

/// How long an agent (or a group) has run: ticking while it runs and its facts are fresh, else
/// the settled time the bridge sends; nothing when it sends neither.
struct AgentElapsed: View {
    let since: Double?
    let settled: String
    var body: some View {
        Group {
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in Text(Elapsed.words(since: since, now: context.date)) }
            } else if !settled.isEmpty {
                Text(settled)
            }
        }
        .monospacedDigit()
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
        .accessibilityLabel("Elapsed time")
    }
}

/// One agent as the web's agent row: its provider's mark, its name and model, its status word in
/// its tone and how long it ran; under them what it does now (shimmering), found, failed with or
/// waits on. The whole row opens it; one that needs the person also offers Review.
struct AgentRow: View {
    let entry: BlockRow.Agents.Entry
    let open: (BlockRow.Agents.Entry) -> Void
    var body: some View {
        Button { open(entry) } label: {
            HStack(alignment: .top, spacing: AceDesign.Space.related) {
                ProviderMark(provider: entry.provider, size: AceDesign.Size.icon).padding(.top, AceTheme.Dimensions.border)
                VStack(alignment: .leading, spacing: AceTheme.Dimensions.border) {
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                        Text(entry.title).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).layoutPriority(1)
                        if !entry.machine.isEmpty { quiet("on \(entry.machine)") }
                        if !entry.meta.isEmpty { quiet(entry.meta) }
                        Spacer(minLength: AceDesign.Space.tight)
                        HStack(spacing: AceDesign.Space.tight) {
                            Text(entry.label).foregroundStyle(StateStyle.text(entry.token))
                            AgentElapsed(since: entry.since, settled: entry.elapsed)
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                        .lineLimit(1).fixedSize().layoutPriority(2)
                    }
                    if !entry.detail.isEmpty {
                        HStack(spacing: AceDesign.Space.related) {
                            Text(entry.detail).lineLimit(1)
                                .foregroundStyle(entry.detailKind == "failed" ? StateStyle.text("failed") : AceTheme.Colours.mutedForeground)
                                
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if entry.detailKind == "human", opens {
                                Text("Review").fontWeight(AceDesign.Typeface.regular).foregroundStyle(AceTheme.Colours.foreground)
                                    .padding(.horizontal, AceDesign.Space.related).padding(.vertical, AceTheme.Spacing.xxs)
                                    .background(AceTheme.Colours.fill, in: AceShape.capsule)
                                    .accessibilityHidden(true)
                            }
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    }
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
            .padding(.vertical, AceDesign.Space.tight + AceTheme.Dimensions.border)
        }
        .buttonStyle(TranscriptRowButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint(entry.detailKind == "human" ? "Review what it needs" : "")
        .accessibilityIdentifier("subagent.\(entry.title)")
    }
    /// It opens its delegated thread or its own lane; one not seen yet opens the agent tree.
    private var opens: Bool { !entry.threadId.isEmpty || !entry.agentId.isEmpty }
    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
    }
}

/// A transcript row you can press: no box at rest, the soft `--active` fill, concentric with its
/// container, while pressed, a full-width touch target.
struct TranscriptRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap - AceDesign.Space.related, alignment: .leading)
            .padding(.horizontal, AceDesign.Space.related)
            .aceConcentricBackground(configuration.isPressed ? AceTheme.Colours.fill : .clear, minimum: AceShape.rowRadius)
            .padding(.horizontal, -AceDesign.Space.related)
            .contentShape(Rectangle())
    }
}
