import SwiftUI

/// An agent's Markdown as native text: SF Pro prose with inline styling, SF Mono code blocks that
/// scroll sideways. Parsing is proportional to this one message, so a streamed delta re-renders
/// its own row only.
struct MarkdownView: View {
    let text: String
    /// Off where the message's own long-press menu offers Copy and Select text instead: the
    /// system's whole-block selection would take the long press from it.
    var selectable = true
    @Environment(\.markdownMath) private var math
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(Array(Markdown.blocks(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(Selectable(on: selectable))
    }
    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            // A very long paragraph is drawn in pieces, so a streamed delta lays out and draws
            // only the last piece instead of the whole paragraph.
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(Array(Markdown.pieces(text).enumerated()), id: \.offset) { _, piece in
                    if !math.isEmpty, piece.contains("\u{E000}") { MathProse(text: String(piece), math: math) }
                    else { MarkdownProse(text: String(piece)).equatable() }
                }
            }
        case .heading(let level, let text):
            Text(Self.styled(MathMarkers.plain(text, math))).aceFont(level <= 2 ? AceTheme.Typography.title : AceTheme.Typography.rowTitle, relativeTo: .headline)
                .accessibilityAddTraits(.isHeader)
        case .code(let language, let text):
            if language == "math", case .formula(let index)? = MathMarkers.pieces(text.trimmingCharacters(in: .whitespacesAndNewlines)).first,
               index < math.count {
                MathBlock(span: math[index])
            } else {
                MarkdownCodeBlock(language: language, text: text)
            }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        Text(verbatim: ordered ? "\(start + index)." : "•").monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
                        Text(Self.styled(MathMarkers.plain(item, math)))
                    }
                    .aceFont(AceTheme.Typography.body, relativeTo: .body)
                    // One element per item, so the number is read with its text.
                    .accessibilityElement(children: .combine)
                }
            }
        case .quote(let text):
            HStack(spacing: AceTheme.Spacing.md) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxs)
                Text(Self.styled(MathMarkers.plain(text, math))).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground)
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
    private func tableCell(_ text: String) -> some View {
        Text(Self.styled(MathMarkers.plain(text, math))).aceFont(AceTheme.Typography.body, relativeTo: .body)
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

private struct Selectable: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        if on { content.textSelection(.enabled) } else { content }
    }
}
