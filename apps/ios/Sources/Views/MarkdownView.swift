import SwiftUI

/// An agent's Markdown as native text: SF Pro prose with inline styling, SF Mono code blocks that
/// scroll sideways. Parsing is proportional to this one message, so a streamed delta re-renders
/// its own row only.
struct MarkdownView: View {
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(Array(Markdown.blocks(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            Text(Markdown.inline(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
        case .heading(let level, let text):
            Text(Markdown.inline(text)).aceFont(level <= 2 ? AceTheme.Typography.title : AceTheme.Typography.rowTitle, relativeTo: .headline)
                .accessibilityAddTraits(.isHeader)
        case .code(_, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(verbatim: text).aceMonospace(AceTheme.Typography.code, relativeTo: .footnote).fixedSize(horizontal: true, vertical: false)
                    .padding(AceTheme.Spacing.md)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.code))
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        Text(verbatim: ordered ? "\(start + index)." : "•").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                        Text(Markdown.inline(item))
                    }
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    // One element per item, so the number is read with its text.
                    .accessibilityElement(children: .combine)
                }
            }
        case .quote(let text):
            HStack(spacing: AceTheme.Spacing.md) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxs)
                Text(Markdown.inline(text)).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
            }.fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        case .table(let headers, let rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .topLeading, horizontalSpacing: AceTheme.Spacing.none, verticalSpacing: AceTheme.Spacing.none) {
                    GridRow {
                        ForEach(Array(headers.enumerated()), id: \.offset) { _, cell in tableCell(cell).fontWeight(.semibold).background(AceTheme.Colours.fill) }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in tableCell(cell) }
                        }
                    }
                }
            }.accessibilityIdentifier("markdown.table")
        }
    }
    private func tableCell(_ text: String) -> some View {
        Text(Markdown.inline(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
            .frame(width: AceTheme.Dimensions.touchTarget * 4, alignment: .leading)
            .padding(AceTheme.Spacing.sm)
            .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
    }
}
