import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The + menu that adds photos (library or camera) and files to a message: the thread's next one
/// or New thread's first. It copies and hashes the picked bytes on the phone and hands them on;
/// every check (size, what the agent can read) is the bridge's.
struct AttachMenu<Title: View>: View {
    let stage: (StagedAttachment) -> Void
    /// Why the last pick couldn't be read; nil when it could.
    @Binding var problem: String?
    var identifier = "composer.attach"
    @ViewBuilder var title: () -> Title
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    @State private var usingCamera = false
    var body: some View {
        Menu {
            Button("Photo Library", systemImage: "photo.on.rectangle") { choosingPhotos = true }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Take Photo", systemImage: "camera") { usingCamera = true }
            }
            Button("Choose File", systemImage: "folder") { choosingFiles = true }
        } label: {
            title().frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .accessibilityLabel("Add photos or files")
        .accessibilityIdentifier(identifier)
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
        await staged { try AttachmentStaging().stage(data: data, name: name, mimeType: type.preferredMIMEType ?? "image/jpeg") }
    }
    private func stageCamera(_ image: UIImage) async {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        await staged { try AttachmentStaging().stage(data: data, name: "Photo.jpg", mimeType: "image/jpeg") }
    }
    private func stageFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        await staged { try AttachmentStaging().stage(copying: url, name: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream") }
    }
    /// Copies and hashes off the main actor; the bridge then decides whether it can go.
    private func staged(_ work: @escaping @Sendable () throws -> StagedAttachment) async {
        let file = await Task.detached(priority: .userInitiated) { try? work() }.value
        guard let file else { problem = "Couldn't read that file."; return }
        problem = nil
        stage(file)
    }
}

extension AttachMenu where Title == Image {
    /// The composer's bare + button.
    init(stage: @escaping (StagedAttachment) -> Void, problem: Binding<String?>, identifier: String = "composer.attach") {
        self.init(stage: stage, problem: problem, identifier: identifier) { Image(systemName: "plus") }
    }
}

/// A file on a message: its name with upload progress, its size, or why it can't go.
struct AttachmentChip: View {
    let file: AttachmentFile
    let remove: () -> Void
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Image(systemName: file.state == "failed" ? "exclamationmark.triangle" : file.kind == "image" ? "photo" : "doc")
                .foregroundStyle(file.state == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.decoration)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(file.name).lineLimit(1).foregroundStyle(AceTheme.Colours.foreground)
                if file.state == "failed" { Text(file.error).lineLimit(2).foregroundStyle(AceTheme.StatusText.failed) }
                else if file.state == "uploading" { ProgressView(value: file.progress).progressViewStyle(.linear) }
                else { Text(ByteCountFormatter.string(fromByteCount: Int64(file.bytes), countStyle: .file)).monospacedDigit() }
            }
            Button(action: remove) { Image(systemName: "xmark.circle.fill").foregroundStyle(AceTheme.Colours.decoration) }
                .buttonStyle(.plain).accessibilityLabel("Remove \(file.name)")
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
        .background(AceTheme.Colours.fill, in: RoundedRectangle(cornerRadius: AceTheme.Radii.button))
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
