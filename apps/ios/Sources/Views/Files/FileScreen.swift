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
    @Environment(\.scenePhase) var scenePhase
    @AppStorage(EditorPreferences.wordWrapKey) var wrap = false
    @AppStorage(EditorPreferences.fontSizeKey) var fontSize = EditorPreferences.defaultFontSize
    @AppStorage(EditorPreferences.lineSpacingKey) var lineSpacing = EditorPreferences.defaultLineSpacing
    @AppStorage(EditorPreferences.tabSizeKey) var tabSize = EditorPreferences.defaultTabSize
    @AppStorage(EditorPreferences.insertSpacesKey) var insertSpaces = true
    @AppStorage(EditorPreferences.autoSaveKey) var autoSaveMode = EditorAutoSaveMode.off.rawValue
    @AppStorage(EditorPreferences.autoSaveDelayKey) var autoSaveDelay = EditorPreferences.defaultAutoSaveDelay
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
    /// Auto save's timer for the text being edited, and whether a write that met another change
    /// has stopped it until the person saves by hand.
    @State var autoSaveTask: Task<Void, Never>?
    @State var autoSave = EditorAutoSave()
    /// What auto save last wrote while the editor stayed open: the version later writes go over
    /// and the base a merge starts from. Kept apart from `content` so the text being typed in
    /// isn't reloaded; nil once the editor reloads onto a version (Save, Merge, stopping).
    @State var autoSaved: FileContent?
    /// Text to show when Save or Merge moves the edit onto a new base.
    @State var rebasedText: String?
    @State var conflict: String?
    @State var conflictTask: Task<Void, Never>?
    @State var conflictReview: FileConflictReview?
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
            _content = State(initialValue: draft.base)
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
    var conflictBusy: Bool { conflictTask != nil }

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
            .sheet(item: $conflictReview) { review in showConflict(review) }
            .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard changes", role: .destructive) { stopEditing() }
                Button("Keep editing", role: .cancel) {}
            }
            .overlay(alignment: .bottom) { mentionLines }
            .overlay(alignment: .bottomTrailing) { notesChip }
            .sheet(item: $noting) { draft in noteSheet(draft) }
            // Notes made here name this checkout, so a rename in another one leaves them.
            .task(id: noteThread) { if let thread = noteThread { await model.checkoutKey(thread) } }
            .animation(.default, value: selectedLines)
            .sensoryFeedback(.success, trigger: mentioned)
            .modifier(FileActionPrompts(actions: actions))
            .modifier(GoToLineRoute(isPresented: $goingToLine, enabled: showsSource && slot?.focused != false, handle: handle))
            .navigationDestination(item: $shownFolder) { folder in
                FilesScreen(model: model, scope: scope, subtitle: threadTitle, mention: mention, folder: folder)
            }
            .onAppear { actions.changed = { prompt, change in moved(prompt, change) } }
            .onDisappear { autoSaveTask?.cancel(); autoSaveTask = nil; cancelConflictRead() }
            .onChange(of: path, initial: true) { _, now in model.fileOpened(scope, now) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background, editing, dirty, let content,
                   handle.documentKey == documentKey(content, carried: carriedText), let view = handle.view {
                    slot?.left(view.text)
                }
            }
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
            let carried = carriedText
            let session = editSession
            SourceTextView(document: SourceDocument(key: documentKey(content, carried: carried),
                                                    text: carried ?? text, language: content.language,
                                                    marks: content.markedLines, original: carried == nil ? nil : text, file: path),
                           wrap: wrap, editable: editing, preferences: editorPreferences,
                           line: target.line, handle: handle, dirty: markDirty, typed: typedInEditor,
                           selected: mention == nil ? nil : { selectedLines = $0 },
                           mention: mention == nil ? nil : { mentionSelection($0) },
                           left: { body in
                               // A rebased draft is already in the store while TextKit loads it.
                               if editSession == session { slot?.left(body) }
                           }, touched: slot?.focus,
                           annotate: noteThread == nil ? nil : { annotate($0) }, notes: noteMarks,
                           edited: noteEdited, loaded: noteLoaded)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }

    private var carriedText: String? { editing ? rebasedText ?? slot?.draft()?.text : nil }
    private func documentKey(_ content: FileContent, carried: String?) -> String {
        "\(path)|\(content.version ?? "")|\(editSession)|\(carried == nil ? "" : "draft")"
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
            conflictStrip(conflict)
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
        guard !editing else { return }
        let loadingPath = path
        do {
            let next = try await model.files(scope, ["op": "read", "path": loadingPath], as: FileContent.self)
            guard !Task.isCancelled, !editing, path == loadingPath else { return }
            image = next.kind == "image" ? next.data.flatMap { Data(base64Encoded: $0) }.flatMap(UIImage.init(data:)) : nil
            content = next
            failure = nil
        } catch is CancellationError {
        } catch {
            if path == loadingPath, content == nil { failure = error.localizedDescription }
        }
    }

    func startEditing() {
        guard let content else { return }
        slot?.began(content)
        editing = true
    }

    func markDirty(_ now: Bool) {
        guard editing, let content else { return }
        dirty = now
        slot?.dirtied(now, content)
    }

    func stopEditing() {
        autoSaveTask?.cancel()
        autoSaveTask = nil
        autoSaved = nil
        slot?.ended()
        editing = false
        dirty = false
        conflict = nil
        problem = nil
        rebasedText = nil
        editSession += 1
    }

    /// Replace the visible editor text while retaining it as a draft against a known disk version.
    func rebaseEdit(onto disk: FileContent, text: String) {
        slot?.rebased(disk, text)
        rebasedText = text
        content = disk
        autoSaved = nil
        dirty = !text.utf8.elementsEqual((disk.text ?? "").utf8)
        conflict = nil
        problem = nil
        editSession += 1
        // Auto save may have written while editing: show the file as it now is on the machine.
        Task { await load() }
    }

    /// Settings › Editor as the text on screen is drawn and typed in.
    var editorPreferences: EditorPreferences {
        EditorPreferences(fontSize: fontSize, lineSpacing: lineSpacing, tabSize: tabSize,
                          insertSpaces: insertSpaces, wordWrap: wrap)
    }

    /// The person typed: with After a pause, the file writes itself once typing has rested.
    func typedInEditor() {
        autoSaveTask?.cancel()
        autoSaveTask = nil
        guard editing, !saving else { return }
        // Settings may have changed since the last keystroke.
        let mode = EditorAutoSaveMode(rawValue: autoSaveMode) ?? .off
        if autoSave.mode != mode { autoSave.mode = mode }
        let delay = EditorPreferences.clampedDelay(autoSaveDelay)
        if autoSave.delay != delay { autoSave.delay = delay }
        let now = Self.millisecondsNow
        guard let deadline = autoSave.typed(at: now) else { return }
        let wait = max(0, deadline - now)
        autoSaveTask = Task {
            try? await Task.sleep(for: .milliseconds(wait))
            guard !Task.isCancelled else { return }
            await writeByItself()
        }
    }

    /// Auto save's write: the versioned save Save makes, but the editor stays open on the text.
    /// A file someone else changed stops auto save and asks, as Save does.
    func writeByItself() async {
        // Auto save may have been turned off since this write was armed.
        guard EditorAutoSaveMode(rawValue: autoSaveMode) == .pause else { return }
        // Never while the person is being asked whether to throw the changes away, or while a
        // conflict is being read or shown.
        guard editing, dirty, !saving, !confirmDiscard, !conflictBusy, conflict == nil, let content,
              let expected = autoSaved?.version ?? content.version else { return }
        saving = true
        let typed = handle.text
        do {
            let result = try await model.files(scope, ["op": "write", "path": path, "text": typed, "expected": expected], as: FileChange.self)
            if let newer = result.conflict {
                // Someone else changed the file: stop and offer Compare and Merge, as Save does.
                autoSave.failed()
                saving = false
                conflict = newer
                return
            }
            if let version = result.version {
                let saved = content.saved(text: typed, version: version)
                autoSaved = saved
                // Another pane picking this file up starts from what's now on the machine. The
                // draft carries no text: the person may have typed since, and a carried text
                // would reload the view and drop it.
                slot?.wrote(saved)
            }
            dirty = handle.markSaved(typed)
        } catch {
            autoSave.failed()
            problem = error.localizedDescription
        }
        saving = false
        // Typed while the write was out: the rest of the pause starts again.
        if dirty { typedInEditor() }
    }

    private static var millisecondsNow: Int { Int(Date().timeIntervalSince1970 * 1000) }

    /// Save over the version that was opened, or over `newer` once the person chose Replace.
    func save(over newer: String? = nil) {
        guard let content, let expected = newer ?? autoSaved?.version ?? content.version, !saving, !conflictBusy,
              handle.documentKey == documentKey(content, carried: carriedText),
              let view = handle.view else { return }
        autoSaveTask?.cancel()
        autoSaveTask = nil
        let savingPath = path
        let typed = view.text ?? ""
        saving = true
        conflict = nil
        problem = nil
        Task {
            defer { saving = false }
            do {
                let result = try await model.files(scope, ["op": "write", "path": savingPath, "text": typed, "expected": expected], as: FileChange.self)
                guard editing, path == savingPath, handle.view != nil else { return }
                if let newer = result.conflict { conflict = newer; return }
                // The person saved the file themselves: auto save may write it again.
                autoSave.savedByHand()
                guard let version = result.version else { return }
                let saved = content.saved(text: typed, version: version)
                let now = handle.text
                if now.utf8.elementsEqual(typed.utf8) {
                    self.content = saved
                    stopEditing()
                    await load()
                } else {
                    rebaseEdit(onto: saved, text: now)
                }
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
