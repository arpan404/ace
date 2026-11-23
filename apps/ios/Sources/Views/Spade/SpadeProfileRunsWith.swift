import SwiftUI

/// Runs with: the model and machine the bot runs with, then Models for other work (ADR 0162), a
/// fold that opens to its five roles. Each says what it spent this month and, when nothing is set
/// on this bot, that it follows Settings; it opens the model picker with Follow Settings first.
struct SpadeProfileRunsWith: View {
    let client: ClientModel
    let agent: String
    let details: SpadeProfile.Details
    @State private var open = false
    @State private var roles: SpadeProfileEdits.Roles?
    @State private var problem: String?

    var body: some View {
        Section("Runs with") {
            LabeledContent("Model", value: details.model)
            LabeledContent("Machine", value: details.machine)
            DisclosureGroup("Models for other work", isExpanded: $open) {
                if let roles {
                    ForEach(roles.roles) { role(roles, $0) }
                    if let problem { SpadeProfileNone(text: problem, failed: true) }
                } else if let problem {
                    HStack {
                        SpadeProfileNone(text: problem, failed: true)
                        Spacer(minLength: AceDesign.Space.related)
                        Button("Try again") { Task { await load() } }.aceFont(AceDesign.TextRole.meta)
                    }
                } else {
                    ProgressView()
                }
            }
            .accessibilityIdentifier("spade.profile.roles")
            .onChange(of: open) { _, now in if now && roles == nil { Task { await load() } } }
        }
    }

    private func role(_ roles: SpadeProfileEdits.Roles, _ role: SpadeProfileEdits.Role) -> some View {
        NavigationLink {
            SpadeModelChoices(setting: role.setting, groups: roles.groups, more: roles.more) { model in
                Task { await pick(role.role, model) }
            }
        } label: {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(role.title).aceFont(AceDesign.TextRole.rowTitle)
                Text(role.words).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                Text(role.follows ? "\(role.spent) · Follows Settings" : role.spent)
                    .aceFont(AceDesign.TextRole.meta).monospacedDigit().foregroundStyle(AceDesign.Ink.subtle)
            }
        }
        .accessibilityIdentifier("spade.profile.role.\(role.role)")
    }

    private func pick(_ role: String, _ model: String) async {
        let answer = await client.spadeRole(agent, role: role, model: model)
        if answer.ok, let fresh = answer.part { roles = fresh; problem = nil }
        else { problem = answer.problem ?? "Spade didn't take the change." }
    }

    private func load() async {
        let answer = await client.spadeRoles(agent)
        if answer.ok, let fresh = answer.part { roles = fresh; problem = nil }
        else { problem = answer.problem ?? "Couldn't read the models for other work." }
    }
}
