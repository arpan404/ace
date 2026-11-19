import SwiftUI

/// An installed plugin: on or off, which coding agents load what it ships (for the whole
/// plugin), what it ships, and updating or removing it. A switch shows its new state at once;
/// the machine's answer settles it once every change in flight has landed.
struct PluginPageView: View {
    let model: ClientModel
    let components: [PluginComponentRow]
    @State private var plugin: PluginAgents
    @State private var pending = 0
    @State private var problem: String?
    @State private var toggled = 0
    @State private var removing = false
    @State private var review: PluginReviewRequest?
    @Environment(\.dismiss) private var dismiss

    init(model: ClientModel, plugin: PluginAgents, components: [PluginComponentRow]) {
        self.model = model
        self.components = components
        _plugin = State(initialValue: plugin)
    }

    var body: some View {
        List {
            if let problem {
                Section { ProblemRow(problem, id: "plugin.problem") }
            }
            Section {
                Toggle(isOn: Binding(get: { plugin.enabled }, set: { switchPlugin($0) })) {
                    QuietRowText(title: "Enabled", detail: plugin.summary)
                }
                .disabled(!model.canOperate)
                .accessibilityIdentifier("plugin.enabled")
                InsetRow("Version", systemImage: nil, value: plugin.version)
                if let source = plugin.source { QuietRowText(title: "Source", detail: source) }
            }
            .insetRowBackground()
            Section {
                ForEach(plugin.agents) { agent in
                    Toggle(isOn: Binding(get: { agent.on }, set: { setAgent(agent.id, on: $0) })) {
                        HStack(spacing: AceDesign.Space.related) {
                            ProviderMark(provider: agent.id, size: AceDesign.Size.barIcon)
                            Text(agent.name).aceFont(AceDesign.TextRole.rowTitle)
                                .foregroundStyle(AceDesign.Ink.primary)
                        }
                    }
                    .disabled(!model.canOperate)
                    .opacity(plugin.enabled ? 1 : AceDesign.Ink.dimmedOpacity)
                    .accessibilityIdentifier("plugin.agent.\(agent.id)")
                }
            } header: { InsetHeader("Agents") } footer: {
                Text(plugin.enabled ? "Each agent switched on can load everything \(plugin.name) ships." : "Off: no agent loads it until it's enabled again.")
            }
            .insetRowBackground()
            if !components.isEmpty {
                Section {
                    ForEach(components) { component in
                        NavigationLink { SkillSourceView(model: model, component: component) } label: {
                            InsetRow(systemImage: nil, title: component.title ?? component.name, subtitle: component.description) {
                                Text(component.enabled && !component.providers.isEmpty ? component.kind.capitalized : "Off")
                                    .aceFont(AceDesign.TextRole.action)
                                    .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
                            }
                        }
                    }
                } header: { InsetHeader("What it ships") }
                .insetRowBackground()
            }
            if model.canOperate {
                Section {
                    Button("Check for update") { review = PluginReviewRequest(operation: ["type": "plugins.update", "name": plugin.name]) }
                        .buttonStyle(.rowActionOpening)
                    Button("Remove plugin", role: .destructive) { removing = true }
                        .buttonStyle(.rowAction)
                        .accessibilityIdentifier("plugin.remove")
                }
                .insetRowBackground()
            }
        }
        .insetGroupedList()
        .animation(.default, value: plugin)
        .animation(.default, value: problem)
        .sensoryFeedback(.selection, trigger: toggled)
        .navigationTitle(plugin.name).navigationBarTitleDisplayMode(.inline)
        .sheet(item: $review) { PluginReviewView(model: model, request: $0) }
        .confirmationDialog("Remove \(plugin.name)?", isPresented: $removing, titleVisibility: .visible) {
            Button("Remove plugin", role: .destructive) { remove() }
        } message: { Text("Its skills, commands and agents will no longer be available to new sessions.") }
    }

    private func switchPlugin(_ enabled: Bool) {
        change(["op": "switch", "name": plugin.name, "enabled": enabled]) {
            PluginAgents(name: $0.name, version: $0.version, source: $0.source, on: $0.on, enabled: enabled, summary: $0.summary, agents: $0.agents)
        }
    }
    private func setAgent(_ id: String, on: Bool) {
        change(["op": "agent", "name": plugin.name, "provider": id, "on": on]) {
            PluginAgents(name: $0.name, version: $0.version, source: $0.source, on: $0.on, enabled: $0.enabled, summary: $0.summary,
                         agents: $0.agents.map { $0.id == id ? .init(id: $0.id, name: $0.name, on: on) : $0 })
        }
    }
    /// Shows `guess` at once, sends the change, and takes the machine's answer once nothing else
    /// is on its way; a refusal reads the plugin again so the switches show what is true.
    private func change(_ operation: [String: Any], guess: (PluginAgents) -> PluginAgents) {
        plugin = guess(plugin); toggled += 1; pending += 1; problem = nil
        Task {
            defer { pending -= 1 }
            do {
                let reply = try await model.pluginAgents(operation, as: PluginAgentsChanged.self)
                if pending == 1 { plugin = reply.plugin }
            } catch {
                problem = error.localizedDescription
                if let fresh = try? await model.pluginAgents(["op": "plugins"], as: PluginAgentsList.self).plugins.first(where: { $0.name == plugin.name }) {
                    plugin = fresh
                }
            }
        }
    }
    private func remove() {
        Task {
            do {
                _ = try await model.plugin(["type": "plugins.remove", "name": plugin.name], expecting: "plugins.removed")
                toggled += 1
                dismiss()
            } catch { problem = error.localizedDescription }
        }
    }
}
