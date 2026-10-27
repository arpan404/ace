import SwiftUI

/// A provider's page's Behaviour: its default model and which models the picker lists.
struct ProviderBehaviourSection: View {
    let model: ClientModel
    let provider: String
    let models: ProviderModelsData
    @State private var problem: String?
    @State private var saving = false

    var body: some View {
        Section {
            ForEach(models.problems, id: \.self) { line in
                Label(line, systemImage: "exclamationmark.circle").foregroundStyle(AceTheme.StatusText.needsYou)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            }
            if let current = models.defaultModel {
                Menu {
                    Picker("Default model", selection: Binding(get: { current.choices.first { $0.current }?.key ?? "" }, set: choose)) {
                        ForEach(current.choices, id: \.key) { Text($0.label).tag($0.key) }
                    }
                    if current.resettable {
                        Divider()
                        Button("Reset to the provider's default") { save(["kind": "defaultModel", "id": NSNull()]) }
                    }
                } label: {
                    InsetRow(systemImage: nil, title: "Default model", subtitle: current.note) {
                        InsetValue(text: current.label)
                    }
                }
                .accessibilityIdentifier("provider.defaultModel")
            }
            NavigationLink { ProviderModelsView(model: model, provider: provider) } label: {
                InsetRow("Models in the picker", systemImage: nil, value: models.shown)
            }
            .accessibilityIdentifier("provider.models")
            ServiceProblem(message: problem)
        } header: { InsetHeader("Behaviour") }
        .insetRowBackground()
        .disabled(saving || !model.canOperate)
    }

    private func choose(_ key: String) {
        guard let choice = models.defaultModel?.choices.first(where: { $0.key == key }), !choice.current else { return }
        save(["kind": "defaultModel", "id": choice.id])
    }
    private func save(_ change: [String: Any]) {
        saving = true; problem = nil
        Task {
            defer { saving = false }
            do { try await model.editProvider(provider, change) } catch { problem = error.localizedDescription }
        }
    }
}

/// Every model the provider lists, to star, hide or show; deprecated and favourites-only
/// switches; models the CLI knows that discovery doesn't list; and Refresh.
struct ProviderModelsView: View {
    let model: ClientModel
    let provider: String
    @State private var models: ProviderModelsData?
    @State private var problem: String?
    @State private var saving = false
    @State private var refreshing = false
    @State private var newId = ""
    @State private var newName = ""
    @State private var removing: ProviderModelsData.Custom?
    @State private var changed = 0

    init(model: ClientModel, provider: String) {
        self.model = model
        self.provider = provider
        _models = State(initialValue: model.kept(ProviderPageData.read(provider), as: ProviderPageData.self)?.models)
    }

    var body: some View {
        List {
            if let models {
                Section {
                    Toggle("Hide deprecated models", isOn: Binding(get: { models.hideDeprecated }, set: { save(["kind": "hideDeprecated", "on": $0]) }))
                    Toggle("Only favourites", isOn: Binding(get: { models.onlyFavourites }, set: { save(["kind": "onlyFavourites", "on": $0]) }))
                    HStack {
                        Text(models.total).foregroundStyle(AceTheme.Colours.mutedForeground)
                        Spacer()
                        if refreshing { ProgressView().controlSize(.small) }
                        Button("Refresh") { refresh() }.disabled(refreshing)
                    }
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                }
                .insetRowBackground()
                ForEach(models.groups) { group in
                    Section {
                        ForEach(group.models, id: \.key) { row in modelRow(row) }
                    } header: { if let label = group.label { InsetHeader(label) } }
                    .insetRowBackground()
                }
                custom(models)
            } else if problem == nil {
                Section { ForEach(0..<4, id: \.self) { _ in InsetRow("Loading", systemImage: nil) } }
                    .insetRowBackground().redacted(reason: .placeholder)
            }
            if let problem { ServiceProblem(message: problem).listRowBackground(Color.clear) }
        }
        .insetGroupedList()
        .toggleStyle(.systemSwitch)
        .animation(.smooth, value: models)
        .disabled(!model.canOperate)
        .navigationTitle("Models").navigationBarTitleDisplayMode(.inline)
        .sensoryFeedback(.selection, trigger: changed)
        .task(id: [model.connection == "ready" ? 1 : 0, model.readGeneration(ProviderPageData.read(provider))]) {
            if model.connection == "ready" { await read() }
        }
        .refreshable { await read() }
        .confirmationDialog("Remove this model?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { row in
            Button("Remove \(row.displayName)", role: .destructive) { save(["kind": "removeCustom", "id": row.id]) }
        }
    }

    private func modelRow(_ row: ProviderModelsData.Row) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(row.label).aceFont(InsetStyle.label, relativeTo: .body)
                    .foregroundStyle(row.hidden ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground)
                if let marks = row.marks {
                    Text(marks).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            Button { save(["kind": "favourite", "key": row.key]) } label: {
                Image(systemName: row.starred ? "star.fill" : "star")
                    .foregroundStyle(row.starred ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
                    .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.starred ? "Unstar \(row.label)" : "Star \(row.label)")
            Button { save(["kind": "modelHidden", "id": row.id, "aliases": row.aliases, "hidden": row.hidden]) } label: {
                Image(systemName: row.hidden ? "eye.slash" : "eye")
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.hidden ? "Show \(row.label)" : "Hide \(row.label)")
        }
    }

    @ViewBuilder private func custom(_ models: ProviderModelsData) -> some View {
        Section {
            ForEach(models.custom) { row in
                HStack {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        Text(row.displayName).aceFont(InsetStyle.label, relativeTo: .body)
                        Text(row.id).monospaced().aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    Spacer()
                    Button("Remove", role: .destructive) { removing = row }.buttonStyle(.borderless)
                }
                .swipeActions { Button("Remove", role: .destructive) { removing = row } }
            }
            TextField("Model name used by the CLI", text: $newId).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("custom.id")
            TextField("Display name", text: $newName).accessibilityIdentifier("custom.name").onSubmit(add)
            Button("Add model", action: add)
                .disabled(newId.trimmingCharacters(in: .whitespaces).isEmpty || newName.trimmingCharacters(in: .whitespaces).isEmpty)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
        } header: { InsetHeader("Custom models") }
        .insetRowBackground()
    }

    private func read() async {
        do {
            let page = try await model.read(ProviderPageData.read(provider), as: ProviderPageData.self)
            withAnimation(.smooth) { models = page.models; problem = page.models == nil ? "This provider lists no models yet." : nil }
        } catch { if models == nil { problem = error.localizedDescription } }
    }
    private func add() {
        let id = newId, name = newName
        save(["kind": "addCustom", "id": id, "name": name]) { newId = ""; newName = "" }
    }
    private func refresh() {
        refreshing = true
        Task {
            defer { refreshing = false }
            do { try await model.editProvider(provider, ["kind": "refreshModels"]) } catch { problem = error.localizedDescription }
        }
    }
    private func save(_ change: [String: Any], then: @escaping () -> Void = {}) {
        saving = true; problem = nil
        Task {
            defer { saving = false }
            do { try await model.editProvider(provider, change); changed += 1; then() }
            catch { problem = error.localizedDescription }
        }
    }
}
