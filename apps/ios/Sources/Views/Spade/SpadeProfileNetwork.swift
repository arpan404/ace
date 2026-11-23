import SwiftUI

/// The bot's network rules (ADR 0167), as web's: what its commands and its plugins may reach,
/// each Off, Listed sites or Open, said as its own or the machine's with the way back; the listed
/// sites (the defaults, which can be removed and put back, and the person's own); the private
/// hosts it may reach. Each change saves; a rule Spade rejects keeps the old one and says why.
struct SpadeProfileNetwork: View {
    let client: ClientModel
    let agent: String
    @State private var network: SpadeProfileEdits.Network?
    @State private var saving = false
    /// Why Spade refused a change, by the rule it was on.
    @State private var refused: [String: String] = [:]

    var body: some View {
        Group {
            if let network {
                ForEach(network.policies) { policy in
                    rule(policy, network)
                    if policy.mode == "allow_list" { sites(policy) }
                    if policy.mode != "off" { hosts(policy) }
                }
            }
        }
        .task(id: agent) {
            let answer = await client.spadeNetwork(agent)
            if answer.ok, let fresh = answer.part { network = fresh }
        }
    }

    private func rule(_ policy: SpadeProfileEdits.Policy, _ network: SpadeProfileEdits.Network) -> some View {
        Section {
            Picker(policy.title, selection: Binding(get: { policy.mode }, set: { change(policy.which, .mode($0)) })) {
                ForEach(network.modes, id: \.value) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.menu)
            .disabled(saving)
            .accessibilityIdentifier("spade.network.\(policy.which)")
            HStack {
                Text(policy.own ? "Its own" : "Same as \(network.place)")
                    .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                Spacer(minLength: AceDesign.Space.related)
                if policy.own {
                    Button("Same as \(network.place)") { change(policy.which, .inherit) }
                        .aceFont(AceDesign.TextRole.meta).buttonStyle(.borderless).disabled(saving)
                }
            }
        } header: {
            Text(policy.which == "commands" ? "Network for commands" : "Network for plugins")
        } footer: {
            if let why = refused[policy.which] { Text(why).foregroundStyle(AceTheme.StatusText.failed) }
        }
    }

    private func sites(_ policy: SpadeProfileEdits.Policy) -> some View {
        Section("Listed sites for \(policy.which)") {
            ForEach(policy.sites, id: \.self) { site in
                entry(site.entry, line: site.line, action: site.action) {
                    let intent: SpadeProfileEdits.NetworkChange
                    if site.line == nil { intent = .removeEntry(site.entry) }
                    else if site.action == "Put back" { intent = .restoreDefault(site.entry) }
                    else { intent = .removeDefault(site.entry) }
                    change(policy.which, intent)
                }
            }
            SpadeNetworkAdd(label: "Add a site", placeholder: "example.com", disabled: saving) { typed in
                await save(policy.which, .add(typed))
            }
        }
    }

    private func hosts(_ policy: SpadeProfileEdits.Policy) -> some View {
        Section("Private network for \(policy.which)") {
            ForEach(policy.hosts, id: \.self) { host in
                entry(host, line: nil, action: "Remove") { change(policy.which, .removeEntry(host)) }
            }
            SpadeNetworkAdd(label: "Add a private host", placeholder: "localhost:3000", disabled: saving) { typed in
                await save(policy.which, .add(typed))
            }
        }
    }

    private func entry(_ entry: String, line: String?, action: String, act: @escaping () -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(entry).aceFont(AceDesign.TextRole.rowTitle)
                if let line { Text(line).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle) }
            }
            Spacer(minLength: AceDesign.Space.related)
            Button(action, action: act)
                .aceFont(AceDesign.TextRole.action).buttonStyle(.borderless).disabled(saving)
                .accessibilityLabel("\(action) \(entry)")
        }
    }

    private func change(_ which: String, _ change: SpadeProfileEdits.NetworkChange) {
        Task { await save(which, change) }
    }

    /// Saves one change; whether Spade took it.
    @discardableResult
    private func save(_ which: String, _ change: SpadeProfileEdits.NetworkChange) async -> Bool {
        guard !saving else { return false }
        saving = true
        refused[which] = nil
        let answer = await client.spadeNetwork(agent, which: which, change: change)
        saving = false
        if answer.ok, let fresh = answer.part {
            network = fresh
            return true
        }
        refused[which] = answer.problem ?? "Spade didn't take the change."
        return false
    }
}

/// A host typed and added; the field empties once Spade keeps it.
struct SpadeNetworkAdd: View {
    let label: String
    let placeholder: String
    let disabled: Bool
    let add: (String) async -> Bool
    @State private var typed = ""

    var body: some View {
        HStack {
            TextField(label, text: $typed, prompt: Text(placeholder))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .submitLabel(.done)
                .onSubmit(submit)
            Button("Add", action: submit)
                .buttonStyle(.borderless)
                .disabled(disabled || typed.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        .accessibilityIdentifier("spade.network.add")
    }

    private func submit() {
        let entry = typed.trimmingCharacters(in: .whitespaces)
        guard !entry.isEmpty else { return }
        Task { if await add(entry) { typed = "" } }
    }
}
