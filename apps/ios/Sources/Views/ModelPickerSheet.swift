import SwiftUI

/// The open thread's model sheet, opened from the composer's model chip: effort for the next
/// message first, as a stepped slider (the thing changed most), then the models its account
/// offers, then speed. Picking a model marks it; the check switches the thread to it from its next
/// turn. Effort and speed apply at once to the model in use.
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
    /// Effort and speed belong to the model in use; a newly picked one brings its own.
    private var tune: TuneRow? { query.isEmpty && chosen == current?.id ? screen.tune : nil }

    var body: some View {
        ModelSheet(query: $query, confirming: switching, confirm: confirm) {
            if let tune, !tune.efforts.isEmpty {
                Section {
                    EffortSlider(tune: tune) { effort in Task { _ = await model.setEffort(effort) } }
                } footer: {
                    if tune.pending { Text("Applies with your next message.") }
                }
                .insetRowBackground()
            }
            switch screen.modelsState {
            case "ready" where screen.models.isEmpty:
                EmptyState(icon: .cpu, title: "No models listed", line: "Check this account on your machine.")
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
                EmptyState(icon: .wifiX, title: "Couldn't load models", line: "Your machine didn't answer. Check the connection and try again.", failed: true) {
                    Button("Try again") { model.requestModels() }
                }
            default:
                HStack { Spacer(); ProgressView(); Spacer() }.listRowBackground(Color.clear)
            }
            if let tune, !tune.speeds.isEmpty { ThreadSpeedOptions(tune: tune, model: model) }
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

/// Effort as the web's control draws it: the level's name over a stepped slider, the lowest,
/// middle and highest names under it, and a reset to the model's default once changed. Each
/// step is the bridge's level; a level the model can't take is the bridge's reason.
struct EffortSlider: View {
    let tune: TuneRow
    let set: (String?) -> Void
    @State private var position: Double?
    @State private var dragging = false
    private var index: Int { tune.efforts.firstIndex { $0.id == tune.effort } ?? 0 }
    private var shown: Int { Int((position ?? Double(index)).rounded()) }
    var body: some View {
        VStack(spacing: AceTheme.Spacing.xs) {
            HStack {
                Text("Effort").foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer()
                Text(tune.efforts.indices.contains(shown) ? tune.efforts[shown].label : "Default")
                    .foregroundStyle(AceTheme.Colours.foreground)
                if tune.canReset {
                    Button { set(nil) } label: {
                        AceIcon(.arrowUUpLeft, size: 16, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Model default")
                    .accessibilityIdentifier("composer.tune.reset")
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            if tune.efforts.count > 1 {
                // A drag picks when it ends; VoiceOver's steps pick at once.
                Slider(value: Binding(get: { position ?? Double(index) }, set: { position = $0; if !dragging { commit() } }),
                       in: 0...Double(tune.efforts.count - 1), step: 1) { editing in
                    dragging = editing
                    if !editing { commit() }
                }
                .tint(AceTheme.Colours.foreground)
                .accessibilityLabel("Effort")
                .accessibilityValue(tune.efforts.indices.contains(shown) ? tune.efforts[shown].label : "")
                .accessibilityIdentifier("composer.tune")
                HStack {
                    Text(tune.efforts.first?.label ?? "")
                    Spacer()
                    if tune.efforts.count > 2 { Text(tune.efforts[tune.efforts.count / 2].label) }
                    Spacer()
                    Text(tune.efforts.last?.label ?? "")
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityHidden(true)
            }
            if !tune.effortReason.isEmpty {
                Text(tune.effortReason).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .disabled(!tune.effortReason.isEmpty)
        .padding(.vertical, AceTheme.Spacing.xs)
        .sensoryFeedback(.selection, trigger: shown)
        // The bridge's level replaces the slider's own once it lands.
        .onChange(of: tune.effort) { position = nil }
    }
    private func commit() {
        guard let position else { return }
        let picked = Int(position.rounded())
        if picked != index, tune.efforts.indices.contains(picked) { set(tune.efforts[picked].id) }
    }
}

/// Speed for the thread's next message, as the bridge offers it.
private struct ThreadSpeedOptions: View {
    let tune: TuneRow
    let model: ClientModel
    private var fastTier: TuneRow.SpeedTier? {
        guard tune.speeds.count == 2, tune.speeds.contains(where: { $0.speed == "standard" }) else { return nil }
        return tune.speeds.first { $0.speed != "standard" }
    }
    var body: some View {
        Section {
            if let fastTier {
                FastModeRow(on: tune.speed == fastTier.speed, reason: tune.speedReason.isEmpty ? nil : tune.speedReason) { on in
                    Task { _ = await model.setSpeed(on ? fastTier.speed : "standard") }
                }
                .disabled(!tune.speedReason.isEmpty)
                .accessibilityIdentifier("composer.fast")
            } else {
                ModelOptionMenu(systemImage: "bolt", title: "Speed", value: tune.speeds.first { $0.speed == tune.speed }?.label ?? "") {
                    ForEach(tune.speeds) { tier in
                        Button { Task { _ = await model.setSpeed(tier.speed) } } label: {
                            if tier.speed == tune.speed { Label(tier.label, ace: .check) } else { Text(tier.label) }
                        }
                    }
                }
                .disabled(!tune.speedReason.isEmpty)
            }
        } footer: {
            if !tune.notice.isEmpty { Text(tune.notice) }
        }
        .insetRowBackground()
    }
}
