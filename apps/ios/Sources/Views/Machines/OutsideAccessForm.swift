import SwiftUI

/// What an outside app may do, which projects and for how long: the sections the sign-in sheet
/// and a connected app's detail share. Read is always on; the bridge words every choice.
struct OutsideAccessSections: View {
    let choices: [OutsideClientsModel.ScopeChoice]
    @Binding var scopes: Set<String>
    let projects: [ConnectedApps.Project]
    @Binding var allProjects: Bool
    @Binding var chosen: Set<String>
    let expiries: [OutsideClientsModel.Expiry]
    /// Nil keeps the current expiry (a connected app's detail before the person picks one).
    @Binding var expiry: String?
    /// Said under the expiry picker, such as when the current access ends.
    var expiryNote: String? = nil

    var body: some View {
        Section {
            ForEach(choices) { choice in
                Toggle(isOn: Binding(get: { choice.fixed || scopes.contains(choice.scope) },
                                     set: { on in if on { scopes.insert(choice.scope) } else { scopes.remove(choice.scope) } })) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(choice.label).foregroundStyle(AceDesign.Ink.primary)
                        Text(note(choice)).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .toggleStyle(.systemSwitch)
                .disabled(choice.fixed)
                .accessibilityIdentifier("outside.scope.\(choice.scope)")
            }
        } header: { InsetHeader("Access") }
        .insetRowBackground()
        Section {
            Picker("Projects", selection: $allProjects) {
                Text("All projects").tag(true)
                Text("Chosen projects").tag(false)
            }
            .accessibilityIdentifier("outside.projects")
            if !allProjects {
                if projects.isEmpty {
                    Text("No projects on this machine yet.").font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                ForEach(projects) { project in
                    Toggle(project.name, isOn: Binding(get: { chosen.contains(project.id) },
                                                       set: { on in if on { chosen.insert(project.id) } else { chosen.remove(project.id) } }))
                        .toggleStyle(.systemSwitch)
                        .accessibilityIdentifier("outside.project.\(project.id)")
                }
            }
        } header: { InsetHeader("Projects") }
        .insetRowBackground()
        Section {
            Picker("How long", selection: $expiry) {
                if expiry == nil { Text("Keep as it is").tag(String?.none) }
                ForEach(expiries) { Text($0.label).tag(Optional($0.id)) }
            }
            .accessibilityIdentifier("outside.expiry")
        } header: { InsetHeader("How long") } footer: {
            if let expiryNote { Text(expiryNote) }
        }
        .insetRowBackground()
    }

    private func note(_ choice: OutsideClientsModel.ScopeChoice) -> String {
        choice.asked == true && !choice.fixed ? "Asked for. \(choice.note)" : choice.note
    }

    /// The projects to send: every one, or the chosen ones; nil when chosen but none picked.
    static func wire(all: Bool, chosen: Set<String>) -> Any? {
        all ? "all" : (chosen.isEmpty ? nil : chosen.sorted())
    }
}
