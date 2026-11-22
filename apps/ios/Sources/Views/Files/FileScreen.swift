import SwiftUI
import UIKit

/// One file of the checkout, as the web's file viewer shows it: source with line numbers, the
/// web's colours and change bars (Markdown rendered, with its source a tap away), an image, or a
/// plain sentence saying why it can't be shown. Find uses the system find navigator. A thread's
/// text files up to 1 MB can be edited and saved over the version that was opened; a file that
/// changed meanwhile is only replaced when the person says so. A larger one is read and edited a
/// part at a time (`LargeFileView`), with its own find.
struct FileScreen: View {
    let model: ClientModel
    let scope: FilesScope
    let target: FileTarget
    let mention: ((ComposerMention) -> Void)?
    /// Where an Undo for this file goes once the screen closes after deleting it; without one
    /// the screen stays, saying the file is gone, with Undo.
    var deleted: ((FileStrip) -> Void)?
    /// Opens a breadcrumb's folder (ending in "/") in the Files screen this file came from; without
    /// one, a Files screen opens on top with that folder open.
    var openFolder: ((String) -> Void)?
    /// The editor group this file shows in (`EditorGroups`); nil for a file opened on its own.
    var slot: EditorSlot?
    @Environment(\.dismiss) var dismiss
    @AppStorage("files.wrap") var wrap = false
    @State var path: String
    @State var content: FileContent?
    @State var image: UIImage?
    @State var failure: String?
    @State var source = false
    @State var editing = false
    /// A text file too large to edit whole, shown in parts so one can be edited.
    @State var inParts = false
    @State var editSession = 0
    @State var dirty = false
    @State var saving = false
    @State var conflict: String?
    @State var problem: String?
    @State var confirmDiscard = false
    @State var share: SharedFile?
    @State var showChanges = false
    @State var handle = SourceHandle()
    /// Lines selected while reading: Mention lines puts them in the message.
    @State var selectedLines: ClosedRange<Int>?
    @State var mentioned = 0
    @Environment(\.aceReduceMotion) var reduceMotion
    @State var actions: FileActions
    @State var goingToLine = false
    @State var shownFolder: String?
    /// The version this edit began from: a save over anything newer asks first.
    @State var base: String?
    /// A note being written on the selected code (`Annotations+FileScreen.swift`).
    @State var noting: NoteDraft?
    @Environment(\.codeNotesHandOff) var handOffNotes

    init(model: ClientModel, scope: FilesScope, target: FileTarget, mention: ((ComposerMention) -> Void)?, deleted: ((FileStrip) -> Void)? = nil,
         openFolder: ((String) -> Void)? = nil, slot: EditorSlot? = nil) {
        self.deleted = deleted
        self.slot = slot
        self.openFolder = openFolder
        self.model = model
        self.scope = scope
        self.target = target
        self.mention = mention
        _path = State(initialValue: target.path)
        // An editor of this file went with a draft: carry on editing it here.
        if let draft = slot?.draft() {
            _editing = State(initialValue: true)
            _dirty = State(initialValue: draft.dirty)
            _base = State(initialValue: draft.base)
        }
        _actions = State(initialValue: FileActions(model: model, scope: scope))
    }

    var name: String { FileActions.name(path) }
    var text: String? { content?.kind == "text" ? content?.text : nil }
    var markdownPreview: Bool { content?.markdown == true && !source && !editing }
    var canEdit: Bool { actions.canChange && content?.kind == "text" && content?.editable == true }
    var canEditParts: Bool { actions.canChange && content?.parts == true }
    /// The source view is on screen, so Find and Go to line reach it.
    var showsSource: Bool { text != nil && !markdownPreview && !inParts && (editing || text?.isEmpty == false) }
    var hasChanges: Bool { scope.changes && (target.changed || !(content?.marks ?? []).isEmpty) }

