import Foundation

/// Effort or Speed at the top of the model sheet: its levels in words, the one selected, the
/// model's default marked, and why it can't change now.
struct TuneChoiceRow: Equatable {
    struct Level: Equatable, Identifiable {
        let id: String
        let label: String
        let isDefault: Bool
    }
    let levels: [Level]
    let selected: String
    /// Why the provider can't change it now; nil when it can.
    let reason: String?
    var defaultLevel: Level? { levels.first(where: \.isDefault) }
}

/// What the model sheet's Effort and Speed rows show for the model it would run on. A row is
/// there only when its model has more than one level to choose.
struct TuneChoices: Equatable {
    var effort: TuneChoiceRow?
    var speed: TuneChoiceRow?
    /// One quiet line under the rows: a pick waits for the next message, or what a move reset.
    var footer: String?

    var isEmpty: Bool { effort == nil && speed == nil }

    /// The thread's own model, as the bridge offers it (`thread.tune`).
    static func thread(_ tune: TuneRow) -> TuneChoices {
        let efforts = tune.efforts.map { TuneChoiceRow.Level(id: $0.id, label: $0.label, isDefault: $0.id == tune.effortPreset) }
        let speedDefault = tune.speedPreset ?? "standard"
        let speeds = tune.speeds.map { TuneChoiceRow.Level(id: $0.speed, label: $0.label, isDefault: $0.speed == speedDefault) }
        let footer = tune.pending ? "Applies with your next message." : (tune.notice.isEmpty ? nil : tune.notice)
        return TuneChoices(effort: row(efforts, selected: tune.effort, reason: tune.effortReason),
                           speed: row(speeds, selected: tune.speed, reason: tune.speedReason), footer: footer)
    }

    /// A model from the list: its own levels, the picked ones selected, else its defaults.
    /// `effortReason` and `speedReason` say why the provider can't take them.
    static func model(_ model: ComposeAgent.Model, effort: String?, speed: String?,
                      effortReason: String = "", speedReason: String = "") -> TuneChoices {
        let efforts = model.efforts.map { TuneChoiceRow.Level(id: $0.id, label: $0.label, isDefault: $0.id == model.defaultEffort) }
        let speedDefault = model.defaultSpeed ?? "standard"
        let speeds = (model.speeds ?? []).map { TuneChoiceRow.Level(id: $0.speed, label: $0.label, isDefault: $0.speed == speedDefault) }
        let pickedEffort = efforts.contains { $0.id == effort } ? effort : nil
        let pickedSpeed = speeds.contains { $0.id == speed } ? speed : nil
        return TuneChoices(effort: row(efforts, selected: pickedEffort ?? model.defaultEffort ?? efforts.first?.id ?? "", reason: effortReason),
                           speed: row(speeds, selected: pickedSpeed ?? speedDefault, reason: speedReason), footer: nil)
    }

    /// An open thread's sheet: the thread's own tuning while `target` is the model in use, else
    /// the picked model's levels. Another model on the same provider keeps the provider's
    /// reasons; another provider starts its session with what's picked, so nothing blocks it.
    static func forThread(tune: TuneRow?, current: NewThreadPickerRows.Chosen?, target: NewThreadPickerRows.Chosen?,
                          model: ComposeAgent.Model?, effort: String?, speed: String?) -> TuneChoices? {
        if target == nil || target == current { return tune.map(thread) }
        guard let model else { return nil }
        let sameProvider = target?.provider == current?.provider
        return Self.model(model, effort: effort, speed: speed,
                          effortReason: sameProvider ? tune?.effortReason ?? "" : "",
                          speedReason: sameProvider ? tune?.speedReason ?? "" : "")
    }

    private static func row(_ levels: [TuneChoiceRow.Level], selected: String, reason: String) -> TuneChoiceRow? {
        guard levels.count > 1 else { return nil }
        return TuneChoiceRow(levels: levels, selected: selected, reason: reason.isEmpty ? nil : reason)
    }
}
