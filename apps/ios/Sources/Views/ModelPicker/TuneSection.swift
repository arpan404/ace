import SwiftUI

/// The model sheet's Effort and Speed, above its models: each a label over its levels in words
/// on one glass capsule, one tap each, with the model's default named under it, or why the
/// provider can't change it now. VoiceOver reads a level as "Effort, Medium, default, selected".
struct TuneSection: View {
    let choices: TuneChoices
    let pickEffort: (TuneChoiceRow.Level) -> Void
    let pickSpeed: (TuneChoiceRow.Level) -> Void

    var body: some View {
        Section {
            if let effort = choices.effort { line("Effort", effort, id: "tune.effort", pick: pickEffort) }
            if let speed = choices.speed { line("Speed", speed, id: "tune.speed", pick: pickSpeed) }
            if let footer = choices.footer {
                Text(footer).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
                    .modifier(TuneRowPlacement())
                    .accessibilityIdentifier("tune.footer")
            }
        }
        .listSectionSeparator(.hidden)
    }

    private func line(_ title: String, _ row: TuneChoiceRow, id: String, pick: @escaping (TuneChoiceRow.Level) -> Void) -> some View {
        let items = row.levels.map { level in
            GlassChoiceItem(id: level.id, label: level.label, spoken: "\(title), \(level.label)",
                            spokenValue: level.isDefault ? "Default" : nil)
        }
        return OptionChoiceRow(title: title, items: items, selection: row.selected, note: Self.note(row),
                               disabled: row.reason != nil, idPrefix: id) { picked in
            if let level = row.levels.first(where: { $0.id == picked }) { pick(level) }
        }
        .modifier(TuneRowPlacement())
    }

    /// Why it can't change, else which level is the model's own.
    static func note(_ row: TuneChoiceRow) -> String? {
        row.reason ?? row.defaultLevel.map { "Default: \($0.label)" }
    }
}

/// A tune row on the sheet's plain list: no row fill or hairline, at the tab bar's margins.
private struct TuneRowPlacement: ViewModifier {
    func body(content: Content) -> some View {
        content
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: AceTheme.Spacing.lg,
                                      bottom: AceTheme.Spacing.none, trailing: AceTheme.Spacing.lg))
    }
}
