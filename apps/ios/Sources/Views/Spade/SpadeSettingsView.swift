import SwiftUI

/// Settings › Spade for one machine: Run Spade on this machine and Spade's state, then each model
/// endpoint Spade knows with its models (and which role each serves) and whether its key is set.
/// A key typed here goes to Spade once, through this machine's connection, and Spade keeps it in
/// the machine's keychain (ADR 0119): the field empties as it goes and the phone keeps no copy.
struct SpadeSettingsView: View {
    let model: ClientModel
    @State private var models: SpadeModels?
    @State private var saving = false
    @State private var failure: String?

    private var spade: SpadeModel { model.spade }

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { spade.enabled == true }, set: { turn($0) })) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text("Run Spade on this machine")
                        Text(spade.line?.sentence ?? "Checking Spade…")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .disabled(spade.enabled == nil || saving)
                .accessibilityIdentifier("spade.settings.enabled")
            } header: { InsetHeader("Assistant") } footer: {
                if let failure { Text(failure).foregroundStyle(AceTheme.StatusText.failed) }
            }
            .insetRowBackground()
            if spade.line?.ready == true { endpoints }
        }
        .insetGroupedList()
        .nativeTitle("Spade")
        .onAppear { model.spadeWatch(true) }
        .onDisappear { model.spadeWatch(false) }
        .task(id: spade.line?.ready) { if spade.line?.ready == true { await read() } }
        .refreshable { model.spadeRefresh(); await read() }
    }

    @ViewBuilder private var endpoints: some View {
        if let models, models.ok, let endpoints = models.endpoints {
            ForEach(endpoints) { endpoint in
                Section {
                    if let key = endpoint.key {
                        SpadeKeyRow(model: model, endpoint: endpoint.id, line: key) { await read() }
                    }
                    ForEach(endpoint.models) { item in
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                            Text(item.name)
                            if let roles = item.roles {
                                Text(roles).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                } header: { InsetHeader(endpoint.name) }
                .insetRowBackground()
            }
        } else if let models, !models.ok {
            Section {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    Text(models.title ?? "Couldn't read Spade's models")
                    if let message = models.message {
                        Text(message).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
                    }
                    Button("Try again") { Task { await read() } }.buttonStyle(.textAction(.prominent))
                }
            } header: { InsetHeader("Models") }
            .insetRowBackground()
        } else {
            Section { SkeletonBar(width: 180, height: 15) } header: { InsetHeader("Models") }
                .insetRowBackground()
        }
    }

    private func read() async { models = await model.spadeModels() }

    private func turn(_ on: Bool) {
        saving = true
        failure = nil
        Task {
            let outcome = await model.spadeRequest(["type": "spade.enable", "on": on],
                                                   failing: on ? "Couldn't turn on Spade" : "Couldn't turn off Spade")
            saving = false
            if !outcome.ok { failure = [outcome.title, outcome.message].compactMap(\.self).joined(separator: ". ") }
        }
    }
}

/// An endpoint's key: whether it is set and where from, a secure field to save one where the
/// machine has a keychain, and Remove for a key in it.
private struct SpadeKeyRow: View {
    let model: ClientModel
    let endpoint: String
    let line: SpadeModels.KeyLine
    let changed: () async -> Void
    @State private var draft = ""
    @State private var sending = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text("Key")
            Text(line.description).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
            if line.canSave {
                HStack(spacing: AceDesign.Space.related) {
                    SecureField(line.placeholder, text: $draft)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .disabled(sending)
                        .onSubmit { change(remove: false) }
                        .accessibilityIdentifier("spade.key.\(endpoint)")
                    Button("Save") { change(remove: false) }
                        .buttonStyle(.textAction(.prominent))
                        .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    if line.canRemove {
                        Button("Remove") { change(remove: true) }.buttonStyle(.textAction(.destructive)).disabled(sending)
                    }
                }
            }
            if let failure {
                Text(failure).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceTheme.StatusText.failed)
            }
        }
    }

    private func change(remove: Bool) {
        let key = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard remove || !key.isEmpty else { return }
        // The field empties before the request goes, so the key lives only in this call.
        draft = ""
        sending = true
        failure = nil
        Task {
            let outcome = await model.spadeRequest(["type": "spade.key", "endpoint": endpoint, "key": remove ? NSNull() as Any : key],
                                                   failing: remove ? "Couldn't remove the key" : "Couldn't save the key")
            sending = false
            if outcome.ok { await changed() } else { failure = [outcome.title, outcome.message].compactMap(\.self).joined(separator: ". ") }
        }
    }
}
