import SwiftUI

/// Settings › Tools › Skills and plugins: the person's skills grouped by where they live (the
/// chosen project's, personal, ace's own), New skill, and the installed plugins with the agents
/// each reaches. Opens on what this phone last saw, read again behind it. Each read keeps its own
/// failure, so one list failing never hides another's or reports the wrong one.
struct SkillsLibraryView: View {
    let model: ClientModel
    @AppStorage("skills.project") private var projectId = ""
    @State private var projects: [NativeProject] = []
    @State private var projectProblem: String?
    @State private var library: SkillLibrary?
    @State private var libraryProblem: String?
    @State private var plugins: [PluginAgents]
    @State private var pluginProblem: String?
    @State private var reviews: [NativePluginReview]
    @State private var components: [PluginComponentRow]
    @State private var next: Int?
    @State private var catalogProblem: String?
    @State private var catalogMoreFailed = false
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
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                QuietSection {
                    // Always in place, so the rows below never move when the projects arrive.
                    QuietSectionRow {
                        Text("Project").aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                            .foregroundStyle(AceDesign.Ink.primary)
                        Spacer(minLength: AceDesign.Space.related)
                        Picker("Project", selection: $projectId) {
                            Text("None").tag("")
                            ForEach(projects) { Text($0.name).tag($0.id) }
                        }
                        .labelsHidden().pickerStyle(.menu).tint(AceDesign.Ink.muted)
                        .accessibilityIdentifier("skills.project")
                    }
                    if model.canOperate {
                        Button { creating = true } label: {
                            QuietSectionRow {
                                Text("New skill").aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                                    .fontWeight(AceDesign.Typeface.strong).foregroundStyle(AceDesign.Ink.primary)
                            }
                        }
                        .buttonStyle(.row)
                        .accessibilityIdentifier("skills.new")
                    }
                }
                if let projectProblem {
                    QuietProblem(message: projectProblem, id: "skills.projects.problem") { Task { await readProjects() } }
                }
                skills
                PluginsSection(model: model, plugins: plugins, components: components, reviews: reviews, query: query,
                               problem: pluginProblem, catalogProblem: catalogProblem, more: next != nil,
                               install: { installing = true }, review: { review = $0 },
                               retry: { Task { await readPlugins() } },
                               loadMore: { Task { await readCatalog(more: true) } },
                               retryCatalog: { Task { await readCatalog(more: catalogMoreFailed) } })
                QuietSection {
                    NavigationLink { SkillDiscoveryView(model: model) } label: {
                        QuietSectionRow {
                            QuietRowText(title: "Available CLI skills")
                            RowCaret()
                        }
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("skills.discovery")
                }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .animation(.default, value: library)
        .animation(.default, value: plugins)
        .sensoryFeedback(.success, trigger: made)
        .searchable(text: $query, prompt: "Search skills and plugins")
        .navigationTitle("Skills and plugins").navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $opened) { route in
            SkillPageView(model: model, route: route, workspaceId: project?.id, project: project?.name)
        }
        // Keyed on the project as resolved: a remembered project only resolves once the projects
        // arrive, and the library must be read again for it then.
        .readWhenConnected(model, id: project?.id ?? "") {
            library = model.keptSkillLibrary(libraryRead) ?? library
            await read()
        }
        .task(id: model.readGeneration(libraryRead)) { await readLibrary() }
        .task(id: model.connection) { await readProjects() }
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

    /// The chosen project's skills, personal ones and ace's own: quiet headings over hairline
    /// rows, a still skeleton while the first read is on its way, then what is there.
    @ViewBuilder private var skills: some View {
        if let libraryProblem {
            QuietProblem(message: libraryProblem, id: "skills.library.problem") { Task { await readLibrary() } }
        } else if library == nil {
            SkeletonRows(count: 4, label: "Reading skills")
        }
        ForEach(groups) { group in
            QuietSection(group.title) {
                ForEach(group.rows) { row in
                    // A direct link: Settings' stack is driven by its own typed routes, so a
                    // value link of another type would never push.
                    NavigationLink {
                        SkillPageView(model: model, route: SkillRoute(id: row.id, title: row.title), workspaceId: project?.id, project: project?.name)
                    } label: {
                        QuietSectionRow {
                            SkillRowLabel(row: row)
                            RowCaret()
                        }
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("skills.row.\(row.name)")
                }
            }
        }
        if let library, libraryProblem == nil {
            if library.groups.isEmpty {
                EmptyState(icon: .sparkle, title: "No skills yet",
                           line: "Skills your agents keep appear here, whichever project you pick.")
                    .padding(.vertical, AceDesign.Space.section)
            } else if groups.isEmpty, PluginsSection.matching(plugins, components: components, query: query).isEmpty {
                EmptyState.search(query)
                    .padding(.vertical, AceDesign.Space.section)
            }
        }
    }

    private func read() async {
        guard model.connection == "ready" else { return }
        async let skills: Void = readLibrary()
        async let installed: Void = readPlugins()
        _ = await (skills, installed)
    }
    private func readProjects() async {
        guard model.connection == "ready", projects.isEmpty else { return }
        do {
            projects = try await model.allProjects()
            projectProblem = nil
        } catch { if !Task.isCancelled { projectProblem = error.localizedDescription } }
    }
    private func readLibrary() async {
        do {
            library = try await model.skillLibrary(libraryRead)
            libraryProblem = nil
        } catch { if !Task.isCancelled { libraryProblem = error.localizedDescription } }
    }
    private func readPlugins() async {
        do {
            plugins = try await model.read(Self.agentsRead, as: PluginAgentsList.self).plugins
            pluginProblem = nil
        } catch { if !Task.isCancelled { pluginProblem = error.localizedDescription } }
        do {
            reviews = try await model.pluginRead(["type": "plugins.list"], expecting: "plugins.list").reviews ?? []
        } catch { if !Task.isCancelled { pluginProblem = error.localizedDescription } }
        await readCatalog(more: false)
    }
    private func readCatalog(more: Bool) async {
        let page: [String: Any] = more ? ["type": "plugins.catalog", "offset": next ?? 0, "limit": 50] : Self.catalogRead
        do {
            let catalog = try await model.pluginRead(page, expecting: "plugins.catalog")
            components = (more ? components : []) + (catalog.components ?? []); next = catalog.nextOffset
            catalogProblem = nil
        } catch {
            guard !Task.isCancelled else { return }
            catalogProblem = error.localizedDescription
            catalogMoreFailed = more
        }
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
