import SwiftUI

extension FilesScreen {
    @ViewBuilder var treeRows: some View {
        if let tree {
            if tree.rows.isEmpty {
                EmptyState(icon: .folder, title: "No files").listRowSeparator(.hidden)
            }
            ForEach(tree.rows) { row in
                switch row.kind {
                case "loading":
                    FileTreeNoteRow(row: row, text: "Loading…")
                        .listRowSeparator(.hidden)
                        .listRowBackground(AceTheme.Colours.background)
                        .accessibilityIdentifier("files.loading.\(row.folder ?? "")")
                case "more":
                    Button { model.moreFilesFolder(scope, row.folder ?? "") } label: {
                        FileTreeNoteRow(row: row, text: "Show more")
                    }
                    .buttonStyle(.textAction())
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                    .listRowBackground(AceTheme.Colours.background)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("files.more.\(row.folder ?? "")")
                case "error":
                    Button { model.retryFilesFolder(scope, row.folder ?? "") } label: {
                        FileTreeNoteRow(row: row, text: row.error ?? "Couldn't list this folder. Try again.")
                    }
                    .buttonStyle(.textAction())
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                    .listRowBackground(AceTheme.Colours.background)
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("files.error.\(row.folder ?? "")")
                    .accessibilityHint("Double-tap to try again")
                default:
                    Button { tap(row) } label: { FileTreeRowView(row: row) }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                        .listRowBackground(AceTheme.Colours.background)
                        // A tree reads by its indent, not lines: no hairline under every row.
                        .listRowSeparator(.hidden)
                        .contextMenu { rowMenu(path: row.key, folder: row.isFolder) }
                        .swipeActions(edge: .trailing) {
                            if actions.canChange, row.mark != "D" {
                                Button("Delete", role: .destructive) { actions.ask(.delete(path: row.key)) }
                            }
                        }
                        .accessibilityIdentifier("file.\(row.key)")
                }
            }
        } else {
            SkeletonRows(label: "Loading files").listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                .listRowInsets(EdgeInsets())
        }
    }

    func tap(_ row: FileTreeRow) {
        if row.isFolder {
            if row.expanded { model.closeFilesFolder(scope, row.key) } else { model.openFilesFolder(scope, row.key) }
        } else {
            opened = FileTarget(path: row.key, changed: row.mark != nil)
        }
    }
}
