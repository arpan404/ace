import SwiftUI

/// The places at the foot of the iPad sidebar, where a regular window (iPad, the unfolded iPhone
/// Duo, a large iPhone turned) keeps them instead of the tab bar. Two glass capsules: at the
/// leading edge the places the window switches between, in the web rail's order (Projects, Chats,
/// Spade while a machine shows it, Search), the one showing on a filled capsule; at the trailing
/// edge what opens over it: More (Automations and Skills, then Usage, History and Archived) and
/// Settings. Code review sits in the Projects list's top bar, as on a phone. A phone has the
/// system's own tab bar instead, with the same places and glyphs.
struct SidebarPlaces: View {
    @Binding var tab: InboxTab
    /// Opens one of the places outside the lists.
    let open: (SearchPlace) -> Void
    /// Each switchable place's dot: something there needs the person while it isn't showing.
    var needsYou: (InboxTab) -> Bool = { _ in false }
    @Environment(\.showsSpade) private var showsSpade

    /// The machine tools, then the rail's quieter places, in one menu before Settings.
    private static let tools: [SearchPlace] = [.automations, .skills]
    private static let more: [SearchPlace] = [.usage, .history, .archived]

    var body: some View {
        HStack(spacing: AceDesign.Space.related) {
            // The chosen fill glides under a finger, as the system's tab bar's does; the tab it
            // opens shows at once.
            GlidingPlaces(places: HomeTabs.footPlaces(spade: showsSpade), chosen: tab, spacing: AceDesign.Space.tight) { place, lit in
                switchItem(place, lit: lit)
            } select: { place in
                tab = place
            }
            .barGlass(in: AceShape.capsule)
            .floatingShadow()
            Spacer(minLength: AceTheme.Spacing.none)
            HStack(spacing: AceDesign.Space.tight) {
                Menu {
                    Section { ForEach(Self.tools) { place in menuItem(place) } }
                    Section { ForEach(Self.more) { place in menuItem(place) } }
                } label: { placeGlyph(.dotsThree) }
                .buttonStyle(.plain)
                .accessibilityLabel("More")
                .accessibilityIdentifier("sidebar.more")
                placeButton(.settings)
            }
            .padding(AceDesign.Size.tabInset)
            .barGlass(in: AceShape.capsule)
            .floatingShadow()
        }
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.vertical, AceDesign.Space.related)
    }

    private func menuItem(_ place: SearchPlace) -> some View {
        Button(place.title, ace: place.icon) { open(place) }
            .accessibilityIdentifier("sidebar.place.\(place.rawValue)")
    }

    private func placeButton(_ place: SearchPlace) -> some View {
        Button { open(place) } label: { placeGlyph(place.icon) }
            .buttonStyle(.plain)
            .accessibilityLabel(place.title)
            .accessibilityIdentifier("sidebar.place.\(place.rawValue)")
    }

    private func placeGlyph(_ icon: AceIcon.Name) -> some View {
        AceIcon(icon, size: AceDesign.Size.barIcon)
            .foregroundStyle(AceDesign.Ink.muted)
            .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
            .contentShape(AceShape.capsule)
            .tapBand(drawn: AceDesign.Size.navButton, width: AceDesign.Size.navButton)
    }

    private func switchItem(_ place: InboxTab, lit: Bool) -> some View {
        let dot = tab != place && needsYou(place)
        return HomePlaceGlyph(place: place, chosen: lit)
            .frame(width: AceDesign.Size.tap, height: AceDesign.Size.navButton)
            .overlay(alignment: .topTrailing) {
                if dot {
                    Circle().fill(AceTheme.RowStatus.needsYou)
                        .frame(width: AceDesign.Size.dotSmall, height: AceDesign.Size.dotSmall)
                        .padding(AceDesign.Space.tight)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(HomeTabs.title(place))
            .accessibilityValue(dot ? "Needs you" : "")
            .accessibilityIdentifier("sidebar.\(HomeTabs.identifier(place))")
    }
}

/// A place's glyph at the iPad sidebar's foot: ace's own icon at the bar's size, filled while its
/// place shows; Spade's is its whole face, the same chosen or not, its eyes moving while a Spade
/// bot works (`spadeWorking`), which the system's tab bar can't draw.
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

/// Whether the system's tab bar shows over a home place. A regular window hides it, the
/// sidebar's foot holding the places; a phone shows it on a place's first page and hides it for
/// a pushed page or Select mode. Set on the tab bar controller too (`TabBarPlace`): hidden only
/// through SwiftUI, its first layout keeps room for the bar, and a window turning compact again
/// would leave it hidden.
struct HomeTabBar: ViewModifier {
    var hidden = true
    /// The bar slides as it shows or hides (a phone's push); a regular window sets it at once.
    var animated = false
    /// Changes when the tabs may be laid out again (`TabBarPlace.relayout`).
    var relayout = "home"
    func body(content: Content) -> some View {
        content
            .toolbarVisibility(hidden ? .hidden : .visible, for: .tabBar)
            .background { TabBarPlace(hidden: hidden, animated: animated, relayout: relayout).frame(width: 0, height: 0) }
    }
}

extension View {
    /// A bar along the sidebar's foot: the list's end scrolls up from under it and fades out,
    /// so no row reads through the two rows. On the iPadOS 26 sidebar's glass that is the
    /// system's own scroll edge; elsewhere a fade into the page colour.
    @ViewBuilder func inboxFootBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            modifier(GlassFootBar(bar: bar()))
        } else {
            pageFootBar(bar)
        }
    }
    fileprivate func pageFootBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            bar().background(alignment: .top) {
                VStack(spacing: AceTheme.Spacing.none) {
                    LinearGradient(colors: [AceTheme.Colours.background.opacity(0), AceTheme.Colours.background],
                                   startPoint: .top, endPoint: .bottom)
                        .frame(height: AceDesign.Space.fade)
                    AceTheme.Colours.background
                }
                .padding(.top, -AceDesign.Space.fade)
                .ignoresSafeArea(edges: .bottom)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }
}

@available(iOS 26, *)
private struct GlassFootBar<Bar: View>: ViewModifier {
    let bar: Bar
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    func body(content: Content) -> some View {
        if onGlass {
            content
                .safeAreaBar(edge: .bottom, spacing: AceTheme.Spacing.none) { bar }
                .scrollEdgeEffectStyle(.hard, for: .bottom)
        } else {
            content.pageFootBar { bar }
        }
    }
}
