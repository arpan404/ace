import SwiftUI

/// The places at the foot of the iPad sidebar, where a regular window (iPad, the unfolded iPhone
/// Duo, a large iPhone turned) keeps them instead of the tab bar, in the web rail's order: Threads,
/// Chats and Search switch the place, then a short hairline, then Code review (a place of its own,
/// as the rail's), then Automations, Skills, More (Usage, History and Archived) and Settings,
/// which open over it. Bare glyphs on one glass capsule; the place showing
/// sits on a filled capsule. A phone has the system tab bar instead.
struct SidebarPlaces: View {
    @Binding var tab: InboxTab
    /// Opens one of the places outside the lists.
    let open: (SearchPlace) -> Void
    /// Each switchable place's dot: something there needs the person while it isn't showing.
    var needsYou: (InboxTab) -> Bool = { _ in false }
    @Namespace private var fill

    private static let others: [SearchPlace] = [.automations, .skills]
    /// The rail's quieter places, one menu between Skills and Settings.
    private static let more: [SearchPlace] = [.usage, .history, .archived]

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            ForEach(HomeTabs.switchable.filter { $0 != .review }, id: \.self) { place in switchItem(place) }
            Capsule().fill(AceDesign.Ink.faint)
                .frame(width: AceTheme.Dimensions.border, height: AceDesign.Size.icon)
                .padding(.horizontal, AceDesign.Space.tight)
                .accessibilityHidden(true)
            switchItem(.review)
            ForEach(Self.others) { place in placeButton(place) }
            Menu {
                ForEach(Self.more) { place in
                    Button(place.title, ace: place.icon) { open(place) }
                        .accessibilityIdentifier("sidebar.place.\(place.rawValue)")
                }
            } label: { placeGlyph(.dotsThree) }
            .buttonStyle(.plain)
            .accessibilityLabel("More")
            .accessibilityIdentifier("sidebar.more")
            placeButton(.settings)
        }
        // Only the chosen fill slides; the tab it opens shows at once, as the tab bar's do.
        .animation(.default, value: tab)
        .padding(AceDesign.Size.tabInset)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .floatingShadow()
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceDesign.Space.row)
        .padding(.vertical, AceDesign.Space.related)
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

    private func switchItem(_ place: InboxTab) -> some View {
        let chosen = tab == place
        let dot = !chosen && needsYou(place)
        return Button {
            tab = place
        } label: {
            Group {
                if place == .spade { SpadeMark(size: AceDesign.Size.barIcon) } else { AceIcon(HomeTabs.icon(place), size: AceDesign.Size.barIcon) }
            }
                .foregroundStyle(chosen ? AceDesign.Ink.primary : AceDesign.Ink.muted)
                .frame(width: AceDesign.Size.navButton, height: AceDesign.Size.navButton)
                .overlay(alignment: .topTrailing) {
                    if dot {
                        Circle().fill(AceTheme.RowStatus.needsYou)
                            .frame(width: AceDesign.Size.dotSmall, height: AceDesign.Size.dotSmall)
                            .padding(AceDesign.Space.tight)
                    }
                }
                .background {
                    if chosen {
                        AceShape.capsule.fill(AceDesign.Surface.fill).matchedGeometryEffect(id: "chosen", in: fill)
                    }
                }
                .contentShape(AceShape.capsule)
                .tapBand(drawn: AceDesign.Size.navButton, width: AceDesign.Size.navButton)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: chosen)
        .accessibilityLabel(HomeTabs.title(place))
        .accessibilityValue(dot ? "Needs you" : "")
        .accessibilityAddTraits(chosen ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("sidebar.\(HomeTabs.identifier(place))")
    }
}

/// The system tab bar on a page of its own (Search, Spade): shown on a phone, hidden in a regular
/// window, whose sidebar foot holds the places. Set on the tab bar controller too (`TabBarPlace`),
/// since a list's tab may have hidden it there.
struct HomeTabBar: ViewModifier {
    let shown: Bool
    func body(content: Content) -> some View {
        content
            .toolbarVisibility(shown ? .automatic : .hidden, for: .tabBar)
            .background { TabBarPlace(hidden: !shown, relayout: "home \(shown)").frame(width: 0, height: 0) }
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
