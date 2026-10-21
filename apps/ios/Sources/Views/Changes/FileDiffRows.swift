import SwiftUI

@MainActor enum FileDiffStyle {
    static let path = AceTheme.TypeStyle(size: 13.5, lineHeight: 18, weight: 400, tracking: 0)
    static let line = AceTheme.TypeStyle(size: 13, lineHeight: 24, weight: 400, tracking: 0)
    static let rowHeight: CGFloat = 24
    static let gutter: CGFloat = 46
    static let bar: CGFloat = 4
}

/// One open file's unified diff under its header, in SF Mono: 24pt rows, a line-number gutter,
/// and a 4pt bar in the change's colour. Colour marks only additions and deletions, never
/// syntax. Lines wrap unless the ⋯ menu turns wrapping off, which keeps each to one line. Rows
/// are direct children of the sheet's lazy stack, so a long diff builds only what shows; a cut
/// diff says the rest is on the computer.
struct FileDiffRows: View {
    @Bindable var model: ClientModel
    let path: String
    let wrap: Bool
    private var diff: FileDiff? { model.sheets.file?.path == path ? model.sheets.file?.diff : nil }

    var body: some View {
        if let diff {
            if diff.empty && !diff.truncated {
                Text("No line changes to show. Binary files, mode changes and new untracked files show on your computer.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(AceTheme.Spacing.lg)
                    .accessibilityIdentifier("diff.view")
            } else {
                ForEach(Array(diff.lines.enumerated()), id: \.offset) { index, line in
                    DiffLineRow(line: line, wrap: wrap)
                        .accessibilityIdentifier(index == 0 ? "diff.view" : "diff.line")
                }
                if diff.truncated {
                    Text(truncation(diff)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .padding(AceTheme.Spacing.lg)
                        .accessibilityIdentifier("diff.truncated")
                }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity).padding(AceTheme.Spacing.lg)
        }
    }
    private func truncation(_ diff: FileDiff) -> String {
        if diff.hiddenLines > 0 { return "\(diff.hiddenLines.formatted()) more lines. View the full diff on your computer." }
        if diff.lines.contains(where: \.clipped) { return "Some long lines are cut short. View the full diff on your computer." }
        return "This diff is larger than the daemon sends. View the full diff on your computer."
    }
}

private struct DiffLineRow: View {
    let line: FileDiff.Line
    let wrap: Bool
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        if line.kind == "hunk" {
            // At accessibility sizes one line holds little more than the line numbers.
            Text(line.text).aceMonospace(FileDiffStyle.line, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                .padding(.leading, FileDiffStyle.gutter + AceTheme.Spacing.xs)
                .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.none) {
                Text(number).foregroundStyle(numberColour)
                    .frame(width: FileDiffStyle.gutter - AceTheme.Spacing.md, alignment: .trailing)
                    .padding(.trailing, AceTheme.Spacing.md)
                Text(line.clipped ? line.text + " …" : line.text)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .lineLimit(wrap ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.trailing, AceTheme.Spacing.lg)
            }
            .aceMonospace(FileDiffStyle.line, relativeTo: .caption)
            .frame(maxWidth: .infinity, minHeight: FileDiffStyle.rowHeight, alignment: .leading)
            .background(background)
            .overlay(alignment: .leading) {
                if let bar { Rectangle().fill(bar).frame(width: FileDiffStyle.bar) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(line.kind == "add" ? "Added" : line.kind == "del" ? "Removed" : "Unchanged") line \(number): \(line.text)")
        }
    }
    private var number: String { String(line.kind == "del" ? line.old ?? 0 : line.new ?? line.old ?? 0) }
    private var bar: Color? {
        line.kind == "add" ? AceTheme.StatusText.done : line.kind == "del" ? AceTheme.StatusText.failed : nil
    }
    private var numberColour: Color { bar ?? AceTheme.Colours.decoration }
    private var background: Color {
        line.kind == "add" ? AceTheme.Colours.diffAdd : line.kind == "del" ? AceTheme.Colours.diffDelete : .clear
    }
}
