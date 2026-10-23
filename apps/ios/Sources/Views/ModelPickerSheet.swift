import SwiftUI

/// The open thread's model sheet: the models its provider and account offer (a thread keeps
/// its provider, so there is no provider row), then effort and speed for the next message.
/// Picking a model marks it; the check switches the thread to it from its next turn. Effort and
/// speed apply at once to the model in use, as the composer's control did.
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
    private var state: ModelPickerState {
        switch screen.modelsState {
        case "ready": .ready
        case "failed": .failed(title: "Couldn't load models", message: "Your machine didn't answer. Check the connection and try again.")
        default: .loading
        }
    }
    private var groups: [ModelPickerGroup] {
        let rows = screen.models.filter { ModelSearch.matches(query, $0.label) }
            .map { ModelPickerRow(id: $0.id, label: $0.label, detail: $0.detail, chosen: $0.id == chosen) }
        return rows.isEmpty ? [] : [ModelPickerGroup(id: provider, rows: rows)]
    }

    var body: some View {
        ModelPicker(query: $query, shown: .constant(provider), state: state, groups: groups, rowPrefix: "threadModel",
                    retry: { model.requestModels() }, confirming: switching, confirm: confirm,
                    choose: { picked = $0.id }) {
            // Effort and speed belong to the model in use; a newly picked one brings its own.
            if chosen == current?.id, let tune = screen.tune, !tune.efforts.isEmpty || !tune.speeds.isEmpty {
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
        ModelOptionsSection {
            if !tune.efforts.isEmpty {
                ModelOptionMenu(title: "Effort", value: tune.efforts.first { $0.id == tune.effort }?.label ?? "Default") {
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
                ModelOptionMenu(title: "Speed", value: tune.speeds.first { $0.speed == tune.speed }?.label ?? "") {
                    ForEach(tune.speeds) { tier in
                        Button { Task { _ = await model.setSpeed(tier.speed) } } label: {
                            if tier.speed == tune.speed { Label(tier.label, systemImage: "checkmark") } else { Text(tier.label) }
                        }
                    }
                }
                .disabled(!tune.speedReason.isEmpty)
            }
        } footer: {
            if tune.pending { Text("Applies with your next message.") }
            else if !tune.notice.isEmpty { Text(tune.notice) }
        }
    }
}
