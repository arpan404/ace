import SwiftUI

/// Files in the chosen project to `@`-mention, searched on the computer before the thread exists.
struct MentionSearchView: View {
    @Bindable var compose: ComposeModel
    let workspaceId: String
    let search: (String) -> Void
    let choose: (String) -> Void
    @State private var query = ""
    private var result: (workspaceId: String, query: String, state: String, paths: [String])? {
        compose.mentions.flatMap { $0.workspaceId == workspaceId && $0.query == query ? $0 : nil }
    }
    var body: some View {
        List {
            switch result?.state {
            case "ready":
                if result?.paths.isEmpty == true { ContentUnavailableView.search(text: query) }
                ForEach(result?.paths ?? [], id: \.self) { path in
                    Button { choose(path) } label: { FilePathRow(path: path) }
                        .buttonStyle(.plain).accessibilityIdentifier("mention.\(path)")
                }
            case "failed":
                ContentUnavailableView("Couldn't search files", systemImage: "wifi.exclamationmark", description: Text("Check the connection and try again."))
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowSeparator(.hidden)
            }
        }
        .searchable(text: $query, prompt: "Search files")
        .navigationTitle("Mention a file").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            search(query)
        }
    }
}

/// A file as lists show it: its name, then the folder it sits in, in SF Mono.
struct FilePathRow: View {
    let path: String
    var folder: Bool = false
    var body: some View {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        HStack(spacing: AceTheme.Spacing.md) {
            Image(systemName: folder ? "folder" : "doc.text").foregroundStyle(AceTheme.Colours.decoration)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(String(parts.last ?? Substring(path))).aceMonospace(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if parts.count > 1 {
                    Text(parts.dropLast().joined(separator: "/")).aceMonospace(AceTheme.Typography.caption, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.head)
                }
            }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .frame(minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
    }
}
