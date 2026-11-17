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

/// What the model sheet's Effort and Speed rows show for the model it would run on. A thread's row
/// is there only when its model has more than one level to choose. New thread always shows Effort
/// for its model: a single level fixed, or a line saying the model has none.
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
    /// thread starts with them, so nothing blocks a row the model can change.
    static func model(_ model: ComposeAgent.Model, effort: String?, speed: String?) -> TuneChoices {
        let efforts = model.efforts.map { TuneChoiceRow.Level(id: $0.id, label: $0.label, isDefault: $0.id == model.defaultEffort) }
        let speedDefault = model.defaultSpeed ?? "standard"
        let speeds = (model.speeds ?? []).map { TuneChoiceRow.Level(id: $0.speed, label: $0.label, isDefault: $0.speed == speedDefault) }
        let pickedEffort = efforts.contains { $0.id == effort } ? effort : nil
        let pickedSpeed = speeds.contains { $0.id == speed } ? speed : nil
        let selected = pickedEffort ?? model.defaultEffort ?? efforts.first?.id ?? ""
        return TuneChoices(effort: row(efforts, selected: selected, reason: "") ?? fixed(efforts, selected: selected),
                           speed: row(speeds, selected: pickedSpeed ?? speedDefault, reason: ""), footer: nil)
    }

    /// New thread's model pill after the model's name: the effort it starts at in brief ("Med"),
    /// and a speed other than standard. Nil when the model has no levels to name.
    static func brief(_ model: ComposeAgent.Model, effort: String?, speed: String?) -> String? {
        let shown = Self.model(model, effort: effort, speed: speed)
        let level = shown.effort.flatMap { row in row.levels.first { $0.id == row.selected } }
        let effortWord = level.map { $0.label == "Medium" ? "Med" : $0.label }
        let speedWord = shown.speed.flatMap { row in row.levels.first { $0.id == row.selected && $0.id != "standard" } }?.label
        let parts = [effortWord, speedWord].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Effort a model can't change: its one level, or none at all, said in the row's note.
    private static func fixed(_ levels: [TuneChoiceRow.Level], selected: String) -> TuneChoiceRow {
        TuneChoiceRow(levels: levels, selected: selected,
                      reason: levels.isEmpty ? "This model has no effort levels" : "The only level this model has")
    }

    private static func row(_ levels: [TuneChoiceRow.Level], selected: String, reason: String) -> TuneChoiceRow? {
        guard levels.count > 1 else { return nil }
        return TuneChoiceRow(levels: levels, selected: selected, reason: reason.isEmpty ? nil : reason)
    }
}
