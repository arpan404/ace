import SwiftUI

/// How a turn ended when it didn't simply finish: "Stopped", "Turn failed" and its reason.
struct EndingLine: View {
    let ending: BlockRow.Ending
    var body: some View {
        let failed = ending.label == "Turn failed"
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            QuietRow(icon: failed ? "exclamationmark.triangle" : "stop.circle", tint: failed ? AceTheme.Status.failed : AceTheme.Colours.decoration) {
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

struct EventLine: View {
    @Bindable var item: ItemModel
    var body: some View {
        if let handoff = item.row.handoff {
            HandoffDivider(handoff: handoff)
        } else {
            QuietRow(icon: "arrow.triangle.branch") { Text(item.row.text).lineLimit(2) }
        }
    }
}

/// "⇄ Context handoff  GPT-6.1-Sol, Muse Spark → Claude Opus 5.5" between two hairlines, as on
/// the web.
private struct HandoffDivider: View {
    let handoff: HandoffLine
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            rule
            HStack(spacing: AceTheme.Spacing.xs) {
                Image(systemName: "arrow.left.arrow.right")
                Text(handoff.label).fontWeight(.medium)
                if !handoff.from.isEmpty {
                    Text(handoff.from.map(\.name).joined(separator: ", ")).lineLimit(1).truncationMode(.middle)
                    Image(systemName: "arrow.right")
                }
                Text(handoff.to.name).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            }
            .layoutPriority(1)
            rule
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(handoff.text)
    }
    private var rule: some View {
        Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border).frame(minWidth: AceTheme.Spacing.lg).accessibilityHidden(true)
    }
}

/// A question where it was asked, once settled: open ones are answered in place of the composer.
struct QuestionLine: View {
    let interaction: ApprovalRow?
    var body: some View {
        if let interaction, interaction.state != "pending" {
            QuietRow(icon: "questionmark.bubble") {
                Text("\(interaction.title) · \(interaction.state == "resolved" ? "Answered" : interaction.state == "expired" ? "Expired" : "Cancelled")")
                    .lineLimit(2)
            }
        }
    }
}

/// A quiet row that opens something: a started conversation, edited files, published media.
struct QuietLink: View {
    let icon: String
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            QuietRow(icon: icon) {
                Text(title).lineLimit(1)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
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
        QuietRow(icon: "chart.bar.doc.horizontal") {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.text).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
                if let detail = row.detail, !detail.isEmpty { Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote) }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .accessibilityElement(children: .combine)
    }
}
