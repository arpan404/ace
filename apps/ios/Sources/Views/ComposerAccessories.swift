import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Above the composer: the files on the next message with their upload progress, a + menu that
/// adds photos (library or camera) and files, and the effort and speed chip where the thread's
/// provider takes them. Every check (size, what the agent can read, which levels exist) is the
/// bridge's; this view stages the picked bytes and draws what the bridge says.
struct ComposerAccessories: View {
    @Bindable var model: ClientModel
    let screen: ThreadScreenModel
    @State private var photos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var choosingFiles = false
    @State private var usingCamera = false
    @State private var problem: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            if !screen.attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        ForEach(screen.attachments) { file in AttachmentChip(file: file) { model.detach(file.id) } }
                    }
                }
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                Menu {
                    Button("Photo Library", systemImage: "photo.on.rectangle") { choosingPhotos = true }
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button("Take Photo", systemImage: "camera") { usingCamera = true }
                    }
                    Button("Choose File", systemImage: "folder") { choosingFiles = true }
                } label: {
                    Image(systemName: "plus").frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                }
                .accessibilityLabel("Add photos or files")
                .accessibilityIdentifier("composer.attach")
                if let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty { TuneChip(tune: tune, model: model) }
                if let notice = screen.tune?.notice, !notice.isEmpty {
                    Text(notice).lineLimit(1).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                if let problem { Text(problem).lineLimit(2).foregroundStyle(AceTheme.StatusText.failed) }
                Spacer(minLength: AceTheme.Spacing.none)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .padding(.horizontal, AceTheme.Dimensions.composerInset + AceTheme.Spacing.xs)
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
        await stage { try AttachmentStaging().stage(data: data, name: name, mimeType: type.preferredMIMEType ?? "image/jpeg") }
    }
    private func stageCamera(_ image: UIImage) async {
        guard let data = image.jpegData(compressionQuality: 0.85) else { return }
        await stage { try AttachmentStaging().stage(data: data, name: "Photo.jpg", mimeType: "image/jpeg") }
    }
    private func stageFile(_ url: URL) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)
        await stage { try AttachmentStaging().stage(copying: url, name: url.lastPathComponent, mimeType: type?.preferredMIMEType ?? "application/octet-stream") }
    }
    /// Copies and hashes off the main actor; the bridge then decides whether it can go.
    private func stage(_ work: @escaping @Sendable () throws -> StagedAttachment) async {
        let staged = await Task.detached(priority: .userInitiated) { try? work() }.value
        guard let staged else { problem = "Couldn't read that file."; return }
        problem = nil
        model.attach(staged)
    }
}

private struct AttachmentChip: View {
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

/// "High · Fast": the next message's effort and speed, with why one can't change.
private struct TuneChip: View {
    let tune: TuneRow
    let model: ClientModel
    var body: some View {
        Menu {
            if !tune.efforts.isEmpty {
                Section(tune.effortReason.isEmpty ? "Effort" : "Effort · \(tune.effortReason)") {
                    ForEach(tune.efforts) { effort in
                        Button { Task { _ = await model.setEffort(effort.id) } } label: {
                            if effort.id == tune.effort { Label(effort.label, systemImage: "checkmark") } else { Text(effort.label) }
                        }.disabled(!tune.effortReason.isEmpty)
                    }
                    if tune.canReset { Button("Model default") { Task { _ = await model.setEffort(nil) } } }
                }
            }
            if !tune.speeds.isEmpty {
                Section(tune.speedReason.isEmpty ? "Speed" : "Speed · \(tune.speedReason)") {
                    ForEach(tune.speeds) { tier in
                        Button { Task { _ = await model.setSpeed(tier.speed) } } label: {
                            if tier.speed == tune.speed { Label(tier.label, systemImage: "checkmark") } else { Text(tier.label) }
                        }.disabled(!tune.speedReason.isEmpty)
                    }
                }
            }
        } label: {
            HStack(spacing: AceTheme.Spacing.xxs) {
                Image(systemName: tune.speed == "standard" ? "gauge.with.dots.needle.33percent" : "bolt.fill")
                Text(label).lineLimit(1)
                if tune.pending { Image(systemName: "clock") }
            }
            .padding(.horizontal, AceTheme.Spacing.sm).padding(.vertical, AceTheme.Spacing.xs)
            .background(AceTheme.Colours.fill, in: Capsule())
            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
        }
        .accessibilityLabel("Effort and speed: \(label)\(tune.pending ? ", applies with your next message" : "")")
        .accessibilityIdentifier("composer.tune")
    }
    private var label: String {
        let effort = tune.efforts.first { $0.id == tune.effort }?.label
        let speed = tune.speeds.first { $0.speed == tune.speed && tune.speed != "standard" }?.label
        return [effort, speed].compactMap { $0 }.joined(separator: " · ")
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
