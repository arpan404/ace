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

/// The model's tuning in brief for the title's line: the level, and the speed when it isn't the
/// standard one ("Med · Fast"); nil when the model has nothing to tune.
enum TuneSummary {
    static func text(effort: String?, speed: String?, hasLevels: Bool, hasSpeeds: Bool) -> String? {
        guard hasLevels || hasSpeeds else { return nil }
        let parts = [effort ?? (hasLevels ? "Default" : nil), speed].compactMap { $0 }
        return parts.isEmpty ? "Standard" : parts.joined(separator: " · ")
    }
}

/// One access mode a menu offers: its name, what it does, and whether it is the riskier one.
struct AccessItem: Identifiable, Equatable {
    let mode: String
    let label: String
    let description: String
    let attention: Bool
    var id: String { mode }
    /// Match the web composer's access glyphs in both the chip and its choices.
    static func icon(for mode: String?) -> AceIcon.Name {
        switch mode {
        case "read-only": .eye
        case "ask": .handPalm
        case "auto-review": .shieldCheck
        case "full-access": .shieldWarning
        case nil: .shield
        default: .slidersHorizontal
        }
    }
    /// The riskier mode says so in words, never by colour alone.
    var detail: String { attention ? "Riskier: " + description.prefix(1).lowercased() + description.dropFirst() : description }
}

/// The access control uses the web's glyph for its selected mode, with its name when there is
/// room. Its icon remains distinct in compact layouts. It opens the short access list.
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

    var body: some View {
        Button { choosing = true } label: {
            HStack(spacing: AceTheme.Spacing.xs) {
                if loading { ProgressView().controlSize(.mini) }
                else { AceIcon(AccessItem.icon(for: selected), size: AceDesign.Size.metaIcon, relativeTo: .subheadline) }
                if roomy {
                    Text(label).lineLimit(1).fixedSize()
                    AceIcon(.caretDown, size: AceDesign.Size.caret, relativeTo: .caption)
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
                    AceIcon(AccessItem.icon(for: item.mode), size: AceDesign.Size.barIcon)
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(item.label).aceFont(InsetStyle.label, relativeTo: .body)
                            .foregroundStyle(AceTheme.Colours.foreground)
                        Text(item.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
                    }
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if item.mode == selected {
                        AceIcon(.check, size: AceDesign.Size.icon, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
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
