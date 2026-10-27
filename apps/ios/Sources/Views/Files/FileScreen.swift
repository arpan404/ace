import SwiftUI
import UIKit

/// One file of the checkout, as the web's file viewer shows it: source with line numbers, the
/// web's colours and change bars (Markdown rendered, with its source a tap away), an image, or a
/// plain sentence saying why it can't be shown. Find uses the system find navigator. A thread's
/// text files up to 1 MB can be edited and saved over the version that was opened; a file that
/// changed meanwhile is only replaced when the person says so.
struct FileScreen: View {
    let model: ClientModel
    let scope: FilesScope
    let target: FileTarget
    let mention: ((String) -> Void)?
    /// Where an Undo for this file goes once the screen closes after deleting it; without one
    /// the screen stays, saying the file is gone, with Undo.
    var deleted: ((FileStrip) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @AppStorage("files.wrap") private var wrap = false
    @State private var path: String
    @State private var content: FileContent?
    @State private var image: UIImage?
    @State private var failure: String?
    @State private var source = false
    @State private var editing = false
    @State private var editSession = 0
    @State private var dirty = false
    @State private var saving = false
    @State private var conflict: String?
    @State private var problem: String?
    @State private var confirmDiscard = false
    @State private var share: SharedFile?
    @State private var showChanges = false
    @State private var handle = SourceHandle()
    @State private var actions: FileActions

    init(model: ClientModel, scope: FilesScope, target: FileTarget, mention: ((String) -> Void)?, deleted: ((FileStrip) -> Void)? = nil) {
        self.deleted = deleted
        self.model = model
        self.scope = scope
        self.target = target
        self.mention = mention
        _path = State(initialValue: target.path)
        _actions = State(initialValue: FileActions(model: model, scope: scope))
    }

    private var name: String { FileActions.name(path) }
    private var folder: String { (path as NSString).deletingLastPathComponent }
    private var text: String? { content?.kind == "text" ? content?.text : nil }
    private var markdownPreview: Bool { content?.markdown == true && !source && !editing }
    private var canEdit: Bool { actions.canChange && content?.kind == "text" && content?.editable == true }
    private var hasChanges: Bool { scope.changes && (target.changed || !(content?.marks ?? []).isEmpty) }

    var body: some View {
        main
            .background(AceTheme.Colours.background)
            .threadTitle(name, subtitle: folder)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(editing)
            .toolbar { if editing { editToolbar } else { viewToolbar } }
            .readWhenConnected(model, id: "\(path)|\(model.files.revision)") { await load() }
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { strip }
            .sheet(item: $share) { ShareSheet(url: $0.url) }
            .sheet(isPresented: $showChanges) {
                ChangesSheet(model: model, title: threadTitle, initial: path).presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { stopEditing() }
                Button("Keep editing", role: .cancel) {}
            }
            .modifier(FileActionPrompts(actions: actions))
            .onAppear { actions.changed = { prompt, change in moved(prompt, change) } }
    }

    // MARK: Content

    @ViewBuilder private var main: some View {
        if let content {
            switch content.kind {
            case "missing":
                ContentUnavailableView {
                    Label("Not in the checkout", systemImage: "doc.questionmark")
                } description: {
                    Text("Nothing is at \(path) in this thread's checkout. It may have been moved or deleted.")
                } actions: {
                    if hasChanges { Button("Show changes") { showChanges = true } }
                }
            case "large":
                ContentUnavailableView {
                    Label("Too large to show here", systemImage: "doc.text")
                } description: {
                    Text("\(name) is \(size(content.size)). Files over 2 MB open as a download.")
                } actions: { Button("Share") { shareFile() } }
            case "binary":
                ContentUnavailableView {
                    Label("Binary file", systemImage: "doc")
                } description: {
                    Text("\(name) (\(size(content.size))) isn't text, so there's nothing to read here.")
                } actions: { Button("Share") { shareFile() } }
            case "image":
                ScrollView {
                    VStack(spacing: AceTheme.Spacing.md) {
                        if let image { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(name) }
                        else { Text("This image can't be drawn.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                        Text(size(content.size)).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                    }
                    .padding(AceTheme.Spacing.xl)
                }
            default:
                textBody(content)
            }
        } else if let failure {
            ContentUnavailableView {
                Label("Couldn't open \(name)", systemImage: "exclamationmark.triangle")
            } description: { Text(failure) } actions: {
                Button("Try again") { self.failure = nil; Task { await load() } }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func textBody(_ content: FileContent) -> some View {
        let text = content.text ?? ""
        if text.isEmpty && !editing {
            ContentUnavailableView("Empty file", systemImage: "doc.text", description: Text("\(name) has no content."))
        } else if markdownPreview {
            ScrollView {
                MarkdownView(text: text).padding(.horizontal, AceTheme.Spacing.xl).padding(.vertical, AceTheme.Spacing.lg)
            }
            .accessibilityIdentifier("preview.markdown")
        } else {
            SourceTextView(document: SourceDocument(key: "\(path)|\(content.version ?? "")|\(editSession)", text: text,
                                                    colours: content.colours ?? [], runs: content.runs ?? [],
                                                    marks: Dictionary((content.marks ?? []).map { ($0.line, $0.kind) }, uniquingKeysWith: { a, _ in a })),
                           wrap: wrap, editable: editing, line: target.line, handle: handle, dirty: { dirty = $0 })
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    // MARK: Toolbars

    @ToolbarContentBuilder private var viewToolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if text != nil, !markdownPreview {
                Button("Find in file", systemImage: "magnifyingglass") { handle.find() }.accessibilityIdentifier("file.find")
            }
            if canEdit {
                Button("Edit", systemImage: "pencil") { editing = true }.accessibilityIdentifier("file.edit")
            }
            Menu { fileMenu } label: { Label("File options", systemImage: "ellipsis") }
                .accessibilityIdentifier("file.menu")
        }
    }

    /// This file on the computer, for Open in.
    private var hostTarget: HostOpenTarget {
        switch scope {
        case .thread(let id): HostOpenTarget(threadId: id, path: path, line: target.line)
        case .project(let id): HostOpenTarget(workspaceId: id, path: path, line: target.line)
        }
    }
    @ViewBuilder private var fileMenu: some View {
        if text != nil, !markdownPreview { Toggle(isOn: $wrap) { Label("Wrap lines", systemImage: "text.word.spacing") } }
        if content?.markdown == true {
            Button(source ? "View preview" : "View source", systemImage: source ? "eye" : "chevron.left.forwardslash.chevron.right") { source.toggle() }
        }
        if hasChanges { Button("Show changes", systemImage: "plusminus") { showChanges = true }.accessibilityIdentifier("file.changes") }
        if let mention { Button("Mention in message", systemImage: "at") { mention(path) }.accessibilityIdentifier("preview.mention") }
        Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
        if content?.kind != "missing" {
            OpenOnHostMenu(model: model, target: hostTarget) { Label("Open in…", systemImage: "arrow.up.forward.app") }
                .accessibilityIdentifier("file.openIn")
        }
        if content != nil, content?.kind != "missing" { Button("Share", systemImage: "square.and.arrow.up") { shareFile() } }
        if actions.canChange, content?.kind != "missing" {
            Divider()
            Button("Rename", systemImage: "pencil") { actions.ask(.rename(path: path)) }
            Button("Move", systemImage: "folder") { actions.ask(.move(path: path)) }
            Button("Delete", systemImage: "trash", role: .destructive) { actions.ask(.delete(path: path)) }
        }
    }

    @ToolbarContentBuilder private var editToolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { if dirty { confirmDiscard = true } else { stopEditing() } }.disabled(saving)
                .accessibilityIdentifier("file.cancel")
        }
        ToolbarItem(placement: .principal) {
            Text(dirty ? "Unsaved changes" : "Editing").aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Find", systemImage: "magnifyingglass") { handle.find() }
        }
        ToolbarItem(placement: .confirmationAction) {
            Button(saving ? "Saving…" : "Save") { save() }.fontWeight(.semibold).disabled(!dirty || saving)
                .accessibilityIdentifier("file.save")
        }
    }

    @ViewBuilder private var strip: some View {
        if let conflict {
            FilesStripView(message: "\(name) changed since you opened it. Replace it?",
                           action: ("Replace", { save(over: conflict) }), secondary: ("Keep editing", { self.conflict = nil }), dismiss: nil)
        } else if let problem {
            FilesStripView(message: problem, dismiss: { self.problem = nil })
        }
    }

    // MARK: Actions

    private func load() async {
        guard !editing else { return }
        do {
            let next = try await model.files(scope, ["op": "read", "path": path], as: FileContent.self)
            image = next.kind == "image" ? next.data.flatMap { Data(base64Encoded: $0) }.flatMap(UIImage.init(data:)) : nil
            content = next
            failure = nil
        } catch is CancellationError {
        } catch {
            if content == nil { failure = error.localizedDescription }
        }
    }

    private func stopEditing() {
        editing = false
        dirty = false
        conflict = nil
        problem = nil
        // The text view reloads the file as it was opened.
        editSession += 1
    }

    /// Save over the version that was opened, or over `newer` once the person chose Replace.
    private func save(over newer: String? = nil) {
        guard let expected = newer ?? content?.version, !saving else { return }
        saving = true
        conflict = nil
        problem = nil
        let typed = handle.text
        Task {
            defer { saving = false }
            do {
                let result = try await model.files(scope, ["op": "write", "path": path, "text": typed, "expected": expected], as: FileChange.self)
                if let newer = result.conflict { conflict = newer; return }
                editing = false
                dirty = false
                await load()
            } catch {
                problem = error.localizedDescription
            }
        }
    }

    private func shareFile() {
        Task {
            do {
                if let text {
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ace-files/\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let url = folder.appendingPathComponent(name)
                    try Data(text.utf8).write(to: url, options: .atomic)
                    share = SharedFile(url: url)
                } else {
                    share = SharedFile(url: try await model.fileCopy(scope, ["op": "download", "path": path]))
                }
            } catch {
                problem = "Couldn't share \(name). \(error.localizedDescription)"
            }
        }
    }

    /// A rename or move follows the file to its new path; a delete leaves the screen.
    private func moved(_ prompt: FilePrompt?, _ change: FileChange) {
        switch prompt {
        case .delete?:
            if let deleted, let strip = actions.strip { deleted(strip); dismiss() } else { Task { await load() } }
        case .rename?, .move?: if let destination = change.destination { path = destination }
        default: break
        }
    }

    private var threadTitle: String {
        if case .thread(let id) = scope { return model.inbox[id]?.title ?? "" }
        return ""
    }
    private func size(_ bytes: Int?) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes ?? 0), countStyle: .file) }
}

/// A file copied to this phone for the share sheet.
struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The system share sheet for one file.
struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
