import SwiftUI

/// The folders from the project root down to a file, under its title, as the web's editor shows
/// them (`breadcrumbs.tsx`). Each folder opens in Files. When the trail is too wide for the bar,
/// the folders nearest the root give way first, behind one "…" menu that still offers them.
struct FileBreadcrumbs: View {
    struct Folder: Equatable, Identifiable {
        let name: String
        /// The folder's path in the tree, ending in "/".
        let path: String
        var id: String { path }
    }

    /// The folders `path` sits in, outermost first, and its own name. Pure.
    static func trail(_ path: String) -> (folders: [Folder], name: String) {
        var parts = path.split(separator: "/").map(String.init)
        let name = parts.popLast() ?? path
        var folders: [Folder] = []
        var prefix = ""
        for part in parts {
            prefix += "\(part)/"
            folders.append(Folder(name: part, path: prefix))
        }
        return (folders, name)
    }

    let path: String
    let open: (Folder) -> Void

    var body: some View {
        let folders = Self.trail(path).folders
        if !folders.isEmpty {
            // Widest first: the whole trail, then with one more folder from the root hidden.
            ViewThatFits(in: .horizontal) {
                ForEach(0...folders.count, id: \.self) { hidden in
                    row(hidden: Array(folders.prefix(hidden)), shown: Array(folders.dropFirst(hidden)))
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("File path")
            .accessibilityIdentifier("file.breadcrumbs")
        }
    }

    private func row(hidden: [Folder], shown: [Folder]) -> some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            if !hidden.isEmpty {
                Menu {
                    ForEach(hidden) { folder in Button(folder.name, ace: .folder) { open(folder) } }
                } label: { crumb("…") }
                .accessibilityLabel("More folders")
                if !shown.isEmpty { separator }
            }
            ForEach(shown) { folder in
                Button { open(folder) } label: { crumb(folder.name) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open \(folder.name) in Files")
                    .accessibilityIdentifier("file.breadcrumb.\(folder.path)")
                if folder != shown.last { separator }
            }
        }
        .fixedSize()
    }

    private func crumb(_ title: String) -> some View {
        Text(title).aceMonospace(AceDesign.TextRole.meta)
            .foregroundStyle(AceDesign.Ink.muted).lineLimit(1)
            .contentShape(Rectangle())
    }

    private var separator: some View {
        AceIcon(.caretRight, size: 10, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}
