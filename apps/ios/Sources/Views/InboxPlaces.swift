import SwiftUI

/// ace (the threads and chats) and Spade at the foot of the sidebar, where a regular window (iPad, the
/// unfolded iPhone Duo, a large iPhone turned) keeps them instead of the tab bar: one two-way
/// switch, the place showing filled. A compact window has the tab bar back while its list fills
/// the window; as the drawer over a thread the list keeps New thread here too, beside the switch
/// where the tab bar keeps it, since the list's bar has no room for it.
struct InboxPlaces: View {
    @Binding var tab: InboxTab
    var compose: (() -> Void)? = nil
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if sizeClass == .regular {
            HStack(spacing: AceDesign.Space.related) {
                GlassSwitch(selection: $tab, choices: [
                    .init(value: .threads, title: "ace", identifier: "sidebar.threads"),
                    .init(value: .spade, title: "Spade", identifier: "sidebar.spade"),
                ])
                if let compose { ComposeCircle(action: compose, size: AceDesign.Size.tap + AceDesign.Space.tight) }
            }
            .padding(.horizontal, AceDesign.Space.row)
            .padding(.vertical, AceDesign.Space.related)
        } else {
            // A compact window's drawer and full list wear the same bar the window shows with
            // nothing open: Threads and Pulls with their icons, New thread on its own circle.
            HStack(spacing: AceDesign.Space.related) {
                PlacesTabBar(tab: $tab)
                Spacer(minLength: AceDesign.Space.related)
                if let compose { ComposeCircle(action: compose, size: AceDesign.Size.tabBar) }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.bottom, AceDesign.Space.tight)
        }
    }
}

/// ace and Spade as the phone's bottom bar draws them: an outline icon over its word, the place
/// showing on a filled capsule that slides between them, all on one glass capsule.
struct PlacesTabBar: View {
    @Binding var tab: InboxTab
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @Namespace private var fill

    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            item(.threads, title: "ace", identifier: "sidebar.threads") {
                Image(systemName: "bubble.left").font(.system(size: AceDesign.Size.tabIcon, weight: AceDesign.Typeface.regular))
            }
            item(.spade, title: "Spade", identifier: "sidebar.spade") { SpadeMark(size: AceDesign.Size.tabIcon) }
        }
        .padding(AceDesign.Space.tight)
        .frame(height: AceDesign.Size.tabBar)
        .aceGlass(in: AceShape.capsule, interactive: true)
    }

    private func item<Icon: View>(_ value: InboxTab, title: String, identifier: String, @ViewBuilder icon: () -> Icon) -> some View {
        let chosen = tab == value
        return Button {
            withAnimation(AceDesign.Motion.arriving(reduceMotion)) { tab = value }
        } label: {
            VStack(spacing: AceTheme.Spacing.xxs) {
                icon().frame(width: AceDesign.Size.tabIcon, height: AceDesign.Size.tabIcon)
                Text(title).aceFont(AceDesign.TextRole.tab, relativeTo: .caption2).lineLimit(1)
            }
            // The bar keeps its height, as the system's tab bar does.
            .dynamicTypeSize(...DynamicTypeSize.large)
            .foregroundStyle(chosen ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground)
            .frame(width: AceDesign.Size.tabWidth)
            .frame(maxHeight: .infinity)
            .background {
                if chosen {
                    AceShape.capsule.fill(AceDesign.Surface.chosen(scheme))
                        .matchedGeometryEffect(id: "chosen", in: fill)
                }
            }
            .contentShape(AceShape.capsule)
        }
        .buttonStyle(.plain)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: chosen)
        .accessibilityLabel(title)
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

/// Compose on its own glass circle, beside the places.
struct ComposeCircle: View {
    let action: () -> Void
    let size: CGFloat
    var label = "New thread"
    var body: some View {
        Button(action: action) {
            AceIcon(.notePencil, size: AceDesign.Size.composeGlyph)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: size, height: size)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Circle(), interactive: true)
        .accessibilityLabel(label)
        .accessibilityIdentifier("inbox.compose")
    }
}

/// The phone's bottom bar on the home screen: the tab pill at the left and compose alone at the
/// right, floating 8pt above the home indicator. It stands in for the system tab bar on an
/// iPhone, which can't be drawn at this size or carry Spade's two-tone mark; a regular window
/// keeps its sidebar and the system's own bar.
struct HomeBottomBar: ViewModifier {
    @Binding var tab: InboxTab
    let compose: (() -> Void)?
    var composeLabel = "New thread"
    /// Whether the bar shows: the home screen's lists and Spade, not a pushed page.
    var shown = true
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var safeBottom: CGFloat = 0

    func body(content: Content) -> some View {
        if sizeClass == .compact {
            content
                .toolbarVisibility(.hidden, for: .tabBar)
                .background { TabBarPlace(hidden: true, relayout: "home \(shown)").frame(width: 0, height: 0) }
                .bottomBar {
                    if shown {
                        HStack(spacing: AceDesign.Space.related) {
                            PlacesTabBar(tab: $tab)
                            Spacer(minLength: AceDesign.Space.related)
                            if let compose { ComposeCircle(action: compose, size: AceDesign.Size.tabBar, label: composeLabel) }
                        }
                        .padding(.horizontal, AceDesign.Space.margin)
                        // 8pt above the home indicator, wherever the safe area ends on this phone.
                        .padding(.bottom, AceDesign.Space.aboveHome + AceDesign.Space.homeIndicator - (safeBottom > 0 ? safeBottom : AceDesign.Space.homeIndicator))
                    }
                }
                // Read outside the bar's own inset, so the bar never moves the edge it reads.
                // (The system's scroll edge fades the rows under the bar on iOS 26.)
                .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.bottom } action: { safeBottom = $0 }
        } else {
            content
        }
    }
}

extension View {
    /// A bar floating over the page's foot: on iOS 26 it joins the system's scroll edge, as the
    /// tab bar does; before it, a plain inset.
    @ViewBuilder fileprivate func bottomBar<Bar: View>(@ViewBuilder _ bar: () -> Bar) -> some View {
        if #available(iOS 26, *) {
            safeAreaBar(edge: .bottom, spacing: AceTheme.Spacing.none, content: bar)
        } else {
            safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none, content: bar)
        }
    }
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
