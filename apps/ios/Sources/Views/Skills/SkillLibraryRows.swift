import SwiftUI

/// One skill in the library: its title, a line of what it does, and the agents it reaches when
/// that is only one or two (the bridge sends no marks otherwise).
struct SkillRowLabel: View {
    let row: SkillRow
    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            QuietRowText(title: row.title, detail: row.description.isEmpty ? nil : row.description)
            ForEach(row.marks, id: \.self) { ProviderMark(provider: $0, size: AceDesign.Size.metaIcon) }
                .accessibilityHidden(true)
        }
    }
}

/// Installed plugins, each with the agents it reaches, then Install plugin and any review left
/// to finish. The plugin list and its catalog each say when they failed, with their way back.
struct PluginsSection: View {
    let model: ClientModel
    let plugins: [PluginAgents]
    let components: [PluginComponentRow]
    let reviews: [NativePluginReview]
    let query: String
    /// The plugin list's last read failed.
    let problem: String?
    /// The catalog's last read failed.
    let catalogProblem: String?
    /// The catalog has another page.
    let more: Bool
    let install: () -> Void
    let review: (PluginReviewRequest) -> Void
    let retry: () -> Void
    let loadMore: () -> Void
    let retryCatalog: () -> Void

    private var shown: [PluginAgents] { Self.matching(plugins, components: components, query: query) }
    /// The plugins a search finds: by name, or by one of their skills or commands.
    static func matching(_ plugins: [PluginAgents], components: [PluginComponentRow], query: String) -> [PluginAgents] {
        query.isEmpty ? plugins : plugins.filter { plugin in
            plugin.name.localizedCaseInsensitiveContains(query)
                || components.contains { $0.plugin == plugin.name && ($0.title ?? $0.name).localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        if let problem {
            Section { ProblemRow(problem, id: "plugins.problem", retry: retry) }
        }
        if let catalogProblem {
            Section { ProblemRow(catalogProblem, id: "plugins.catalog.problem", retry: retryCatalog) }
        }
        Section {
            ForEach(shown) { plugin in
                NavigationLink {
                    PluginPageView(model: model, plugin: plugin, components: components.filter { $0.plugin == plugin.name })
                } label: {
                    InsetRow(icon: nil, title: plugin.name, subtitle: plugin.summary) {
                        Text(plugin.version).aceFont(AceDesign.TextRole.action)
                            .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
                    }
                }
                .accessibilityIdentifier("plugins.row.\(plugin.name)")
            }
            ForEach(reviews) { pending in
                Button("Finish reviewing \(pending.name)") {
                    review(PluginReviewRequest(operation: ["type": "plugins.readReview", "id": pending.id]))
                }
                .buttonStyle(.rowActionOpening)
            }
            if more {
                Button("Show more plugin skills", action: loadMore).buttonStyle(.rowAction)
            }
            if model.canOperate {
                Button(action: install) { AddRow("Install plugin") }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("plugins.install")
            }
        } header: { InsetHeader("Plugins") }
        .insetRowBackground()
    }
}
