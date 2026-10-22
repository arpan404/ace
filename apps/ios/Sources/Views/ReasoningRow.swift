import SwiftUI

/// What the agent thought, as one quiet row: "Thinking…" while it thinks, "Thought for 12s" once
/// done (the bridge's `thought`, `@ace/ui-core` `thoughtLabel`), the same height either way so
/// nothing moves when it finishes. The thought opens in place as Markdown when asked; the open row
/// takes the fill, with no caret, as on the web.
struct ReasoningRow: View {
    let row: TranscriptRow
    var openMessage: ((TranscriptRow) -> Void)? = nil
    var workEnded = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        // A thought whose turn is over is finished, whatever its stream last said.
        let settled = row.complete || workEnded
        let label = row.thought ?? (settled ? "Thought" : "Thinking…")
        let text = row.text.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Button {
                withAnimation(reduceMotion ? nil : AceTheme.Motion.standardCurve) { expanded.toggle() }
            } label: {
                HStack(spacing: AceTheme.Spacing.sm) {
                    AceIcon(.brain, size: 16, relativeTo: .subheadline)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .frame(minWidth: AceTheme.Spacing.xl)
                    Text(label).shimmer(!settled)
                    Spacer(minLength: AceTheme.Spacing.none)
                }
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(minHeight: AceTheme.Spacing.xxxl)
                .padding(.horizontal, AceTheme.Spacing.sm)
                .background(expanded ? AceTheme.Colours.fill : .clear, in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
                .padding(.horizontal, -AceTheme.Spacing.sm)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Still thinking with no words yet: a header with nothing to open.
            .disabled(text.isEmpty)
            .accessibilityIdentifier("thought.\(row.id)")
            .accessibilityValue(text.isEmpty ? "" : expanded ? "Expanded" : "Collapsed")
            if expanded, !text.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    MarkdownView(text: text).foregroundStyle(AceTheme.Colours.mutedForeground)
                    if row.truncated, let openMessage {
                        Button("Read full thought") { openMessage(row) }
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                }
                .padding(.leading, AceTheme.Spacing.xl + AceTheme.Spacing.sm)
            }
        }
    }
}
