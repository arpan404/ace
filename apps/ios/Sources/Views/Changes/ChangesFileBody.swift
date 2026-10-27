import SwiftUI

/// One open file under its header: its rows as far as pages have come (each a direct child of
/// the sheet's lazy stack, so a 20,000-line file builds only what shows), comments under the
/// lines they're on, and Show more until the whole file is in.
struct ChangesFileBody: View {
    @Bindable var model: ClientModel
    let path: String
    let wrap: Bool
    let split: Bool
    @Binding var selection: LineSelection?
    let comment: (ChangesReview.Draft) -> AnyView

    private var header: ChangesFileHeader? { model.sheets.files[path] }
    @Environment(\.changesCommentable) private var commentable

    var body: some View {
        if let header {
            if header.state == "error" {
                note("Couldn't read this file's diff. Pull to refresh and try again.")
            } else if header.binary {
                note("Binary file: no lines to show.")
            } else if header.empty {
                note("No line changes: only the file's mode or name changed.")
            } else if split {
                ForEach(Array(model.sheets.pairs(header).enumerated()), id: \.offset) { _, pair in
                    ChangesSplitRow(pair: pair, wrap: wrap, selected: { isSelected($0) }, tap: { pick($0) }, wholeLine: { whole($0, header) })
                    ForEach(drafts(after: pair.right ?? pair.left)) { comment($0) }
                }
            } else {
                ForEach(model.sheets.rows(header)) { row in
                    ChangesLineRow(row: row, wrap: wrap, selected: isSelected(row), tap: { pick(row) }, wholeLine: { whole(row, header) })
                        .accessibilityIdentifier("diff.line")
                    ForEach(drafts(after: row)) { comment($0) }
                }
            }
            footer(header)
        } else {
            loading
        }
    }

    @ViewBuilder private func footer(_ header: ChangesFileHeader) -> some View {
        if header.state == "loading" || (header.pages == 0 && !header.empty && !header.binary && header.state != "error") {
            loading
        } else if header.remaining != 0 && !header.complete || (header.remaining ?? 0) > 0 {
            Button {
                model.sheet(["kind": "changes.more", "path": path])
            } label: {
                Text(header.remaining.map { "Show \(min($0, 300).formatted()) more of \($0.formatted()) lines" } ?? "Show more lines")
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.plain)
            .foregroundStyle(AceTheme.Colours.foreground)
            .accessibilityIdentifier("diff.more")
        } else if header.cut {
            note("This file is larger than the phone reads. The rest is on your computer.")
        }
    }

    private var loading: some View {
        ProgressView().frame(maxWidth: .infinity, minHeight: 44).padding(.vertical, AceTheme.Spacing.sm)
    }
    private func note(_ text: String) -> some View {
        Text(text).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(AceTheme.Spacing.lg)
            .accessibilityIdentifier("diff.view")
    }

    /// Comments whose last line is this row, on its side.
    private func drafts(after row: ChangesRow?) -> [ChangesReview.Draft] {
        guard let anchor = row?.anchor, let drafts = model.sheets.review?.drafts, !drafts.isEmpty else { return [] }
        return drafts.filter { $0.path == path && $0.side == anchor.side && $0.end == anchor.line }.reversed()
    }
    private func isSelected(_ row: ChangesRow) -> Bool { selection?.contains(row, in: path) == true }

    /// A tap picks a line; a tap on another line of the same side extends the pick to a range of
    /// at most 100 lines; a tap on the only picked line lets it go.
    private func pick(_ row: ChangesRow) {
        guard commentable, let anchor = row.anchor else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        if var current = selection, current.path == path, current.side == anchor.side {
            if current.start == current.end && current.start == anchor.line { selection = nil; return }
            let start = min(current.start, anchor.line)
            let end = max(current.end, anchor.line)
            if end - start < 100 { current.start = start; current.end = end; selection = current; return }
        }
        selection = LineSelection(path: path, side: anchor.side, start: anchor.line, end: anchor.line)
    }
    private func whole(_ row: ChangesRow, _ header: ChangesFileHeader) {
        model.sheet(["kind": "changes.line", "path": path, "index": row.i])
    }
}
