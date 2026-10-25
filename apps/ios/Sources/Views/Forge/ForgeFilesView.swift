import SwiftUI

/// A pull request's changed files in GitHub's order, each with its line counts and how many
/// conversations are still open on it. A file opens its Code view.
struct ForgeFilesView: View {
    let client: ClientModel
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    @State private var list: ForgeFilesList?
    @State private var failure: String?
    private var request: [String: Any] { ClientModel.forgeFilesRead(project: route.project, number: route.number) }

    init(client: ClientModel, route: ForgeRoute, open: @escaping (ForgeRoute) -> Void) {
        self.client = client
        self.route = route
        self.open = open
        _list = State(initialValue: client.kept(ClientModel.forgeFilesRead(project: route.project, number: route.number), as: ForgeFilesList.self))
    }

    var body: some View {
        ScrollView {
            if let list {
                ForgeSection(title: nil) {
                    ForEach(Array(list.files.enumerated()), id: \.element) { index, file in row(file, index) }
                }
                .padding(.vertical, AceTheme.Spacing.md)
                if list.more { Text("More files on GitHub").meta().padding(.horizontal, AceTheme.Spacing.lg) }
            } else if let failure {
                EmptyState(icon: nil, title: "Couldn't load the files", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .navigationTitle("Files changed")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: client.readGeneration(request)) { await load() }
    }

    private func row(_ file: ForgeFilesList.File, _ index: Int) -> some View {
        Button {
            open(ForgeRoute(kind: .file, machineId: route.machineId, project: route.project, number: route.number, path: file.path, index: index))
        } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(file.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.head)
                Spacer(minLength: AceTheme.Spacing.sm)
                if file.conversations > 0 {
                    HStack(spacing: AceTheme.Spacing.xxs) {
                        AceIcon(.chatCircle, size: 13, relativeTo: .footnote)
                        Text(verbatim: "\(file.conversations)").monospacedDigit()
                    }
                    .meta()
                    .accessibilityLabel(file.conversations == 1 ? "1 open conversation" : "\(file.conversations) open conversations")
                }
                ForgeDiffStat(additions: file.additions, deletions: file.deletions)
            }
            .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("forge.files.\(index)")
    }

    private func load() async {
        do { list = try await client.forgeFiles(project: route.project, number: route.number); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}
