import SwiftUI

/// One model: its name (and a muted line when there's more to say), a check when it's the one
/// chosen, and a star that adds it to Favorites or takes it off.
struct ModelChoiceRow: View {
    let row: ModelPickerRow
    /// The choose button's accessibility identifier.
    let identifier: String
    var enabled = true
    let choose: () -> Void
    let star: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Button(action: choose) {
                HStack(spacing: AceTheme.Spacing.md) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                        // One line per model keeps the list even; accessibility sizes wrap instead.
                        Text(row.label).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                        if let detail = [row.detail, row.note].compactMap({ $0 }).filter({ !$0.isEmpty }).joined(separator: " · ") as String?,
                           !detail.isEmpty {
                            Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                        }
                    }
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if row.chosen { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!enabled)
            .accessibilityAddTraits(row.chosen ? .isSelected : [])
            .accessibilityIdentifier(identifier)
            Button(action: star) {
                Image(systemName: row.starred ? "star.fill" : "star")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(row.starred ? AceTheme.Colours.foreground : AceTheme.Colours.decoration)
                    .frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(row.starred ? "Remove \(row.label) from favorites" : "Add \(row.label) to favorites")
            .accessibilityIdentifier("star.\(row.label)")
            .sensoryFeedback(.selection, trigger: row.starred)
        }
        .opacity(enabled ? 1 : 0.5)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 0, leading: AceTheme.Spacing.xl, bottom: 0, trailing: AceTheme.Spacing.xs))
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
