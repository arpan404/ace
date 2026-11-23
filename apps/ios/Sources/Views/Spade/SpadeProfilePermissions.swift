import SwiftUI

/// The profile's Permissions tab (ADR 0171, amendment 7), as web's: what the bot may reach, one
/// switch each, over the default in Settings › Spade › Security. A switch it sets itself says so
/// and offers Use default; one at the default says that. Under Computer use, one line points to
/// the apps bots never use. A Spade without Permissions says so. Each switch saves as it flips;
/// a refusal says why under it and the switch stays where Spade has it.
struct SpadeProfilePermissions: View {
    let client: ClientModel
    let agent: String
    let name: String
    @State private var permissions: SpadePermissions?
    /// Read, with nothing to show: a Spade before Permissions.
    @State private var none = false
    @State private var problem: String?
    /// The switch whose write is out.
    @State private var saving: String?
    /// Why Spade refused a switch's change, by its key.
    @State private var refused: [String: String] = [:]

    var body: some View {
        Group {
            if let permissions {
                Section {
                    ForEach(permissions.rows) { row($0) }
                } header: {
                    Text("\(name) uses the default in Settings › Spade unless you set its own.")
                        .textCase(nil)
                }
            } else if none {
                Section { SpadeProfileNone(text: "This version of Spade has no Permissions yet.") }
            } else if let problem {
                ProblemRow(problem, id: "spade.permissions.problem") { Task { await load() } }
            } else {
                SkeletonRows(count: 3).listRowInsets(EdgeInsets())
            }
        }
        .task(id: agent) { await load() }
    }

    private func row(_ row: SpadePermissions.Row) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Toggle(isOn: Binding(get: { row.on }, set: { on in change(row.key, on: on) })) {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(row.title).aceFont(AceDesign.TextRole.rowTitle)
                    Text(row.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                }
            }
            .disabled(saving != nil)
            .accessibilityIdentifier("spade.permission.\(row.key)")
            HStack(spacing: AceDesign.Space.related) {
                Text(row.own ? "Its own" : "Default").aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
                if row.own {
                    Button("Use default") { change(row.key, on: nil) }
                        .aceFont(AceDesign.TextRole.meta)
                        .buttonStyle(.borderless)
                        .disabled(saving != nil)
                        .accessibilityIdentifier("spade.permission.\(row.key).default")
                }
            }
            if let why = refused[row.key] {
                Text(why).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceTheme.StatusText.failed)
            }
            if row.key == "computer_use" && row.on {
                Text("It never uses the apps listed under Computer use in Settings › Spade.")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
            }
        }
    }

    private func change(_ key: String, on: Bool?) {
        guard saving == nil else { return }
        saving = key
        refused[key] = nil
        Task {
            let answer = await client.spadePermission(agent, key: key, on: on)
            saving = nil
            if answer.ok, let fresh = answer.part { permissions = fresh }
            else { refused[key] = answer.problem ?? "Spade didn't take the change." }
        }
    }

    private func load() async {
        let answer = await client.spadePermissions(agent)
        if answer.ok {
            permissions = answer.part
            none = answer.part == nil
            problem = nil
        } else if permissions == nil {
            problem = answer.problem ?? "Couldn't read its permissions."
        }
    }
}
