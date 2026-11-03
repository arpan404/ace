import SwiftUI

/// Inbox, Chats, Snoozed and Settled under the title (ADR 0107), as the desktop's panel has the
/// thread tabs: words on one glass capsule, the open one on a filled capsule that slides between
/// them, Inbox and Snoozed with a quiet count after the word. Inbox and Chats carry a small dot
/// while not open and something there needs the person.
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
        .padding(AceDesign.Space.tight)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.tight)
        .padding(.bottom, AceDesign.Space.related)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Threads")
    }

    private func item(_ tab: MergedInbox.Tab) -> some View {
        let chosen = selection == tab.id
        let lit = !chosen && (tab.id == "inbox" ? dot : tab.chats && tab.needsYou > 0)
        let total = count(tab.id)
        return Button {
            withAnimation(AceDesign.Motion.arriving(reduceMotion)) { selection = tab.id }
        } label: {
            HStack(spacing: AceDesign.Space.tight) {
                Text(tab.label).lineLimit(1)
                if tab.counted && total > 0 {
                    Text(total.formatted()).monospacedDigit()
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
                if lit {
                    Circle().fill(AceTheme.RowStatus.needsYou).frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
                        .accessibilityHidden(true)
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .fontWeight(chosen ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceDesign.Space.row)
            .frame(minHeight: AceDesign.Size.tap)
            .background {
                if chosen {
                    AceShape.capsule.fill(AceDesign.Surface.fill)
                        .matchedGeometryEffect(id: "chosen", in: fill)
                }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: chosen)
        .accessibilityLabel("\(tab.label), \(total)")
        .accessibilityValue(lit ? "Needs you" : "")
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("threads.tab.\(tab.id)")
    }
}
