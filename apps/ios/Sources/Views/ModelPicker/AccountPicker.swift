import SwiftUI

/// Which account's models the sheet lists: one capsule naming the shown account in full, with
/// its provider's mark, that opens a system menu of Favorites and every account. An account that
/// can't take work says why under its name. It never scrolls sideways, so the selected account is
/// always whole on screen; a long name wraps instead of being cut.
struct AccountPicker: View {
    let tabs: [ModelPickerTab]
    @Binding var shown: String

    private var tab: ModelPickerTab? { tabs.first { $0.id == shown } }

    var body: some View {
        Menu {
            ForEach(tabs) { entry in
                Button { shown = entry.id } label: {
                    Text(entry.name)
                    if let note = entry.note { Text(note) }
                    if entry.id == shown { Image(systemName: "checkmark") }
                }
                .accessibilityAddTraits(entry.id == shown ? .isSelected : [])
                .accessibilityIdentifier("tab.\(entry.id)")
            }
        } label: {
            HStack(spacing: AceDesign.Space.tight) {
                if let provider = tab?.provider {
                    ProviderMark(provider: provider, size: AceDesign.Size.icon, quiet: tab?.note != nil)
                } else {
                    Image(systemName: "star").font(AceDesign.Typeface.meta.weight(AceDesign.Typeface.strong))
                }
                Text(tab?.name ?? "").multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
                AceIcon(.caretDown, size: AceDesign.Size.caret, relativeTo: .caption)
                    .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .fontWeight(AceDesign.Typeface.strong)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .padding(.vertical, AceTheme.Spacing.xs)
            .frame(minHeight: AceDesign.Size.tap)
            .background(AceTheme.Colours.fill, in: AceShape.capsule)
            .contentShape(AceShape.capsule)
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel("Account").accessibilityValue(tab?.name ?? "")
        .accessibilityIdentifier("modelSheet.account")
        .sensoryFeedback(.selection, trigger: shown)
    }
}
