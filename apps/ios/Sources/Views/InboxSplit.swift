import SwiftUI

/// The Threads tab's list and open thread (`ThreadColumns`, `ThreadDrawer`). A regular window
/// (iPad, the unfolded iPhone Duo) keeps the list beside the thread in the split view. A compact
/// one (iPhone, the folded Duo, a narrow iPad window) gives the open thread the whole window and
/// the list a drawer over it, or the whole window while nothing is open. The split view stays the
/// thread's home in both, so a resize or a fold keeps the thread, its scroll place, the draft and
/// any open sheet. Pages pushed from the thread open on the detail column's own stack.
struct InboxSplit<Sidebar: View, Page: View>: View {
    @Binding var path: [InboxRoute]
    @Binding var drawer: ThreadDrawer
    /// What the detail column says while nothing is open.
    let empty: String
    /// This tab is the one showing; only it places the window's tab bar.
    let showing: Bool
    @ViewBuilder let list: () -> Sidebar
    @ViewBuilder let page: (InboxRoute) -> Page
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var scheme
    @State private var visibility = NavigationSplitViewVisibility.all
    @State private var width: CGFloat = 0
    /// Counts the window's changes still settling; zero once the split view has settled.
    @State private var settling = 0
    /// The width of the window's controls in its top-leading corner; zero without them.
    @State private var windowControls: CGFloat = 0
    /// How far open the drawer is while a finger holds it; nil when none does.
    @State private var held: CGFloat?

    private var layout: ThreadDrawer.Layout { ThreadDrawer.layout(sizeClass, path: path) }
    private var shown: CGFloat { held ?? (drawer.isOpen ? 1 : 0) }
    private var placement: ThreadDrawer.Placement {
        ThreadDrawer.placement(layout, progress: shown, window: width, reduceMotion: reduceMotion)
    }
    /// The drawer follows a finger exactly and settles with the system's spring; Reduce Motion
    /// fades it instead.
    private var motion: Animation? {
        if held != nil { return nil }
        return reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring
    }

