import SwiftUI
import UniformTypeIdentifiers

/// Download a folder: pick it, see what the archive holds and leaves out, then save it to the
/// phone a chunk at a time and hand it to Share or Save to Files.
struct FolderDownloadSheet: View {
    let model: ClientModel
    let threadId: String
    /// Folders to choose from, "" for the checkout itself.
    let folders: [String]
    @State var folder: String
    @Environment(\.dismiss) private var dismiss
    @State private var includeIgnored = false
    @State private var preview: ArchivePreview?
    @State private var failure: String?
    @State private var transfer: String?
    private var download: FileDownload? { transfer.flatMap { model.files.downloads[$0] } }
    private var scope: FilesScope { .thread(threadId) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Folder", selection: $folder) {
                        ForEach(folders, id: \.self) { Text($0.isEmpty ? "Whole checkout" : $0).tag($0) }
                    }
                    .disabled(transfer != nil)
                    Toggle("Include ignored files", isOn: $includeIgnored).disabled(transfer != nil)
                } footer: {
                    if let preview { Text(preview.leavesOut) }
                }
                Section {
                    if let failure {
                        Text(failure).foregroundStyle(AceTheme.StatusText.failed)
                    } else if let preview {
                        LabeledContent(preview.name, value: preview.summary)
                    } else {
                        HStack { Text("Reading the folder"); Spacer(); ProgressView() }
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    if let download { progress(download) }
                }
            }
            .navigationTitle("Download folder").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(transfer == nil ? "Cancel" : "Close") { close() } }
                ToolbarItem(placement: .confirmationAction) {
                    if download?.phase == "saved", let path = download?.filePath {
                        ShareLink(item: URL(fileURLWithPath: path)) { Text("Save") }
                            .accessibilityIdentifier("download.share")
                    } else if transfer == nil {
                        Button("Download") { start() }.fontWeight(.semibold).disabled(preview == nil)
                            .accessibilityIdentifier("download.start")
                    }
                }
            }
            .task(id: "\(folder)|\(includeIgnored)") { await read() }
            .onChange(of: download?.phase) { _, phase in
                if phase == "saved" { UINotificationFeedbackGenerator().notificationOccurred(.success) }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(download?.phase == "saving")
    }

    @ViewBuilder private func progress(_ download: FileDownload) -> some View {
        switch download.phase {
        case "saving":
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                if let size = download.size, size > 0 { ProgressView(value: Double(download.received), total: Double(size)) }
                else { ProgressView(value: Double(download.received), total: Double(max(download.received, preview?.bytes ?? 1))) }
                HStack {
                    Text("Saving · \(ByteCountFormatter.string(fromByteCount: Int64(download.received), countStyle: .file))").monospacedDigit()
                    Spacer()
                    Button("Stop") { model.action(["type": "files.download.cancel", "id": download.id]) }
                        .foregroundStyle(AceTheme.StatusText.failed).buttonStyle(.plain)
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            }
            .accessibilityIdentifier("download.progress")
        case "saved":
            Text("Saved. Tap Save to keep it in Files or share it.").foregroundStyle(AceTheme.Colours.mutedForeground)
                .accessibilityIdentifier("download.saved")
        case "failed":
            Text(download.message ?? "Couldn't save the folder. Try again.").foregroundStyle(AceTheme.StatusText.failed)
        default:
            Text("Stopped").foregroundStyle(AceTheme.Colours.mutedForeground)
        }
    }

    private func read() async {
        preview = nil; failure = nil
        do {
            preview = try await model.files(scope, ["op": "archive", "path": folder, "includeIgnored": includeIgnored], as: ArchivePreview.self)
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }
    private func start() {
        guard let preview else { return }
        let id = "dl-\(UUID().uuidString.prefix(20))"
        transfer = id
        model.action(["type": "files.download", "id": id, "scope": scope.wire, "target": ["kind": "archive", "path": folder, "previewId": preview.previewId]])
    }
    private func close() {
        if let transfer { model.action(["type": "files.download.done", "id": transfer]) }
        dismiss()
    }
}

