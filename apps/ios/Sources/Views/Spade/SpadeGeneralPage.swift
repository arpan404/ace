import SwiftUI

/// Settings › Spade › General: whether Spade runs on this machine, then the models it starts new
/// bots on and uses for small jobs, dictation and speech. Each model opens its own list to pick
/// from, grouped by where the models come from.
struct SpadeGeneralPage: View {
    let client: ClientModel
    @State private var load: SpadeSettingsLoad

    init(client: ClientModel) {
        self.client = client
        _load = State(initialValue: SpadeSettingsLoad(client: client, page: .general))
    }

    var body: some View {
        SpadeSettingsPageFrame(client: client, load: load) { answer in
            if let general = answer.general { rows(general) }
        }
    }

    @ViewBuilder private func rows(_ general: SpadeSettings.General) -> some View {
        Section {
            if let on = general.run.on {
                Toggle(isOn: Binding(get: { on }, set: { next in load.change { await client.spadeSettingsRun(next) } })) {
                    Text("Run Spade on this machine").aceFont(AceDesign.TextRole.rowTitle)
                }
                .disabled(load.busy)
                .accessibilityIdentifier("spade.settings.run")
            } else {
                HStack {
                    Text("Run Spade on this machine").aceFont(AceDesign.TextRole.rowTitle)
                    Spacer()
                    ProgressView()
                }
            }
        } footer: {
            if let line = general.run.line { Text(line) }
        }
        .insetRowBackground()
        if !general.models.isEmpty {
            Section {
                ForEach(general.models) { setting in
                    NavigationLink {
                        SpadeModelChoices(setting: setting, groups: general.groups, more: general.more) { value in
                            load.change { await client.spadeSettingsModel(setting.role, model: value.isEmpty ? nil : value) }
                        }
                    } label: {
                        SpadeSettingRow(title: setting.title, line: setting.words, value: nil)
                    }
                    .disabled(load.busy)
                    .accessibilityIdentifier("spade.settings.model.\(setting.role)")
                }
            } header: {
                InsetHeader("Models")
            }
            .insetRowBackground()
        }
    }
}

/// One model setting's choices: its empty choice first, then every model, grouped by the
/// endpoint or subscription it comes from, the chosen one checked. Picking one saves it and goes
/// back. A long list can be searched.
struct SpadeModelChoices: View {
    let setting: SpadeSettings.ModelSetting
    let groups: [SpadeSettings.Group]
    /// Models left out so the list fits; they stay on the computer.
    let more: Int
    let pick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var shown: [SpadeSettings.Group] {
        let typed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty else { return groups }
        return groups.compactMap { group in
            let found = group.choices.filter { choice in
                choice.name.localizedCaseInsensitiveContains(typed) || group.label.localizedCaseInsensitiveContains(typed)
            }
            return found.isEmpty ? nil : SpadeSettings.Group(label: group.label, choices: found)
        }
    }

    var body: some View {
        List {
            if query.isEmpty {
                Section {
                    choice(setting.none, value: "")
                } footer: {
                    if let line = setting.line { Text(line) }
                }
                .insetRowBackground()
            }
            ForEach(shown, id: \.label) { group in
                Section {
                    ForEach(group.choices, id: \.value) { choice($0.name, value: $0.value) }
                } header: {
                    InsetHeader(group.label)
                }
                .insetRowBackground()
            }
            if more > 0 && query.isEmpty {
                Section {} footer: { Text("\(more) more models are listed in Spade on the computer.") }
            }
        }
        .insetGroupedList()
        .searchable(text: $query, prompt: Text("Search models"))
        .nativeTitle(setting.title)
        .accessibilityIdentifier("spade.settings.choices")
    }

    private func choice(_ name: String, value: String) -> some View {
        Button {
            if value != setting.value { pick(value) }
            dismiss()
        } label: {
            HStack {
                Text(name).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                Spacer(minLength: AceDesign.Space.related)
                if value == setting.value {
                    AceIcon(.check).foregroundStyle(AceDesign.Ink.action).accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(value == setting.value ? .isSelected : [])
        .accessibilityIdentifier("spade.choice.\(value.isEmpty ? "none" : value)")
    }
}