    var body: some View {
        ZStack(alignment: .topLeading) {
            split
                .animation(motion) { content in
                    content
                        .overlay { AceTheme.Colours.scrim.opacity(AceTheme.Opacity.scrim(scheme) * 2 * placement.dim).allowsHitTesting(false) }
                        .displayCorners(placement.rounded)
                        .offset(x: placement.pageOffset)
                }
                // Behind the drawer the page is one element, the closer over it.
                .accessibilityHidden(layout == .list || (layout == .page && drawer.isOpen))
            if layout != .beside { drawerLayer }
        }
        .gesture(DrawerEdgePan(enabled: ThreadDrawer.edgeOpens(layout, path: path) && !drawer.isOpen, follows: !reduceMotion,
                               began: beginHold, moved: { held = ThreadDrawer.progress(from: false, translation: $0, width: placement.listWidth) },
                               ended: { release(from: false, translation: $0, velocity: $1) }))
        // As a stack, the tab bar hides once a page is open; beside the list the sidebar's foot
        // takes its place and there is no tab bar at all, nor room kept for one.
        .toolbarVisibility(ThreadColumns.showsTabBar(sizeClass, path: path) ? .automatic : .hidden, for: .tabBar)
        // The tab bar controller itself follows the same rule, or its first layout keeps room for it.
        .background {
            if showing { TabBarPlace(hidden: !ThreadColumns.showsTabBar(sizeClass, path: path)).frame(width: 0, height: 0) }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onGeometryChange(for: CGFloat.self) { proxy in
            if #available(iOS 26, *) { proxy.containerCornerInsets.topLeading.width } else { 0 }
        } action: { windowControls = $0 }
        .onChange(of: path) { old, new in drawer.follow(layout: layout, old: old, new: new) }
        .onChange(of: layout) { _, now in drawer.follow(layout: now, old: path, new: path); held = nil }
        // The columns follow the window's shape when it changes, and leave the person's own
        // sidebar toggle alone in between. Expanding from a stack, the split view picks its own
        // columns just after the change: while it settles, the window's columns win.
        .onChange(of: ColumnsChange(sizeClass: sizeClass, wanted: columns), initial: true) { _, change in
            visibility = change.wanted
            settling += 1
        }
        // While a window change settles, the split view's own late layout passes (a turn, the tab
        // bar leaving) never pick the columns; after that the sidebar button is the person's.
        .onChange(of: visibility) { _, now in
            if settling > 0, now != columns { visibility = columns }
        }
        .task(id: settling) {
            guard settling > 0 else { return }
            try? await Task.sleep(for: .milliseconds(800))
            if !Task.isCancelled { settling = 0 }
        }
    }

    private var split: some View {
        // A compact window always shows the detail column: the list is the drawer's, never a
        // page under the thread to go back to.
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: .constant(.detail)) {
            Group {
                if layout == .beside {
                    listed(onGlass: onSidebarGlass)
                        .background { SidebarPlain().frame(width: 0, height: 0) }
                } else {
                    Color.clear.accessibilityHidden(true)
                }
            }
            // The thread's bar carries the sidebar button, where the list it hides was.
            .toolbar(removing: .sidebarToggle)
            // Room for the wordmark beside the window's controls and its three buttons.
            .navigationSplitViewColumnWidth(min: ThreadColumns.listWidth.min, ideal: ThreadColumns.listWidth.ideal, max: ThreadColumns.listWidth.max)
        } detail: {
            NavigationStack(path: detail) {
                Group {
                    // A new thread is a new page: its feed, sheets and draft start fresh.
                    if let first = path.first {
                        page(first).id(first)
                            .environment(\.closeOpenThread, first.thread.map { key in CloseOpenThread(id: key.id) { path = [] } })
                    }
                    else { EmptyState(icon: nil, title: empty).frame(maxHeight: .infinity) }
                }
                // Only the open page's root opens the list; pages pushed over it go back.
                .navigationBarBackButtonHidden(sizeClass != .regular)
                .toolbar {
                    if sizeClass == .regular {
                        ToolbarItem(placement: .topBarLeading) { SidebarButton(visibility: $visibility) }
                    } else if !path.isEmpty {
                        ToolbarItem(placement: .topBarLeading) { DrawerButton(action: openDrawer) }
                    }
                }
                .navigationDestination(for: InboxRoute.self) { page($0) }
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    /// The list over a compact window: the whole window while nothing is open, otherwise out
    /// from the leading edge over the dimmed page. Open, it is a modal region VoiceOver leaves
    /// with the escape gesture, the dimmed page one Close sidebar button beside it.
    private var drawerLayer: some View {
        ZStack(alignment: .topLeading) {
            if layout == .page && shown > 0 {
                // Over the part of the page still in sight, beside the list.
                let leading = reduceMotion ? placement.listWidth : placement.pageOffset
                DrawerCloser(close: closeDrawer, moved: { held = ThreadDrawer.progress(from: true, translation: $0, width: placement.listWidth) },
                             ended: { release(from: true, translation: $0, velocity: $1) })
                    .frame(width: max(width - leading, 0))
                    .frame(maxHeight: .infinity)
                    .offset(x: leading)
            }
            NavigationStack { listed(onGlass: false) }
                .animation(motion) { content in
                    content
                        .frame(width: max(placement.listWidth, 0))
                        .offset(x: placement.listOffset)
                        .opacity(placement.listOpacity)
                }
                .allowsHitTesting(layout == .list || (drawer.isOpen && held == nil))
                .accessibilityHidden(layout == .page && !drawer.isOpen)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(layout == .page && drawer.isOpen ? .isModal : [])
        .accessibilityAction(.escape) { closeDrawer() }
    }

    /// The list with what it reads from the split: the open row, its header's place, and
    /// whether it carries the tabs.
    private func listed(onGlass: Bool) -> some View {
        list()
            .environment(\.openThreadRow, ThreadColumns.selection(path))
            .environment(\.openForgeRow, path.first?.forge)
            .environment(\.onSidebarGlass, onGlass)
            .environment(\.listHoldsTabs, ThreadDrawer.listHoldsTabs(layout))
            .environment(\.headerLead, ThreadColumns.headerLead(sizeClass, windowControls: windowControls))
    }

    private func openDrawer() {
        dismissKeyboard()
        drawer.open(in: layout)
    }
    private func closeDrawer() {
        held = nil
        drawer.close()
    }
    private func beginHold() {
        dismissKeyboard()
        if reduceMotion { drawer.open(in: layout) } else { held = 0 }
    }
    private func release(from open: Bool, translation: CGFloat, velocity: CGFloat) {
        guard held != nil else { return }
        let progress = ThreadDrawer.progress(from: open, translation: translation, width: placement.listWidth)
        let open = ThreadDrawer.settlesOpen(progress: progress, velocity: velocity)
        held = nil
        if open { drawer.open(in: layout) } else { drawer.close() }
    }
    private func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// Beside a page the iPadOS 26 sidebar is the system's glass panel: the list draws nothing
    /// behind its rows, so no page colour sits inside the panel's edge. A stack keeps the page.
    private var onSidebarGlass: Bool {
        guard #available(iOS 26, *) else { return false }
        return ThreadColumns.sidebarHoldsTabs(sizeClass)
    }
    private var columns: NavigationSplitViewVisibility {
        ThreadColumns.visibility(sizeClass, width: width, open: !path.isEmpty)
    }
    private var detail: Binding<[InboxRoute]> {
        Binding(get: { ThreadColumns.detail(path) }, set: { path = ThreadColumns.path(path, detail: $0) })
    }
}

/// What the split view's columns follow: the window's size class and the columns it wants.
private struct ColumnsChange: Equatable {
    let sizeClass: UserInterfaceSizeClass?
    let wanted: NavigationSplitViewVisibility
}

extension EnvironmentValues {
    /// The thread open beside the list, whose row reads as selected.
    @Entry var openThreadRow: InboxKey?
    /// How far the list's header steps in (`ThreadColumns.headerLead`).
    @Entry var headerLead: CGFloat = 0
    /// The pull request or issue open beside the list.
    @Entry var openForgeRow: ForgeRoute?
    /// Closes the detail column's own thread; pages pushed over it go back instead.
    @Entry var closeOpenThread: CloseOpenThread?
    /// The list carries Threads, Pull requests and New thread itself (`ThreadDrawer.listHoldsTabs`).
    @Entry var listHoldsTabs = false
}

struct CloseOpenThread {
    let id: String
    let close: () -> Void
}

/// Hides and shows the list beside the thread, from the thread's bar: the iPhone's list slides
/// away and the thread recentres in its reading column.
private struct SidebarButton: View {
    @Binding var visibility: NavigationSplitViewVisibility
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let hidden = visibility == .detailOnly
        Button {
            withAnimation(reduceMotion ? nil : .smooth) { visibility = hidden ? .all : .detailOnly }
        } label: { Image(systemName: "sidebar.left") }
            .accessibilityLabel(hidden ? "Show Sidebar" : "Hide Sidebar")
            .accessibilityIdentifier("split.sidebar")
            .keyboardShortcut("s", modifiers: [.command, .control])
    }
}
