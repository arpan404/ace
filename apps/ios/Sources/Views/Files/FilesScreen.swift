import SwiftUI
import UniformTypeIdentifiers

/// A file to open, at a line when a link named one.
struct FileTarget: Hashable, Identifiable {
    let path: String
    var line: Int?
    /// The tree marked it changed since the last commit (a deleted file has no lines to mark).
    var changed = false
    var id: String { "\(path):\(line ?? 0)" }
}

/// A thread's checkout (or, from New thread, a project's own folder) as the web's Files tree:
/// folders first, a folder listed when it opens and a page at a time, each uncommitted change
/// lettered as the web does, folders holding one open at first, and open folders listed again
/// when the computer says they changed. The system search field finds any file through the
/// computer's path index. A thread's files can be created, renamed, moved and deleted to
/// Recently deleted.
struct FilesScreen: View {
    let model: ClientModel
    let scope: FilesScope
    let subtitle: String
    /// Puts `@path` into the message being written and goes back to it; nil where nothing is sent.
    let mention: ((ComposerMention) -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    /// Whether this Files screen is on screen (not covered by a pushed file or the background).
    @State private var isPresented = false
    /// Whether the bridge is counting this screen as showing the tree.
    @State private var shown = false
    @State private var query = ""
    @State private var results: FileSearch?
    @State private var searchFailure: String?
    @State private var opened: FileTarget?
    @State private var showTrash = false
    @State private var actions: FileActions
    @State private var quickLine: Int?
    @State private var downloading: String?
    @State private var importing = false
    @State private var uploadFolder = ""
    @State private var staged: [StagedAttachment] = []
    @State private var uploading = false
    @State private var importProblem: String?

    init(model: ClientModel, scope: FilesScope, subtitle: String, mention: ((ComposerMention) -> Void)?) {
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
        .environment(\.defaultMinListRowHeight, AceDesign.Size.rowLine)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .searchable(text: $query, prompt: "Search files")
        .autocorrectionDisabled().textInputAutocapitalization(.never)
        .refreshable { await refreshTree() }
        .modifier(PageTitle(title: "Files", subtitle: subtitle))
        .navigationBarTitleDisplayMode(.inline)
        .screenBar {
            OpenFilesButton(model: model, scope: scope) { opened = FileTarget(path: $0) }
            if actions.canChange { manageMenu }
        }
        .onAppear {
            actions.changed = { prompt, change in changed(prompt, change) }
            model.watchFileMemory(scope)
            isPresented = true
            // Opening this screen lists its tree; coming back from a pushed file keeps the rows.
            if !shown {
                shown = true
                model.showFilesTree(scope)
            }
        }
        .onDisappear { isPresented = false }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                // Only the background stops the tree: a pushed file leaves it warm for the return.
                if shown {
                    shown = false
                    model.hideFilesTree(scope)
                }
            } else if phase == .active, isPresented, !shown {
                shown = true
                model.showFilesTree(scope)
            }
        }
        .sheet(item: Binding(get: { downloading.map { DownloadPick(folder: $0) } }, set: { downloading = $0?.folder })) { pick in
            if case .thread(let id) = scope { FolderDownloadSheet(model: model, threadId: id, folders: folders, folder: pick.folder) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in stage(result) }
        .sheet(isPresented: $uploading) {
            if case .thread(let id) = scope { UploadSheet(model: model, threadId: id, folders: folders, folder: uploadFolder, staged: staged) }
        }
        .alert("Couldn't add those files", isPresented: Binding(get: { importProblem != nil }, set: { if !$0 { importProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(importProblem ?? "") }
        .task(id: query) { await search() }
        .navigationDestination(item: $opened) { target in
            FileScreen(model: model, scope: scope, target: target, mention: mention, deleted: { actions.strip = $0 })
        }
        .navigationDestination(isPresented: $showTrash) { RecentlyDeletedView(model: model, scope: scope) }
        .modifier(FileActionPrompts(actions: actions))
    }

    /// The live tree the bridge lists for this scope; nil until its first rows arrive. Reading
    /// `treesRevision` notices a new scope; each scope's own model keeps other patches away.
    private var tree: FileTree? {
        _ = model.files.treesRevision
        return model.files.existingTree(scope.memoryKey)?.tree
    }

    // MARK: Tree

    @ViewBuilder private var treeRows: some View {
        if let tree {
            if tree.rows.isEmpty {
                EmptyState(systemImage: "folder", title: "No files").listRowSeparator(.hidden)
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

    private func tap(_ row: FileTreeRow) {
        if row.isFolder {
            if row.expanded { model.closeFilesFolder(scope, row.key) } else { model.openFilesFolder(scope, row.key) }
        } else {
            opened = FileTarget(path: row.key, changed: row.mark != nil)
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
            if !shown.ready {
                SkeletonRows(count: 3, label: "Searching files").listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    .listRowInsets(EdgeInsets())
            } else if shown.rows.isEmpty {
                EmptyState.search(query).listRowSeparator(.hidden)
            }
            ForEach(shown.rows) { row in
                Button { pick(row) } label: { FileSearchRowView(row: row) }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceDesign.Space.margin, bottom: AceTheme.Spacing.none, trailing: AceDesign.Space.margin))
                    .listRowBackground(AceTheme.Colours.background)
                    .contextMenu { rowMenu(path: row.path, folder: row.isFolder) }
                    .accessibilityIdentifier("search.\(row.path)")
            }
        } else {
            SkeletonRows(count: 3, label: "Searching files").listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                .listRowInsets(EdgeInsets())
        }
    }

    /// A folder found by search opens in the tree; a file opens.
    private func pick(_ row: FileSearchRow) {
        if row.isFolder {
            reveal(row.path)
            query = ""
        } else {
            opened = FileTarget(path: row.path, line: quickLine)
        }
    }
    private func reveal(_ folder: String) {
        var path = ""
        for part in folder.split(separator: "/") {
            path += "\(part)/"
            model.openFilesFolder(scope, path)
        }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { results = nil; searchFailure = nil; return }
        try? await Task.sleep(for: .milliseconds(150))
        guard !Task.isCancelled else { return }
        do {
            var found = try await model.files(scope, ["op": "quick", "text": text], as: QuickOpen.self)
            // A checkout whose index is still building answers empty with `ready: false`: keep
            // the skeleton and ask again, until it answers or the wait runs out. Past the
            // deadline the screen says so and the next keystroke tries again.
            let deadline = ContinuousClock.now.advanced(by: .seconds(8))
            while found.ready == false {
                guard ContinuousClock.now < deadline else {
                    results = nil
                    searchFailure = "The checkout's file index is still building. Try again in a moment."
                    return
                }
                try? await Task.sleep(for: .milliseconds(300))
                guard !Task.isCancelled, query.trimmingCharacters(in: .whitespaces) == text else { return }
                found = try await model.files(scope, ["op": "quick", "text": text], as: QuickOpen.self)
            }
            guard !Task.isCancelled else { return }
            quickLine = found.line
            results = FileSearch(query: query, rows: found.rows.map(\.search), ready: found.ready != false)
            searchFailure = nil
        } catch is CancellationError {
        } catch {
            if !Task.isCancelled { searchFailure = error.localizedDescription }
        }
    }

    /// Pull to refresh lists what the tree shows and waits for the patch that draws it.
    private func refreshTree() async {
        let tree = model.files.tree(scope.memoryKey)
        let revision = tree.revision
        model.refreshFilesTree(scope)
        await tree.nextPatch(after: revision)
    }

    // MARK: Transfers

    private struct DownloadPick: Identifiable { let folder: String; var id: String { folder } }
    /// Every folder listed so far, the checkout itself first.
    private var folders: [String] { [""] + (tree?.rows ?? []).filter(\.isFolder).map { Self.bare($0.key) } }
    private static func bare(_ path: String) -> String { path.hasSuffix("/") ? String(path.dropLast()) : path }

    /// Copy picked documents into the app's staging folder, then offer where they go.
    private func stage(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, !urls.isEmpty else { return }
        var picked: [StagedAttachment] = []
        for url in urls.prefix(32) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if let file = try? AttachmentStaging().stage(copying: url, name: url.lastPathComponent, mimeType: type) { picked.append(file) }
        }
        guard !picked.isEmpty else { importProblem = "The files couldn't be read. Try picking them again."; return }
        staged = picked
        uploading = true
    }

    // MARK: Changes

    private var manageMenu: some View {
        Menu {
            Button("New file", systemImage: "doc.badge.plus") { actions.ask(.create(folder: "")) }
                .accessibilityIdentifier("files.newFile")
            Button("New folder", systemImage: "folder.badge.plus") { actions.ask(.mkdir(folder: "")) }
                .accessibilityIdentifier("files.newFolder")
            Button("Upload files…", systemImage: "square.and.arrow.up.on.square") { uploadFolder = ""; importing = true }
                .accessibilityIdentifier("files.upload")
            Button("Download folder…", systemImage: "arrow.down.circle") { downloading = "" }
                .accessibilityIdentifier("files.download")
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
            Button("Upload files here", systemImage: "square.and.arrow.up.on.square") { uploadFolder = Self.bare(path); importing = true }
            Button("Download folder", systemImage: "arrow.down.circle") { downloading = Self.bare(path) }
        }
        if !folder, let mention {
            Button("Mention in message", systemImage: "at") { mention(ComposerMention(path: path)) }
        }
        Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        if actions.canChange {
            Button("Rename", systemImage: "pencil") { actions.ask(.rename(path: path)) }
            Button("Move", systemImage: "folder") { actions.ask(.move(path: path)) }
            Button("Delete", systemImage: "trash", role: .destructive) { actions.ask(.delete(path: path)) }
        }
    }

    /// After a change: the tree lists its open folders again, a new file opens (as on the web),
    /// and a new or restored entry's folders open so it shows.
    private func changed(_ prompt: FilePrompt?, _ change: FileChange) {
        model.refreshFilesTree(scope)
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
