import SwiftUI

/// Plugins (ADR 0151), as web's: one switch per plugin accepted in ace, saved as it flips, with
/// its line and what Spade doesn't use of it. A bot gets none until turned on; a plugin off in
/// ace is off for every bot and says so. With none accepted the section isn't there.
struct SpadeProfilePlugins: View {
    let client: ClientModel
    let agent: String
    @State private var page: SpadeProfileAccess.Plugins?
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        Group {
            if let page, !page.plugins.isEmpty {
                Section {
                    if page.cli { SpadeProfileNone(text: "This bot runs on a subscription, so it gets only rules.") }
                    if let note = page.problem { SpadeProfileNone(text: note) }
                    ForEach(page.plugins) { row($0) }
                } header: {
                    Text("Plugins")
                } footer: {
                    if let problem { Text(problem).foregroundStyle(AceTheme.StatusText.failed) }
                }
            }
        }
        .task(id: agent) {
            let answer = await client.spadePlugins(agent)
            if answer.ok { page = answer.part }
        }
    }

    private func row(_ plugin: SpadeProfileAccess.Plugin) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Toggle(isOn: Binding(get: { plugin.on }, set: { change(plugin.name, on: $0) })) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(plugin.name).aceFont(AceDesign.TextRole.rowTitle)
                    Text(plugin.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                }
            }
            .disabled(saving || plugin.offInAce)
            .accessibilityIdentifier("spade.plugin.\(plugin.name)")
            ForEach(plugin.notes, id: \.self) { note in
                Text(note).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
            }
        }
    }

    private func change(_ name: String, on: Bool) {
        guard !saving else { return }
        saving = true
        problem = nil
        Task {
            let answer = await client.spadePlugin(agent, name: name, on: on)
            saving = false
            if answer.ok, let fresh = answer.part { page = fresh }
            else { problem = answer.problem ?? "Couldn't change its plugins." }
        }
    }
}
