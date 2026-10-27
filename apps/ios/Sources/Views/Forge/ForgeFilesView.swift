import SwiftUI

/// A pull request's changed files in GitHub's order, each with its line counts, how many
/// conversations are still open on it and its Viewed mark. The bar on top says which commits
/// are shown, with Change to pick one commit or two to compare. A file opens its Code view.
struct ForgeFilesView: View {
    let client: ClientModel
    let route: ForgeRoute
    let open: (ForgeRoute) -> Void
    @State private var range: ForgeRange?
    @State private var list: ForgeFilesList?
    @State private var failure: String?
    @State private var choosing = false
    private var request: [String: Any] { ClientModel.forgeFilesRead(project: route.project, number: route.number, repository: route.repository, range: range) }

    init(client: ClientModel, route: ForgeRoute, open: @escaping (ForgeRoute) -> Void) {
        self.client = client
        self.route = route
        self.open = open
        _range = State(initialValue: route.range)
        _list = State(initialValue: client.kept(ClientModel.forgeFilesRead(project: route.project, number: route.number, repository: route.repository, range: route.range), as: ForgeFilesList.self))
    }

    var body: some View {
        ScrollView {
            if let list {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    ForgeCompareBar(label: list.range?.label ?? "All commits", viewed: viewedLine(list)) { choosing = true }
                    ForEach(list.caveats, id: \.self) { caveat in
                        Text(caveat).meta().padding(.horizontal, AceTheme.Spacing.lg)
                    }
                    ForgeSection(title: nil) {
                        ForEach(Array(list.files.enumerated()), id: \.element) { index, file in row(file, index) }
                    }
                    if list.more { Text("More files on GitHub").meta().padding(.horizontal, AceTheme.Spacing.lg) }
                }
                .padding(.vertical, AceTheme.Spacing.md)
                .transition(.opacity)
            } else if let failure {
                EmptyState(icon: nil, title: "Couldn't load the files", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .animation(AceMotion.smooth, value: list)
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .navigationTitle("Files changed")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: TaskKey(range: range, generation: client.readGeneration(request))) { await load() }
        .sheet(isPresented: $choosing) {
            ForgeRangeSheet(client: client, route: route, current: range) { picked in
                withAnimation(AceMotion.smooth) { range = picked }
            }
        }
    }

    private struct TaskKey: Hashable { let range: ForgeRange?; let generation: Int }

    private func viewedLine(_ list: ForgeFilesList) -> String? {
        list.viewedCount.map { "\($0) of \(list.files.count) viewed" }
    }

    private func row(_ file: ForgeFilesList.File, _ index: Int) -> some View {
        Button {
            open(ForgeRoute(kind: .file, machineId: route.machineId, project: route.project, number: route.number, path: file.path,
                            index: index, repository: route.repository, range: range))
        } label: {
            HStack(spacing: AceTheme.Spacing.sm) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    Text(file.path).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.head)
                    if let word = ForgeViewedWord.of(file.viewed) {
                        Text(word).meta()
                            .accessibilityIdentifier("forge.files.viewed.\(index)")
                    }
                }
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
        do { list = try await client.forgeFiles(project: route.project, number: route.number, repository: route.repository, range: range); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }
}

/// A Viewed mark in words: a file pushed to since it was viewed says so; unviewed says nothing.
enum ForgeViewedWord {
    static func of(_ mark: String?) -> String? {
        switch mark {
        case "viewed": "Viewed"
        case "changed": "Changed since viewed"
        default: nil
        }
    }
}
