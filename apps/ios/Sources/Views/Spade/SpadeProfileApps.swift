import SwiftUI

/// Apps (ADR 0131), as web's: one row per connected app the bot may use, its account under it,
/// with Remove; then Add an app, a menu of the connected apps it doesn't have yet (no new
/// sign-in). Each change saves as it is made; a refusal says why under the list.
struct SpadeProfileApps: View {
    let client: ClientModel
    let agent: String
    let name: String
    @State private var apps: SpadeProfileAccess.Apps?
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        Section {
            if let apps {
                if apps.allowed.isEmpty { SpadeProfileNone(text: "No apps yet.") }
                ForEach(apps.allowed) { app in
                    HStack {
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            Text(app.name).aceFont(AceDesign.TextRole.rowTitle)
                            if let account = app.account {
                                Text(account).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                            }
                        }
                        Spacer(minLength: AceDesign.Space.related)
                        Button("Remove") { change(app.id, on: false) }
                            .aceFont(AceDesign.TextRole.action).buttonStyle(.borderless).disabled(saving)
                            .accessibilityLabel("Remove \(app.name) from \(name)")
                    }
                }
                if !apps.others.isEmpty {
                    Menu {
                        ForEach(apps.others) { app in Button(app.name) { change(app.id, on: true) } }
                    } label: {
                        Label("Add an app", ace: .plus)
                    }
                    .disabled(saving)
                    .accessibilityIdentifier("spade.apps.add")
                }
            } else if let problem {
                SpadeProfileNone(text: problem, failed: true)
            } else {
                ProgressView()
            }
        } header: {
            Text("Apps")
        } footer: {
            if apps != nil, let problem { Text(problem).foregroundStyle(AceTheme.StatusText.failed) }
        }
        .task(id: agent) {
            let answer = await client.spadeApps(agent)
            if answer.ok, let fresh = answer.part { apps = fresh }
            else { problem = answer.problem ?? "Couldn't read its apps." }
        }
    }

    private func change(_ app: String, on: Bool) {
        guard !saving else { return }
        saving = true
        problem = nil
        Task {
            let answer = await client.spadeApp(agent, connector: app, on: on)
            saving = false
            if answer.ok, let fresh = answer.part { apps = fresh }
            else { problem = answer.problem ?? "Couldn't change its apps." }
        }
    }
}
