import SwiftUI

/// A file to open, at a line when a link named one.
struct FileTarget: Hashable, Identifiable {
    let path: String
    var line: Int?
    /// The tree marked it changed since the last commit (a deleted file has no lines to mark).
    var changed = false
    var id: String { "\(path):\(line ?? 0)" }
}

/// The search field's Names and Contents scopes, in a thread's checkout only.
struct ContentSearchScopes: ViewModifier {
    let enabled: Bool
    @Binding var scope: FilesSearchScope
    func body(content: Content) -> some View {
        if enabled {
            content.searchScopes($scope, activation: .onSearchPresentation) {
                Text("Names").tag(FilesSearchScope.names)
                Text("Contents").tag(FilesSearchScope.contents)
            }
        } else {
            content
        }
    }
}

/// A one-line tree row: indent, disclosure for a folder, its symbol, the name, and the change letter.
struct FileTreeRowView: View {
    let row: FileTreeRow
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Color.clear.frame(width: CGFloat(row.depth) * AceDesign.Space.treeLevel, height: AceDesign.Size.hairline)
            RowCaret()
                .rotationEffect(.degrees(row.expanded ? 90 : 0))
                .animation(.default, value: row.expanded)
                .foregroundStyle(AceTheme.Colours.decoration)
                .frame(width: AceDesign.Size.caret).opacity(row.isFolder ? 1 : 0)
            Text(row.name).aceMonospace(AceDesign.TextRole.rowTitle)
                .foregroundStyle(ink)
                .strikethrough(row.mark == "D", color: AceTheme.Colours.mutedForeground)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: AceTheme.Spacing.sm)
            if let mark = row.mark {
                Text(mark).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityLabel(row.markLabel ?? mark)
            }
        }
        .frame(minHeight: AceDesign.Size.rowLine).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.isFolder ? (row.expanded ? "Open" : "Closed") : "")
    }
    /// Ignored entries and deleted files read quieter than the ones the checkout carries.
    private var ink: Color {
        row.ignored || row.mark == "D" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground
    }
}

/// A folder's Loading…, Show more or error row: one quiet line, indented under its folder.
struct FileTreeNoteRow: View {
    let row: FileTreeRow
    let text: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Color.clear.frame(width: CGFloat(row.depth) * AceDesign.Space.treeLevel, height: AceDesign.Size.hairline)
            Text(text)
                .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(2)
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: AceDesign.Size.rowLine).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// A quick-open match: the name with the typed characters in full ink, its folder beneath.
struct FileSearchRowView: View {
    let row: FileSearchRow
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(name).aceMonospace(AceDesign.TextRole.rowTitle).lineLimit(1)
                if !row.folder.isEmpty {
                    Text(row.folder).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: AceDesign.Size.rowDetail).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    /// The name, muted, with the matched characters in ink.
    private var name: AttributedString {
        let bare = row.isFolder ? String(row.path.dropLast()) : row.path
        let start = bare.utf16.count - row.name.utf16.count
        let hits = Set(row.positions.map { $0 - start })
        var out = AttributedString()
        var offset = 0
        for character in row.name {
            let width = String(character).utf16.count
            var piece = AttributedString(String(character))
            let hit = (offset..<offset + width).contains { hits.contains($0) }
            piece.foregroundColor = hit ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground
            if hit { piece.inlinePresentationIntent = .stronglyEmphasized }
            out += piece
            offset += width
        }
        return out
    }
}
