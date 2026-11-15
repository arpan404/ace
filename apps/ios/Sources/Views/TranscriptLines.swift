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
            HStack(spacing: AceDesign.Space.related) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceDesign.Space.group, height: AceTheme.Dimensions.border)
                Text(ending.label)
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceDesign.Space.group, height: AceTheme.Dimensions.border)
            }
            .font(AceDesign.Typeface.caption).foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore).accessibilityLabel(ending.label)
            .accessibilityIdentifier("turn.end")
        case "interrupted":
            LogRowBox { AceIcon(.stopCircle, size: AceDesign.Size.glyphMeta, relativeTo: .footnote) } title: { Text(ending.label) }
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
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                AceIcon(.warningCircle, size: AceDesign.Size.icon, relativeTo: .subheadline).foregroundStyle(AceTheme.StatusText.failed)
                    .frame(minWidth: AceDesign.Size.lead)
                (Text(ending.label).fontWeight(AceDesign.Typeface.regular).foregroundStyle(AceTheme.Colours.foreground)
                    + Text(ending.message.isEmpty ? "" : " · \(ending.message)").foregroundStyle(AceTheme.Colours.mutedForeground))
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !ending.details.isEmpty {
                    Button("Details") { open.toggle() }
                        .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .accessibilityValue(open ? "Expanded" : "Collapsed")
                        .accessibilityIdentifier("turn.failed.details")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
            .frame(minHeight: AceDesign.Size.tap - AceDesign.Space.tight)
            if open {
                Text(ending.details).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(AceDesign.Typeface.regular)
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
    @Environment(\.displayScale) private var displayScale
    var body: some View {
        ChipFlow(spacing: AceDesign.Space.tight, scale: displayScale) {
            ForEach(files.chips) { chip in
                Button(action: open) {
                    HStack(spacing: AceDesign.Space.related) {
                        Text(chip.name).lineLimit(1).truncationMode(.middle).foregroundStyle(AceTheme.Colours.foreground)
                        HStack(spacing: AceDesign.Space.tight) {
                            Text("+\(chip.added)").foregroundStyle(AceTheme.StatusText.done)
                            Text("−\(chip.removed)").foregroundStyle(AceTheme.StatusText.failed)
                        }
                    }
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .padding(.horizontal, AceDesign.Space.related)
                    .frame(minHeight: AceDesign.Space.group + AceDesign.Space.tight)
                    .background(AceTheme.Colours.fill, in: AceShape.capsule)
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
                    .frame(minHeight: AceDesign.Space.group + AceDesign.Space.tight)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(files.label)
        .accessibilityIdentifier("transcript.changes")
    }
}

/// Lays chips out in rows, wrapping to the next row when one runs out of width.
///
/// A flow must lay out the same rows where SwiftUI places it as it reported: placed on the
/// screen's pixels, a flow whose last chip wrapped would be a row taller than it said, and the
/// layout would swap between the two widths (#2051). So packing always uses one capacity, the
/// width rounded down to the pixel grid, and the reported width is the widest row rounded up to
/// it, which never passes the capacity. Each chip is measured once at its own size (a row clamps
/// one wider than itself), and the rows for the last capacity asked are kept.
struct ChipFlow: Layout {
    var spacing: CGFloat
    /// The screen's pixels per point (`displayScale`), for the pixel grid.
    var scale: CGFloat
    struct Row: Equatable { var indexes: [Int] = []; var width: CGFloat = 0; var height: CGFloat = 0 }
    /// The chips' own sizes and the rows for the last capacity asked; cleared when the chips change.
    struct Cache {
        private(set) var sizes: [CGSize] = []
        private var measured = false
        private var last: (capacity: CGFloat, rows: [Row])?
        /// The rows at `capacity`. The chips are measured (`measure`) only the first time.
        mutating func rows(capacity: CGFloat, spacing: CGFloat, measure: () -> [CGSize]) -> [Row] {
            if let last, last.capacity == capacity { return last.rows }
            if !measured { sizes = measure(); measured = true }
            let rows = ChipFlow.rows(sizes, capacity: capacity, spacing: spacing)
            last = (capacity, rows)
            return rows
        }
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) { cache = Cache() }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let rows = arranged(capacity: Self.capacity(proposal.width ?? .infinity, scale: scale), subviews: subviews, cache: &cache)
        return Self.reported(Self.size(of: rows, spacing: spacing, scale: scale), proposal: proposal.width)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let capacity = Self.capacity(bounds.width, scale: scale)
        let rows = arranged(capacity: capacity, subviews: subviews, cache: &cache)
        var y = bounds.minY
        for row in rows {
            var x = bounds.minX
            for index in row.indexes {
                let size = cache.sizes[index]
                let width = min(size.width, capacity)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(width: width, height: size.height))
                x += width + spacing
            }
            y += row.height + spacing
        }
    }
    /// The flow's leading edge is its bounds' own. Without this, SwiftUI places every chip to
    /// merge their guides each time the feed's leading-aligned stack asks.
    func explicitAlignment(of guide: HorizontalAlignment, in bounds: CGRect, proposal: ProposedViewSize,
                           subviews: Subviews, cache: inout Cache) -> CGFloat? { nil }
    private func arranged(capacity: CGFloat, subviews: Subviews, cache: inout Cache) -> [Row] {
        cache.rows(capacity: capacity, spacing: spacing) {
            PerfCounters.bump("chips.measure")
            return subviews.map { $0.sizeThatFits(.unspecified) }
        }
    }

    /// What `sizeThatFits` returns for chips of `sizes` at a proposed width. Pure.
    static func fit(_ sizes: [CGSize], proposal: CGFloat?, spacing: CGFloat, scale: CGFloat) -> (size: CGSize, rows: [Row]) {
        let rows = rows(sizes, capacity: capacity(proposal ?? .infinity, scale: scale), spacing: spacing)
        return (reported(size(of: rows, spacing: spacing, scale: scale), proposal: proposal), rows)
    }
    /// The room rows pack into at `width`: the width rounded down to the pixel grid.
    static func capacity(_ width: CGFloat, scale: CGFloat) -> CGFloat {
        guard width.isFinite, scale > 0 else { return width }
        // Within a millionth of a pixel is on it: a width SwiftUI computed is never rounded down a whole pixel.
        return (width * scale + 1e-6).rounded(.down) / scale
    }
    /// The size rows take: their widest rounded up to the pixel grid (never past their capacity,
    /// which is on it), and their heights with the spacing between them.
    static func size(of rows: [Row], spacing: CGFloat, scale: CGFloat) -> CGSize {
        let widest = rows.map(\.width).max() ?? 0
        let width = scale > 0 ? (widest * scale - 1e-6).rounded(.up) / scale : widest
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: max(0, width), height: height)
    }
    private static func reported(_ size: CGSize, proposal: CGFloat?) -> CGSize {
        CGSize(width: min(size.width, proposal ?? size.width), height: size.height)
    }
    /// Chips of `sizes` in rows of at most `capacity`: a chip wider than the row takes one of its
    /// own, at the row's width. Pure.
    static func rows(_ sizes: [CGSize], capacity: CGFloat, spacing: CGFloat) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for (index, size) in sizes.enumerated() {
            let item = min(size.width, capacity)
            if !row.indexes.isEmpty, row.width + spacing + item > capacity {
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

/// A quiet row that opens something: a started conversation, edited files, published media.
struct QuietLink: View {
    let icon: AceIcon.Name
    let title: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            QuietRow(icon: icon) {
                Text(title).lineLimit(1)
                AceIcon(.caretRight, size: AceDesign.Size.glyphSmall, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .frame(minHeight: AceDesign.Size.tap - AceDesign.Space.related)
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
