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
    private var matches: [CatalogReply.Entry] {
        entries.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        List {
            Section {
                SettingsRow(title: "Project") {
                    Picker("Project", selection: $project) { ForEach(projects) { Text($0.name).tag($0.id) } }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
                SettingsRow(title: "Coding agent") {
                    Picker("Coding agent", selection: $provider) { ForEach(ProviderLabels.ids, id: \.self) { Text($0.capitalized).tag($0) } }
                        .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
                }
            }
            .settingsRow()
            if !entries.isEmpty {
                Section {
                    if matches.isEmpty {
                        Text("No entries match").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    ForEach(matches) { entry in
                        NavigationLink { detail(entry) } label: { entryRow(entry) }
                            .accessibilityIdentifier("skills.entry.\(entry.id)")
                    }
                } header: {
                    SettingsHeader("Skills and commands", note: stale ? "Showing cached entries. Refresh when the machine is ready." : nil)
                }
                .settingsRow()
            }
            if let problem {
                EmptyState(icon: nil, title: "Couldn't read the CLI catalog", line: problem, failed: true) {
                    Button("Try again") { Task { if project.isEmpty { await readProjects() }; await read() } }
                }
                .accessibilityIdentifier("service.problem")
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if loading {
                Section {
                    ForEach(0..<4, id: \.self) { index in
                        SettingsSkeletonRow(title: 140, line: 220)
                            .accessibilityElement(children: .ignore).accessibilityLabel("Reading CLI catalog")
                            .accessibilityHidden(index != 0)
                    }
                }
                .settingsRow()
            } else if loaded && entries.isEmpty {
                EmptyState(icon: .bookOpen, title: "No entries for this agent", line: "Choose another coding agent or project.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .settingsList()
        .searchable(text: $query, prompt: "Search skills and commands")
        .navigationTitle("Available CLI skills").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await readProjects() } }
        .task(id: scope) { await read() }
        .refreshable { await read() }
    }
    /// A skill or command: its title at full ink with its kind at the right, then the start of
    /// its description.
    private func entryRow(_ entry: CatalogReply.Entry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(entry.title ?? entry.name).aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if !entry.description.isEmpty {
                    Text(entry.description).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Text(entry.kind.capitalized).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private func detail(_ entry: CatalogReply.Entry) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                MarkdownView(text: entry.description)
                Text("Use this entry from a conversation's Skills and commands menu.")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, SettingsStyle.margin).padding(.vertical, AceTheme.Spacing.lg)
        }
        .background(AceTheme.Colours.background)
        .navigationTitle(entry.title ?? entry.name).navigationBarTitleDisplayMode(.inline)
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

