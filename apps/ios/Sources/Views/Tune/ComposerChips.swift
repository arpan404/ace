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
            .accessibilityLabel("Model").accessibilityValue(model)
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
/// shield alone where there is no room for the name. A native menu lists the modes the agent supports, each
/// with what it does; `note` (a pick waiting for the next turn, a stricter default) heads it.
struct AccessChip: View {
    let label: String
    let selected: String?
    let items: [AccessItem]
    var note: String? = nil
    var loading = false
    let identifier: String
    let select: (String) -> Void
    @Environment(\.composerRoomy) private var roomy
    private var risky: Bool { items.first { $0.mode == selected }?.attention == true }

    var body: some View {
        Menu {
            Section {
                ForEach(items) { item in
                    Button { if item.mode != selected { select(item.mode) } } label: {
                        if item.mode == selected { Label(item.label, systemImage: "checkmark") } else { Text(item.label) }
                        Text(item.detail)
                    }
                    .accessibilityIdentifier("\(identifier).\(item.mode)")
                }
            } header: { if let note { Text(note) } }
        } label: {
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
    }
}
