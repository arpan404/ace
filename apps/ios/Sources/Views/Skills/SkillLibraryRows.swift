import SwiftUI

/// One skill in the library: its title, a line of what it does, and the agents it reaches when
/// that is only one or two (the bridge sends no marks otherwise).
struct SkillRowLabel: View {
    let row: SkillRow
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(InsetStyle.label, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground)
                if !row.description.isEmpty {
                    Text(row.description).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            HStack(spacing: AceTheme.Spacing.xs) {
                ForEach(row.marks, id: \.self) { ProviderMark(provider: $0, size: 14) }
            }
            .accessibilityHidden(true)
        }
        .padding(.vertical, AceTheme.Spacing.xs)
        .contentShape(Rectangle())
    }
}

/// The rows' shape while the first read is on its way, so nothing jumps when it lands.
struct SkillRowsPlaceholder: View {
    var body: some View {
        Section {
            ForEach(0..<4, id: \.self) { index in
                SkillRowLabel(row: SkillRow(id: "\(index)", name: "", title: "A skill title", description: "What it does and when agents use it",
                                            marks: [], editable: false))
            }
        } header: { InsetHeader("Personal") }
        .insetRowBackground()
        .redacted(reason: .placeholder)
        .accessibilityLabel("Reading skills")
        .transition(.opacity)
    }
}

/// Installed plugins, each with the agents it reaches, then Install plugin and any review left
/// to finish.
struct PluginRows: View {
    let model: ClientModel
    let plugins: [PluginAgents]
    let components: [PluginComponentRow]
    let reviews: [NativePluginReview]
    let query: String
    let install: () -> Void
    let review: (PluginReviewRequest) -> Void

    private var shown: [PluginAgents] {
        query.isEmpty ? plugins : plugins.filter { plugin in
            plugin.name.localizedCaseInsensitiveContains(query)
                || components.contains { $0.plugin == plugin.name && ($0.title ?? $0.name).localizedCaseInsensitiveContains(query) }
        }
    }

    var body: some View {
        Section {
            ForEach(shown) { plugin in
                NavigationLink {
                    PluginPageView(model: model, plugin: plugin, components: components.filter { $0.plugin == plugin.name })
                } label: {
                    InsetRow(systemImage: nil, title: plugin.name, subtitle: plugin.summary) {
                        InsetValue(text: plugin.version)
                    }
                }
                .accessibilityIdentifier("plugins.row.\(plugin.name)")
            }
            ForEach(reviews) { pending in
                Button { review(PluginReviewRequest(operation: ["type": "plugins.readReview", "id": pending.id])) } label: {
                    InsetRow("Finish reviewing \(pending.name)", systemImage: "checkmark.shield")
                }
                .buttonStyle(.plain)
            }
            if model.canOperate {
                Button(action: install) { InsetRow("Install plugin", systemImage: "plus") }
                    .buttonStyle(.plain).accessibilityIdentifier("plugins.install")
            }
        } header: { InsetHeader("Plugins") }
        .insetRowBackground()
    }
}
