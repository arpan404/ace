import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The + menu, "Add files and context": photos (library or camera) and files for the message (the
/// thread's next one or New thread's first), then the catalog's other builtins the phone can run
/// (`more`: files to mention, plan mode, the model, ...). It copies and hashes the picked bytes on
/// the phone and hands them on; every check (size, what the agent can read) is the bridge's.
struct AttachMenu<Title: View>: View {
    let stage: (StagedAttachment) -> Void
    /// Why the last pick couldn't be read; nil when it could.
    @Binding var problem: String?
    var identifier = "composer.attach"
    /// Where picked bytes are copied: the temporary folder, or New thread's draft folder.
    var staging = AttachmentStaging()
    /// The + list's builtins besides attaching, and what picking one does.
    var more: [SuggestionRow] = []
    var pickMore: (SuggestionRow) -> Void = { _ in }
    /// Set from elsewhere ("Attach files" picked from the `/` list): offers the same three sources.
    var ask: Binding<Bool> = .constant(false)
    @ViewBuilder var title: () -> Title
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    @State private var usingCamera = false
    var body: some View {
        Menu {
            Button("Photo Library", ace: .images) { choosingPhotos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", ace: .camera) { usingCamera = true }
            }
            Button("Choose File", ace: .folder) { choosingFiles = true }
            ComposerAddRows(rows: more, pick: pickMore)
        } label: {
            title().frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .accessibilityLabel("Add files and context")
        .accessibilityIdentifier(identifier)
        .confirmationDialog("Attach files", isPresented: ask, titleVisibility: .hidden) {
            Button("Photo Library") { choosingPhotos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) { Button("Take Photo") { usingCamera = true } }
            Button("Choose File") { choosingFiles = true }
        }
        .photosPicker(isPresented: $choosingPhotos, selection: $photos, maxSelectionCount: 8, matching: .images)
        .onChange(of: photos) { _, picked in
            guard !picked.isEmpty else { return }
            photos = []
            for item in picked { Task { await stagePhoto(item) } }
        }
        .fileImporter(isPresented: $choosingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { Task { await stageFile(url) } }
        }
        .fullScreenCover(isPresented: $usingCamera) {
            CameraPicker { image in Task { await stageCamera(image) } }.ignoresSafeArea()
        }
    }
    private func stagePhoto(_ item: PhotosPickerItem) async {
        let type = item.supportedContentTypes.first { $0.conforms(to: .image) } ?? .jpeg
        guard let data = try? await item.loadTransferable(type: Data.self) else { problem = "Couldn't read that photo."; return }
        let name = "Photo.\(type.preferredFilenameExtension ?? "jpg")"
        await staged { [staging] in try staging.stage(data: data, name: name, mimeType: type.preferredMIMEType ?? "image/jpeg") }
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
    /// Copies and hashes off the main actor; the bridge then decides whether it can go.
    private func staged(_ work: @escaping @Sendable () throws -> StagedAttachment) async {
        let file = await Task.detached(priority: .userInitiated) { try? work() }.value
        guard let file else { problem = "Couldn't read that file."; return }
        problem = nil
        stage(file)
    }
}

extension AttachMenu where Title == AceIcon {
    /// The composer's bare + button.
    init(stage: @escaping (StagedAttachment) -> Void, problem: Binding<String?>, identifier: String = "composer.attach",
         more: [SuggestionRow] = [], pickMore: @escaping (SuggestionRow) -> Void = { _ in }, ask: Binding<Bool> = .constant(false)) {
        self.init(stage: stage, problem: problem, identifier: identifier, more: more, pickMore: pickMore, ask: ask) { AceIcon(.plus, size: 20) }
    }
}

/// A file on a message: its name with upload progress, its size, or why it can't go.
struct AttachmentChip: View {
    let file: AttachmentFile
    let remove: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            AceIcon(file.state == "failed" ? .warning : file.kind == "image" ? .image : .file, size: 14, relativeTo: .footnote)
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
