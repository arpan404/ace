import SwiftUI

/// An agent's Markdown as native text: SF Pro prose with inline styling, SF Mono code blocks that
/// scroll sideways. Blocks are kept across updates (`MarkdownStream`) under ids that hold while a
/// streaming window slides, and each block view is equatable: a streamed delta parses, styles and
/// lays out only the blocks and pieces it changed.
struct MarkdownView: View {
    let text: String
    @State private var stream = MarkdownStream()
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(stream.update(text)) { block in
                MarkdownBlockView(block: block).equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
    /// Inline code on the code surface at about 0.92 of the prose, in SF Mono; links in the
    /// accent, as the web's `text-link`.
    static func styled(_ text: String) -> AttributedString {
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

/// One block. Equatable, so a block a delta left alone is neither styled nor laid out again.
private struct MarkdownBlockView: View, Equatable {
    let block: MarkdownStream.Block
    var body: some View { view(for: block.block) }
    @ViewBuilder private func view(for markdown: MarkdownBlock) -> some View {
        switch markdown {
        case .paragraph(let text):
            // A very long paragraph is drawn in pieces, so a streamed delta lays out and draws
            // only the last piece instead of the whole paragraph.
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Markdown.pieces(text, at: block.id), id: \.offset) { piece in
                    MarkdownProse(text: String(piece.text)).equatable()
                }
            }
        case .heading(let level, let text):
            Text(MarkdownView.styled(text)).aceFont(level <= 2 ? AceTheme.Typography.title : AceTheme.Typography.rowTitle, relativeTo: .headline)
                .accessibilityAddTraits(.isHeader)
        case .code(let language, let text):
            MarkdownCodeBlock(language: language, text: text)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        Text(verbatim: ordered ? "\(start + index)." : "•").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                        Text(MarkdownView.styled(item))
                    }
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    // One element per item, so the number is read with its text.
                    .accessibilityElement(children: .combine)
                }
            }
        case .quote(let text):
            HStack(spacing: AceTheme.Spacing.md) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxs)
                Text(MarkdownView.styled(text)).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
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
        Text(MarkdownView.styled(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
            .frame(width: AceTheme.Dimensions.touchTarget * 4, alignment: .leading)
            .padding(AceTheme.Spacing.sm)
            .overlay(alignment: .bottom) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
    }
}

/// One run of prose. Equatable, so an unchanged piece of a streaming paragraph is neither parsed
/// nor laid out again.
private struct MarkdownProse: View, Equatable {
    let text: String
    var body: some View {
        Text(MarkdownView.styled(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
    }
}
