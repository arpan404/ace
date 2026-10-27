import SwiftUI

@MainActor enum FileDiffStyle {
    static let path = AceTheme.TypeStyle(size: 13.5, lineHeight: 18, weight: 400, tracking: 0)
    static let line = AceTheme.TypeStyle(size: 13, lineHeight: 24, weight: 400, tracking: 0)
    static let rowHeight: CGFloat = 24
    static let gutter: CGFloat = 46
    static let bar: CGFloat = 4
}

/// Lines picked for a comment: one side of one file, `start...end`.
struct LineSelection: Equatable {
    let path: String
    let side: String
    var start: Int
    var end: Int
    var label: String { start == end ? "Line \(start)" : "Lines \(start)–\(end)" }
    func contains(_ row: ChangesRow, in path: String) -> Bool {
        guard path == self.path, let anchor = row.anchor, anchor.side == side else { return false }
        return (start...end).contains(anchor.line)
    }
}

/// One unified diff row in SF Mono: a line-number gutter, a 4pt bar in the change's colour, and
/// the text. Tapping a line picks it for a comment; a second tap on the same side extends the
/// pick to a range. Colour marks only additions and deletions, never syntax.
struct ChangesLineRow: View {
    let row: ChangesRow
    let wrap: Bool
    let selected: Bool
    let tap: () -> Void
    let wholeLine: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if row.kind == "fold" {
            Text(row.count.map { "\($0) unchanged \($0 == 1 ? "line" : "lines")" } ?? "Unchanged lines")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .padding(.leading, FileDiffStyle.gutter + AceTheme.Spacing.xs)
                .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
                .background(AceTheme.Colours.fill.opacity(0.5))
        } else {
            Button(action: tap) {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.none) {
                    Text(number).foregroundStyle(numberColour)
                        .frame(width: FileDiffStyle.gutter - AceTheme.Spacing.md, alignment: .trailing)
                        .padding(.trailing, AceTheme.Spacing.md)
                    Text(row.text)
                        .foregroundStyle(AceTheme.Colours.foreground)
                        .lineLimit(wrap ? nil : 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.trailing, AceTheme.Spacing.lg)
                    if row.clipped {
                        Spacer(minLength: 0)
                        Button("Whole line", action: wholeLine)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .padding(.trailing, AceTheme.Spacing.lg)
                            .frame(minHeight: 44)
                    }
                }
                .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
                .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
                .background(selected ? AceTheme.Colours.accent.opacity(0.16) : background)
                .overlay(alignment: .leading) {
                    if let bar { Rectangle().fill(bar).frame(width: FileDiffStyle.bar) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Comment on this line", systemImage: "text.bubble", action: tap)
                Button("Copy line", systemImage: "doc.on.doc") { UIPasteboard.general.string = row.text }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(row.kind == "add" ? "Added" : row.kind == "del" ? "Removed" : "Unchanged") line \(number): \(row.text)")
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityHint("Picks the line for a comment")
        }
    }
    private var number: String { String(row.kind == "del" ? row.old ?? 0 : row.new ?? row.old ?? 0) }
    private var bar: Color? {
        row.kind == "add" ? AceTheme.StatusText.done : row.kind == "del" ? AceTheme.StatusText.failed : nil
    }
    private var numberColour: Color { bar ?? AceTheme.Colours.decoration }
    private var background: Color {
        row.kind == "add" ? AceTheme.Colours.diffAdd : row.kind == "del" ? AceTheme.Colours.diffDelete : .clear
    }
}

/// Split layout on wide screens: the old side on the left, the new on the right, removed lines
/// beside the added lines that replaced them.
struct ChangesSplitRow: View {
    let pair: ChangesPair
    let wrap: Bool
    let selected: (ChangesRow) -> Bool
    let tap: (ChangesRow) -> Void
    let wholeLine: (ChangesRow) -> Void

    var body: some View {
        if pair.kind == "fold", let fold = pair.fold {
            ChangesLineRow(row: fold, wrap: wrap, selected: false, tap: {}, wholeLine: {})
        } else {
            HStack(alignment: .top, spacing: AceTheme.Spacing.none) {
                side(pair.left)
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                side(pair.right)
            }
        }
    }
    @ViewBuilder private func side(_ row: ChangesRow?) -> some View {
        if let row {
            ChangesLineRow(row: row, wrap: wrap, selected: selected(row), tap: { tap(row) }, wholeLine: { wholeLine(row) })
                .frame(maxWidth: .infinity)
        } else {
            AceTheme.Colours.fill.opacity(0.4).frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight)
        }
    }
}
