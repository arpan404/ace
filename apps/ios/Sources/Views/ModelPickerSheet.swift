import SwiftUI

/// The open thread's model sheet: the models its account offers, then effort and speed for the
/// next message. Picking a model marks it; the check switches the thread to it from its next
/// turn. Effort and speed apply at once to the model in use, as the composer's control did.
struct ModelPickerSheet: View {
    let model: ClientModel
    @Bindable var screen: ThreadScreenModel
    @Environment(\.dismiss) private var dismiss
    @State private var picked: String?
    @State private var switching = false
    @State private var query = ""
    private var current: ModelOption? { screen.models.first(where: \.current) }
    private var chosen: String? { picked ?? current?.id }
    private var provider: String { screen.controls?.provider ?? "" }

    var body: some View {
        ModelSheet(query: $query, confirming: switching, confirm: confirm) {
            switch screen.modelsState {
            case "ready" where screen.models.isEmpty:
                ContentUnavailableView("No models listed", systemImage: "cpu", description: Text("Check this account on your machine."))
            case "ready":
                let shown = screen.models.filter { ModelSearch.matches(query, $0.label, screen.controls?.providerName ?? "") }
                if shown.isEmpty { ContentUnavailableView.search(text: query) }
                else {
                    Section {
                        ForEach(shown) { option in
                            ModelChoiceRow(provider: provider, label: option.label, detail: option.detail, chosen: option.id == chosen) { picked = option.id }
                                .accessibilityIdentifier("threadModel.\(option.label)")
                        }
                    } header: { InsetHeader(screen.controls?.providerName ?? "Models") }
                    .insetRowBackground()
                }
            case "failed":
                ContentUnavailableView {
                    Label("Couldn't load models", systemImage: "wifi.exclamationmark")
                } description: { Text("Your machine didn't answer. Check the connection and try again.") } actions: {
                    Button("Try again") { model.requestModels() }
                }
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
            // Effort and speed belong to the model in use; a newly picked one brings its own.
            if query.isEmpty, chosen == current?.id, let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty {
                ThreadTuneOptions(tune: tune, model: model)
            }
        }
        .onAppear { model.requestModels() }
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

/// Effort and speed for the thread's next message, as the bridge offers them.
private struct ThreadTuneOptions: View {
    let tune: TuneRow
    let model: ClientModel
    private var fastTier: TuneRow.SpeedTier? {
        guard tune.speeds.count == 2, tune.speeds.contains(where: { $0.speed == "standard" }) else { return nil }
        return tune.speeds.first { $0.speed != "standard" }
    }
    var body: some View {
        Section {
            if !tune.efforts.isEmpty {
                ModelOptionMenu(systemImage: "lightbulb", title: "Effort", value: tune.efforts.first { $0.id == tune.effort }?.label ?? "Default") {
                    ForEach(tune.efforts) { effort in
                        Button { Task { _ = await model.setEffort(effort.id) } } label: {
                            if effort.id == tune.effort { Label(effort.label, systemImage: "checkmark") } else { Text(effort.label) }
                        }
                    }
                    if tune.canReset { Button("Model default") { Task { _ = await model.setEffort(nil) } } }
                }
                .disabled(!tune.effortReason.isEmpty)
                .accessibilityIdentifier("composer.tune")
            }
            if let fastTier {
                FastModeRow(on: tune.speed == fastTier.speed, reason: tune.speedReason.isEmpty ? nil : tune.speedReason) { on in
                    Task { _ = await model.setSpeed(on ? fastTier.speed : "standard") }
                }
                .disabled(!tune.speedReason.isEmpty)
                .accessibilityIdentifier("composer.fast")
            } else if !tune.speeds.isEmpty {
                ModelOptionMenu(systemImage: "bolt", title: "Speed", value: tune.speeds.first { $0.speed == tune.speed }?.label ?? "") {
                    ForEach(tune.speeds) { tier in
                        Button { Task { _ = await model.setSpeed(tier.speed) } } label: {
                            if tier.speed == tune.speed { Label(tier.label, systemImage: "checkmark") } else { Text(tier.label) }
                        }
                    }
                }
                .disabled(!tune.speedReason.isEmpty)
            }
        } header: { InsetHeader("Options") } footer: {
            if tune.pending { Text("Applies with your next message.") }
            else if !tune.notice.isEmpty { Text(tune.notice) }
        }
        .insetRowBackground()
    }
}
