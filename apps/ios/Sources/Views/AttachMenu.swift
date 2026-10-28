import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The + menu, "Add files and context": photos (library or camera) and files for the message (the
/// thread's next one or New thread's first), then the catalog's other builtins the phone can run
/// (`more`: files to mention, plan mode, the model, ...). It copies and hashes the picked bytes on
/// the phone and hands them on; every check (size, how many) is the bridge's.
struct AttachMenu: View {
    let stage: (StagedAttachment) -> Void
    /// Why the last pick couldn't be read; nil when it could.
    @Binding var problem: String?
    var identifier = "composer.attach"
    /// Where picked bytes are copied: the temporary folder, or New thread's draft folder.
    var staging = AttachmentStaging()
    /// The + list's builtins besides attaching, and what picking one does.
    var more: [SuggestionRow] = []
    var pickMore: (SuggestionRow) -> Void = { _ in }
    /// Offers Previous message, which puts an earlier message back in the composer.
    var recall = false
    /// Set from elsewhere ("Attach files" picked from the `/` list): offers the same three sources.
    var ask: Binding<Bool> = .constant(false)
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    /// Files picks a folder instead: the files inside it go (`ComposerIntake.folder`).
    @State private var choosingFolder = false
    @State private var usingCamera = false
    init(stage: @escaping (StagedAttachment) -> Void, problem: Binding<String?>, identifier: String = "composer.attach",
         staging: AttachmentStaging = AttachmentStaging(), more: [SuggestionRow] = [],
         pickMore: @escaping (SuggestionRow) -> Void = { _ in }, recall: Bool = false, ask: Binding<Bool> = .constant(false)) {
        self.stage = stage; _problem = problem; self.identifier = identifier
        self.staging = staging; self.more = more; self.pickMore = pickMore; self.recall = recall; self.ask = ask
    }
    var body: some View {
        AttachmentMenuButton(identifier: identifier, actions: actions, ask: ask)
            .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
        .photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 8, matching: .any(of: [.images, .videos]))
        .onChange(of: photos) { _, picked in
            guard !picked.isEmpty else { return }
            photos = []
            for item in picked { Task { await stagePhoto(item) } }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: choosingFolder ? [.folder] : [.item], allowsMultipleSelection: !choosingFolder) { result in
            guard case .success(let urls) = result else { return }
            if choosingFolder, let folder = urls.first { Task { await stageFolder(folder) } }
            else { for url in urls { Task { await stageFile(url) } } }
        }
        .fullScreenCover(isPresented: $usingCamera) {
            CameraPicker { image in Task { await stageCamera(image) } }.ignoresSafeArea()
        }
    }
    private var actions: [AttachmentMenuAction] {
        var choices = [AttachmentMenuAction(id: "photos", title: "Photo Library", icon: .images) { choosingPhotos = true }]
        if UIImagePickerController.isSourceTypeAvailable(.camera) {
            choices.append(AttachmentMenuAction(id: "camera", title: "Take Photo", icon: .camera) { usingCamera = true })
        }
        choices.append(AttachmentMenuAction(id: "file", title: "Choose File", icon: .file) { choosingFolder = false; choosingFiles = true })
        choices.append(AttachmentMenuAction(id: "folder", title: "Choose Folder", icon: .folder) { choosingFolder = true; choosingFiles = true })
        if recall { choices.append(AttachmentMenuAction(id: "composer.recall", title: "Previous message", icon: .clockCounterClockwise) { pickMore(.recall) }) }
        for row in more where row.action != "attach" {
            choices.append(AttachmentMenuAction(id: "composer.add.\(row.action ?? row.id)", title: SuggestionSymbol.menuTitle(row), icon: SuggestionSymbol.icon(row), group: 1) { pickMore(row) })
        }
        return choices
    }
    /// Anything Photos holds: a picture (HEIC re-encoded so the agent sees it) or a video.
    private func stagePhoto(_ item: PhotosPickerItem) async {
        do {
            let file = try await PhotoLibraryPick.stage(item, into: staging)
            problem = nil
            stage(file)
        } catch {
            problem = item.supportedContentTypes.contains { $0.conforms(to: .movie) } ? "Couldn't read that video." : "Couldn't read that photo."
        }
    }
    private func stageCamera(_ image: UIImage) async {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        await staged { [staging] in try staging.stage(data: data, name: "Photo.jpg", mimeType: "image/jpeg") }
    }
    private func stageFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        await staged { [staging] in try staging.stage(copying: url, name: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream") }
    }
    private func stageFolder(_ url: URL) async {
        let result = await Task.detached(priority: .userInitiated) { [staging] in ComposerIntake.folder(url, into: staging) }.value
        problem = result.note
        for file in result.files { stage(file) }
    }
    /// Copies and hashes off the main actor; the bridge then decides whether it can go.
    private func staged(_ work: @escaping @Sendable () throws -> StagedAttachment) async {
        let file = await Task.detached(priority: .userInitiated) { try? work() }.value
        guard let file else { problem = "Couldn't read that file."; return }
        problem = nil
        stage(file)
    }
}

/// A stable native menu anchor: keyboard and composer relayouts do not replace its menu actions.
private struct AttachmentMenuAction {
    let id: String
    let title: String
    let icon: AceIcon.Name
    var group = 0
    let run: () -> Void
}

private struct AttachmentMenuButton: UIViewRepresentable {
    let identifier: String
    let actions: [AttachmentMenuAction]
    let ask: Binding<Bool>
    @Environment(\.isEnabled) private var enabled

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> Anchor {
        let button = Anchor(type: .custom)
        var appearance = UIButton.Configuration.plain()
        appearance.image = UIImage(named: "ph-plus")
        appearance.contentInsets = .zero
        button.configuration = appearance
        button.showsMenuAsPrimaryAction = true
        button.accessibilityLabel = "Add files and context"
        return button
    }
    func updateUIView(_ button: Anchor, context: Context) {
        let owner = context.coordinator
        button.tintColor = UIColor(AceTheme.Colours.foreground)
        button.isEnabled = enabled
        button.accessibilityIdentifier = identifier
        owner.actions = Dictionary(actions.map { ($0.id, $0.run) }, uniquingKeysWith: { _, last in last })
        let signature = actions.map { "\($0.group):\($0.id):\($0.title):\($0.icon.rawValue)" }
        if signature != owner.signature {
            owner.signature = signature
            let groups = [0, 1].compactMap { group -> UIMenu? in
                let rows = actions.filter { $0.group == group }.map { choice in
                    UIAction(title: choice.title, image: UIImage(named: "ph-\(choice.icon.rawValue)"), identifier: UIAction.Identifier(choice.id)) { [weak owner] _ in
                        owner?.actions[choice.id]?()
                    }
                }
                return rows.isEmpty ? nil : UIMenu(options: .displayInline, children: rows)
            }
            button.menu = UIMenu(children: groups)
        }
        if ask.wrappedValue && !owner.asked {
            owner.asked = true
            Task { @MainActor [weak button, weak owner] in
                ask.wrappedValue = false
                button?.performPrimaryAction()
                owner?.asked = false
            }
        }
    }
    static func dismantleUIView(_ button: Anchor, coordinator: Coordinator) {
        button.contextMenuInteraction?.dismissMenu()
        coordinator.actions.removeAll()
    }
    final class Anchor: UIButton {
        private var windowSize: CGSize?
        override func layoutSubviews() {
            super.layoutSubviews()
            let size = window?.bounds.size
            if let old = windowSize, let size, old != size { contextMenuInteraction?.dismissMenu() }
            windowSize = size
        }
        override func willMove(toWindow newWindow: UIWindow?) {
            if window !== newWindow { contextMenuInteraction?.dismissMenu(); windowSize = nil }
            super.willMove(toWindow: newWindow)
        }
    }
    final class Coordinator {
        var signature: [String] = []
        var actions: [String: () -> Void] = [:]
        var asked = false
    }
}

/// A file on a message: its name with upload progress, its size, or why it can't go.
struct AttachmentChip: View {
    let file: AttachmentFile
    let remove: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            AceIcon(file.state == "failed" ? .warning : file.kind == "image" ? .image : file.kind == "video" ? .playCircle : .file, size: 14, relativeTo: .footnote)
                .foregroundStyle(file.state == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.decoration)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(file.name).lineLimit(1).foregroundStyle(AceTheme.Colours.foreground)
                if file.state == "failed" { Text(file.error).lineLimit(2).foregroundStyle(AceTheme.StatusText.failed) }
                else if file.state == "uploading" { ProgressView(value: file.progress).progressViewStyle(.linear) }
                else { Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)).monospacedDigit() }
            }
            Button(action: remove) { AceIcon(.xCircle, size: 16, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.decoration) }
                .buttonStyle(.plain).accessibilityLabel("Remove \(file.name)")
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
        .background(AceTheme.Colours.fill, in: AceShape.capsule)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("composer.attachment")
    }
}

/// The camera, for a photo taken now.
private struct CameraPicker: UIViewControllerRepresentable {
    let picked: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.picked(image) }
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
