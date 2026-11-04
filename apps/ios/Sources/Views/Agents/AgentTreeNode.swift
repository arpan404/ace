import SwiftUI

/// The rails a tree line sits on: one hairline per level above it, through the middle of its
/// parent's status icon, so a branch's children hang under it. Lines draw their own rails, so
/// the tree scrolls as a plain lazy list.
struct AgentTreeRails: View {
    let level: Int
    static let indent = AceDesign.Size.rowGlyph
    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(0..<max(level, 0), id: \.self) { depth in
                Rectangle().fill(AceTheme.Colours.separator)
                    .frame(width: AceTheme.Dimensions.border)
                    .frame(maxHeight: .infinity)
                    .offset(x: CGFloat(depth) * Self.indent + AceDesign.Size.lead / 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityHidden(true)
    }
}

/// One agent in the tree: its status icon, its name, and a meta line (its provider's mark, its
/// role or model, how long it has worked while it works, the machine when it's another one, why
/// it stopped). One that needs the person offers its answers inline, Deny and Allow in words.
/// Settled agents step back to the muted ink; every word and state is the bridge's.
struct AgentTreeNode: View {
    let row: AgentSheet.Row
    let level: Int
    /// The thread's provider: the main agent runs on it, and older bridges send no provider.
    let provider: String
    /// The oldest request the person can answer here, when there is one.
    let request: ApprovalRow?
    let canAnswer: Bool
    let answer: (ApprovalRow, ApprovalRow.Option) -> Void
    let review: (ApprovalRow) -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    private var settled: Bool { !row.running && !row.needsYou }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            icon
            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                Text(row.depth == 0 && row.name.isEmpty ? "Main agent" : row.name)
                    .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .body)
                    .foregroundStyle(settled ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 2)
                // A settled agent with nothing more to say keeps to one line.
                if !(metaWords.isEmpty && !row.running) { meta }
                if let request { answers(request) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.leading, CGFloat(level) * AgentTreeRails.indent)
        .padding(.vertical, AceDesign.Size.rowPaddingTop)
        .frame(minHeight: AceDesign.Size.tap, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.depth == 0 && row.name.isEmpty ? "Main agent" : row.name)
        .accessibilityValue([row.status.label, metaWords].filter { !$0.isEmpty }.joined(separator: ", "))
    }

    @ViewBuilder private var icon: some View {
        Group {
            if let icon = row.icon, let kind = icon.kind {
                RowStatusIcon(kind: kind, tone: icon.tone, count: icon.count)
            } else {
                Color.clear
            }
        }
        .frame(width: AceDesign.Size.lead)
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + AceDesign.Size.icon / 3 }
    }

    /// Provider mark, then the quiet facts in one line.
    private var meta: some View {
        HStack(spacing: AceDesign.Space.tight + 1) {
            ProviderMark(provider: row.provider ?? provider, size: AceDesign.Size.rowMark)
                .opacity(AceDesign.Ink.markOpacity)
            if row.running && !row.needsYou && row.endedAt == nil {
                // Live work: the running time after the words, ticking only while it works.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text([metaWords, Elapsed.words(since: row.createdAt, now: context.date)].filter { !$0.isEmpty }.joined(separator: " · "))
                        .monospacedDigit()
                }
                .lineLimit(1)
            } else {
                Text(metaWords).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
            }
        }
        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.subtleForeground)
    }

    /// Role or model, the machine, and why it stopped or waits: "Lead · Opus 5.5 · Rijan's Mac".
    var metaWords: String {
        var parts: [String] = []
        if let role = row.role, !role.isEmpty { parts.append(role.prefix(1).uppercased() + role.dropFirst()) }
        if let label = row.modelLabel, !label.isEmpty { parts.append(label) } else if !row.model.isEmpty { parts.append(row.model) }
        if let machine = row.machine, !machine.isEmpty { parts.append(machine) }
        if let request { parts.append(request.heading ?? request.title) }
        else if let reason = row.reason, !reason.isEmpty { parts.append(reason) }
        if row.background { parts.append("in the background") }
        // A settled agent says how long it ran.
        if !row.running, let ended = row.endedAt, ended > row.createdAt {
            parts.append(Elapsed.words(since: row.createdAt, now: Date(timeIntervalSince1970: ended / 1000)))
        }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func answers(_ request: ApprovalRow) -> some View {
        HStack(spacing: AceTheme.Spacing.none) {
            if request.kind == "approval", let deny = denyOption(request), let allow = allowOption(request) {
                Button(deny.label) { answer(request, deny.option) }
                    .buttonStyle(StripTextButtonStyle())
                    .accessibilityIdentifier("agents.node.deny")
                Button(allow.label) { answer(request, allow.option) }
                    .buttonStyle(StripTextButtonStyle(prominent: true))
                    .accessibilityIdentifier("agents.node.allow")
            } else {
                Button(request.kind == "question" ? "Answer" : "Review") { review(request) }
                    .buttonStyle(StripTextButtonStyle(prominent: true))
                    .accessibilityIdentifier("agents.node.review")
            }
        }
        .disabled(!canAnswer)
        // The words line up with the name above them; the first button's own padding is taken back.
        .padding(.leading, -AceDesign.Space.related)
    }

    private func denyOption(_ request: ApprovalRow) -> (label: String, option: ApprovalRow.Option)? {
        if let verb = request.verbs.first(where: { $0.option.kind == "deny" }) { return (verb.decision.label, verb.option) }
        return request.options.first { $0.kind == "deny" }.map { ($0.label, $0) }
    }
    private func allowOption(_ request: ApprovalRow) -> (label: String, option: ApprovalRow.Option)? {
        if let verb = request.verbs.first(where: { $0.decision.emphasis == "primary" }) { return (verb.decision.label, verb.option) }
        return request.options.first { $0.kind == "allow_once" }.map { ($0.label, $0) }
    }
}

/// A background command under its agent: a quiet terminal mark, the command in mono, and its
/// state in words. Stop, in words, while it runs and ace can stop it.
struct AgentTreeTask: View {
    let task: AgentSheet.BackgroundTask
    let level: Int
    let canStop: Bool
    let stop: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            RowStatusIcon(kind: "background", tone: task.status.token == "working" ? "background" : "muted")
                .frame(width: AceDesign.Size.lead)
            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                Group {
                    if task.kind == "shell" { Text(task.title).aceMonospace(AceDesign.TextRole.code, relativeTo: .footnote) }
                    else { Text(task.title).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote) }
                }
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1).truncationMode(.middle)
                Text(task.status.label.prefix(1).uppercased() + task.status.label.dropFirst())
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(task.status.token == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if canStop && task.stoppable {
                Button("Stop", action: stop)
                    .buttonStyle(StripTextButtonStyle())
                    .accessibilityIdentifier("agents.task.stop.\(task.id)")
            }
        }
        .padding(.leading, CGFloat(level) * AgentTreeRails.indent)
        .padding(.vertical, AceDesign.Space.related)
        .frame(minHeight: AceDesign.Size.tap)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Background command, \(task.title)")
        .accessibilityValue(task.status.label)
    }
}
