import SwiftUI

/// One model: its name (and a muted line when there's more to say), and a check when it's the
/// one chosen.
struct ModelChoiceRow: View {
    let label: String
    var detail: String? = nil
    let chosen: Bool
    var busy = false
    let choose: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Button(action: choose) {
            HStack(spacing: AceTheme.Spacing.md) {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    // One line per model keeps the list even; accessibility sizes wrap instead.
                    Text(label).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    if let detail, !detail.isEmpty {
                        Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    }
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                if busy { ProgressView() }
                else if chosen { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.clear)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: chosen)
    }
}

/// "Options" under the models: effort, speed and access for the chosen model, plain rows.
struct ModelOptionsSection<Rows: View, Footer: View>: View {
    @ViewBuilder var rows: () -> Rows
    @ViewBuilder var footer: () -> Footer
    var body: some View {
        Section {
            rows().listRowBackground(Color.clear)
        } header: { InsetHeader("Options") } footer: {
            footer().aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .listSectionSeparator(.hidden, edges: .bottom)
    }
}

/// An option picked from a menu: "Effort … High ⌃⌄", "Access … Auto review ⌃⌄".
struct ModelOptionMenu<Items: View>: View {
    let title: String
    let value: String
    @ViewBuilder var items: () -> Items
    var body: some View {
        Menu(content: items) {
            InsetRow(systemImage: nil, title: title) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    InsetValue(text: value)
                    Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.semibold))
                        .foregroundStyle(AceTheme.Colours.decoration)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title).accessibilityValue(value)
    }
}

/// Fast mode: on runs the model's quickest tier, off its standard one. Shown only for models
/// that offer exactly a standard and a faster tier; more tiers get a menu instead.
struct FastModeRow: View {
    let on: Bool
    var reason: String? = nil
    let set: (Bool) -> Void
    var body: some View {
        InsetRow(systemImage: nil, title: "Fast mode", subtitle: reason) {
            Toggle("Fast mode", isOn: Binding(get: { on }, set: set)).labelsHidden()
        }
        .accessibilityElement(children: .combine)
        .sensoryFeedback(.selection, trigger: on)
    }
}
