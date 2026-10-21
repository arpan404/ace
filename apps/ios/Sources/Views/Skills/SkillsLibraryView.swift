import SwiftUI

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
            Group {
                Section {
                    NavigationLink { SkillDiscoveryView(model: model) } label: { InsetRow("Available CLI skills", systemImage: "sparkle.magnifyingglass") }
                        .accessibilityIdentifier("skills.discovery")
                    if model.canOperate {
                        Button { installing = true } label: { InsetRow("Install plugin", systemImage: "plus") }.buttonStyle(.plain)
                    }
                    ForEach(reviews) { pending in
                        Button { review = PluginReviewRequest(operation: ["type": "plugins.readReview", "id": pending.id]) } label: {
                            InsetRow("Review \(pending.name)", systemImage: "checkmark.shield")
                        }
                        .buttonStyle(.plain)
                    }
                }
                ForEach(installs.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }) { plugin in
                    Section {
                        Text("Version \(plugin.version)").foregroundStyle(AceTheme.Colours.mutedForeground)
                        if model.canOperate {
                            let policy = policies.first { $0.name == plugin.name }
                            Toggle("Enabled", isOn: Binding(get: { policy?.enabled ?? true }, set: { enabled in
                                mutate(["type": "plugins.availability", "name": plugin.name, "enabled": enabled, "providers": policy?.providers ?? ProviderLabels.ids], expecting: "plugins.availability")
                            }))
                            Button("Check for update") { review = PluginReviewRequest(operation: ["type": "plugins.update", "name": plugin.name]) }
                            Button("Remove plugin", role: .destructive) { removing = plugin }
                        }
                        ForEach(components.filter { $0.plugin == plugin.name }) { component in
                            NavigationLink { SkillSourceView(model: model, component: component) } label: {
                                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                                    LabeledContent(component.title ?? component.name, value: component.kind.capitalized)
                                    Text(component.description).lineLimit(3).foregroundStyle(AceTheme.Colours.mutedForeground)
                                }
                            }
                        }
                    } header: { InsetHeader(plugin.name) }
                }
                if next != nil { Button("Show more skills") { Task { await read(more: true) } }.disabled(loading) }
                ServiceProblem(message: problem)
                if problem != nil { Button("Retry") { Task { await read() } } }
            }
            .insetRowBackground()
            Group {
                if loading { HStack { Spacer(); ProgressView().accessibilityLabel("Reading skills"); Spacer() } }
                if loaded && installs.isEmpty && problem == nil { ContentUnavailableView("No plugins installed", systemImage: "book", description: Text("Install a plugin from its Git repository to add skills, commands and agents.")) }
            }
            .listRowBackground(Color.clear)
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: "Search plugins")
        .navigationTitle("Skills and plugins").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await read() } }.refreshable { await read() }
        .sheet(isPresented: $installing, onDismiss: { Task { await read() } }) { PluginInstallView(model: model) }
        .sheet(item: $review, onDismiss: { Task { await read() } }) { PluginReviewView(model: model, request: $0) }
        .confirmationDialog("Remove plugin?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
            Button("Remove plugin", role: .destructive) { if let plugin = removing { mutate(["type": "plugins.remove", "name": plugin.name], expecting: "plugins.removed") }; removing = nil }
        } message: { Text("Its skills, commands and agents will no longer be available to new sessions.") }
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
