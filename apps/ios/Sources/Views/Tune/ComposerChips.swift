import SwiftUI

extension EnvironmentValues {
    /// The composer has room for its controls' names (its own row under the words).
    @Entry var composerRoomy = true
}

/// How tall a control in the composer's own row is: shorter than a touch target, so the row and
/// the words above it make one compact box. The control's tap area spans the row.
enum ComposerControlRow {
    static let height: CGFloat = 36
}

/// The composer's model controls, two taps: the model's name opens the model sheet; the effort
/// ("Med", "Med · Fast") opens effort and speed. The effort shows only when the model has levels or speeds.
struct ModelEffortChip: View {
    let provider: String?
    let model: String
    /// "Med", "Med · Fast"; nil when the model has nothing to tune.
    let effort: String?
    var loading = false
    var queued = false
    /// Why the model named isn't in effect yet, read out with it.
    var note: String? = nil
    let modelID: String
    let effortID: String
    let openModel: () -> Void
    let openEffort: () -> Void

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button(action: openModel) {
                HStack(spacing: AceTheme.Spacing.xs) {
                    if let provider, !provider.isEmpty { ProviderMark(provider: provider, size: 14) }
                    if loading { ProgressView().controlSize(.mini) }
                    Text(model).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: AceTheme.Spacing.xxxl * 3, alignment: .leading).fixedSize()
                    caret
                }
                .padding(.horizontal, AceTheme.Spacing.sm)
                .frame(minHeight: ComposerControlRow.height)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Model").accessibilityValue(model).accessibilityHint(note ?? "")
            .accessibilityIdentifier(modelID)
            if let effort {
                Button(action: openEffort) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        Text(effort).lineLimit(1).fixedSize()
                        caret
                    }
                    .padding(.horizontal, AceTheme.Spacing.sm)
                    .frame(minHeight: ComposerControlRow.height)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Effort and speed").accessibilityValue(effort)
                .accessibilityIdentifier(effortID)
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
    private var caret: some View {
        AceIcon(queued ? .clock : .caretDown, size: 11, relativeTo: .caption)
            .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

/// One access mode a menu offers: its name, what it does, and whether it is the riskier one.
struct AccessItem: Identifiable, Equatable {
    let mode: String
    let label: String
    let description: String
    let attention: Bool
    var id: String { mode }
    /// The riskier mode says so in words, never by colour alone.
    var detail: String { attention ? "Riskier: " + description.prefix(1).lowercased() + description.dropFirst() : description }
}

/// The composer's access control beside +: a shield and the mode's name ("⛨ Auto review ⌄"), the
/// shield alone where there is no room for the name. It opens the short access list.
struct AccessChip: View {
    let label: String
    let selected: String?
    let items: [AccessItem]
    var note: String? = nil
    var loading = false
    let identifier: String
    let select: (String) -> Void
    @Environment(\.composerRoomy) private var roomy
    @State private var choosing = false
    private var risky: Bool { items.first { $0.mode == selected }?.attention == true }

    var body: some View {
        Button { choosing = true } label: {
            HStack(spacing: AceTheme.Spacing.xs) {
                if loading { ProgressView().controlSize(.mini) }
                else { Image(systemName: risky ? "exclamationmark.shield" : "checkmark.shield").imageScale(.small) }
                if roomy {
                    Text(label).lineLimit(1).fixedSize()
                    AceIcon(.caretDown, size: 11, relativeTo: .caption)
                        .font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceTheme.Spacing.sm)
            .frame(minWidth: ComposerControlRow.height, minHeight: ComposerControlRow.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(items.isEmpty)
        .accessibilityLabel("Access").accessibilityValue(label)
        .accessibilityIdentifier(identifier)
        .sheet(isPresented: $choosing) {
            AccessSheet(selected: selected, items: items, note: note, identifier: identifier) { mode in
                choosing = false
                if mode != selected { select(mode) }
            }
        }
    }
}

/// The access modes as one short list: each mode on one row with what it does under it, the
/// current one ticked. Choosing one closes the sheet.
struct AccessSheet: View {
    let selected: String?
    let items: [AccessItem]
    var note: String? = nil
    let identifier: String
    let choose: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    AccessRows(selected: selected, items: items, identifier: identifier, choose: choose)
                } footer: { if let note { Text(note) } }
            }
            .insetGroupedList()
            .navigationTitle("Access")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}

/// The access rows, shared by the access sheet and the composer's settings sheet.
struct AccessRows: View {
    let selected: String?
    let items: [AccessItem]
    let identifier: String
    let choose: (String) -> Void
    var body: some View {
        ForEach(items) { item in
            Button { choose(item.mode) } label: {
                HStack(spacing: AceTheme.Spacing.md) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(item.label).aceFont(InsetStyle.label, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground)
                        Text(item.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                    }
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if item.mode == selected {
                        Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(AceTheme.Colours.foreground)
                    }
                }
                .padding(.vertical, AceTheme.Spacing.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .insetRowBackground()
            .accessibilityAddTraits(item.mode == selected ? .isSelected : [])
            .accessibilityIdentifier("\(identifier).\(item.mode)")
        }
    }
}
