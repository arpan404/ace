import SwiftUI

/// The phone's tab bar, drawn by ace in the iPad sidebar foot's system (`SidebarPlaces`): the
/// places the home screen switches between (Projects, Chats, Spade while a machine shows it,
/// Search) in one glass capsule, each glyph over its name as iOS labels its tabs, the one
/// showing on a filled capsule; then New thread (New chat on Chats) in a round capsule of its
/// own. Spade's tab is its full face, moving while a Spade bot works, which the system's bar
/// can't draw. It sits along the foot of each place's first page and steps away with it for a
/// pushed page, Select mode or the keyboard.
struct HomeBar: View {
    @Binding var tab: InboxTab
    /// New thread or New chat; nil where no machine can start one.
    let compose: (() -> Void)?
    /// Each place's dot: something there needs the person while it isn't showing.
    var needsYou: (InboxTab) -> Bool = { _ in false }
    @Environment(\.showsSpade) private var showsSpade
    @Environment(\.homeRetap) private var retap
    /// At accessibility text sizes the names leave the bar, as the system's tab bars drop theirs:
    /// a long press shows each in the Large Content Viewer instead.
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var keyboard = false
    @Namespace private var fill

    var body: some View {
        Group {
            if !keyboard {
                HStack(spacing: AceDesign.Space.related) {
                    places
                    if let compose { composeButton(compose) }
                }
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.bottom, AceDesign.Space.tight)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }

    private var places: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(HomeTabs.footPlaces(spade: showsSpade), id: \.self) { place in item(place) }
        }
        // Only the chosen fill slides; the page it opens shows at once.
        .animation(.default, value: tab)
        .padding(AceDesign.Size.tabInset)
        .barGlass(in: AceShape.capsule)
        .floatingShadow()
    }

    private func item(_ place: InboxTab) -> some View {
        let chosen = tab == place
        let dot = !chosen && needsYou(place)
        return Button {
            // Tapped again, the place showing goes back to its top, as the system's tabs do. Set
            // anyway: Search's own choice turns a second tap into focusing its field.
            if chosen { retap?.ask(place) }
            tab = place
        } label: {
            VStack(spacing: AceTheme.Spacing.none) {
                HomePlaceGlyph(place: place, chosen: chosen)
                    .overlay(alignment: .topTrailing) {
                        if dot {
                            Circle().fill(AceTheme.RowStatus.needsYou)
                                .frame(width: AceDesign.Size.dotSmall, height: AceDesign.Size.dotSmall)
                                .offset(x: AceDesign.Space.tight, y: -AceDesign.Space.tight / 2)
                        }
                    }
                if !typeSize.isAccessibilitySize {
                    Text(HomeTabs.title(place))
                        .aceFont(AceDesign.TextRole.caption)
                        .fontWeight(chosen ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
                        .foregroundStyle(chosen ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
            .background {
                if chosen { AceShape.capsule.fill(AceDesign.Surface.fill).matchedGeometryEffect(id: "chosen", in: fill) }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityShowsLargeContentViewer {
            HomePlaceGlyph(place: place, chosen: chosen)
            Text(HomeTabs.title(place))
        }
        .accessibilityLabel(HomeTabs.title(place))
        .accessibilityValue(dot ? "Needs you" : "")
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("tab.\(HomeTabs.identifier(place))")
    }

    /// The places capsule's height at the default text size: a tap-tall place inside its inset.
    private static let height = AceDesign.Size.tap + 2 * AceDesign.Size.tabInset

    /// New thread, round, in its own capsule at the bar's end, as tall as the places beside it.
    private func composeButton(_ compose: @escaping () -> Void) -> some View {
        let title = tab == .chats ? "New chat" : "New thread"
        return Button(action: compose) {
            Image(HomeTabs.tabImage(.compose, chosen: false))
                .resizable()
                .scaledToFit()
                .frame(width: AceDesign.Size.barIcon, height: AceDesign.Size.barIcon)
                .foregroundStyle(AceDesign.Ink.primary)
                .frame(width: Self.height, height: Self.height)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityShowsLargeContentViewer {
            Image(HomeTabs.tabImage(.compose, chosen: false))
            Text(title)
        }
        .barGlass(in: Circle())
        .floatingShadow()
        .accessibilityLabel(title)
        .accessibilityIdentifier("tab.compose")
    }
}

/// A place's glyph in the home bar and the iPad sidebar's foot: ace's own icon at the bar's size,
/// filled while its place shows; Spade's is its whole face, the same chosen or not, its eyes
/// moving while a Spade bot works (`spadeWorking`).
struct HomePlaceGlyph: View {
    let place: InboxTab
    let chosen: Bool
    @Environment(\.spadeWorking) private var spadeWorking

    var body: some View {
        Group {
            if place == .spade {
                SpadeMark(size: AceDesign.Size.barIcon, moving: spadeWorking)
            } else {
                Image(HomeTabs.tabImage(place, chosen: chosen))
                    .resizable()
                    .scaledToFit()
                    .frame(width: AceDesign.Size.barIcon, height: AceDesign.Size.barIcon)
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(chosen ? AceDesign.Ink.primary : AceDesign.Ink.muted)
    }
}

extension View {
    /// The home bar along the foot of a place's first page: the list scrolls on under it, behind
    /// the system's soft scroll edge on iOS 26.
    @ViewBuilder func homeBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom, spacing: AceTheme.Spacing.none) { bar() }
        } else {
            safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { bar() }
        }
    }
}

/// A place's tab tapped while it shows, counted per place: its list scrolls back to the top
/// (`scrollsToTop(on:)`). Observed per place, so a tap redraws only the list it asks.
@MainActor @Observable final class HomeRetap {
    private var asks: [InboxTab: Int] = [:]
    func ask(_ place: InboxTab) { asks[place, default: 0] += 1 }
    func count(_ place: InboxTab) -> Int { asks[place] ?? 0 }
}

extension View {
    /// The list scrolls back to its top when its place's tab is tapped again (`HomeRetap`).
    func scrollsToTop(on place: InboxTab) -> some View { modifier(ScrollsToTop(place: place)) }
}

private struct ScrollsToTop: ViewModifier {
    let place: InboxTab
    @Environment(\.homeRetap) private var retap
    @State private var position = ScrollPosition()
    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .onChange(of: retap?.count(place)) { withAnimation { position.scrollTo(edge: .top) } }
    }
}

extension EnvironmentValues {
    /// The home tabs' re-taps (`HomeRetap`); nil outside the home screen.
    @Entry var homeRetap: HomeRetap? = nil
    /// A Spade bot works on a machine that shows Spade: Spade's face in the bars moves its eyes.
    @Entry var spadeWorking = false
}
