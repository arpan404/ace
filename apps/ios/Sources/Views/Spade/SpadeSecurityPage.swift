import SwiftUI

/// Settings › Spade › Security (web's, in its order): whether this machine seals commands off,
/// once, as the page's first line; the Permissions every bot follows unless it sets its own, with
/// the apps bots never use under Computer use; then how bots decide. Each control saves as it
/// changes; a refusal says why at the top in Spade's words. Turning Full access on asks first.
struct SpadeSecurityPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad
    @State private var asking: SpadeSettings.Confirm?
    @State private var adding = ""

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .security))
    }

    var body: some View {
        SpadeSettingsPageFrame(client: client, load: load) { answer in
            if let security = answer.security { rows(security) }
        }
        .confirmationDialog(asking?.title ?? "", isPresented: askingShown, titleVisibility: .visible,
                            presenting: asking) { confirm in
            Button(confirm.button) { load.change { await client.spadeSettingsAutonomy("full_access") } }
                .accessibilityIdentifier("spade.security.fullAccess.confirm")
            Button("Cancel", role: .cancel) {}
        } message: { confirm in
            Text(confirm.message)
        }
    }

    private var askingShown: Binding<Bool> {
        Binding(get: { asking != nil }, set: { if !$0 { asking = nil } })
    }

    @ViewBuilder private func rows(_ security: SpadeSettings.Security) -> some View {
        Section {
            Text(security.line)
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.muted)
                .accessibilityIdentifier("spade.security.line")
        }
        .insetRowBackground()
        if let permissions = security.permissions {
            Section {
                SpadePermissionRows(permissions: permissions, busy: load.busy, save: { key, on in
                    guard let on else { return }
                    load.change { await client.spadeSettingsPermission(key, on: on) }
                }) { key in
                    if key == "computer_use", let apps = security.neverApps { neverApps(apps) }
                }
            } header: {
                InsetHeader("Permissions")
            }
            .insetRowBackground()
        }
        Section {
            autonomy(security.autonomy)
        } header: {
            InsetHeader("Bots")
        } footer: {
            if let words = security.autonomy.fullAccess { Text(words) }
        }
        .insetRowBackground()
    }

    /// The apps bots never use, folded behind their count: each with Remove, and a name to add.
    private func neverApps(_ apps: [String]) -> some View {
        DisclosureGroup {
            Text("Bots never use these apps, even with Computer use on.")
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.muted)
            ForEach(apps, id: \.self) { app in
                HStack {
                    Text(app).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    Spacer()
                    Button("Remove") { save(apps.filter { $0 != app }) }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Remove \(app)")
                }
                .disabled(load.busy)
            }
            HStack {
                TextField("App name", text: $adding)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit { add(to: apps) }
                    .accessibilityIdentifier("spade.security.neverApps.field")
                Button("Add") { add(to: apps) }
                    .buttonStyle(.borderless)
                    .disabled(load.busy || trimmed.isEmpty)
                    .accessibilityIdentifier("spade.security.neverApps.add")
            }
        } label: {
            Text("Never let bots use · \(apps.count) \(apps.count == 1 ? "app" : "apps")")
                .aceFont(AceDesign.TextRole.rowTitle)
                .foregroundStyle(AceDesign.Ink.primary)
        }
        .accessibilityIdentifier("spade.security.neverApps")
    }

    private var trimmed: String { adding.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func add(to apps: [String]) {
        let app = trimmed
        guard !app.isEmpty, !load.busy else { return }
        Task {
            let answer = await load.awaiting { await client.spadeSettingsNeverApps(apps + [app]) }
            if answer.ok { adding = "" }
        }
    }

    private func save(_ apps: [String]) {
        load.change { await client.spadeSettingsNeverApps(apps) }
    }

    /// How bots decide; Full access asks first, Auto-review saves at once.
    private func autonomy(_ autonomy: SpadeSettings.Autonomy) -> some View {
        let chosen = autonomy.choices.first { $0.value == autonomy.value }?.label
        return Menu {
            ForEach(autonomy.choices, id: \.self) { choice in
                Button {
                    guard choice.value != autonomy.value else { return }
                    if choice.value == "full_access" { asking = autonomy.confirm }
                    else { load.change { await client.spadeSettingsAutonomy(choice.value) } }
                } label: {
                    if choice.value == autonomy.value {
                        Label { Text(choice.label) } icon: { AceIcon(.check) }
                    } else {
                        Text(choice.label)
                    }
                }
            }
        } label: {
            InsetRow(icon: nil, title: "How they decide", subtitle: nil) { SpadeMenuValue(text: chosen) }
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
        .disabled(load.busy)
        .accessibilityIdentifier("spade.security.autonomy")
    }
}
