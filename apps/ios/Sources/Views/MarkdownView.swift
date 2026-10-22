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
            Text(styled(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
        case .heading(let level, let text):
            Text(styled(text)).aceFont(level <= 2 ? AceTheme.Typography.title : AceTheme.Typography.rowTitle, relativeTo: .headline)
                .accessibilityAddTraits(.isHeader)
        case .code(let language, let text):
            MarkdownCodeBlock(language: language, text: text)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        Text(verbatim: ordered ? "\(start + index)." : "•").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                        Text(styled(item))
                    }
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    // One element per item, so the number is read with its text.
                    .accessibilityElement(children: .combine)
                }
            }
        case .quote(let text):
            HStack(spacing: AceTheme.Spacing.md) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxs)
                Text(styled(text)).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
            }.fixedSize(horizontal: false, vertical: true)
        case .rule:
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        case .table(let headers, let rows):
            // Columns share the reading width and wrap: a sideways scroller inside the lazy
            // transcript made it re-place rows without end.
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                tableRow(headers, header: true)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in tableRow(row, header: false) }
            }
            .accessibilityIdentifier("markdown.table")
        }
    }
    private func tableRow(_ cells: [String], header: Bool) -> some View {
        HStack(alignment: .top, spacing: AceTheme.Spacing.none) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                Text(styled(cell)).aceFont(AceTheme.Typography.body, relativeTo: .body)
                    .fontWeight(header ? .semibold : .regular)
                    .padding(AceTheme.Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
        .background(header ? AceTheme.Colours.fill : .clear)
        .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
    }
    /// Inline code on the code surface at about 0.92 of the prose, in SF Mono; links in the
    /// accent, as the web's `text-link`.
    private func styled(_ text: String) -> AttributedString {
        var styled = Markdown.inline(text)
        for run in styled.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                styled[run.range].font = .system(.subheadline, design: .monospaced)
                styled[run.range].backgroundColor = AceTheme.Colours.fill
            }
            if run.link != nil { styled[run.range].foregroundColor = AceTheme.Colours.accent }
        }
        return styled
    }
}
