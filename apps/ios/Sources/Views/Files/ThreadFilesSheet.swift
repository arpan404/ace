import SwiftUI

private enum FilesRoute: Hashable { case folder(String), file(String) }

/// The thread's checkout, read-only (`bridge/project-files.ts`): a folder at a time within the
/// bridge's row cap, search on the computer, and a size-capped preview. "Mention" puts the file
/// into the thread's composer as `@path`, as the web's mention menu does.
struct ThreadFilesSheet: View {
    let model: ClientModel
    let threadId: String
    /// Nil on a view-only machine: nothing to send, so no mention.
    let mention: ((String) -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var path: [FilesRoute] = []
    @State private var query = ""
    private var files: ThreadFilesModel { model.files }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if query.isEmpty { FolderList(files: files, folder: "", open: { path.append($0) }) }
                else { searchResults }
            }
            .searchable(text: $query, prompt: "Search files")
            .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: FilesRoute.self) { route in
                switch route {
                case .folder(let folder):
                    FolderList(files: files, folder: folder, open: { path.append($0) })
                        .navigationTitle(String(folder.dropLast().split(separator: "/").last ?? "Files"))
                        .onAppear { model.filesAction(["kind": "folder", "path": folder]) }
                case .file(let file):
                    FilePreviewView(files: files, path: file, mention: mention.map { insert in { insert(file); dismiss() } })
                        .onAppear { model.filesAction(["kind": "preview", "path": file]) }
                }
            }
        }
        .task { model.filesAction(["kind": "open", "threadId": threadId]) }
        .task(id: query) {
            guard !query.isEmpty else { return }
            try? await Task.sleep(for: .milliseconds(200))
            guard !Task.isCancelled else { return }
            model.filesAction(["kind": "search", "query": query])
        }
        .onDisappear { model.filesAction(["kind": "close"]); model.files.reset() }
    }
    @ViewBuilder private var searchResults: some View {
        let result = files.search.flatMap { $0.query == query ? $0 : nil }
        List {
            switch result?.state {
            case "ready":
                if result?.paths.isEmpty == true { ContentUnavailableView.search(text: query) }
                ForEach(result?.paths ?? [], id: \.self) { file in
                    Button { path.append(.file(file)) } label: { FilePathRow(path: file) }.buttonStyle(.plain)
                }
            case "failed": ContentUnavailableView("Couldn't search files", systemImage: "wifi.exclamationmark")
            default: HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            }
        }
    }

    fileprivate struct FolderList: View {
        let files: ThreadFilesModel
        let folder: String
        let open: (FilesRoute) -> Void
        var body: some View {
            let listing = files.listings[folder]
            List {
                switch listing?.state {
                case "ready":
                    if listing?.rows.isEmpty == true { ContentUnavailableView("Empty folder", systemImage: "folder") }
                    ForEach(listing?.rows ?? []) { row in
                        Button { open(row.folder ? .folder(row.path) : .file(row.path)) } label: {
                            HStack {
                                Image(systemName: row.folder ? "folder" : "doc.text").foregroundStyle(AceTheme.Colours.decoration)
                                Text(row.name).aceMonospace(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                                Spacer(minLength: AceTheme.Spacing.none)
                                if row.folder { Image(systemName: "chevron.right").foregroundStyle(AceTheme.Colours.decoration) }
                            }
                            .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("file.\(row.path)")
                    }
                    if let listing, listing.hidden > 0 || (folder.isEmpty && listing.truncated) {
                        Text(listing.hidden > 0 ? "\(listing.hidden) more here. Search to find them, or view this folder on your computer." : "Large checkout: only part of it is listed. Search finds the rest.")
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                            .accessibilityIdentifier("files.more")
                    }
                case "failed": ContentUnavailableView("Couldn't read the files", systemImage: "wifi.exclamationmark", description: Text("Check the connection and open Files again."))
                case "missing": ContentUnavailableView("Folder not listed", systemImage: "folder", description: Text("View it on your computer."))
                default: HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
                }
            }
        }
    }
}

/// A file's start, read-only in SF Mono, with where to see the rest.
struct FilePreviewView: View {
    let files: ThreadFilesModel
    let path: String
    let mention: (() -> Void)?
    var body: some View {
        let shown = files.preview.flatMap { $0.path == path ? $0 : nil }
        Group {
            switch shown?.state {
            case "ready" where shown?.binary == true:
                ContentUnavailableView("Not a text file", systemImage: "doc", description: Text("View it on your computer."))
            case "ready":
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
                        Text(verbatim: shown?.text ?? "").aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled).fixedSize(horizontal: true, vertical: false)
                            .accessibilityIdentifier("preview.text")
                        if shown?.truncated == true {
                            Label("Showing the start of this file. View the rest on your computer.", systemImage: "desktopcomputer")
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                                .accessibilityIdentifier("preview.truncated")
                        }
                    }
                    .padding(AceTheme.Spacing.lg)
                }
            case "failed": ContentUnavailableView("Couldn't read this file", systemImage: "wifi.exclamationmark")
            default: ProgressView()
            }
        }
        .background(AceTheme.Colours.background)
        .navigationTitle(String(path.split(separator: "/").last ?? Substring(path))).navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let mention {
                ToolbarItem(placement: .bottomBar) {
                    Button(action: mention) { Label("Mention in message", systemImage: "at") }.accessibilityIdentifier("preview.mention")
                }
            }
        }
    }
}
