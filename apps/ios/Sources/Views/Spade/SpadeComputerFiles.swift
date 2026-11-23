import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A bot's files (web's `file-manager.tsx`), one folder at a time under a trail back up. Upload
/// (from Files or Photos) and New folder put things in the folder shown; each row opens its
/// folder or file, and its menu downloads (the share sheet), renames or moves (a path with
/// folders moves it), or deletes after asking. Browsing and downloads always work; every change
/// needs the person able to act, checked again right before it goes. A rename or delete names
/// the revision of the file read when the person began it, so Spade refuses it if the bot changed
/// the file meanwhile.
struct SpadeComputerFiles: View {
    let model: ClientModel
    let watch: SpadeComputerWatch
    let name: String
    let face: SpadeModel.Face
    @Environment(\.scenePhase) private var scene
    @State private var path = ""
    @State private var folder: SpadeFolder?
    @State private var problem: String?
    @State private var alert: String?
    @State private var importing = false
    @State private var choosingPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var uploading = 0
    @State private var making = false
    @State private var newName = ""
    @State private var renaming: Renaming?
    @State private var deleting: Deleting?
    @State private var shared: SharedFile?

    /// A rename under way: what it began from, the revision seen then, and what is typed.
    private struct Renaming { let entry: SpadeFileEntry; let revision: String?; var to: String }
    private struct Deleting { let entry: SpadeFileEntry; let revision: String? }

    private var mayAct: Bool { scene == .active && watch.mayAct(model) }

