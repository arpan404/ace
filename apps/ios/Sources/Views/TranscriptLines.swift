import SwiftUI

/// How a turn ended when it didn't simply finish, as the web's `TurnEnd` draws it: the person's
/// Stop as a thin centred break, a restart as a quiet row, a failure as one row with its reason
/// and the provider's words behind Details, a usage-limit pause as the work it did.
struct EndingLine: View {
    let ending: BlockRow.Ending
    let row: BlockRow
    let thread: ThreadModel
    var body: some View {
        switch ending.kind {
        case "interrupted" where !ending.automatic:
            HStack(spacing: AceTheme.Spacing.sm) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxl, height: AceTheme.Dimensions.border)
                Text(ending.label)
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxl, height: AceTheme.Dimensions.border)
            }
            .font(.caption2).foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore).accessibilityLabel(ending.label)
            .accessibilityIdentifier("turn.end")
        case "interrupted":
            LogRowBox { AceIcon(.stopCircle, size: 14, relativeTo: .footnote) } title: { Text(ending.label) }
                .accessibilityElement(children: .combine).accessibilityIdentifier("turn.end")
        case "paused":
            PausedWork(ending: ending, row: row, thread: thread)
        default:
            if !ending.hidden { FailedTurnRow(ending: ending) }
        }
    }
}

/// "Turn failed · Composer 2.5 · Cursor couldn't finish the request." with Details for the
/// provider's own words.
private struct FailedTurnRow: View {
    let ending: BlockRow.Ending
    @State private var open = false
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                AceIcon(.warningCircle, size: 16, relativeTo: .subheadline).foregroundStyle(AceTheme.StatusText.failed)
                    .frame(minWidth: AceTheme.Spacing.xl)
                (Text(ending.label).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
                    + Text(ending.message.isEmpty ? "" : " · \(ending.message)").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !ending.details.isEmpty {
                    Button("Details") { open.toggle() }
                        .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                        .accessibilityIdentifier("turn.failed.details")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.xs)
            if open {
                Text(ending.details).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).textSelection(.enabled)
                    .rowDetailIndent()
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(ending.message.isEmpty ? ending.label : "\(ending.label): \(ending.message)")
        .accessibilityIdentifier("turn.failed")
    }
}

/// A turn a usage limit paused: the limit itself is the composer strip's; history keeps the work.
private struct PausedWork: View {
    let ending: BlockRow.Ending
    let row: BlockRow
    let thread: ThreadModel
    var body: some View {
        let key = "paused:\(row.items.first ?? "")"
        let open = thread.disclosures.isOpen(key)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Hairline()
            Button { thread.disclosures.toggle(key) } label: { LogRowBox(open: open) { Text(ending.label) } }
                .buttonStyle(.plain).accessibilityValue(open ? "Expanded" : "Collapsed")
            if open, let log = row.log {
                WorkLogRows(rows: log, source: LogSource(thread: thread, block: row))
            }
        }
    }
}

/// The files a turn changed, as wrapping chips (the web's `ChangedFiles`): each file's name with
/// its `+N −M`, then "+2 more". A chip opens the thread's changes.
struct ChangedFilesRow: View {
    let files: BlockRow.Files
    let open: () -> Void
    var body: some View {
        ChipFlow(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            ForEach(files.chips) { chip in
                Button(action: open) {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        Text(chip.name).lineLimit(1).truncationMode(.middle).foregroundStyle(AceTheme.Colours.foreground)
                        HStack(spacing: AceTheme.Spacing.xs) {
                            Text("+\(chip.added)").foregroundStyle(AceTheme.StatusText.done)
                            Text("−\(chip.removed)").foregroundStyle(AceTheme.StatusText.failed)
                        }
                    }
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .padding(.horizontal, AceTheme.Spacing.sm)
                    .frame(minHeight: AceTheme.Spacing.xxl + AceTheme.Spacing.xs)
                    .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.md, style: .continuous))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(chip.path) +\(chip.added) −\(chip.removed)")
            }
            if files.more > 0 {
                Button("+\(files.more) more", action: open)
                    .buttonStyle(.plain)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(minHeight: AceTheme.Spacing.xxl + AceTheme.Spacing.xs)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(files.label)
        .accessibilityIdentifier("transcript.changes")
    }
}

/// Lays chips out in rows, wrapping to the next row when one runs out of width.
struct ChipFlow: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        let width = rows.map(\.width).max() ?? 0
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indexes {
                let size = subviews[index].sizeThatFits(ProposedViewSize(width: bounds.width, height: nil))
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(width: min(size.width, bounds.width), height: size.height))
                x += min(size.width, bounds.width) + spacing
            }
            y += row.height + spacing
        }
    }
    private struct Row { var indexes: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(ProposedViewSize(width: width, height: nil))
            let item = min(size.width, width)
            if !row.indexes.isEmpty, row.width + spacing + item > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.indexes.isEmpty ? 0 : spacing) + item
            row.height = max(row.height, size.height)
            row.indexes.append(index)
        }
        if !row.indexes.isEmpty { rows.append(row) }
        return rows
    }
}

struct EventLine: View {
    @Bindable var item: ItemModel
    var body: some View {
        if let handoff = item.row.handoff {
            HandoffDivider(handoff: handoff)
        } else {
            QuietRow(icon: .gitBranch) { Text(item.row.text).lineLimit(2) }
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
                AceIcon(.arrowsLeftRight, size: 14, relativeTo: .footnote)
                Text(handoff.label).fontWeight(.medium)
                if !handoff.from.isEmpty {
                    Text(handoff.from.map(\.name).joined(separator: ", ")).lineLimit(1).truncationMode(.middle)
                    AceIcon(.arrowRight, size: 14, relativeTo: .footnote)
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
