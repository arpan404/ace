import SwiftUI

/// One model: its name (and a muted line when there's more to say), a check when it's the one
/// chosen, and a star that adds it to Favorites or takes it off. The name and its line are the
/// shared quiet row's, so the list reads with the rest of the app's inner pages.
struct ModelChoiceRow: View {
    let row: ModelPickerRow
    /// The choose button's accessibility identifier.
    let identifier: String
    var enabled = true
    let choose: () -> Void
    let star: () -> Void

    private var detail: String? {
        let line = [row.detail, row.note].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        return line.isEmpty ? nil : line
    }

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            Button(action: choose) {
                QuietSectionRow {
                    QuietRowText(title: row.label, detail: detail)
                    if row.chosen {
                        AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .subheadline)
                            .foregroundStyle(AceDesign.Ink.primary)
                    }
                }
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .accessibilityAddTraits(row.chosen ? .isSelected : [])
            .accessibilityIdentifier(identifier)
            Button(action: star) {
                Image(systemName: row.starred ? "star.fill" : "star")
                    .font(AceDesign.Typeface.title)
                    .foregroundStyle(row.starred ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                    .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.trailing, AceDesign.Space.tight)
            .accessibilityLabel(row.starred ? "Remove \(row.label) from favorites" : "Add \(row.label) to favorites")
            .accessibilityIdentifier("star.\(row.label)")
            .sensoryFeedback(.selection, trigger: row.starred)
        }
        .opacity(enabled ? 1 : AceDesign.Ink.dimmedOpacity)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        .sensoryFeedback(.selection, trigger: row.chosen)
    }
}

/// One option as its choices in words: "Effort" over Low · Medium · High, "Speed" over
/// Standard · Fast · Ultra. `note` says why it can't change now, or what the choice does.
struct OptionChoiceRow: View {
    let title: String
    let items: [GlassChoiceItem]
    let selection: String?
    var note: String? = nil
    var disabled = false
    let idPrefix: String
    let select: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Text(title).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
            GlassChoice(items: items, selection: selection, idPrefix: idPrefix, disabled: disabled, select: select)
            if let note, !note.isEmpty {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, AceTheme.Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
        .accessibilityIdentifier(idPrefix)
    }
}
