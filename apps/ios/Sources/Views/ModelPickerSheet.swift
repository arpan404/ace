import SwiftUI

/// The open thread's model sheet, models only: Favorites and the account the thread runs on (a
/// thread keeps its provider and account, so there is no other tab). Effort and speed have their
/// own panel from the composer. It opens on Favorites when any of these models is starred. Picking a model marks it;
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
        )
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
