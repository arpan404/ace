import SwiftUI

/// One agent in the tree: its provider's mark (indented by depth), its name over what it is
/// doing, and the shared status word.
struct AgentRowView: View {
    let row: AgentSheet.Row
    /// The thread's provider: its agents run on it.
    let provider: String
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            ProviderMark(provider: provider, size: AceDesign.Size.icon).foregroundStyle(AceDesign.Ink.primary)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.depth == 0 ? "Main agent" : row.name)
                    .font(AceDesign.Typeface.body).foregroundStyle(AceDesign.Ink.primary)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
                Text(detail).font(AceDesign.Typeface.body).fontWeight(.regular)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
            }
            Spacer(minLength: AceDesign.Space.related)
            StateLabel(status: row.status)
        }
        // Depth beyond a few levels keeps its own line rather than squeezing the name.
        .padding(.leading, CGFloat(min(row.depth, 4)) * AceDesign.Space.margin)
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
    }
    /// What it is doing; the model when that says no more than the status word.
    private var detail: String {
        var parts: [String] = []
        if row.activity.lowercased() != row.status.label.lowercased() && !row.activity.isEmpty { parts.append(row.activity) }
        else if !row.model.isEmpty { parts.append(row.model) }
        if row.depth == 0 && row.name != "Main agent" && !row.name.isEmpty { parts.insert(row.name, at: 0) }
        if row.background { parts.append("background") }
        return parts.joined(separator: " · ")
    }
}

/// A background command or task with its state; Stop, in words, where ace can stop it on its own.
struct TaskRowView: View {
    let task: AgentSheet.BackgroundTask
    let canStop: Bool
    let stop: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // At accessibility sizes Stop goes under the command instead of squeezing it.
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceDesign.Space.related))
                             : AnyLayout(HStackLayout(spacing: AceDesign.Space.row))
        layout {
            HStack(spacing: AceDesign.Space.row) {
                Image(systemName: task.kind == "shell" ? "terminal" : "gearshape.2").foregroundStyle(AceDesign.Ink.muted)
                    .frame(width: AceDesign.Size.icon + AceDesign.Space.tight)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    // Only a shell's title is its command; anything else is words, never code.
                    Group {
                        if task.kind == "shell" {
                            Text(task.title).font(AceDesign.Typeface.code)
                        } else {
                            Text(task.title).font(AceDesign.Typeface.body)
                        }
                    }
                    .foregroundStyle(AceDesign.Ink.primary)
                    .lineLimit(stacked ? 4 : 2)
                    StateLabel(status: StatusDisplay(label: task.status.label.capitalized, token: task.status.token))
                }
            }
            if !stacked { Spacer(minLength: AceTheme.Spacing.none) }
            if canStop && task.stoppable {
                Button("Stop", action: stop)
                    .font(AceDesign.Typeface.body).fontWeight(.semibold)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .padding(.horizontal, AceDesign.Space.related)
                    .buttonStyle(.plain)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("agents.task.stop.\(task.id)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Tokens across the tree and the root agent's context window, as one quiet line.
struct BudgetLine: View {
    let totals: AgentSheet.Totals
    let context: AgentSheet.Context?
    var body: some View {
        let parts = [
            context.map { "Context \(TokenCount.short($0.used)) of \(TokenCount.short($0.window))" },
            totals.tokens.map { "\(TokenCount.short($0)) tokens" },
            totals.costUsd.map { $0.formatted(.currency(code: "USD")) },
        ].compactMap { $0 }
        if !parts.isEmpty {
            Text(parts.joined(separator: " · ")).font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("agents.budget")
        }
    }
}

enum TokenCount {
    static func short(_ value: Int) -> String {
        value >= 1000 ? "\((Double(value) / 1000).formatted(.number.precision(.fractionLength(0...1))))k" : String(value)
    }
}
