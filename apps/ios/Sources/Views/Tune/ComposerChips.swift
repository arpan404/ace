import SwiftUI

extension EnvironmentValues {
    /// The composer shows its controls on their own row under the words, with room for names.
    @Entry var composerRoomy = true
    /// Drawn as a small quiet chip under the thread's composer: words only, on a soft capsule.
    @Entry var composerChip = false
}

/// The soft capsule behind a chip under the composer, shorter than the control's touch target.
private struct ChipBackground: ViewModifier {
    let on: Bool
    func body(content: Content) -> some View {
        content.background {
            if on {
                AceShape.capsule.fill(AceTheme.Colours.fill)
                    .frame(height: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.lg)
            }
        }
    }
}

/// The composer's model control in two parts, one tap each: "◎ Opus 5.5" opens the model sheet,
/// "Med ⌄" opens effort and speed. The effort part shows only when the model has levels or speeds.
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
    @Environment(\.composerChip) private var chip

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            Button(action: openModel) {
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    if !chip, let provider, !provider.isEmpty { ProviderMark(provider: provider, size: 15) }
                    if loading { ProgressView().controlSize(.mini) }
                    Text(model).foregroundStyle(chip ? AceTheme.Colours.mutedForeground : AceTheme.Colours.foreground).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: AceTheme.Spacing.xxxl * 3, alignment: .leading).fixedSize()
                    if effort == nil && !chip { caret }
                }
                .padding(.leading, chip ? AceTheme.Spacing.md - AceTheme.Spacing.xxs : AceTheme.Spacing.sm)
                .padding(.trailing, effort == nil ? (chip ? AceTheme.Spacing.md - AceTheme.Spacing.xxs : AceTheme.Spacing.sm) : AceTheme.Spacing.xs)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Model").accessibilityValue(model)
            .accessibilityIdentifier(modelID)
            if let effort {
                Button(action: openEffort) {
                    HStack(spacing: AceTheme.Spacing.xs) {
                        Text("·").foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
                        Text(effort).lineLimit(1).fixedSize()
                        if !chip { caret }
                    }
                    .padding(.trailing, chip ? AceTheme.Spacing.md - AceTheme.Spacing.xxs : AceTheme.Spacing.sm)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Effort and speed").accessibilityValue(effort)
                .accessibilityIdentifier(effortID)
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .modifier(ChipBackground(on: chip))
    }
    private var caret: some View {
        AceIcon(queued ? .clock : .caretDown, size: 12, relativeTo: .caption)
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

/// The composer's access control beside +: a shield and the mode's name ("⛨ Ask ⌄"), the shield
/// alone while the composer is one line. A native menu lists the modes the agent supports, each
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
    @Environment(\.composerChip) private var chip
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
                else if !chip { Image(systemName: risky ? "exclamationmark.shield" : "checkmark.shield").imageScale(.medium) }
                if roomy || chip {
                    Text(label).lineLimit(1).fixedSize()
                }
                if roomy && !chip {
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.horizontal, chip ? AceTheme.Spacing.md - AceTheme.Spacing.xxs : AceTheme.Spacing.xs)
            .modifier(ChipBackground(on: chip))
            .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(items.isEmpty)
        .accessibilityLabel("Access").accessibilityValue(label)
        .accessibilityIdentifier(identifier)
    }
}
