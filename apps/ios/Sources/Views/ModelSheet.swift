import SwiftUI

/// The model sheet's frame, shared by the thread's composer and New thread: X on the left, a
/// prominent check on the right, provider groups and options as inset groups, and "Find a model"
/// search (in the bottom bar on iOS 26).
struct ModelSheet<Content: View>: View {
    @Binding var query: String
    var confirming = false
    /// Puts back what the sheet changed as it went, when X closes it.
    var cancel: () -> Void = {}
    let confirm: () -> Void
    @ViewBuilder var content: () -> Content
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List { content() }
                .insetGroupedList()
                .searchable(text: $query, prompt: "Find a model")
                .navigationTitle("Model").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { cancel(); dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("modelSheet.close")
                    }
                    ToolbarItem(placement: .confirmationAction) { confirmButton }
                }
        }
        .tint(AceTheme.Colours.foreground)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
    }
    @ViewBuilder private var confirmButton: some View {
        if confirming { ProgressView() }
        else if #available(iOS 26, *) {
            Button(role: .confirm, action: confirm) { Image(systemName: "checkmark").foregroundStyle(AceTheme.Colours.onAccent) }
                .buttonStyle(.glassProminent).tint(AceTheme.Colours.accent)
                .accessibilityLabel("Done").accessibilityIdentifier("modelSheet.done")
        } else {
            Button(action: confirm) { Image(systemName: "checkmark").fontWeight(.semibold) }
                .accessibilityLabel("Done").accessibilityIdentifier("modelSheet.done")
        }
    }
}

/// Whether a model's name or its provider's matches what was typed into "Find a model".
enum ModelSearch {
    static func matches(_ query: String, _ words: String...) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces)
        return needle.isEmpty || words.contains { $0.localizedCaseInsensitiveContains(needle) }
    }
}

/// One model: its provider's mark, its name (and a muted line when there's more to say), and a
/// check when it's the one chosen.
struct ModelChoiceRow: View {
    let provider: String
    let label: String
    var detail: String? = nil
    let chosen: Bool
    var busy = false
    let choose: () -> Void

    var body: some View {
        Button(action: choose) {
            HStack(spacing: AceTheme.Spacing.md + AceTheme.Spacing.xxs) {
                ProviderMark(provider: provider, size: 20).foregroundStyle(AceTheme.Colours.foreground)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    Text(label).aceFont(InsetStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
                    if let detail, !detail.isEmpty {
                        Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                    }
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                if busy { ProgressView() }
                else if chosen { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .sensoryFeedback(.selection, trigger: chosen)
    }
}

/// An option picked from a menu: "Effort … High ⌃⌄", "Access … Auto review ⌃⌄".
struct ModelOptionMenu<Items: View>: View {
    let systemImage: String
    let title: String
    let value: String
    @ViewBuilder var items: () -> Items
    var body: some View {
        Menu(content: items) {
            InsetRow(systemImage: systemImage, title: title) {
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
        InsetRow(systemImage: "bolt", title: "Fast mode", subtitle: reason) {
            Toggle("Fast mode", isOn: Binding(get: { on }, set: set)).labelsHidden()
        }
        .accessibilityElement(children: .combine)
        .sensoryFeedback(.selection, trigger: on)
    }
}
