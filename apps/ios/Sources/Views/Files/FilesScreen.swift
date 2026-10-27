import SwiftUI

/// A file to open, at a line when a link named one.
struct FileTarget: Hashable, Identifiable {
    let path: String
    var line: Int?
    /// The tree marked it changed since the last commit (a deleted file has no lines to mark).
    var changed = false
    var id: String { "\(path):\(line ?? 0)" }
}

/// A thread's checkout (or, from New thread, a project's own folder) as the web's Files tree:
/// folders first, opened in place, each uncommitted change lettered as the web does, folders
/// holding one open at first. The system search field finds any file through the computer's
/// path index. A thread's files can be created, renamed, moved and deleted to Recently deleted.
struct FilesScreen: View {
    let model: ClientModel
    let scope: FilesScope
    let subtitle: String
    /// Puts `@path` into the message being written and goes back to it; nil where nothing is sent.
    let mention: ((String) -> Void)?
    @State private var tree: FileTree?
    @State private var failure: String?
    @State private var open: Set<String> = []
    @State private var seeded = false
    @State private var query = ""
    @State private var results: FileSearch?
    @State private var searchFailure: String?
    @State private var opened: FileTarget?
    @State private var showTrash = false
    @State private var actions: FileActions

    init(model: ClientModel, scope: FilesScope, subtitle: String, mention: ((String) -> Void)?) {
        self.model = model
        self.scope = scope
        self.subtitle = subtitle
        self.mention = mention
        _actions = State(initialValue: FileActions(model: model, scope: scope))
    }

