import SwiftUI

/// The browser's project/provider catalog includes CLI-native skills as well as plugins.
struct SkillDiscoveryView: View {
    let model: ClientModel
    @State private var projects: [NativeProject] = []
    @State private var project = ""
    @State private var provider = "codex"
    @State private var entries: [CatalogReply.Entry] = []
    @State private var query = ""
    @State private var problem: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var stale = false
    private var scope: [String] { [project, provider, model.connection] }
    var body: some View {
        List {
            Group {
                Section {
                    Picker("Project", selection: $project) { ForEach(projects) { Text($0.name).tag($0.id) } }
                    Picker("Coding agent", selection: $provider) { ForEach(ProviderLabels.ids, id: \.self) { Text($0.capitalized).tag($0) } }
                }
                ForEach(entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }) { entry in
                    NavigationLink {
                        ScrollView {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                                MarkdownView(text: entry.description)
                                Text("Use this entry from a conversation's Skills and commands menu.").foregroundStyle(AceTheme.Colours.mutedForeground)
                            }.padding(AceTheme.Spacing.lg)
                        }.navigationTitle(entry.title ?? entry.name).navigationBarTitleDisplayMode(.inline)
                    } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                            LabeledContent(entry.title ?? entry.name, value: entry.kind.capitalized)
                            Text(entry.description).lineLimit(3).foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                    }.accessibilityIdentifier("skills.entry.\(entry.id)")
                }
                if loading { ProgressView("Reading CLI catalog…") }
                if stale { Text("Showing cached entries. Refresh when the machine is ready.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                ServiceProblem(message: problem)
                if problem != nil { Button("Retry") { Task { if project.isEmpty { await readProjects() }; await read() } } }
                if loaded && entries.isEmpty && problem == nil { ContentUnavailableView("No entries for this agent", systemImage: "book", description: Text("Choose another coding agent or project.")) }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "Search skills and commands")
        .navigationTitle("Available CLI skills").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await readProjects() } }
        .task(id: scope) { await read() }
        .refreshable { await read() }
    }
    private func readProjects() async {
        do {
            var after: String?
            var all: [NativeProject] = []
            for _ in 0..<10 {
                var operation: [String: Any] = ["op": "workspace.list", "limit": 100]
                if let after { operation["after"] = after }
                let reply = try await model.service(["type": "projects.request", "operation": operation], as: ProjectListReply.self)
                guard reply.result.kind == "projects" else { throw ServiceFailure(message: "This pairing needs Projects access to discover CLI skills.") }
                all += reply.result.projects ?? []
                after = reply.result.next
                if after == nil { break }
            }
            projects = all
            if !all.contains(where: { $0.id == project }) { project = all.first?.id ?? "" }
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func read() async {
        guard !project.isEmpty, model.connection == "ready" else { return }
        loading = true; loaded = false; problem = nil; entries = []
        defer { loading = false }
        do {
            let reply = try await model.service(["type": "catalog.list", "workspace": ["workspaceId": project, "provider": provider], "limit": 512], as: CatalogReply.self)
            guard !Task.isCancelled else { return }
            entries = reply.entries; stale = reply.stale; loaded = true
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}
