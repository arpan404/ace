import SwiftUI

/// Pull request and issue text drawn natively from the bridge's blocks (ADR 0096): prose,
/// headings, code, alerts (monochrome: the kind reads from its icon and word), lists with task
/// boxes, tables, details, footnotes, images and videos through the daemon, and mermaid
/// diagrams. A task box ticks only where `tick` is given (the viewer may edit the text).
struct ForgeRichView: View {
    let blocks: [ForgeRichBlock]
    let scope: ForgeRichScope
    /// Ticks the box whose mark sits at an offset; nil leaves boxes showing their state only.
    var tick: ((Int, Bool) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                ForgeRichBlockView(block: block, scope: scope, tick: tick)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
}

private struct ForgeRichBlockView: View {
    let block: ForgeRichBlock
    let scope: ForgeRichScope
    let tick: ((Int, Bool) -> Void)?
    @State private var open: Bool?

    var body: some View {
        switch block {
        case .paragraph(let runs, let align):
            ForgeRunsText(runs: runs, align: align)
        case .heading(let level, let runs):
            ForgeRunsText(runs: runs.map { ForgeRun(text: $0.text, b: true, i: $0.i, s: $0.s, code: $0.code, link: $0.link) },
                          size: level <= 2 ? AceTheme.Typography.title.size : AceTheme.Typography.rowTitle.size)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, AceTheme.Spacing.xs)
        case .code(let lang, let text):
            MarkdownCodeBlock(language: lang, text: text)
        case .mermaid(let text):
            ForgeMermaidView(source: text)
        case .quote(let blocks):
            HStack(alignment: .top, spacing: AceTheme.Spacing.md) {
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Spacing.xxs)
                ForgeRichView(blocks: blocks, scope: scope, tick: tick).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .alert(let kind, let blocks):
            alert(kind, blocks)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        marker(item, ordered ? "\(start + index)." : "•")
                        ForgeRichView(blocks: item.blocks, scope: scope, tick: tick)
                    }
                }
            }
        case .table(let head, let rows):
            table(head, rows)
        case .rule:
            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
        case .image(let image):
            ForgeImageBlock(image: image, scope: scope)
        case .video(let src):
            ForgeMediaLinkBlock(url: src, runs: [ForgeRun(text: src, link: src)], scope: scope)
        case .media(let url, let runs):
            ForgeMediaLinkBlock(url: url, runs: runs, scope: scope)
        case .details(let summary, let startsOpen, let blocks):
            let shown = open ?? startsOpen
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                Button { withAnimation(.smooth(duration: 0.2)) { open = !shown } } label: {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        AceIcon(.caretRight, size: 12, relativeTo: .footnote).rotationEffect(.degrees(shown ? 90 : 0))
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                        Text(ForgeRichText.string(summary)).foregroundStyle(AceTheme.Colours.foreground)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isButton)
                .accessibilityValue(shown ? "Expanded" : "Collapsed")
                if shown { ForgeRichView(blocks: blocks, scope: scope, tick: tick).padding(.leading, AceTheme.Spacing.lg) }
            }
        case .footnotes(let notes):
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                ForEach(notes, id: \.number) { note in
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                        Text(verbatim: "\(note.number).").monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
                        ForgeRunsText(runs: note.runs, size: AceTheme.Typography.caption.size)
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                }
            }
            .accessibilityLabel("Footnotes")
        case .unknown:
            EmptyView()
        }
    }

    /// A list item's marker: its task box (ticking where allowed), else its number or bullet.
    @ViewBuilder private func marker(_ item: ForgeRichBlock.Item, _ word: String) -> some View {
        if let task = item.task {
            let tickable = tick != nil && task.offset != nil
            Button {
                if let offset = task.offset { tick?(offset, !task.checked) }
            } label: {
                AceIcon(task.checked ? .checkSquare : .square, size: 16, relativeTo: .body)
                    .foregroundStyle(task.checked ? AceTheme.Colours.foreground : AceTheme.Colours.subtleForeground)
            }
            .buttonStyle(.plain)
            .disabled(!tickable)
            .accessibilityLabel(task.checked ? "Done" : "Not done")
            .accessibilityIdentifier("forge.task.\(task.offset ?? -1)")
            .accessibilityAddTraits(tickable ? .isButton : [])
        } else {
            Text(verbatim: word).monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }

    private func alert(_ kind: String, _ blocks: [ForgeRichBlock]) -> some View {
        let (word, icon): (String, AceIcon.Name) = switch kind {
        case "tip": ("Tip", .lightbulb)
        case "important": ("Important", .info)
        case "warning": ("Warning", .warning)
        case "caution": ("Caution", .warningCircle)
        default: ("Note", .info)
        }
        return HStack(alignment: .top, spacing: AceTheme.Spacing.md) {
            Rectangle().fill(AceTheme.Colours.foreground.opacity(0.4)).frame(width: AceTheme.Spacing.xxs)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Label(word, ace: icon).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground)
                ForgeRichView(blocks: blocks, scope: scope, tick: tick)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private func table(_ head: [[ForgeRun]], _ rows: [[[ForgeRun]]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: AceTheme.Spacing.none, verticalSpacing: AceTheme.Spacing.none) {
                if !head.isEmpty {
                    GridRow { ForEach(Array(head.enumerated()), id: \.offset) { _, cell in tableCell(cell, header: true) } }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow { ForEach(Array(row.enumerated()), id: \.offset) { _, cell in tableCell(cell, header: false) } }
                }
            }
            .overlay(Rectangle().stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border))
        }
    }

    private func tableCell(_ runs: [ForgeRun], header: Bool) -> some View {
        Text(ForgeRichText.string(header ? runs.map { ForgeRun(text: $0.text, b: true, link: $0.link) } : runs, size: AceTheme.Typography.caption.size))
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
            .frame(minWidth: 60, alignment: .leading)
            .background(header ? AceTheme.Colours.fill : .clear)
            .overlay(Rectangle().stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border / 2))
    }
}
