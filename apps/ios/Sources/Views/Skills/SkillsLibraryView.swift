import SwiftUI

/// Settings › Skills and plugins: the CLIs' own catalog, plugins waiting for review, then each
/// installed plugin as a section of its skills with its switch and actions.
struct SkillsLibraryView: View {
    let model: ClientModel
    @State private var installs: [NativePlugin] = []
    @State private var policies: [PluginPolicy] = []
    @State private var components: [PluginComponentRow] = []
    @State private var reviews: [NativePluginReview] = []
    @State private var next: Int?
    @State private var problem: String?
    @State private var loading = false
    @State private var loaded = false
    @State private var query = ""
    @State private var installing = false
    @State private var removing: NativePlugin?
    @State private var review: PluginReviewRequest?
    var body: some View {
        List {
            Section {
                NavigationLink { SkillDiscoveryView(model: model) } label: { SettingsRow("Available CLI skills") }
                    .accessibilityIdentifier("skills.discovery")
                if model.canOperate {
                    Button { installing = true } label: {
                        SettingsRow(title: "Install plugin") { AceIcon(.plus, size: 16).foregroundStyle(AceTheme.Colours.subtleForeground) }
                    }
                    .buttonStyle(.plain)
                }
            }
            .settingsRow()
            if !reviews.isEmpty {
                Section {
                    ForEach(reviews) { pending in
                        Button { review = PluginReviewRequest(operation: ["type": "plugins.readReview", "id": pending.id]) } label: {
                            SettingsActionLabel(title: "Review \(pending.name)")
                        }
                        .buttonStyle(.plain)
                    }
                } header: { SettingsHeader("Waiting for review") }
                .settingsRow()
            }
            ForEach(installs.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { plugin in
                Section {
                    if model.canOperate {
                        let policy = policies.first { $0.name == plugin.name }
                        Toggle(isOn: Binding(get: { policy?.enabled ?? true }, set: { enabled in
                            mutate(["type": "plugins.availability", "name": plugin.name, "enabled": enabled, "providers": policy?.providers ?? ProviderLabels.ids], expecting: "plugins.availability")
                        })) { SettingsRow(title: "Enabled") { EmptyView() } }
                    }
                    ForEach(components.filter { $0.plugin == plugin.name }) { component in
                        NavigationLink { SkillSourceView(model: model, component: component) } label: { componentRow(component) }
                    }
                    if model.canOperate {
                        Button { review = PluginReviewRequest(operation: ["type": "plugins.update", "name": plugin.name]) } label: {
                            SettingsActionLabel(title: "Check for update")
                        }
                        .buttonStyle(.plain)
                        Button(role: .destructive) { removing = plugin } label: { SettingsActionLabel(title: "Remove plugin", destructive: true) }
                            .buttonStyle(.plain)
                    }
                } header: { SettingsHeader(plugin.name, note: "Version \(plugin.version)") }
                .settingsRow()
            }
            if let problem, installs.isEmpty {
                EmptyState(icon: nil, title: "Couldn't read plugins", line: problem, failed: true) {
                    Button("Try again") { Task { await read() } }
                }
                .accessibilityIdentifier("service.problem")
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if loading && !loaded && installs.isEmpty {
                Section {
                    ForEach(0..<3, id: \.self) { index in
                        SettingsSkeletonRow(title: 140, line: 220)
                            .accessibilityElement(children: .ignore).accessibilityLabel("Reading skills")
                            .accessibilityHidden(index != 0)
                    }
                }
                .settingsRow()
            } else if loaded && installs.isEmpty {
                EmptyState(icon: .package, title: "No plugins installed", line: "Install a plugin from its Git repository to add skills, commands and agents.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if next != nil || (problem != nil && !installs.isEmpty) {
                Section {
                    if next != nil {
                        Button { Task { await read(more: true) } } label: { SettingsActionLabel(title: "Show more skills") }
                            .buttonStyle(.plain).disabled(loading)
                    }
                    if let problem, !installs.isEmpty {
                        ServiceProblem(message: problem)
                        Button { Task { await read() } } label: { SettingsActionLabel(title: "Try again") }.buttonStyle(.plain)
                    }
                }
                .settingsRow()
            }
        }
        .settingsList()
        .searchable(text: $query, prompt: "Search plugins")
        .navigationTitle("Skills and plugins").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await read() } }.refreshable { await read() }
        .sheet(isPresented: $installing, onDismiss: { Task { await read() } }) { PluginInstallView(model: model) }
        .sheet(item: $review, onDismiss: { Task { await read() } }) { PluginReviewView(model: model, request: $0) }
        .confirmationDialog("Remove plugin?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove plugin", role: .destructive) { if let plugin = removing { mutate(["type": "plugins.remove", "name": plugin.name], expecting: "plugins.removed") }; removing = nil }
        } message: { Text("Its skills, commands and agents will no longer be available to new sessions.") }
    }
    /// A skill, command or agent: its title at full ink with its kind at the right, then the
    /// start of its description.
    private func componentRow(_ component: PluginComponentRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(component.title ?? component.name).aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                if !component.description.isEmpty {
                    Text(component.description).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Text(component.kind.capitalized).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
    private func mutate(_ request: [String: Any], expecting: String) {
        Task {
            do { _ = try await model.plugin(request, expecting: expecting); await read() }
            catch { problem = error.localizedDescription }
        }
    }
    private func read(more: Bool = false) async {
        guard !loading else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            if !more {
                let list = try await model.plugin(["type": "plugins.list"], expecting: "plugins.list")
                installs = list.installs ?? []; policies = list.availability ?? []; reviews = list.reviews ?? []
            }
            let catalog = try await model.plugin(["type": "plugins.catalog", "offset": more ? next ?? 0 : 0, "limit": 50], expecting: "plugins.catalog")
            components = (more ? components : []) + (catalog.components ?? []); next = catalog.nextOffset
            loaded = true
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

enum ProviderLabels {
    static let ids = ["claude", "codex", "cursor", "opencode", "antigravity", "acp", "pi"]
}

