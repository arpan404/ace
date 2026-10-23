import SwiftUI

/// The open thread's model sheet: Favorites and the account the thread runs on (a thread keeps
/// its provider and account, so there is no other tab), then effort and speed for the next
/// message. It opens on Favorites when any of these models is starred. Picking a model marks it;
/// the check switches the thread to it from its next turn. Effort and speed apply at once to the
/// model in use, as the composer's control did.
struct ModelPickerSheet: View {
    let model: ClientModel
    @Bindable var screen: ThreadScreenModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: String?
    @State private var switching = false
    @State private var query = ""
    @State private var shown: String?
    private var current: ModelOption? { screen.models.first(where: \.current) }
    private var chosen: String? { picked ?? current?.id }
    private var provider: String { screen.controls?.provider ?? "" }
    private var tabs: [ModelPickerTab] {
        ThreadPickerRows.tabs(provider: provider, name: screen.controls?.providerName ?? "Models")
    }
    private var tab: String {
        shown ?? ModelPickerStart.tab(tabs, hasFavorites: !screen.modelList.favorites.isEmpty, current: ThreadPickerRows.account)
    }
    private var state: ModelPickerState {
        switch screen.modelsState {
        case "ready": .ready
        case "failed": .failed(title: "Couldn't load models", message: "Your machine didn't answer. Check the connection and try again.")
        default: .loading
        }
    }

    var body: some View {
        ModelPicker(
            query: $query, tabs: tabs, shown: Binding(get: { tab }, set: { shown = $0 }), state: state,
            rows: ThreadPickerRows.rows(screen.modelList, provider: provider, tab: tab, chosen: chosen, query: query),
            rowPrefix: "threadModel", starProblem: screen.modelList.starProblem,
            retry: { model.requestModels() }, confirming: switching, confirm: confirm,
            choose: { picked = $0.id },
            star: { row in model.favoriteModel(row.id) }
        ) {
            // Effort and speed belong to the model in use; a newly picked one brings its own.
            if chosen == current?.id, let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty {
                ThreadTuneOptions(tune: tune, model: model)
            }
        }
        .onAppear { model.requestModels() }
        // Where it opens is decided once the list arrives, so a new star never moves the sheet.
        .task(id: screen.modelsState) { if shown == nil, screen.modelsState == "ready" { shown = tab } }
    }
    private func confirm() {
        guard let picked, picked != current?.id, let option = screen.models.first(where: { $0.id == picked }) else { dismiss(); return }
        switching = true
        Task {
            let switched = await model.switchModel(option)
            switching = false
            if switched { dismiss() }
        }
    }
}

/// Effort and speed for the thread's next message, as the bridge offers them: each a row of
/// its levels in words.
private struct ThreadTuneOptions: View {
    let tune: TuneRow
    let model: ClientModel

    var body: some View {
        ModelOptionsSection {
            if !tune.efforts.isEmpty {
                OptionChoiceRow(title: "Effort", items: tune.efforts.map { GlassChoiceItem(id: $0.id, label: $0.label) },
                                selection: tune.effort, note: tune.effortReason.isEmpty ? nil : tune.effortReason,
                                disabled: !tune.effortReason.isEmpty, idPrefix: "composer.tune") { effort in
                    Task { _ = await model.setEffort(effort) }
                }
            }
            if tune.speeds.count > 1 {
                OptionChoiceRow(title: "Speed", items: tune.speeds.map { GlassChoiceItem(id: $0.speed, label: $0.label) },
                                selection: tune.speed, note: tune.speedReason.isEmpty ? nil : tune.speedReason,
                                disabled: !tune.speedReason.isEmpty, idPrefix: "composer.speed") { speed in
                    Task { _ = await model.setSpeed(speed) }
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                if tune.pending { Text("Applies with your next message.") }
                else if !tune.notice.isEmpty { Text(tune.notice) }
                if tune.canReset {
                    Button("Use the model's default effort") { Task { _ = await model.setEffort(nil) } }
                        .buttonStyle(.plain).foregroundStyle(AceTheme.Colours.foreground)
                        .accessibilityIdentifier("composer.tune.default")
                }
            }
        }
    }
}