    var body: some View {
        List {
            Section { trail.listRowInsets(EdgeInsets()).listRowBackground(Color.clear) }
            if let problem, folder == nil {
                ProblemRow(problem, id: "spade.files.problem") { Task { await load() } }
            } else if let folder {
                Section {
                    if folder.entries.isEmpty {
                        Text("Nothing here yet.").foregroundStyle(AceDesign.Ink.muted)
                    }
                    ForEach(folder.entries) { entry in row(entry) }
                    if folder.truncated {
                        Text("Spade lists only the first part of this folder.")
                            .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
            } else {
                SkeletonRows(count: 4).listRowInsets(EdgeInsets())
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
        .navigationTitle(path.isEmpty ? "Files" : (path.split(separator: "/").last.map(String.init) ?? "Files"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
        .safeAreaInset(edge: .bottom) {
            SpadeDriveLineView(model: model, watch: watch, kind: "files", face: face)
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.related)
        }
        .task(id: path) { await load() }
        .followsComputer(watch, model: model)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { pickedFiles($0) }
        .photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 8, matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { _, picked in
            guard !picked.isEmpty else { return }
            photos = []
            Task { await pickedPhotos(picked) }
        }
        .alert("New folder", isPresented: $making) {
            TextField("Name", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) {}
            Button("Make") { makeFolder() }
        } message: { Text(path.isEmpty ? "In \(name)'s files." : "In \(path).") }
        .alert("Rename or move", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Path", text: Binding(get: { renaming?.to ?? "" }, set: { renaming?.to = $0 }))
                .textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("Cancel", role: .cancel) { renaming = nil }
            Button("Rename") { move() }
        } message: { Text("A path with folders moves it.") }
        .confirmationDialog(deleting.map { "Delete \($0.entry.name)?" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) { remove() }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: {
            if let entry = deleting?.entry {
                Text(entry.isFolder ? "This deletes \(entry.path) and everything in it from \(name)'s files."
                                    : "This deletes \(entry.path) from \(name)'s files.")
            }
        }
        .alert(alert ?? "", isPresented: Binding(get: { alert != nil }, set: { if !$0 { alert = nil } })) {
            Button("Close", role: .cancel) { alert = nil }
        }
        .sheet(item: $shared) { file in
            ShareSheet(url: file.url) { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
        }
    }

    /// "Files › src › lib": each step opens that folder.
    private var trail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.tight) {
                crumb("Files", "")
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    AceIcon(.caretRight, size: AceDesign.Size.icon).foregroundStyle(AceDesign.Ink.faint)
                    crumb(step.name, step.path)
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Folder path")
    }

    private var steps: [(name: String, path: String)] {
        var prefix = ""
        return path.split(separator: "/").map { part in
            prefix = prefix.isEmpty ? String(part) : "\(prefix)/\(part)"
            return (String(part), prefix)
        }
    }

    private func crumb(_ title: String, _ target: String) -> some View {
        Button(title) { path = target }
            .buttonStyle(.secondaryAction)
            .frame(minHeight: AceDesign.Size.tap)
            .disabled(target == path)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Upload from Files", ace: .file) { if checkMayAct() { importing = true } }
                Button("Upload from Photos", ace: .images) { if checkMayAct() { choosingPhotos = true } }
                Button("New folder", ace: .folderPlus) { if checkMayAct() { newName = ""; making = true } }
            } label: {
                if uploading > 0 { ProgressView() } else { Image(ace: .trayArrowUp) }
            }
            .accessibilityLabel("Add files")
            .accessibilityIdentifier("spade.files.add")
        }
    }

    @ViewBuilder private func row(_ entry: SpadeFileEntry) -> some View {
        Group {
            if entry.isFolder {
                Button { path = entry.path } label: { label(entry) }
            } else {
                NavigationLink {
                    SpadeComputerFileEditor(model: model, watch: watch, path: entry.path, name: name, face: face)
                } label: { label(entry) }
            }
        }
        .contextMenu {
            if !entry.isFolder { Button("Download", ace: .export) { download(entry) } }
            Button("Rename or move", ace: .pencilSimple) { Task { await beginRename(entry) } }.disabled(!mayAct)
            Button("Delete", ace: .trash, role: .destructive) { Task { await beginDelete(entry) } }.disabled(!mayAct)
        }
        .accessibilityIdentifier("spade.files.row")
    }

    private func label(_ entry: SpadeFileEntry) -> some View {
        Label {
            LabeledContent(entry.name) {
                if !entry.isFolder {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file))
                        .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            }
            .foregroundStyle(AceDesign.Ink.primary)
        } icon: { AceIcon(entry.isFolder ? .folder : .fileText, size: AceDesign.Size.barIcon) }
    }

    // MARK: Reads and changes

    private func load() async {
        let reply = await model.spadeComputer(["type": "spade.files.folder", "agentId": watch.agent, "path": path],
                                              failing: "Couldn't read the folder")
        guard !Task.isCancelled else { return }
        if let read = reply.folder { folder = read; problem = nil } else { problem = reply.problem }
    }

    /// Whether a change may go now; says why not when it can't.
    private func checkMayAct() -> Bool {
        if mayAct { return true }
        alert = spadeNotNowToChange
        return false
    }

    private func inFolder(_ name: String) -> String { path.isEmpty ? name : "\(path)/\(name)" }

    private func pickedFiles(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, !urls.isEmpty else { return }
        var picked: [StagedAttachment] = []
        for url in urls.prefix(32) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            if let file = try? AttachmentStaging().stage(copying: url, name: url.lastPathComponent, mimeType: type) { picked.append(file) }
        }
        guard !picked.isEmpty else { alert = "The files couldn't be read. Try picking them again."; return }
        Task { await upload(picked) }
    }

    private func pickedPhotos(_ items: [PhotosPickerItem]) async {
        var picked: [StagedAttachment] = []
        for item in items { if let file = try? await PhotoLibraryPick.stage(item, into: AttachmentStaging()) { picked.append(file) } }
        guard !picked.isEmpty else { alert = "Couldn't read those photos."; return }
        await upload(picked)
    }

    private func upload(_ files: [StagedAttachment]) async {
        uploading += 1
        defer { uploading -= 1 }
        let into = path
        for file in files {
            // The pick took a while: the person may have handed back meanwhile.
            guard checkMayAct() else { break }
            let reply = await model.spadeUpload(watch.agent, folder: into, file: file)
            if let problem = reply.problem { alert = problem }
        }
        await load()
    }

    private func makeFolder() {
        let typed = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty, checkMayAct() else { return }
        Task {
            let reply = await model.spadeComputer(["type": "spade.files.mkdir", "agentId": watch.agent, "path": inFolder(typed)],
                                                  failing: "Couldn't make \(typed)")
            if let problem = reply.problem { alert = problem }
            await load()
        }
    }

    /// The revision of a file as the person sees it now; nil for a folder. Nil and false when it
    /// couldn't be checked, after saying why: nothing goes then.
    private func seen(_ entry: SpadeFileEntry) async -> (revision: String?, ok: Bool) {
        guard !entry.isFolder else { return (nil, true) }
        let reply = await model.spadeComputer(["type": "spade.files.revision", "agentId": watch.agent, "path": entry.path],
                                              failing: "Couldn't check the file. Try again.")
        // A file's change always names its revision: without one it would land on whatever is
        // there by the time it goes.
        if reply.ok, let revision = reply.revision { return (revision, true) }
        alert = reply.problem ?? "Couldn't check the file. Try again."
        if reply.gone == true { await load() }
        return (nil, false)
    }

    private func beginRename(_ entry: SpadeFileEntry) async {
        guard checkMayAct() else { return }
        let saw = await seen(entry)
        guard saw.ok else { return }
        renaming = Renaming(entry: entry, revision: saw.revision, to: entry.path)
    }

    private func move() {
        guard let renaming else { return }
        self.renaming = nil
        let to = renaming.to.trimmingCharacters(in: .whitespacesAndNewlines)
        // Asked first: the person may have handed back while the question was open.
        guard !to.isEmpty, to != renaming.entry.path, checkMayAct() else { return }
        var payload: [String: Any] = ["type": "spade.files.move", "agentId": watch.agent, "from": renaming.entry.path, "to": to]
        if let revision = renaming.revision { payload["base"] = revision }
        Task {
            let reply = await model.spadeComputer(payload, failing: "Couldn't move \(renaming.entry.name)")
            if let problem = reply.problem { alert = problem }
            await load()
        }
    }

    private func beginDelete(_ entry: SpadeFileEntry) async {
        guard checkMayAct() else { return }
        let saw = await seen(entry)
        guard saw.ok else { return }
        deleting = Deleting(entry: entry, revision: saw.revision)
    }

    private func remove() {
        guard let deleting else { return }
        self.deleting = nil
        guard checkMayAct() else { return }
        var payload: [String: Any] = ["type": "spade.files.delete", "agentId": watch.agent, "path": deleting.entry.path]
        if let revision = deleting.revision { payload["base"] = revision }
        Task {
            let reply = await model.spadeComputer(payload, failing: "Couldn't delete \(deleting.entry.name)")
            if let problem = reply.problem { alert = problem }
            await load()
        }
    }

    private func download(_ entry: SpadeFileEntry) {
        Task {
            do { shared = SharedFile(url: try await model.spadeDownload(watch.agent, path: entry.path)) }
            catch { alert = "\(entry.name) couldn't be downloaded. Check the connection and try again." }
        }
    }
}
