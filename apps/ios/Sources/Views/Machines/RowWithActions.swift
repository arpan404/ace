import SwiftUI

/// A list row whose actions are kept off it, as iOS lists do (ADR 0184): its title and a muted
/// line, then a ⋯ menu holding the actions, which a swipe to the left also uncovers but never
/// runs. Used where a row has one or two things to do (Revoke, Cancel link) that shouldn't read
/// as words beside it.
struct RowWithActions<Actions: View>: View {
    let title: String
    let detail: String?
    /// What VoiceOver calls the menu: "Actions for iPad Air".
    let actionsLabel: String
    let actionsId: String
    /// False on a view-only pairing: the row shows, its actions don't.
    let canOperate: Bool
    @ViewBuilder let actions: () -> Actions
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                Text(title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            .frame(maxWidth: .infinity, alignment: .leading)
            if canOperate {
                Menu { actions() } label: { RowActionsMark() }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(actionsLabel)
                    .accessibilityIdentifier(actionsId)
            }
        }
        .padding(.vertical, AceDesign.Space.tight)
        // No full swipe: Revoke, Cancel link and Unlink take effect or ask at once, so a long
        // swipe only uncovers them and a tap does the rest.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) { if canOperate { actions() } }
    }
}

/// The ⋯ that opens a row's actions: the system's ellipsis in a circle, in the action colour, on
/// a full tap target.
struct RowActionsMark: View {
    var body: some View {
        Image(systemName: "ellipsis.circle").font(.title3)
            .foregroundStyle(AceDesign.Ink.action)
            .frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap)
            .contentShape(Rectangle())
    }
}
