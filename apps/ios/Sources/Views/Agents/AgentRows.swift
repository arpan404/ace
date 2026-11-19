import SwiftUI

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
