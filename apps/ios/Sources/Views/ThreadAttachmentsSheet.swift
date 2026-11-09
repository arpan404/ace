import SwiftUI
import UIKit

private struct ThreadFileVideo: Identifiable {
    let name: String
    let url: URL
    let mimeType: String
    var id: URL { url }
}

private struct ThreadFilesPage: Decodable {
    struct File: Decodable, Identifiable {
        let ref: String
        let name: String
        let size: String
        let mimeType: String
        let kind: String
        var id: String { ref }
    }
    let files: [File]
    /// Why a file asked to be removed stays (the fork being written carries it); nil otherwise.
    var refused: String? = nil
}

/// Files stored for the thread, from every message. Removing one frees its space and stops it
/// opening from older messages, so it asks first.
struct ThreadFilesSheet: View {
    let model: ClientModel
    let threadId: String
    @Environment(\.dismiss) private var dismiss
    @State private var files: [ThreadFilesPage.File]?
    @State private var problem: String?
    @State private var removing: ThreadFilesPage.File?
    @State private var busy: String?
    @State private var picture: ThreadFilesPage.File?
    @State private var video: ThreadFileVideo?
    @State private var document: URL?
    @State private var opening: String?
    @State private var openProblem: String?
    /// Why a file asked to be removed stays.
    @State private var kept: String?
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Files stored for this thread. Removing a file frees space and stops it opening from older messages.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
                if let files {
                    if files.isEmpty {
                        Text("No attachments in this thread.").foregroundStyle(AceTheme.Colours.mutedForeground)
                            .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    }
                    ForEach(files) { file in
                        HStack(spacing: AceDesign.Space.row) {
                          Button { open(file) } label: {
                           HStack(spacing: AceDesign.Space.row) {
                            AceIcon(file.kind == "image" ? .image : file.mimeType.hasPrefix("video/") ? .playCircle : .fileText, size: AceDesign.Size.barIcon).foregroundStyle(AceTheme.Colours.mutedForeground)
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                                Text(file.name).lineLimit(1).truncationMode(.middle).foregroundStyle(AceTheme.Colours.foreground)
                                Text(opening == file.ref ? "Opening…" : file.size).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                            }
                            Spacer(minLength: AceDesign.Space.related)
                           }
                           .contentShape(Rectangle())
                          }
                          .buttonStyle(.plain)
                          .disabled(opening != nil)
                          .accessibilityHint("Opens it")
                          .accessibilityIdentifier("file.open.\(file.name)")
                            if model.canOperate {
                                Button(busy == file.ref ? "Removing…" : "Remove") { removing = file }
                                    .buttonStyle(.textAction(.destructive))
                                    .disabled(busy != nil)
                                    .accessibilityLabel("Remove \(file.name)")
                            }
                        }
                        .frame(minHeight: AceDesign.Size.tap)
                        .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                    }
                } else if problem == nil {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
                if let problem {
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        Text(problem).foregroundStyle(AceTheme.Colours.mutedForeground)
                        Button("Try again") { load() }.foregroundStyle(AceTheme.Colours.foreground)
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .listRowSeparator(.hidden).listRowBackground(AceTheme.Colours.background)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationTitle("Attachments")
            .navigationBarTitleDisplayMode(.inline)
            .escapeCloses { dismiss() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }.accessibilityLabel("Close")
                }
            }
            .fullScreenCover(item: $picture) { file in
                MediaViewer(title: file.name) { await original(file) }
            }
            .fullScreenCover(item: $video) { video in
                VideoViewer(title: video.name, url: video.url, mimeType: video.mimeType)
            }
            .quickLookPreview($document)
            .alert("The file stays", isPresented: Binding(get: { kept != nil }, set: { if !$0 { kept = nil } })) {
                Button("OK") { kept = nil }
            } message: { Text(kept ?? "") }
            .alert("Couldn't open the file", isPresented: Binding(get: { openProblem != nil }, set: { if !$0 { openProblem = nil } })) {
                Button("OK") { openProblem = nil }
            } message: { Text(openProblem ?? "") }
            .alert("Remove \(removing?.name ?? "this file")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
                Button("Cancel", role: .cancel) {}
                Button("Remove", role: .destructive) { if let file = removing { load(release: file.ref) } }
            } message: {
                Text("It frees space and stops opening from older messages.")
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { load() }
    }
    /// A picture in the full-screen viewer; a video in the player; anything else in Quick Look,
    /// which shares it. Each read because the thread holds the file.
    private func open(_ file: ThreadFilesPage.File) {
        if file.kind == "image" { picture = file; return }
        opening = file.ref
        Task {
            defer { opening = nil }
            do {
                let reply = try await model.service(originalRequest(file), as: AttachmentBytes.self)
                guard let data = Data(base64Encoded: reply.data) else { throw ServiceFailure(message: "The file couldn't be decoded.") }
                let url = try MessageAttachmentRoutes.keep(data, named: reply.name)
                if file.mimeType.hasPrefix("video/") { video = ThreadFileVideo(name: file.name, url: url, mimeType: file.mimeType) }
                else { document = url }
            } catch {
                openProblem = "\(file.name) couldn't be read. Check the connection and try again."
            }
        }
    }
    private func original(_ file: ThreadFilesPage.File) async -> UIImage? {
        guard let reply = try? await model.service(originalRequest(file), as: AttachmentBytes.self) else { return nil }
        return await MediaViewer.image(base64: reply.data)
    }
    private func originalRequest(_ file: ThreadFilesPage.File) -> [String: Any] {
        ["type": "native.attachment", "threadId": threadId, "ref": file.ref, "variant": "original"]
    }
    private func load(release: String? = nil) {
        problem = nil
        busy = release
        Task {
            defer { busy = nil }
            var payload: [String: Any] = ["type": "native.threadFiles", "threadId": threadId]
            if let release { payload["release"] = release }
            do {
                let page = try await model.service(payload, as: ThreadFilesPage.self)
                files = page.files
                if let refused = page.refused { kept = refused }
            } catch { problem = error.localizedDescription }
        }
    }
}
