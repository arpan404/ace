import SwiftUI

/// How a turn ended when it didn't simply finish: "Stopped", "Turn failed" and its reason.
struct EndingLine: View {
    let ending: BlockRow.Ending
    var body: some View {
        let failed = ending.label == "Turn failed"
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            QuietRow(icon: failed ? .warning : .stopCircle, tint: failed ? AceTheme.Status.failed : AceTheme.Colours.decoration) {
                Text(ending.label).foregroundStyle(failed ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
            }
            if !ending.error.isEmpty {
                Text(ending.error).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3)
                    .padding(.leading, AceTheme.Spacing.xxl + AceTheme.Spacing.sm + AceTheme.Spacing.xxs)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A question where it was asked, once settled: open ones are answered in place of the composer.
struct QuestionLine: View {
    let interaction: ApprovalRow?
    var body: some View {
        if let interaction, interaction.state != "pending" {
            QuietRow(icon: .question) {
                Text("\(interaction.title) · \(interaction.state == "resolved" ? "Answered" : interaction.state == "expired" ? "Expired" : "Cancelled")")
                    .lineLimit(2)
            }
        }
    }
}

/// A quiet row that opens something: a started conversation, edited files, published media.
struct QuietLink: View {
    let icon: AceIcon.Name
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            QuietRow(icon: icon) {
                Text(title).lineLimit(1)
                AceIcon(.caretRight, size: 12, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

/// The sandboxed renderer is desktop/web only; show what was published and where to see it.
struct VisualizationRow: View {
    let row: TranscriptRow
    var body: some View {
        QuietRow(icon: .chartBarHorizontal) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.text).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                if let detail = row.detail, !detail.isEmpty { Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote) }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .accessibilityElement(children: .combine)
    }
}
