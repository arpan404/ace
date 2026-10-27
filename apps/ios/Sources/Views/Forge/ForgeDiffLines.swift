import SwiftUI

/// A file's diff lines in SF Mono, stacked or side by side, wrapped or each on one line (then
/// the lines scroll sideways together), with each line's pending comments and conversations
/// under it. Picked lines are tinted. Rows are lazy: only those near the viewport are made.
struct ForgeDiffLines: View {
    let file: ForgeFileDiff
    let desk: ForgeReviewDesk
    let wrap: Bool
    let split: Bool
    let pick: ForgeLinePick?
    /// Whether a line can be picked for a comment here.
    let pickable: Bool
    let tap: (Int) -> Void
    let compose: (ForgeCompose) -> Void
    @State private var width: CGFloat = 0

    var body: some View {
        Group {
            if wrap {
                rows
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    rows.frame(minWidth: width, alignment: .leading)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
    }

    private var rows: some View {
        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            if split {
                ForEach(Array(file.pairs.enumerated()), id: \.offset) { _, pair in
                    pairRow(left: pair.first ?? nil, right: pair.count > 1 ? pair[1] : nil)
                    let indexes = Set([pair.first ?? nil, pair.count > 1 ? pair[1] : nil].compactMap { $0 })
                    ForEach(indexes.sorted(), id: \.self) { extras($0) }
                }
            } else {
                ForEach(file.lines.indices, id: \.self) { index in
                    lineRow(index)
                    extras(index)
                }
            }
        }
    }

    /// What sits under a line: its pending comments, then its conversations.
    @ViewBuilder private func extras(_ index: Int) -> some View {
        let line = file.lines[index]
        if !line.drafts.isEmpty || !line.threads.isEmpty {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                ForEach(line.drafts) { draft in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        Text("Pending").meta(AceTone.needsYou.text)
                        MarkdownView(text: draft.body)
                    }
                    .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
                }
                ForEach(line.threads) { thread in
                    ForgeThreadBlock(thread: thread, showsPlace: false, desk: desk, compose: compose)
                        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
                }
            }
            // One long line each: the conversations stay the screen's width.
            .frame(width: wrap || width == 0 ? nil : width, alignment: .leading)
            .background(AceTheme.Colours.background)
        }
    }

    @ViewBuilder private func lineRow(_ index: Int) -> some View {
        let line = file.lines[index]
        tappable(index) {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                number(line.kind == "hunk" ? nil : (line.new ?? line.old))
                code(marker(line) + line.text, hunk: line.kind == "hunk")
            }
            .padding(.horizontal, AceTheme.Spacing.sm)
            .padding(.vertical, AceTheme.Spacing.xxs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint(line))
        }
    }

    @ViewBuilder private func pairRow(left: Int?, right: Int?) -> some View {
        if let left, left == right, file.lines[left].kind == "hunk" {
            lineRow(left)
        } else {
            HStack(alignment: .top, spacing: AceTheme.Spacing.none) {
                half(left, number: { $0.old })
                Rectangle().fill(AceTheme.Colours.separator).frame(width: AceTheme.Dimensions.border)
                half(right, number: { $0.new })
            }
        }
    }

    @ViewBuilder private func half(_ index: Int?, number value: (ForgeFileDiff.Line) -> Int?) -> some View {
        if let index {
            let line = file.lines[index]
            tappable(index) {
                HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.xs) {
                    number(value(line))
                    code(line.text, hunk: false)
                }
                .padding(.horizontal, AceTheme.Spacing.xs)
                .padding(.vertical, AceTheme.Spacing.xxs)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(tint(line))
            }
        } else {
            AceTheme.Colours.fill.opacity(0.5).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// A line that takes a comment is a button; the picked span is tinted over its colour.
    @ViewBuilder private func tappable<Content: View>(_ index: Int, @ViewBuilder content: () -> Content) -> some View {
        let line = file.lines[index]
        let picked = pick?.holds(line) == true
        let row = content()
            .overlay(AceTheme.Colours.accent.opacity(picked ? 0.14 : 0))
            .animation(.smooth, value: picked)
        if let anchor = line.anchor, pickable {
            Button { tap(index) } label: { row.contentShape(Rectangle()) }
                .buttonStyle(.row)
                .accessibilityAddTraits(picked ? .isSelected : [])
                .accessibilityHint("Pick this line to comment on")
                .accessibilityIdentifier("forge.line.\(anchor.side).\(anchor.line)")
        } else {
            row
        }
    }

    private func number(_ value: Int?) -> some View {
        Text(verbatim: value.map(String.init) ?? "")
            .monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground)
            .frame(minWidth: 32, alignment: .trailing)
            .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
    }

    @ViewBuilder private func code(_ text: String, hunk: Bool) -> some View {
        let shown = Text(verbatim: text)
            .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(hunk ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
        if wrap {
            shown.frame(maxWidth: .infinity, alignment: .leading)
        } else {
            shown.lineLimit(1).fixedSize(horizontal: true, vertical: false)
        }
    }

    private func marker(_ line: ForgeFileDiff.Line) -> String {
        switch line.kind { case "add": "+"; case "del": "-"; case "hunk": ""; default: " " }
    }

    private func tint(_ line: ForgeFileDiff.Line) -> Color {
        switch line.kind {
        case "add": AceTheme.Colours.diffAdd
        case "del": AceTheme.Colours.diffDelete
        case "hunk": AceTheme.Colours.fill
        default: .clear
        }
    }
}
