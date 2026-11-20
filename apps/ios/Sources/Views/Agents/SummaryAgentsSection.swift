import SwiftUI

/// The Summary's agents, ordered for a phone: who waits on the person first, each with its ask and
/// Answer; then what works, its provider's mark and what it does in one line with its running
/// time; then what failed, in the failure colour; then the finished folded into one "N done" line
/// that opens in place. A nested agent indents under one above it in its group, two levels at
/// most; past that, or when its parent sits in another group, it names its parent. The whole tree
/// is one more tap away. The grouping and every word are the bridge's (`summaryAgents` in
/// ui-core), so phone and desktop never disagree on an agent's state.
struct SummaryAgentsSection: View {
    let agents: ThreadSummarySheet.Agents
    /// Opens one agent's page, or the thread it delegated to.
    let open: (ThreadSummarySheet.Agent) -> Void
    /// Opens the whole agent tree; nil where it isn't one tap away.
    let openTree: (() -> Void)?
    @State private var showDone = false

    var body: some View {
        QuietSection("Agents") {
            ForEach(agents.asks) { agent in SummaryAgentRow(agent: agent, open: { open(agent) }) }
            ForEach(agents.working) { agent in SummaryAgentRow(agent: agent, open: { open(agent) }) }
            ForEach(agents.failed) { agent in SummaryAgentRow(agent: agent, open: { open(agent) }) }
            if let words = agents.doneWords { doneFold(words) }
            if showDone {
                ForEach(agents.done) { agent in SummaryAgentRow(agent: agent, open: { open(agent) }) }
            }
            if let openTree {
                Button("Agent tree", action: openTree)
                    .buttonStyle(.rowActionOpening)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .accessibilityIdentifier("summary.agents")
            }
        }
        .accessibilityIdentifier("summary.agentList")
    }

    private func doneFold(_ words: String) -> some View {
        Button {
            withAnimation(.default) { showDone.toggle() }
        } label: {
            QuietSectionRow {
                RowStatusIcon(kind: "done", tone: "muted")
                    .frame(width: AceDesign.Size.lead)
                    .accessibilityHidden(true)
                Text(words).aceFont(AceDesign.TextRole.rowTitle)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.down")
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .rotationEffect(.degrees(showDone ? 180 : 0))
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(words)
        .accessibilityValue(showDone ? "Shown" : "Hidden")
        .accessibilityHint(showDone ? "Hides the finished agents" : "Shows the finished agents")
        .accessibilityIdentifier("summary.agents.done")
    }
}

/// One agent: its status icon, its name, then its provider's mark and what it does, asks or came
/// back with. Live work counts its running time; a request offers its way on as a button.
private struct SummaryAgentRow: View {
    let agent: ThreadSummarySheet.Agent
    let open: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var settled: Bool { agent.icon.kind == "done" }

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
            : AnyLayout(HStackLayout(alignment: .center, spacing: AceDesign.Space.related))
        layout {
            Button(action: open) {
                HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                    RowStatusIcon(kind: agent.icon.kind, tone: agent.icon.tone, count: agent.icon.count)
                        .frame(width: AceDesign.Size.lead)
                        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + AceDesign.Size.icon / 3 }
                    VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                        Text(agent.name).aceFont(AceDesign.TextRole.rowTitle)
                            .foregroundStyle(settled ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                            .lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
                        meta
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if agent.action == nil { RowCaret() }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(agent.name)
            .accessibilityValue(spoken)
            .accessibilityHint("Opens the agent")
            .accessibilityIdentifier("summary.agent.\(agent.agentId)")
            if let action = agent.action {
                Button(action, action: open)
                    .buttonStyle(.secondaryAction)
                    .accessibilityLabel("\(action) \(agent.name)")
                    .accessibilityIdentifier("summary.agent.\(agent.agentId).action")
            }
        }
        .padding(.leading, CGFloat(agent.indent) * AgentTreeRails.indent)
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Size.rowPaddingTop)
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
    }

    /// The provider's mark, then the step, its running time while it works, and the parent it
    /// hangs under when the indent doesn't say.
    private var meta: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.tight + 1) {
            ProviderMark(provider: agent.provider, size: AceDesign.Size.rowMark)
                .opacity(AceDesign.Ink.markOpacity)
            if agent.ticking {
                // Only the running time changes each second; the line keeps its place.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    line(Elapsed.words(since: agent.startedAt, now: context.date))
                }
            } else {
                line(nil)
            }
        }
        .aceFont(AceDesign.TextRole.meta)
    }

    private func line(_ time: String?) -> some View {
        var text = Text(agent.step).foregroundStyle(ThreadSummaryPage.ink(agent.tone, rest: AceDesign.Ink.muted))
        if let time { text = text + Text(" · \(time)").foregroundStyle(AceDesign.Ink.subtle) }
        if let under = agent.under { text = text + Text(" · in \(under)").foregroundStyle(AceDesign.Ink.subtle) }
        return text.monospacedDigit().lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
    }

    private var spoken: String {
        [agent.icon.words, agent.step, agent.under.map { "in \($0)" } ?? ""]
            .filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

private extension ThreadSummarySheet.Agent.Icon {
    /// The status icon's meaning, for VoiceOver.
    var words: String {
        switch kind {
        case "question", "approve": "Needs you"
        case "failed": "Failed"
        case "working": "Working"
        case "agents": count.map { "Waiting on \($0) agents" } ?? "Waiting on agents"
        case "waiting": "Waiting"
        case "done": "Done"
        default: ""
        }
    }
}