    var body: some View {
        main
            .background(AceTheme.Colours.background)
            // Beside another group, each file's bar is a row over it and the editor keeps the title.
            .navigationTitle(inPane ? slot?.title ?? name : name)
            .toolbar { if !inPane { ToolbarItem(placement: .principal) { titleStack(alignment: .center) } } }
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(editing || slot?.locked == true)
            .toolbar { if !inPane { if editing { editToolbar } else { viewToolbar } } }
            .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { if inPane { paneBar } }
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
            .overlay(alignment: .bottom) { mentionLines }
            .overlay(alignment: .bottomTrailing) { notesChip }
            .sheet(item: $noting) { draft in noteSheet(draft) }
            .animation(.default, value: selectedLines)
            .sensoryFeedback(.success, trigger: mentioned)
            .modifier(FileActionPrompts(actions: actions))
            .modifier(GoToLineRoute(isPresented: $goingToLine, enabled: showsSource && slot?.focused != false, handle: handle))
            .navigationDestination(item: $shownFolder) { folder in
                FilesScreen(model: model, scope: scope, subtitle: threadTitle, mention: mention, folder: folder)
            }
            .onAppear { actions.changed = { prompt, change in moved(prompt, change) } }
            .onChange(of: path, initial: true) { _, now in model.fileOpened(scope, now) }
            .onChange(of: editing) { _, now in
                if now {
                    if base == nil { base = content?.version }
                    slot?.began(base)
                } else {
                    base = nil
                    slot?.ended()
                }
            }
            .onChange(of: dirty) { _, now in if editing { slot?.dirtied(now, base) } }
    }

    /// The switcher picked another open file: show it here, as a tab switch would.
    func switchTo(_ picked: String) {
        guard picked != path else { return }
        // In the editor a draft stays with its file, so another file can show over it.
        if let slot { return slot.pick(picked) }
        guard !editing else { return }
        content = nil; image = nil; failure = nil; source = false; inParts = false
        path = picked
    }

    // MARK: Content

