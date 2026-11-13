import SwiftUI

/// The Summary's agent tree (ADR 0108): every agent of the thread and of the threads it
/// delegated, each level stepped in on a hairline rail. The provider's mark is the only status
/// mark; colour is kept for words (the warning colour for a request, red for a failure). A row
/// with children folds from its caret; a live branch shows and a finished one is folded until the
/// person chooses, and the bridge keeps that choice (`summary.fold`). Every word is the bridge's.
struct SummaryTree: View {
    let tree: ThreadSummarySheet.Tree
    let canStop: Bool
    let fold: (ThreadSummarySheet.Tree.Line, Bool) -> Void
    let open: (ThreadSummarySheet.Tree.Line.Open, String) -> Void
    let stop: (ThreadSummarySheet.Tree.Line.Stop) -> Void
    /// Opens Agents, where the lines past the cap live; nil where it isn't one tap away.
    let openAgents: (() -> Void)?

    var body: some View {
        QuietSection("Agents · \(tree.count)") {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(tree.lines) { line in
                    SummaryTreeLine(line: line, canStop: canStop, fold: fold, open: open, stop: stop)
                        .background { AgentTreeRails(level: line.depth) }
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            if tree.more > 0, let openAgents {
                QuietSectionRow {
                    Button("\(tree.more) more in Agents", action: openAgents)
                        .buttonStyle(.textAction())
                        .accessibilityIdentifier("summary.tree.more")
                    Spacer(minLength: 0)
                }
            }
        }
        .accessibilityIdentifier("summary.tree")
    }
}

private struct SummaryTreeLine: View {
    let line: ThreadSummarySheet.Tree.Line
    let canStop: Bool
    let fold: (ThreadSummarySheet.Tree.Line, Bool) -> Void
    let open: (ThreadSummarySheet.Tree.Line.Open, String) -> Void
    let stop: (ThreadSummarySheet.Tree.Line.Stop) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.tight) {
            caret
            Button { tap() } label: {
                HStack(alignment: .center, spacing: AceDesign.Space.related) {
                    content
                }
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(line.open == nil && line.kind != "finished")
            .contextMenu {
                if canStop, let target = line.stop {
                    Button(role: .destructive) { stop(target) } label: { Label("Stop", systemImage: "stop.circle") }
                }
            }
            .accessibilityLabel(line.label ?? line.words ?? "")
            .accessibilityValue(line.time ?? "")
            .accessibilityHint(line.open == nil ? "" : "Opens it")
            .accessibilityIdentifier("summary.tree.row.\(line.key)")
        }
        .padding(.leading, CGFloat(line.depth) * AgentTreeRails.indent)
    }

    /// A row with children folds from here; the others keep its room so names line up.
    @ViewBuilder private var caret: some View {
        if let expanded = line.expanded, line.kind != "finished" {
            Button { fold(line, !expanded) } label: {
                AceIcon(expanded ? .caretDown : .caretRight, size: AceDesign.Size.chevron, weight: .bold, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .frame(width: AceDesign.Size.lead, height: AceDesign.Size.tap)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Fold" : "Unfold")
            .accessibilityIdentifier("summary.tree.fold.\(line.key)")
        } else {
            Color.clear.frame(width: AceDesign.Size.lead, height: 1).accessibilityHidden(true)
        }
    }

    @ViewBuilder private var content: some View {
        switch line.kind {
        case "agent": agent
        case "command": command
        default:
            Text(line.words ?? "")
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var agent: some View {
        Group {
            BreathingMark(provider: line.provider ?? "", live: line.live == true, done: line.done == true)
            VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                (Text(line.name ?? "") + Text(line.machine.map { " · \($0)" } ?? "").foregroundStyle(AceDesign.Ink.subtle))
                    .aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(line.muted == true ? AceDesign.Ink.muted : AceDesign.Ink.primary)
                    .lineLimit(1)
                if let step = line.step, !step.isEmpty {
                    (Text(step).foregroundStyle(ThreadSummaryPage.ink(line.tone ?? "plain", rest: AceDesign.Ink.subtle))
                        + Text(line.folded.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? "").foregroundStyle(AceDesign.Ink.subtle))
                        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                        .lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            time
        }
    }

    private var command: some View {
        Group {
            Text("$")
                .aceMonospace(AceDesign.TextRole.code, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(width: AceDesign.Size.glyphSmall)
                .accessibilityHidden(true)
            Text(line.command ?? "")
                .aceMonospace(AceDesign.TextRole.code, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.primary)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            time
        }
    }

    @ViewBuilder private var time: some View {
        if let time = line.time, !time.isEmpty {
            Text(time)
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
                .monospacedDigit()
        }
    }

    private func tap() {
        if line.kind == "finished" { fold(line, !(line.expanded ?? false)) }
        else if let target = line.open { open(target, line.name ?? "") }
    }
}

/// The tree's one status mark: the provider's own mark, breathing (opacity and scale over 2.4s)
/// while its branch works or waits, still at rest, dimmed once done. It holds still under reduced
/// motion; the bridge already holds it still while its facts are stale.
private struct BreathingMark: View {
    let provider: String
    let live: Bool
    let done: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let mark = ProviderMark(provider: provider, size: AceDesign.Size.glyphSmall + 2)
            .opacity(done ? 0.55 : 1)
            .accessibilityHidden(true)
        if live && !reduceMotion {
            mark.phaseAnimator([false, true]) { content, low in
                content.opacity(low ? 0.45 : 1).scaleEffect(low ? 0.88 : 1)
            } animation: { _ in .easeInOut(duration: 1.2) }
        } else {
            mark
        }
    }
}
