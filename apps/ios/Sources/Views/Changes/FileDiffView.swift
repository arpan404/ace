import SwiftUI

/// One file's unified diff in SF Mono. Colour marks only additions and deletions, never syntax.
/// Long lines wrap by default and can scroll sideways instead; a cut diff says the rest is on
/// the computer.
struct FileDiffView: View {
    @Bindable var model: ClientModel
    let path: String
    @State private var wrap = true
    private var diff: FileDiff? { model.sheets.file?.path == path ? model.sheets.file?.diff : nil }

    var body: some View {
        Group {
            if let diff {
                if diff.empty && !diff.truncated {
                    ContentUnavailableView("No line changes to show", systemImage: "doc",
                                           description: Text("Binary files, mode changes and new untracked files show on your computer."))
                } else if wrap {
                    ScrollView(.vertical) { lines(diff) }
                } else {
                    ScrollView([.vertical, .horizontal]) { lines(diff) }
                }
            } else {
                ProgressView("Loading diff…")
            }
        }
        .background(AceTheme.Colours.background)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(wrap ? "Don't wrap" : "Wrap", systemImage: wrap ? "arrow.left.and.right.text.vertical" : "text.word.spacing") { wrap.toggle() }
                    .accessibilityIdentifier("diff.wrap")
            }
        }
        .onAppear { model.sheet(["kind": "changes.file", "path": path]) }
        .onDisappear { if model.sheets.file?.path == path { model.sheet(["kind": "changes.file", "path": NSNull()]) } }
        .accessibilityIdentifier("diff.view")
    }

    @ViewBuilder private func lines(_ diff: FileDiff) -> some View {
        LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, line in DiffLineView(line: line, wrap: wrap) }
            if diff.truncated {
                Text(truncation(diff)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .padding(AceTheme.Spacing.lg)
                    .accessibilityIdentifier("diff.truncated")
            }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
    }
    private func truncation(_ diff: FileDiff) -> String {
        if diff.hiddenLines > 0 { return "\(diff.hiddenLines.formatted()) more lines. View the full diff on your computer." }
        if diff.lines.contains(where: \.clipped) { return "Some long lines are cut short. View the full diff on your computer." }
        return "This diff is larger than the daemon sends. View the full diff on your computer."
    }
}

private struct DiffLineView: View {
    let line: FileDiff.Line
    let wrap: Bool
    var body: some View {
        if line.kind == "hunk" {
            Text(line.text).aceMonospace(AceTheme.Typography.code, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
                .padding(.horizontal, AceTheme.Spacing.md).padding(.vertical, AceTheme.Spacing.xs)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AceTheme.Colours.fill)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
                Text(number).foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(minWidth: AceTheme.Spacing.xxxl, alignment: .trailing)
                Text(mark).foregroundStyle(markColour)
                Text(line.clipped ? line.text + " …" : line.text)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .fixedSize(horizontal: !wrap, vertical: true)
                    .textSelection(.enabled)
            }
            .aceMonospace(AceTheme.Typography.code, relativeTo: .caption)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(maxWidth: wrap ? .infinity : nil, alignment: .leading)
            .background(background)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(line.kind == "add" ? "Added" : line.kind == "del" ? "Removed" : "Unchanged") line \(number): \(line.text)")
        }
    }
    private var number: String { String(line.kind == "del" ? line.old ?? 0 : line.new ?? line.old ?? 0) }
    private var mark: String { line.kind == "add" ? "+" : line.kind == "del" ? "−" : " " }
    private var markColour: Color { line.kind == "add" ? AceTheme.StatusText.done : AceTheme.StatusText.failed }
    private var background: Color {
        line.kind == "add" ? AceTheme.Colours.diffAdd : line.kind == "del" ? AceTheme.Colours.diffDelete : .clear
    }
}
