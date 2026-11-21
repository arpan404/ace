import SwiftUI
import UIKit

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
        SpadeSettingsPageFrame(client: client, load: load) { answer in
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
                // A key from the environment stays; one kept here is used instead of it.
                Button(search.brave.canRemove ? "Replace key" : "Add key") {
                    keying = SpadeKeyTarget(id: "brave", name: "Brave Search", replacing: search.brave.canRemove)
                }
                .disabled(load.busy)
                .accessibilityIdentifier("spade.search.setKey")
            }
            if search.brave.canRemove {
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

/// Settings › Spade › Apps (docs/design/spade.md): each app Spade is connected to, with whether it
/// works, the account, the bots that use it and when one last did; Reconnect when its sign-in
/// ended, and Disconnect, after asking. A token app takes a token pasted here; a device sign-in
/// shows its code and opens its page; a browser sign-in says where to finish. Then the skills the
/// bots use or wrote. New apps connect on the computer, where the person signs in.
struct SpadeAppsPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad
    @State private var leaving: SpadeSettings.App?
    @State private var token: SpadeKeyTarget?
    @Environment(\.openURL) private var openURL

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .apps))
    }

    var body: some View {
        SpadeSettingsPageFrame(client: client, load: load) { answer in
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
        .sheet(item: $token) { target in
            SpadeKeySheet(target: target) { pasted in
                await load.awaiting { await client.spadeSettingsReconnect(target.id, token: pasted) }
            }
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
                        Button(role: .destructive) { leaving = app } label: {
                            Label { Text("Disconnect") } icon: { AceIcon(.xCircle) }
                        }
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
            appActions(app)
        }
        .padding(.vertical, AceDesign.Space.tight)
        .accessibilityElement(children: .contain)
    }

    /// Reconnect while its sign-in has ended; while a device sign-in waits, its page and code.
    @ViewBuilder private func appActions(_ app: SpadeSettings.App) -> some View {
        if let device = app.device {
            HStack(spacing: AceDesign.Space.group) {
                if let page = URL(string: device.url) {
                    Button("Open sign-in page") { openURL(page) }
                        .accessibilityIdentifier("spade.app.open.\(app.id)")
                }
                Button("Copy code") { UIPasteboard.general.string = device.code }
                    .accessibilityIdentifier("spade.app.copy.\(app.id)")
            }
            .buttonStyle(.borderless)
            .aceFont(AceDesign.TextRole.action)
            .padding(.top, AceDesign.Space.tight)
        } else if let reconnect = app.reconnect {
            Button("Reconnect") {
                if reconnect == "token" {
                    token = SpadeKeyTarget(id: app.id, name: app.name, replacing: true, secret: "token")
                } else {
                    load.change { await client.spadeSettingsReconnect(app.id, token: nil) }
                }
            }
            .buttonStyle(.borderless)
            .aceFont(AceDesign.TextRole.action)
            .padding(.top, AceDesign.Space.tight)
            .accessibilityIdentifier("spade.app.reconnect.\(app.id)")
        }
    }
}
