import SwiftUI

/// Inbox, Snoozed and Settled under the Threads title (ADR 0107), as the desktop's panel has
/// them: three words on one glass capsule, the open one on a filled capsule that slides between
/// them, Inbox and Snoozed with a quiet count after the word. The Inbox carries a small dot while
/// it is not open and a thread there needs the person.
/// The tabs, their words and which threads light the dot come from the runtimes (`MergedInbox`).
struct ThreadsTabsBar: View {
    let tabs: [MergedInbox.Tab]
    @Binding var selection: String
    /// Whether the Inbox's dot shows: one of its requests is in the list's scope.
    let dot: Bool
    /// Each tab's thread count in the list's scope: after the word where the tab counts, and for
    /// VoiceOver.
    let count: (String) -> Int
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Namespace private var fill

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(tabs) { tab in item(tab) }
        }
        .padding(3)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.top, AceTheme.Spacing.xs)
        .padding(.bottom, AceTheme.Spacing.sm)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Threads")
    }

    private func item(_ tab: MergedInbox.Tab) -> some View {
        let chosen = selection == tab.id
        let lit = tab.id == "inbox" && dot && !chosen
        let total = count(tab.id)
        return Button {
            withAnimation(reduceMotion ? nil : .smooth(duration: 0.25)) { selection = tab.id }
        } label: {
            HStack(spacing: 5) {
                Text(tab.label).lineLimit(1)
                if tab.counted && total > 0 {
                    Text(total.formatted()).monospacedDigit()
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                if lit {
                    Circle().fill(AceTheme.RowStatus.needsYou).frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .fontWeight(chosen ? .semibold : .medium)
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, 14)
            .frame(minHeight: 32)
            .background {
                if chosen {
                    AceShape.capsule.fill(AceTheme.Colours.foreground.opacity(0.12))
                        .matchedGeometryEffect(id: "chosen", in: fill)
                }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(.selection, trigger: chosen)
        .accessibilityLabel("\(tab.label), \(total)")
        .accessibilityValue(lit ? "Needs you" : "")
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("threads.tab.\(tab.id)")
    }
}
