import SwiftUI

/// Settings › Spade › Models and keys: each endpoint with its server, where its key comes from
/// and its models; a key typed here, replaced or removed; then the services to add from. A key
/// is never shown, here or anywhere: it goes once to the machine's keychain (ADR 0119).
struct SpadeModelsPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad
    @State private var keying: SpadeKeyTarget?
    @State private var removing: SpadeSettings.Endpoint?

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .models))
    }

    var body: some View {
        SpadeSettingsPageFrame(load: load) { answer in
            if let models = answer.models { rows(models) }
        }
        .sheet(item: $keying) { target in
            SpadeKeySheet(target: target) { key in
                await load.awaiting { await client.spadeSettingsKey(target.id, key: key) }
            }
        }
        .confirmationDialog(removing.map { "Remove \($0.name)?" } ?? "", isPresented: removingShown, titleVisibility: .visible,
                            presenting: removing) { endpoint in
            Button("Remove \(endpoint.name)", role: .destructive) {
                load.change { await client.spadeSettingsRemove(endpoint: endpoint.id) }
            }
        } message: { _ in
            Text("Its key leaves this machine's keychain too.")
        }
    }

    private var removingShown: Binding<Bool> {
        Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
    }

    @ViewBuilder private func rows(_ models: SpadeSettings.Models) -> some View {
        if models.endpoints.isEmpty {
            Section {
                Text("No model endpoints yet. Add a service below, then its key.")
                    .aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.muted)
            }
            .insetRowBackground()
        }
        ForEach(models.endpoints) { endpoint in
            Section {
                endpointRows(endpoint)
            } header: {
                InsetHeader(endpoint.name)
            }
            .insetRowBackground()
        }
        Section {
            ForEach(models.presets) { preset in
                Button { load.change { await client.spadeSettingsAdd(preset: preset.id) } } label: { AddRow(preset.name) }
                    .buttonStyle(.plain)
                    .disabled(load.busy)
                    .accessibilityIdentifier("spade.settings.add.\(preset.id)")
            }
        } header: {
            if !models.presets.isEmpty { InsetHeader("Add a service") }
        } footer: {
            Text(models.note)
        }
        .insetRowBackground()
    }

    /// Where the key is, as one row: tapped, it offers what can be done with the key here.
    /// Then the models, and removing the endpoint.
    @ViewBuilder private func endpointRows(_ endpoint: SpadeSettings.Endpoint) -> some View {
        if endpoint.key.canSet || endpoint.key.canRemove {
            Menu {
                if endpoint.key.canSet {
                    Button(endpoint.key.set ? "Replace key" : "Add key", systemImage: "key") {
                        keying = SpadeKeyTarget(id: endpoint.id, name: endpoint.name, replacing: endpoint.key.set)
                    }
                }
                if endpoint.key.canRemove {
                    Button("Remove key", systemImage: "trash", role: .destructive) {
                        load.change { await client.spadeSettingsKey(endpoint.id, key: nil) }
                    }
                }
            } label: {
                keyRow(endpoint, chevron: true)
            }
            .buttonStyle(.plain)
            .disabled(load.busy)
            .accessibilityIdentifier("spade.settings.key.\(endpoint.id)")
        } else {
            keyRow(endpoint, chevron: false).accessibilityIdentifier("spade.settings.key.\(endpoint.id)")
        }
        if !endpoint.models.isEmpty {
            SpadeSettingRow(title: "Models", line: modelLine(endpoint), value: nil)
        }
        Button("Remove \(endpoint.name)", role: .destructive) { removing = endpoint }
            .disabled(load.busy)
            .accessibilityIdentifier("spade.settings.remove.\(endpoint.id)")
    }

    private func keyRow(_ endpoint: SpadeSettings.Endpoint, chevron: Bool) -> some View {
        InsetRow(systemImage: nil, title: "Key", subtitle: endpoint.address) {
            HStack(spacing: AceDesign.Space.tight) {
                InsetValue(text: endpoint.key.words)
                if chevron {
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AceDesign.Ink.subtle)
                        .accessibilityHidden(true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func modelLine(_ endpoint: SpadeSettings.Endpoint) -> String {
        let names = endpoint.models.joined(separator: ", ")
        return endpoint.more > 0 ? "\(names) and \(endpoint.more) more" : names
    }
}

/// Whose key the sheet takes: an endpoint's, or Brave Search's.
struct SpadeKeyTarget: Identifiable, Hashable {
    let id: String
    let name: String
    let replacing: Bool
}

/// A key, pasted once: a secure field, Save, and where the key goes. It leaves the phone on Save
/// and the field empties; a refusal says why and keeps the sheet open.
struct SpadeKeySheet: View {
    let target: SpadeKeyTarget
    let save: (String) async -> SpadeSettings.Answer
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @State private var saving = false
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var typed: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("Paste the key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focused)
                        .disabled(saving)
                        .onSubmit(submit)
                        .accessibilityIdentifier("spade.key.field")
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(AceTheme.StatusText.failed)
                    } else {
                        Text("It goes straight to this machine's keychain. The phone doesn't keep it, and it can't be read back here.")
                    }
                }
            }
            .navigationTitle(target.replacing ? "Replace \(target.name) key" : "\(target.name) key")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(saving)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button("Save", action: submit)
                            .disabled(typed.isEmpty)
                            .accessibilityIdentifier("spade.key.save")
                    }
                }
            }
        }
        .onAppear { focused = true }
        .onDisappear { key = "" }
        .presentationDetents([.medium])
    }

    private func submit() {
        let sent = typed
        guard !sent.isEmpty, !saving else { return }
        saving = true
        problem = nil
        // The field lets go of the key as it leaves.
        key = ""
        Task {
            let answer = await save(sent)
            saving = false
            if answer.ok { dismiss() } else { problem = answer.problem }
        }
    }
}
