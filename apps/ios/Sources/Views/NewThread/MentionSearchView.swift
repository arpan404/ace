import SwiftUI

/// Files in the chosen project to `@`-mention, searched on the computer before the thread exists.
/// A page of quiet rows over hairlines, each path in mono; a search that failed says so and can be
/// asked again.
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
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                switch result?.state {
                case "ready":
                    if result?.paths.isEmpty == true {
                        EmptyState.search(query)
                    } else {
                        QuietSection("Files") {
                            ForEach(result?.paths ?? [], id: \.self) { path in
                                Button { choose(path) } label: { FilePathRow(path: path) }
                                    .buttonStyle(.row)
                                    .accessibilityIdentifier("mention.\(path)")
                            }
                        }
                    }
                case "failed":
                    QuietProblemRow(title: "Couldn't search files.", detail: "Check the connection and try again.",
                                    action: "Try again", identifier: "mention.retry") { search(query) }
                default:
                    SkeletonRows(count: 3, label: "Searching files")
                }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .searchable(text: $query, prompt: "Search files")
        .navigationTitle("Mention a file").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
            guard !Task.isCancelled else { return }
            search(query)
        }
    }
}

/// A file as lists show it: its name over the folder it sits in, both in SF Mono.
struct FilePathRow: View {
    let path: String
    var folder: Bool = false
    var body: some View {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        QuietSectionRow {
            AceIcon(folder ? .folder : .file, size: AceDesign.Size.icon, relativeTo: .subheadline)
                .foregroundStyle(AceDesign.Ink.subtle)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(verbatim: String(parts.last ?? Substring(path)))
                    .aceMonospace(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                if parts.count > 1 {
                    Text(verbatim: parts.dropLast().joined(separator: "/"))
                        .aceMonospace(AceDesign.TextRole.branch, relativeTo: .caption)
                        .foregroundStyle(AceDesign.Ink.muted).lineLimit(1).truncationMode(.head)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}