    @ViewBuilder var main: some View {
        if let content {
            switch content.kind {
            case "missing":
                EmptyState(icon: .fileDashed, title: "Not in the checkout",
                           line: "Nothing is at \(path) in this thread's checkout. It may have been moved or deleted.") {
                    if hasChanges { Button("Show changes") { showChanges = true } }
                }
            case "large":
                LargeFileView(model: model, scope: scope, path: path, size: content.size, editable: canEditParts,
                                  marks: content.markedLines)
            case "binary":
                EmptyState(icon: .file, title: "Binary file",
                           line: "\(name) (\(size(content.size))) isn't text, so there's nothing to read here.") {
                    Button("Share") { shareFile() }
                }
            case "image":
                ScrollView {
                    VStack(spacing: AceTheme.Spacing.md) {
                        if let image { Image(uiImage: image).resizable().scaledToFit().accessibilityLabel(name) }
                        else { Text("This image can't be drawn.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                        Text(size(content.size)).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                    }
                    .padding(AceDesign.Space.margin)
                }
            default:
                if inParts {
                    LargeFileView(model: model, scope: scope, path: path, size: content.size, editable: canEditParts,
                                  marks: content.markedLines)
                } else {
                    textBody(content)
                }
            }
        } else if let failure {
            EmptyState(icon: nil, title: "Couldn't open \(name)", line: failure, failed: true) {
                Button("Try again") { self.failure = nil; Task { await load() } }
            }
        } else {
            SkeletonPage(label: "Loading \(name)")
        }
    }

    @ViewBuilder func textBody(_ content: FileContent) -> some View {
        let text = content.text ?? ""
        if text.isEmpty && !editing {
            EmptyState(icon: .fileText, title: "Empty file", line: "\(name) has no content.")
        } else if markdownPreview {
            ScrollView {
                AceMarkdown(text: text).padding(.horizontal, AceDesign.Space.margin).padding(.vertical, AceDesign.Space.margin)
            }
            .accessibilityIdentifier("preview.markdown")
        } else {
            // A draft an earlier editor of this file left, shown over the file as saved.
            let carried = editing ? slot?.draft()?.text : nil
            SourceTextView(document: SourceDocument(key: "\(path)|\(content.version ?? "")|\(editSession)|\(carried == nil ? "" : "draft")",
                                                    text: carried ?? text, language: content.language,
                                                    marks: content.markedLines, original: carried == nil ? nil : text, file: path),
                           wrap: wrap, editable: editing, line: target.line, handle: handle, dirty: { dirty = $0 },
                           selected: mention == nil ? nil : { selectedLines = $0 },
                           mention: mention == nil ? nil : { mentionSelection($0) },
                           left: slot?.left, touched: slot?.focus,
                           annotate: noteThread == nil ? nil : { annotate($0) }, notes: noteMarks,
                           edited: noteEdited, loaded: noteLoaded)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    /// While lines are selected, one glass capsule over the text says what Mention puts in the
    /// message: "Mention line 12" or "Mention lines 12–20".
    @ViewBuilder var mentionLines: some View {
        if let lines = selectedLines, mention != nil, !editing {
            Button { mentionSelection(lines) } label: {
                Text(lines.count == 1 ? "Mention line \(lines.lowerBound)" : "Mention lines \(lines.lowerBound)–\(lines.upperBound)")
                    .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .monospacedDigit()
                    .padding(.horizontal, AceTheme.Spacing.lg)
                    .frame(minHeight: AceDesign.Size.tap)
                    .contentShape(AceShape.capsule)
            }
            .buttonStyle(.plain)
            .floatingGlass()
            .padding(.bottom, AceTheme.Spacing.lg)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .accessibilityIdentifier("preview.mentionLines")
        }
    }
    func mentionSelection(_ lines: ClosedRange<Int>) {
        mentioned += 1
        selectedLines = nil
        mention?(ComposerMention(path: path, lines: lines))
    }

    @ViewBuilder var strip: some View {
        if let conflict {
            FilesStripView(message: "\(name) changed since you opened it. Replace it?",
                           action: ("Replace", { save(over: conflict) }), secondary: ("Keep editing", { self.conflict = nil }), dismiss: nil)
        } else if let problem {
            FilesStripView(message: problem, dismiss: { self.problem = nil })
        }
    }

    // MARK: Actions

    /// A breadcrumb's folder opens in Files.
    func open(_ folder: FileBreadcrumbs.Folder) {
        if let openFolder { openFolder(folder.path) } else { shownFolder = folder.path }
    }

    func load() async {
        // While editing the file stays as it was opened, except for a draft carried over unread.
        guard !editing || content == nil else { return }
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

    func stopEditing() {
        editing = false
        dirty = false
        conflict = nil
        problem = nil
        // The text view reloads the file as it was opened.
        editSession += 1
    }

    /// Save over the version that was opened, or over `newer` once the person chose Replace.
    func save(over newer: String? = nil) {
        guard let expected = newer ?? base ?? content?.version, !saving else { return }
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

    func shareFile() {
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
    func moved(_ prompt: FilePrompt?, _ change: FileChange) {
        switch prompt {
        case .delete?:
            if let slot, slot.pane {
                // Beside other files the tab closes; the editor leaves once no file is open.
                if let strip = actions.strip { deleted?(strip) }
                slot.removed()
            } else if let deleted, let strip = actions.strip {
                // Back to the tree, where Undo shows.
                deleted(strip)
                if let slot { slot.removed() } else { dismiss() }
            } else {
                Task { await load() }
            }
        case .rename?, .move?:
            guard let destination = change.destination else { return }
            path = destination
            slot?.renamed(destination)
        default: break
        }
    }

    var threadTitle: String {
        if case .thread(let id) = scope { return model.inbox[id]?.title ?? "" }
        return ""
    }
    func size(_ bytes: Int?) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes ?? 0), countStyle: .file) }
}
