import SwiftUI

/// Settings › Spade › Web search: the person's own SearXNG address, and a Brave Search key kept
/// in the machine's keychain, never shown.
struct SpadeSearchPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad
    @State private var keying: SpadeKeyTarget?

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .search))
    }

    var body: some View {
        SpadeSettingsPageFrame(load: load) { answer in
            if let search = answer.search { SpadeSearchRows(client: client, search: search, load: load, keying: $keying) }
        }
        .sheet(item: $keying) { target in
            SpadeKeySheet(target: target) { key in
                await load.awaiting { await client.spadeSettingsBrave(key: key) }
            }
        }
    }
}

private struct SpadeSearchRows: View {
    let client: ClientModel
    let search: SpadeSettings.Search
    let load: SpadeSettingsLoad
    @Binding var keying: SpadeKeyTarget?
    @State private var address = ""
    @FocusState private var editing: Bool

    private var typed: String { address.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Section {
            TextField("https://search.example.org", text: $address)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .focused($editing)
                .onSubmit(saveAddress)
                .accessibilityIdentifier("spade.search.address")
            if typed != (search.searxng ?? "") && !typed.isEmpty {
                Button("Save address", action: saveAddress)
                    .disabled(load.busy)
                    .accessibilityIdentifier("spade.search.save")
            }
            if search.searxng != nil {
                Button("Forget address", role: .destructive) {
                    load.change { await client.spadeSettingsSearxng(nil) }
                }
                .disabled(load.busy)
            }
        } header: {
            InsetHeader("SearXNG")
        } footer: {
            Text("Your own SearXNG server. Bots search through it before anything else.")
        }
        .insetRowBackground()
        .onAppear { address = search.searxng ?? "" }
        .onChange(of: search.searxng) { _, saved in if !editing { address = saved ?? "" } }
        Section {
            SpadeSettingRow(title: "Key", value: search.brave.words)
                .accessibilityIdentifier("spade.search.brave")
            if search.brave.canSet {
                Button(search.brave.set ? "Replace key" : "Add key") {
                    keying = SpadeKeyTarget(id: "brave", name: "Brave Search", replacing: search.brave.set)
                }
                .disabled(load.busy)
                .accessibilityIdentifier("spade.search.setKey")
            }
            if search.brave.set && search.keychain {
                Button("Remove key", role: .destructive) {
                    load.change { await client.spadeSettingsBrave(key: nil) }
                }
                .disabled(load.busy)
            }
        } header: {
            InsetHeader("Brave Search")
        } footer: {
            if !search.keychain {
                Text("This machine has no keychain to keep keys in. Set BRAVE_API_KEY in Spade's environment instead.")
            }
        }
        .insetRowBackground()
    }

    private func saveAddress() {
        let sent = typed
        editing = false
        guard sent != (search.searxng ?? "") else { return }
        load.change { await client.spadeSettingsSearxng(sent.isEmpty ? nil : sent) }
    }
}

/// Settings › Spade › Apps: each app Spade is connected to, with whether it works, the account,
/// the bots that use it and when one last did; Disconnect, after asking. Then the skills the
/// bots use or wrote. New apps connect on the computer, where the person signs in.
struct SpadeAppsPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad
    @State private var leaving: SpadeSettings.App?

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .apps))
    }

    var body: some View {
        SpadeSettingsPageFrame(load: load) { answer in
            if let apps = answer.apps { rows(apps) }
        }
        .confirmationDialog(leaving.map { "Disconnect \($0.name)?" } ?? "", isPresented: leavingShown,
                            titleVisibility: .visible, presenting: leaving) { app in
            Button("Disconnect", role: .destructive) {
                load.change { await client.spadeSettingsDisconnect(app.id) }
            }
        } message: { _ in
            Text("Bots can't use it until it's connected again from the computer.")
        }
    }

    private var leavingShown: Binding<Bool> {
        Binding(get: { leaving != nil }, set: { if !$0 { leaving = nil } })
    }

    @ViewBuilder private func rows(_ apps: SpadeSettings.Apps) -> some View {
        Section {
            if apps.apps.isEmpty {
                Text("No apps connected yet.")
                    .aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(apps.apps) { app in
                appRow(app)
                    .swipeActions {
                        Button("Disconnect", role: .destructive) { leaving = app }
                    }
                    .contextMenu {
                        Button("Disconnect", systemImage: "xmark.circle", role: .destructive) { leaving = app }
                    }
                    .disabled(load.busy)
                    .accessibilityIdentifier("spade.app.\(app.id)")
            }
        } header: {
            InsetHeader("Connected apps")
        } footer: {
            Text("Connect new apps from Spade on the computer, where you sign in to them.")
        }
        .insetRowBackground()
        if !apps.skills.isEmpty {
            Section {
                ForEach(apps.skills, id: \.self) { skill in
                    SpadeSettingRow(title: skill.name, line: skill.line.isEmpty ? nil : skill.line)
                }
            } header: {
                InsetHeader("Skills")
            }
            .insetRowBackground()
        }
    }

    private func appRow(_ app: SpadeSettings.App) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            Text(app.name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
            Text([app.health, app.account].compactMap(\.self).joined(separator: " · "))
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(app.ok ? AceDesign.Ink.muted : AceTheme.StatusText.needsYou)
            Text(app.line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
    }
}