/// Upload: the picked files go into a folder of the checkout, one after another, asking before
/// anything already there is replaced.
struct UploadSheet: View {
    let model: ClientModel
    let threadId: String
    let folders: [String]
    @State var folder: String
    let staged: [StagedAttachment]
    @Environment(\.dismiss) private var dismiss
    @State private var batch: String?
    @State private var all = false
    private var upload: FileUpload? { batch.flatMap { model.files.uploads[$0] } }
    private var conflict: FileUpload.Item? { upload?.items.first { $0.state == "conflict" } }
    private var finished: Bool { ["done", "failed", "stopped"].contains(upload?.phase ?? "") }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Upload to", selection: $folder) {
                        ForEach(folders, id: \.self) { Text($0.isEmpty ? "Top of the checkout" : $0).tag($0) }
                    }
                    .disabled(batch != nil)
                }
                if let conflict {
                    Section {
                        Text("\(conflict.path) is already there.").fontWeight(.medium)
                        if (upload?.items.filter { $0.state == "queued" }.count ?? 0) > 0 {
                            Toggle("Do the same for the rest", isOn: $all)
                        }
                        Button("Replace") { resolve("replace") }.accessibilityIdentifier("upload.replace")
                        Button("Keep both") { resolve("keepBoth") }.accessibilityIdentifier("upload.keepBoth")
                        Button("Skip") { resolve("skip") }.accessibilityIdentifier("upload.skip")
                    }
                    .transition(.opacity)
                }
                Section {
                    ForEach(upload?.items ?? staged.map(pending)) { item in
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                            HStack {
                                Text(item.name).lineLimit(1)
                                Spacer()
                                Text(word(item)).foregroundStyle(item.state == "failed" ? AceTheme.StatusText.failed : AceTheme.Colours.mutedForeground)
                                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            }
                            if item.state == "sending" || item.state == "waiting" {
                                ProgressView(value: Double(item.sent), total: Double(max(item.size, 1)))
                            }
                            if let message = item.message, item.state == "failed" {
                                Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
                            }
                        }
                        .accessibilityIdentifier("upload.item")
                    }
                } footer: {
                    if upload?.phase == "waiting" { Text("Waiting for the connection. It carries on by itself.") }
                }
            }
            .animation(.smooth(duration: AceTheme.Motion.standard), value: upload)
            .navigationTitle(staged.count == 1 ? "Upload file" : "Upload \(staged.count) files").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if batch == nil || finished { Button(finished ? "Done" : "Cancel") { close() } }
                    else { Button("Stop", role: .destructive) { model.action(["type": "files.upload.cancel", "id": batch ?? ""]) } }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if batch == nil { Button("Upload") { start() }.fontWeight(.semibold).accessibilityIdentifier("upload.start") }
                }
            }
            .onChange(of: upload?.phase) { _, phase in
                if phase == "done" { UINotificationFeedbackGenerator().notificationOccurred(.success) }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(batch != nil && !finished)
    }

    private func pending(_ file: StagedAttachment) -> FileUpload.Item {
        FileUpload.Item(localId: file.localId, name: file.name, path: file.name, size: file.bytes, sent: 0, state: "queued", message: nil)
    }
    private func word(_ item: FileUpload.Item) -> String {
        switch item.state {
        case "queued": ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)
        case "sending": "Sending"
        case "conflict": "Already there"
        case "waiting": "Waiting"
        case "done": "Uploaded"
        case "skipped": "Skipped"
        case "failed": "Failed"
        default: "Stopped"
        }
    }
    private func start() {
        let id = "up-\(UUID().uuidString.prefix(20))"
        batch = id
        model.action(["type": "files.upload", "id": id, "threadId": threadId, "folder": folder, "files": staged.map(\.json)])
    }
    private func resolve(_ choice: String) {
        guard let batch else { return }
        model.action(["type": "files.upload.resolve", "id": batch, "choice": choice, "all": all])
    }
    private func close() {
        if let batch { model.action(["type": "files.upload.dismiss", "id": batch]) }
        for file in staged { AttachmentStaging().discard(file.localId) }
        dismiss()
    }
}
