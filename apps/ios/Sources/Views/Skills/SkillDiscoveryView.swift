import SwiftUI

/// The browser's project/provider catalog includes CLI-native skills as well as plugins: choose
/// the project and the coding agent, then open an entry to read what it does.
struct SkillDiscoveryView: View {
    let model: ClientModel
    @State private var projects: [NativeProject] = []
    @State private var project = ""
    @State private var provider = "codex"
    @State private var entries: [CatalogReply.Entry] = []
    @State private var query = ""
    /// Each read keeps its own failure: the projects read succeeding never erases the catalog's.
    @State private var projectsProblem: String?
    @State private var catalogProblem: String?
    private var problem: String? { projectsProblem ?? catalogProblem }
    @State private var loading = false
    @State private var loaded = false
    @State private var notice: String?
    private var scope: [String] { [project, provider, model.connection] }
    private var shown: [CatalogReply.Entry] {
        entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        List {
            Section {
                Picker("Project", selection: $project) { ForEach(projects) { Text($0.name).tag($0.id) } }
                    .pickerStyle(.menu)
                Picker("Coding agent", selection: $provider) { ForEach(ProviderLabels.ids, id: \.self) { Text($0.capitalized).tag($0) } }
                    .pickerStyle(.menu)
            }
            .insetRowBackground()
            if let problem {
                Section {
                    ProblemRow(problem, id: "skills.discovery.problem") { Task { if project.isEmpty { await readProjects() }; await read() } }
                }
            }
            if loading {
                Section { SkeletonRows(count: 3, label: "Reading CLI catalog").listRowInsets(EdgeInsets()) }
                    .listRowBackground(Color.clear)
            }
            if !shown.isEmpty || notice != nil {
                Section {
                    ForEach(shown) { entry in
                        NavigationLink { CatalogEntryPage(entry: entry) } label: {
                            InsetRow(systemImage: nil, title: entry.title ?? entry.name, subtitle: entry.description) {
                                Text(entry.kind.capitalized).aceFont(AceDesign.TextRole.action)
                                    .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
                            }
                        }
                        .accessibilityIdentifier("skills.entry.\(entry.id)")
                    }
                } footer: { if let notice { Text(notice) } }
                .insetRowBackground()
            }
            if loaded && entries.isEmpty && problem == nil {
                Section {
                    EmptyState(systemImage: "book", title: "No entries for this agent", line: "Choose another coding agent or project.")
                        .padding(.vertical, AceDesign.Space.group)
                }
                .listRowBackground(Color.clear)
            }
        }
        .insetGroupedList()
        .searchBarEdge()
        .searchable(text: $query, prompt: "Search skills and commands")
        .navigationTitle("Available CLI skills").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await readProjects() } }
        .task(id: scope) { await read() }
        .refreshable { await read() }
    }
    private func readProjects() async {
        do {
            let all = try await model.allProjects()
            projects = all
            projectsProblem = nil
            if !all.contains(where: { $0.id == project }) { project = all.first?.id ?? "" }
        } catch { if !Task.isCancelled { projectsProblem = error.localizedDescription } }
    }
    private func read() async {
        guard !project.isEmpty, model.connection == "ready" else { return }
        loading = true; loaded = false; catalogProblem = nil; entries = []; notice = nil
        defer { loading = false }
        do {
            try await model.catalogPage(["workspace": ["workspaceId": project, "provider": provider]]) { reply in
                guard !Task.isCancelled else { return }
                entries = reply.entries; notice = reply.notice; loaded = true; loading = false
            }
        } catch { if !Task.isCancelled { notice = nil; catalogProblem = error.localizedDescription } }
    }
}

/// One catalog entry's description, and where it is used.
private struct CatalogEntryPage: View {
    let entry: CatalogReply.Entry
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.row) {
                AceMarkdown(text: entry.description)
                Text("Use it from a conversation's Skills and commands menu.")
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.top, AceDesign.Space.related)
        }
        .background(AceDesign.Surface.background)
        .barEdge()
        .navigationTitle(entry.title ?? entry.name).navigationBarTitleDisplayMode(.inline)
    }
}
