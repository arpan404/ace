import SwiftUI

/// The room a page leaves under the thread's header (the page pills drawn over the pages), so
/// its first row starts below them; rows still scroll beneath, under the header's fade.
struct PageHeaderClearance: ViewModifier {
    let height: CGFloat
    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
            Color.clear.frame(height: height).accessibilityHidden(true)
        }
    }
}

/// The header's soft edge under the navigation bar: rows fade into the page colour behind the
/// page pills and out again below them, as they fade under the bar above. The system's own edge
/// effect only reaches a list that no other scroll view holds, and the pages sit in the pager's,
/// so this draws the same fade the composer's floor does at the bottom (`BarFloor`). Never a box:
/// it has no edge of its own.
struct ThreadHeaderFade: View {
    private let fade = AceDesign.Space.fade
    var body: some View {
        VStack(spacing: AceTheme.Spacing.none) {
            LinearGradient(colors: [AceTheme.Colours.background.opacity(0), AceTheme.Colours.background], startPoint: .top, endPoint: .bottom)
                .frame(height: fade)
            AceTheme.Colours.background
            LinearGradient(colors: [AceTheme.Colours.background, AceTheme.Colours.background.opacity(0)], startPoint: .top, endPoint: .bottom)
                .frame(height: fade)
        }
        .padding(.vertical, -fade)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
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
