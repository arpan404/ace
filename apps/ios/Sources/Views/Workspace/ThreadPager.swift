import SwiftUI

/// The thread's header under its title (its status at accessibility sizes) as the navigation
/// bar's own accessory: on iOS 26 a `safeAreaBar`, so rows pass under the title and the status
/// together, behind the hard edge Apple uses under a pinned control. Without a status there is
/// no accessory: the bar alone keeps the system's soft edge over the transcript. Before iOS 26
/// it sits on the page colour.
struct ThreadHeaderBar<Bar: View>: ViewModifier {
    let shown: Bool
    @ViewBuilder let bar: () -> Bar
    func body(content: Content) -> some View {
        if !shown {
            content
        } else if #available(iOS 26, *) {
            content
                .scrollEdgeEffectStyle(.hard, for: .top)
                .safeAreaBar(edge: .top, spacing: AceTheme.Spacing.none, content: bar)
        } else {
            content.safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) { bar().background(AceTheme.Colours.background) }
        }
    }
}

/// The thread's pages side by side (Chat, then Changes), a swipe apart, one screen wide each. Chat
/// is always built, so the transcript keeps its place and its reading position while Changes
/// shows. Changes is built only while some of it is on screen (showing, or during a swipe); off
/// screen it is an empty page, so its diff isn't followed while nobody reads it.
struct ThreadPager<Page: View>: View {
    let pages: ThreadPages
    /// The page showing once a swipe settles; a bar button or a command sets it too.
    @Binding var shown: ThreadPageKind
    @ViewBuilder let page: (ThreadPageKind) -> Page
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
        .scrollDisabled(pages.kinds.count < 2)
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
            // A bar button or a command shows its page at once, as a segmented control swaps what it
            // shows: never a slide through the pages between. A swipe stays the finger's.
            position = page
        }
        // A page that went away (the changes committed) leaves the pager on Chat.
        .onChange(of: pages.kinds) { _, kinds in
            if !kinds.contains(shown) { shown = .chat }
        }
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: shown)
    }
}
