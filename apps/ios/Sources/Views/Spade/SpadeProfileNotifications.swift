import SwiftUI

/// Notifications, a section of Details (ADR 0195), as web's: whether this bot reaches the person
/// outside Spade, and, while it does, whether its approvals and questions wait through quiet
/// hours. On follows Spade's own settings; a refusal keeps what Spade has and says why.
struct SpadeProfileNotifications: View {
    let client: ClientModel
    let agent: String
    @Binding var reach: SpadeProfileEdits.Reach
    @State private var saving = false
    @State private var problem: String?

    private static let approvals = [("inherit", "As in Settings"), ("notify", "Notify me"),
                                    ("wait", "Wait for the morning brief")]

    var body: some View {
        Section {
            Toggle("Notify me", isOn: Binding(get: { reach.notify }, set: { on in save(notify: on) }))
                .disabled(saving)
                .accessibilityIdentifier("spade.reach.notify")
            if reach.notify {
                Picker("During quiet hours, approvals and questions",
                       selection: Binding(get: { reach.approvals }, set: { save(approvals: $0) })) {
                    ForEach(Self.approvals, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.menu)
                .disabled(saving)
                .accessibilityIdentifier("spade.reach.approvals")
            }
        } header: {
            Text("Notifications")
        } footer: {
            if let problem { Text(problem).foregroundStyle(AceTheme.StatusText.failed) }
        }
    }

    private func save(notify: Bool? = nil, approvals: String? = nil) {
        guard !saving else { return }
        saving = true
        problem = nil
        Task {
            let answer = await client.spadeReach(agent, notify: notify, approvals: approvals)
            saving = false
            if answer.ok, let stored = answer.part { reach = stored }
            else { problem = answer.problem ?? "Spade didn't take the change." }
        }
    }
}
