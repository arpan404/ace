import SwiftUI

/// The thread's header under its title (the page pills) as the navigation bar's own accessory:
/// on iOS 26 a `safeAreaBar` with the system's scroll-edge effect, so rows blur away under the
/// title and the pills together as they do under Mail's. Pinned pills take the hard edge Apple
/// uses under a pinned control; the transcript alone keeps the soft one. Before iOS 26 it sits on
/// the page colour.
struct ThreadHeaderBar<Bar: View>: ViewModifier {
    let pinned: Bool
    @ViewBuilder let bar: () -> Bar
    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content
                .scrollEdgeEffectStyle(pinned ? .hard : .soft, for: .top)
                .safeAreaBar(edge: .top, spacing: AceTheme.Spacing.none, content: bar)
        } else {
            content.safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { bar().background(AceTheme.Colours.background) }
        }
    }
}

/// The thread's pages side by side, a swipe apart, one screen wide each. Chat is always built, so
/// the transcript keeps its place and its reading position while another page shows. Every
/// other page is built only while some of it is on screen (the one showing, and its neighbour
/// during a swipe); off screen it is an empty page, so nothing it follows (a terminal, a live
/// browser, the agent tree) keeps streaming. A page that takes sideways touches of its own (the
/// live browser) holds the swipe; the pill row still moves between pages.
struct ThreadPager<Page: View>: View {
    let pages: ThreadPages
    /// The page showing once a swipe settles; a pill or a command sets it too.
    @Binding var shown: ThreadPageKind
    /// The page takes sideways drags itself: no swiping away from it.
    let holdsSwipe: Bool
    @ViewBuilder let page: (ThreadPageKind) -> Page
    @Environment(\.aceReduceMotion) private var reduceMotion
    @State private var position: ThreadPageKind?
    /// Pages with any part on screen right now.
    @State private var visible: Set<ThreadPageKind> = []

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: AceTheme.Spacing.none) {
                ForEach(pages.kinds) { kind in
                    Group {
                        if kind == .chat || kind == shown || visible.contains(kind) {
                            page(kind)
                        } else {
                            AceDesign.Surface.background
                        }
                    }
                    .containerRelativeFrame(.horizontal)
                    // Off screen, a page is hidden from VoiceOver and touch.
                    .accessibilityHidden(kind != shown)
                    .id(kind)
                }
            }
            .scrollTargetLayout()
        }
        // The page colour behind every page, which the header's scroll-edge effect takes up.
        .background(AceDesign.Surface.background)
        .scrollTargetBehavior(.paging)
        .scrollPosition(id: $position)
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .scrollDisabled(holdsSwipe || pages.kinds.count < 2)
        .onScrollGeometryChange(for: [Int].self) { geometry in
            let width = geometry.containerSize.width
            guard width > 0 else { return [] }
            let at = geometry.contentOffset.x / width
            return Array(Set([Int(at.rounded(.down)), Int(at.rounded(.up))])).sorted()
        } action: { _, indices in
            visible = Set(indices.compactMap { pages.kinds.indices.contains($0) ? pages.kinds[$0] : nil })
        }
        .onAppear { position = shown }
        .onChange(of: position) { _, settled in
            if let settled, settled != shown { shown = settled }
        }
        .onChange(of: shown) { _, page in
            guard position != page else { return }
            withAnimation(reduceMotion ? nil : AceDesign.Motion.arrive) { position = page }
        }
        // A page that went away (a browser closed) leaves the pager on Chat.
        .onChange(of: pages.kinds) { _, kinds in
            if !kinds.contains(shown) { shown = .chat }
        }
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: shown)
    }
}
