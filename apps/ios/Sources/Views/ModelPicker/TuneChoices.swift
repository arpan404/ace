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

    /// New thread's model: its own levels, the picked ones selected, else its defaults. A new
    /// thread starts with them, so nothing blocks a row.
    static func model(_ model: ComposeAgent.Model, effort: String?, speed: String?) -> TuneChoices {
        let efforts = model.efforts.map { TuneChoiceRow.Level(id: $0.id, label: $0.label, isDefault: $0.id == model.defaultEffort) }
        let speedDefault = model.defaultSpeed ?? "standard"
        let speeds = (model.speeds ?? []).map { TuneChoiceRow.Level(id: $0.speed, label: $0.label, isDefault: $0.speed == speedDefault) }
        let pickedEffort = efforts.contains { $0.id == effort } ? effort : nil
        let pickedSpeed = speeds.contains { $0.id == speed } ? speed : nil
        return TuneChoices(effort: row(efforts, selected: pickedEffort ?? model.defaultEffort ?? efforts.first?.id ?? "", reason: ""),
                           speed: row(speeds, selected: pickedSpeed ?? speedDefault, reason: ""), footer: nil)
    }

    private static func row(_ levels: [TuneChoiceRow.Level], selected: String, reason: String) -> TuneChoiceRow? {
        guard levels.count > 1 else { return nil }
        return TuneChoiceRow(levels: levels, selected: selected, reason: reason.isEmpty ? nil : reason)
    }
}