    var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).isEmpty { treeRows } else { searchRows }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 42)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .searchable(text: $query, prompt: "Search files")
        .autocorrectionDisabled().textInputAutocapitalization(.never)
        .refreshable { await load() }
        .threadTitle("Files", subtitle: subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if actions.canChange { ToolbarItem(placement: .topBarTrailing) { manageMenu } }
        }
        .readWhenConnected(model, id: model.files.revision) { await load() }
        .task(id: query) { await search() }
        .navigationDestination(item: $opened) { target in
            FileScreen(model: model, scope: scope, target: target, mention: mention, deleted: { actions.strip = $0 })
        }
        .navigationDestination(isPresented: $showTrash) { RecentlyDeletedView(model: model, scope: scope) }
        .modifier(FileActionPrompts(actions: actions))
        .onAppear { actions.changed = { prompt, change in changed(prompt, change) } }
    }

    // MARK: Tree

    @ViewBuilder private var treeRows: some View {
        if let tree {
            if tree.rows.isEmpty {
                ContentUnavailableView("No files", systemImage: "folder").listRowSeparator(.hidden)
            }
            ForEach(visible) { row in
                Button { tap(row) } label: { FileTreeRowView(row: row, open: open.contains(row.path)) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xl, bottom: 0, trailing: AceTheme.Spacing.xl))
                    .listRowBackground(AceTheme.Colours.background)
                    .contextMenu { rowMenu(path: row.path, folder: row.folder) }
                    .swipeActions(edge: .trailing) {
                        if actions.canChange, row.mark != "D" {
                            Button("Delete", role: .destructive) { actions.ask(.delete(path: row.path)) }
                        }
                    }
                    .accessibilityIdentifier("file.\(row.path)")
            }
            if tree.truncated {
                Text("Showing the first 1,000 entries. Search by name to find more.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    .accessibilityIdentifier("files.more")
            }
        } else if let failure {
            ContentUnavailableView {
                Label("Couldn't read the files", systemImage: "exclamationmark.triangle")
            } description: { Text(failure) } actions: {
                Button("Try again") { Task { await load() } }
            }
            .listRowSeparator(.hidden)
        } else {
            HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
        }
    }

    /// The rows under open folders, in tree order.
    private var visible: [FileTreeRow] {
        var out: [FileTreeRow] = []
        var closedDepth: Int?
        for row in tree?.rows ?? [] {
            if let depth = closedDepth {
                if row.depth > depth { continue }
                closedDepth = nil
            }
            out.append(row)
            if row.folder, !open.contains(row.path) { closedDepth = row.depth }
        }
        return out
    }

    private func tap(_ row: FileTreeRow) {
        if row.folder {
            if open.contains(row.path) { open.remove(row.path) } else { open.insert(row.path) }
        } else {
            opened = FileTarget(path: row.path, changed: row.mark != nil)
        }
    }

    // MARK: Search

    @ViewBuilder private var searchRows: some View {
        let shown = results.flatMap { $0.query == query ? $0 : nil }
        if let searchFailure {
            Text("Couldn't search the files. \(searchFailure)")
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                .listRowSeparator(.hidden)
        } else if let shown {
            if shown.rows.isEmpty { ContentUnavailableView.search(text: query).listRowSeparator(.hidden) }
            ForEach(shown.rows) { row in
                Button { pick(row) } label: { FileSearchRowView(row: row) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xl, bottom: 0, trailing: AceTheme.Spacing.xl))
                    .listRowBackground(AceTheme.Colours.background)
                    .contextMenu { rowMenu(path: row.path, folder: row.isFolder) }
                    .accessibilityIdentifier("search.\(row.path)")
            }
        } else {
            HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
        }
    }

    /// A folder found by search opens in the tree; a file opens.
    private func pick(_ row: FileSearchRow) {
        if row.isFolder {
            reveal(row.path)
            query = ""
        } else {
            opened = FileTarget(path: row.path)
        }
    }
    private func reveal(_ folder: String) {
        var path = ""
        for part in folder.split(separator: "/") {
            path += "\(part)/"
            open.insert(path)
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { results = nil; searchFailure = nil; return }
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        do {
            let found = try await model.files(scope, ["op": "search", "query": text], as: FileSearch.self)
            guard !Task.isCancelled else { return }
            results = FileSearch(query: query, rows: found.rows)
            searchFailure = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { searchFailure = error.localizedDescription }
        }
    }

    private func load() async {
        do {
            let next = try await model.files(scope, ["op": "tree"], as: FileTree.self)
            tree = next
            failure = nil
            if !seeded {
                open = Set(next.open)
                seeded = true
            }
        } catch is CancellationError {
        } catch {
            if tree == nil { failure = error.localizedDescription }
        }
    }

    // MARK: Changes

    private var manageMenu: some View {
        Menu {
            Button("New file", systemImage: "doc.badge.plus") { actions.ask(.create(folder: "")) }
                .accessibilityIdentifier("files.newFile")
            Button("New folder", systemImage: "folder.badge.plus") { actions.ask(.mkdir(folder: "")) }
                .accessibilityIdentifier("files.newFolder")
            Divider()
            Button("Recently deleted", systemImage: "trash") { showTrash = true }
                .accessibilityIdentifier("files.trash")
        } label: {
            Label("Manage files", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("files.manage")
    }

    @ViewBuilder private func rowMenu(path: String, folder: Bool) -> some View {
        if folder, actions.canChange {
            Button("New file here", systemImage: "doc.badge.plus") { actions.ask(.create(folder: path)) }
            Button("New folder here", systemImage: "folder.badge.plus") { actions.ask(.mkdir(folder: path)) }
        }
        if !folder, let mention {
            Button("Mention in message", systemImage: "at") { mention(path) }
        }
        Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        if actions.canChange {
            Button("Rename", systemImage: "pencil") { actions.ask(.rename(path: path)) }
            Button("Move", systemImage: "folder") { actions.ask(.move(path: path)) }
            Button("Delete", systemImage: "trash", role: .destructive) { actions.ask(.delete(path: path)) }
        }
    }

    /// After a change: the tree reads again, a new file opens (as on the web), and a new or
    /// restored entry's folders open so it shows.
    private func changed(_ prompt: FilePrompt?, _ change: FileChange) {
        Task { await load() }
        guard let path = change.destination ?? change.path else { return }
        let folder = path.hasSuffix("/") ? path : String(path[..<(path.lastIndex(of: "/") ?? path.startIndex)])
        switch prompt {
        case .create?:
            reveal(folder)
            opened = FileTarget(path: path)
        case .mkdir?, .move?, .rename?, nil:
            reveal(folder)
        case .delete?:
            break
        }
    }
}

/// A 42pt tree row: indent, disclosure for a folder, its symbol, the name, and the change letter.
struct FileTreeRowView: View {
    let row: FileTreeRow
    let open: Bool
    @Environment(\.aceReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Color.clear.frame(width: CGFloat(row.depth) * 18, height: 1)
            Image(systemName: "chevron.right").font(.caption2.weight(.semibold))
                .rotationEffect(.degrees(open ? 90 : 0))
                .animation(reduceMotion ? nil : .easeOut(duration: AceTheme.Motion.standard), value: open)
                .foregroundStyle(AceTheme.Colours.decoration)
                .frame(width: 10).opacity(row.folder ? 1 : 0)
            Image(systemName: row.folder ? "folder" : "doc")
                .font(.subheadline).foregroundStyle(AceTheme.Colours.mutedForeground).frame(width: 22)
            Text(row.name).aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(row.mark == "D" ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                .strikethrough(row.mark == "D", color: AceTheme.Colours.mutedForeground)
                .lineLimit(1).truncationMode(.middle)
            Spacer(minLength: AceTheme.Spacing.sm)
            if let mark = row.mark {
                Text(mark).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .accessibilityLabel(row.markLabel ?? mark)
            }
        }
        .frame(minHeight: 42).contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.folder ? (open ? "Open" : "Closed") : "")
    }
}

/// A quick-open match: the name with the typed characters in full ink, its folder beneath.
struct FileSearchRowView: View {
    let row: FileSearchRow
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: row.isFolder ? "folder" : "doc")
                .font(.subheadline).foregroundStyle(AceTheme.Colours.mutedForeground).frame(width: 22)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(name).aceFont(AceTheme.Typography.body, relativeTo: .body).lineLimit(1)
                if !row.folder.isEmpty {
                    Text(row.folder).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: 52).contentShape(Rectangle())
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
