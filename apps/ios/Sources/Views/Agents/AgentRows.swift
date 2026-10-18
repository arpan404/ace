import SwiftUI

/// One agent in the tree: indent by depth, the shared status word and colour, what it is doing.
struct AgentRowView: View {
    let row: AgentSheet.Row
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Circle().fill(StateStyle.marker(row.status.token))
                .frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.model.isEmpty ? row.name : "\(row.name) · \(row.model)")
                    .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(row.needsYou ? StateStyle.text(row.status.token) : AceTheme.Colours.mutedForeground).lineLimit(2)
            }
        }
        // Depth beyond a few levels keeps its own line rather than squeezing the name.
        .padding(.leading, CGFloat(min(row.depth, 4)) * AceTheme.Spacing.lg)
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.status.label)
    }
    private var detail: String {
        var parts = [row.status.label]
        // Only a working or failed agent's activity says more than its status word.
        if ["working", "failed"].contains(row.status.token) && row.activity.lowercased() != row.status.label.lowercased() { parts.append(row.activity) }
        if let tokens = row.tokens { parts.append("\(TokenCount.short(tokens)) tokens") }
        if row.background { parts.append("background") }
        return parts.joined(separator: " · ")
    }
}

/// A background process or task with its state; Stop where ace can stop it on its own.
struct TaskRowView: View {
    let task: AgentSheet.BackgroundTask
    let canStop: Bool
    let stop: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Image(systemName: task.kind == "shell" ? "terminal" : "gearshape.2").foregroundStyle(AceTheme.Colours.mutedForeground)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(task.title).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).lineLimit(2)
                Text(task.status.label.capitalized).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(StateStyle.text(task.status.token))
            }
            Spacer(minLength: AceTheme.Spacing.none)
            if canStop && task.stoppable {
                Button("Stop", role: .destructive, action: stop).buttonStyle(.bordered).controlSize(.small)
                    .accessibilityIdentifier("agents.task.stop.\(task.id)")
            }
        }
        .accessibilityElement(children: .contain)
    }
}

/// Tokens across the tree and the root agent's context window, when the provider reports them.
struct BudgetView: View {
    let totals: AgentSheet.Totals
    let context: AgentSheet.Context?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            if let context {
                LabeledContent("Context", value: "\(TokenCount.short(context.used)) / \(TokenCount.short(context.window))")
                ProgressView(value: Double(min(context.used, context.window)), total: Double(max(context.window, 1))).tint(AceTheme.Colours.accent)
            }
            if let tokens = totals.tokens { LabeledContent("Tokens used", value: TokenCount.short(tokens)) }
            if let cost = totals.costUsd { LabeledContent("Cost", value: cost.formatted(.currency(code: "USD"))) }
        }
        .aceFont(AceTheme.Typography.body, relativeTo: .body)
    }
}

enum TokenCount {
    static func short(_ value: Int) -> String {
        value >= 1000 ? "\((Double(value) / 1000).formatted(.number.precision(.fractionLength(0...1))))k" : String(value)
    }
}
