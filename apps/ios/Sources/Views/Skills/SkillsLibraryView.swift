import SwiftUI

/// Settings › Tools › Skills and plugins: the person's skills grouped by where they live (the
/// chosen project's, personal, ace's own), New skill, and the installed plugins with the agents
/// each reaches. Opens on what this phone last saw, read again behind it.
struct SkillsLibraryView: View {
    let model: ClientModel
    @AppStorage("skills.project") private var projectId = ""
    @State private var projects: [NativeProject] = []
    @State private var library: SkillLibrary?
    @State private var plugins: [PluginAgents]
    @State private var reviews: [NativePluginReview]
    @State private var components: [PluginComponentRow]
    @State private var next: Int?
    @State private var problem: String?
    @State private var query = ""
    @State private var creating = false
    @State private var installing = false
    @State private var review: PluginReviewRequest?
    @State private var opened: SkillRoute?
    @State private var made = 0
    private static let pluginList: [String: Any] = ["type": "pluginRequest", "request": ["type": "plugins.list"]]
    private static let agentsRead: [String: Any] = ["type": "plugins.native", "op": "plugins"]
    private static let catalogRead: [String: Any] = ["type": "plugins.catalog", "offset": 0, "limit": 50]

    init(model: ClientModel) {
        self.model = model
        _plugins = State(initialValue: model.kept(Self.agentsRead, as: PluginAgentsList.self)?.plugins ?? [])
        _reviews = State(initialValue: model.keptPlugin(["type": "plugins.list"], expecting: "plugins.list")?.reviews ?? [])
        let catalog = model.keptPlugin(Self.catalogRead, expecting: "plugins.catalog")
        _components = State(initialValue: catalog?.components ?? [])
        _next = State(initialValue: catalog?.nextOffset)
    }

    private var project: NativeProject? { projects.first { $0.id == projectId } }
    private var libraryRead: [String: Any] {
        var read: [String: Any] = ["type": "skills.native", "op": "library"]
        if let project { read["workspaceId"] = project.id; read["project"] = project.name }
        return read
    }
    private var groups: [SkillGroup] {
        guard let library else { return [] }
        guard !query.isEmpty else { return library.groups }
        return library.groups.compactMap { group in
            let rows = group.rows.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }
            return rows.isEmpty ? nil : SkillGroup(id: group.id, title: group.title, rows: rows)
        }
    }

    var body: some View {
        List {
            Section {
                if !projects.isEmpty {
                    InsetRow(systemImage: "folder", title: "Project") {
                        Picker("Project", selection: $projectId) {
                            Text("None").tag("")
                            ForEach(projects) { Text($0.name).tag($0.id) }
                        }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                    }
                    .accessibilityIdentifier("skills.project")
                }
                if model.canOperate {
                    Button { creating = true } label: { InsetRow("New skill", systemImage: "plus") }
                        .buttonStyle(.plain).accessibilityIdentifier("skills.new")
                }
            }
            .insetRowBackground()
            if library == nil, problem == nil {
                SkillRowsPlaceholder()
            }
            ForEach(groups) { group in
                Section {
                    ForEach(group.rows) { row in
                        NavigationLink(value: SkillRoute(id: row.id, title: row.title)) { SkillRowLabel(row: row) }
                            .accessibilityIdentifier("skills.row.\(row.name)")
                    }
                } header: { InsetHeader(group.title) }
                .insetRowBackground()
            }
            PluginRows(model: model, plugins: plugins, components: components, reviews: reviews, query: query,
                       install: { installing = true }, review: { review = $0 })
            if next != nil {
                Button("Show more plugin skills") { Task { await readCatalog(more: true) } }.insetRowBackground()
            }
            Section {
                NavigationLink { SkillDiscoveryView(model: model) } label: { InsetRow("Available CLI skills", systemImage: "sparkle.magnifyingglass") }
                    .accessibilityIdentifier("skills.discovery")
            } footer: {
                if let problem {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                        ServiceProblem(message: problem)
                        Button("Try again") { Task { await read() } }
                    }
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth, value: library)
        .animation(.smooth, value: plugins)
        .sensoryFeedback(.success, trigger: made)
        .searchable(text: $query, prompt: "Search skills and plugins")
        .navigationTitle("Skills and plugins").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: SkillRoute.self) { route in
            SkillPageView(model: model, route: route, workspaceId: project?.id, project: project?.name)
        }
        .navigationDestination(item: $opened) { route in
            SkillPageView(model: model, route: route, workspaceId: project?.id, project: project?.name)
        }
        .readWhenConnected(model, id: projectId) {
            library = model.keptSkillLibrary(libraryRead) ?? library
            await read()
        }
        .task(id: model.readGeneration(libraryRead)) { await readLibrary() }
        .task(id: model.connection) {
            if model.connection == "ready", projects.isEmpty { projects = (try? await model.allProjects()) ?? [] }
        }
        .task(id: model.pluginGeneration(["type": "plugins.list"])) { await readPlugins() }
        .refreshable { await read() }
        .sheet(isPresented: $creating) {
            NewSkillView(model: model, project: project) { route in
                creating = false; made += 1
                Task { await readLibrary(); opened = route }
            }
        }
        .sheet(isPresented: $installing, onDismiss: { Task { await readPlugins() } }) { PluginInstallView(model: model) }
        .sheet(item: $review, onDismiss: { Task { await readPlugins() } }) { PluginReviewView(model: model, request: $0) }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        async let skills: Void = readLibrary()
        async let installed: Void = readPlugins()
        _ = await (skills, installed)
    }
    private func readLibrary() async {
        do { library = try await model.skillLibrary(libraryRead); problem = nil }
        catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func readPlugins() async {
        do {
            plugins = try await model.read(Self.agentsRead, as: PluginAgentsList.self).plugins
            reviews = try await model.pluginRead(["type": "plugins.list"], expecting: "plugins.list").reviews ?? []
            await readCatalog(more: false)
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func readCatalog(more: Bool) async {
        let page: [String: Any] = more ? ["type": "plugins.catalog", "offset": next ?? 0, "limit": 50] : Self.catalogRead
        guard let catalog = try? await model.pluginRead(page, expecting: "plugins.catalog") else { return }
        components = (more ? components : []) + (catalog.components ?? []); next = catalog.nextOffset
    }
}

/// A skill to open: its id, and its title for the bar while the page reads.
struct SkillRoute: Hashable, Identifiable {
    let id: String
    let title: String
}

enum ProviderLabels {
    static let ids = ["claude", "codex", "cursor", "opencode", "antigravity", "acp", "pi"]
}
