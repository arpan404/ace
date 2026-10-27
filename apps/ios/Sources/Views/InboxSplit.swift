import SwiftUI

/// The Threads tab's list and open thread (`ThreadColumns`, `ThreadDrawer`). A regular window
/// (iPad, the unfolded iPhone Duo) keeps the list beside the thread in the split view. A compact
/// one (iPhone, the folded Duo, a narrow iPad window) gives the open thread the whole window and
/// the list a drawer over it, or the whole window while nothing is open. The split view stays the
/// thread's home in both, so a resize or a fold keeps the thread, its scroll place, the draft and
/// any open sheet. Pages pushed from the thread open on the detail column's own stack.
struct InboxSplit<Sidebar: View, Page: View, Side: View>: View {
    @Binding var path: [InboxRoute]
    @Binding var drawer: ThreadDrawer
    /// What the detail column says while nothing is open.
    let empty: String
    /// This tab is the one showing; only it places the window's tab bar.
    let showing: Bool
    @ViewBuilder let list: () -> Sidebar
    @ViewBuilder let page: (InboxRoute) -> Page
    /// The side panel of the thread showing, beside the detail's stack (`ThreadSidePanel`).
    @ViewBuilder let side: (InboxKey, PanelPart) -> Side
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var visibility = NavigationSplitViewVisibility.all
    @State private var width: CGFloat = 0
    /// Counts the window's changes still settling; zero once the split view has settled.
    @State private var settling = 0
    /// The width of the window's controls in its top-leading corner; zero without them.
    @State private var windowControls: CGFloat = 0
    /// Where a finger holds the drawer. This view never reads it, so a drag never redraws the
    /// thread or the list, only the modifiers that place them (`DrawerPlace`).
    @State private var hold = DrawerHold()
    /// The list stepped aside for the thread's side panel (`ThreadWorkspace`).
    @State private var panelYield = false
    /// Each time the person brought the list back over such a panel.
    @State private var reclaimed = 0
    /// The list column's width when it last showed fully.
    @State private var listColumn: CGFloat = ThreadColumns.listWidth.ideal
    /// The list's width as it stepped aside, kept while it is away: measuring it as it slides
    /// would tell the panel it has room again, bringing the list back, and round again.
    @State private var yieldedList: CGFloat = 0
    @State private var panelPlace = PanelPlace.none
    /// Set once the window first shows, for the tab bar's place (`TabBarPlace`).
    @State private var appeared = false
    @State private var panelColumn: PanelColumnWidth?
    /// Each time the system closed the inspector itself.
    @State private var panelDismissed = 0

    private var layout: ThreadDrawer.Layout { ThreadDrawer.layout(sizeClass, path: path) }
    /// The drawer settles with the system's spring; Reduce Motion fades it instead.
    private var motion: Animation { reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring }
    private var listWidth: CGFloat { ThreadDrawer.listWidth(window: width) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            split
                .modifier(DrawerPlace(part: .page, hold: hold, stop: drawer.stop, window: width, reduceMotion: reduceMotion))
                // Behind the drawer the page is one element, the closer over it.
                .accessibilityHidden(layout == .list || (layout == .page && drawer.isOpen))
            if layout != .beside { drawerLayer }
        }
        // The list's own page colour behind the pushed page, so its rounded corners show.
        .background { if layout != .beside { AceTheme.Colours.background.ignoresSafeArea() } }
        .gesture(DrawerEdgePan(enabled: ThreadDrawer.edgeOpens(layout, path: path) && !drawer.isOpen, follows: !reduceMotion,
                               began: beginHold, moved: { [hold, listWidth] in hold.move($0, width: listWidth) },
                               ended: { release(velocity: $1) }))
        // As a stack, the tab bar hides once a page is open; beside the list the sidebar's foot
        // takes its place and there is no tab bar at all, nor room kept for one.
        .toolbarVisibility(ThreadColumns.showsTabBar(sizeClass, path: path) ? .automatic : .hidden, for: .tabBar)
        // The tab bar controller itself follows the same rule, or its first layout keeps room for it.
        .background {
            if showing { TabBarPlace(hidden: !ThreadColumns.showsTabBar(sizeClass, path: path), relayout: "\(panelColumn != nil) \(path.count) \(sizeClass == .regular) \(appeared)").frame(width: 0, height: 0) }
        }
        .task { try? await Task.sleep(for: .milliseconds(300)); appeared = true }
        // Set outside any animation: a launch, a turn or a window resize never springs the list.
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onGeometryChange(for: CGFloat.self) { proxy in
            if #available(iOS 26, *) { proxy.containerCornerInsets.topLeading.width } else { 0 }
        } action: { windowControls = $0 }
        .onChange(of: path) { old, new in
            let wasOpen = drawer.isOpen
            withAnimation(motion) { drawer.follow(layout: layout, old: old, new: new) }
            if wasOpen && !drawer.isOpen { closed() }
        }
        // A thread opened from the full-width list slides in over it; archiving it slides it away.
        .onChange(of: layout, initial: true) { old, now in
            hold.drop()
            withAnimation(old == now ? nil : motion) { hold.layout = now }
            drawer.follow(layout: now, old: path, new: path)
        }
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
            // The person showed the list over a panel that had it step aside: the panel gives way.
            else if panelYield, now != .detailOnly { panelYield = false; reclaimed += 1 }
        }
        // Nothing open, nothing needs the room.
        .onChange(of: path.isEmpty) { _, empty in
            guard empty else { return }
            yieldList(false)
            panelPlace = .none
            panelColumn = nil
        }
        .task(id: settling) {
            guard settling > 0 else { return }
            try? await Task.sleep(for: .milliseconds(800))
            if !Task.isCancelled { settling = 0 }
        }
    }

    private var split: some View {
        // A compact window always shows the detail column: the list is the drawer's, never a
        // page under the thread to go back to. The split view reports its sidebar on top each
        // time a page pushed over the thread pops, so that report opens nothing. Back stays
        // hidden at the root, which leaves the system's back swipe off there, and VoiceOver's
        // escape at the root opens the drawer instead.
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: .constant(.detail)) {
            Group {
                if layout == .beside {
                    listed(onGlass: onSidebarGlass)
                        .background { SidebarPlain().frame(width: 0, height: 0) }
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if $0 >= ThreadColumns.listWidth.min, !panelYield { listColumn = $0 } }
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
                // VoiceOver's escape at the page's root goes back to the list, as the drawer.
                .accessibilityAction(.escape) { if layout == .page { openDrawer() } }
                .toolbar {
                    if sizeClass == .regular {
                        ToolbarItem(placement: .topBarLeading) { SidebarButton(visibility: $visibility) }
                    } else if !path.isEmpty {
                        ToolbarItem(placement: .topBarLeading) { DrawerButton(action: toggleDrawer) }
                    }
                }
                .navigationDestination(for: InboxRoute.self) { page($0) }
            }
            .environment(\.panelPlace, panelPlace)
            // The decisions behind the open thread's side panel, and its column in the inspector.
            .background { if let key = ThreadColumns.panelScope(path) { side(key, .state) } }
            .inspector(isPresented: inspectorShown) {
                Group {
                    if let key = ThreadColumns.panelScope(path) { side(key, .column) } else { AceTheme.Colours.background }
                }
                .inspectorColumnWidth(min: panelColumn?.min ?? 320, ideal: panelColumn?.ideal ?? 400, max: panelColumn?.max ?? 560)
            }
            .environment(\.panelRoom, panelRoom)
        }
        .navigationSplitViewStyle(.balanced)
    }

    /// The list over a compact window: the whole window while nothing is open, otherwise out
    /// from the leading edge over the dimmed page. Open, it is a modal region VoiceOver leaves
    /// with the escape gesture (Esc on a keyboard), the dimmed page one Close sidebar button.
    private var drawerLayer: some View {
        ZStack(alignment: .topLeading) {
            DrawerCloser(hold: hold, layout: layout, stop: drawer.stop, window: width, listWidth: listWidth, reduceMotion: reduceMotion,
                         close: closeDrawer, ended: { release(velocity: $0) })
            NavigationStack { listed(onGlass: false) }
                .modifier(DrawerPlace(part: .list, hold: hold, stop: drawer.stop, window: width, reduceMotion: reduceMotion))
            if layout == .page && drawer.isOpen { Color.clear.frame(width: 0, height: 0).escapeCloses(closeDrawer) }
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
        hold.drop()
        withAnimation(motion) { drawer.open(in: layout) }
    }
    private func closeDrawer() {
        guard drawer.isOpen || hold.progress != nil else { return }
        hold.drop()
        withAnimation(motion) { drawer.close() }
        closed()
    }
    private func toggleDrawer() { if drawer.isOpen { closeDrawer() } else { openDrawer() } }
    private func beginHold() {
        dismissKeyboard()
        if reduceMotion { openDrawer() } else { hold.begin(from: 0, full: ThreadDrawer.full(window: width)) }
    }
    private func release(velocity: CGFloat) {
        let wasOpen = drawer.isOpen
        withAnimation(motion) {
            guard let stop = hold.release(velocity: velocity) else { return }
            drawer.settle(stop, in: layout)
        }
        if wasOpen && !drawer.isOpen { closed() }
    }
    /// Once the list goes in, nothing of it keeps the keyboard, and VoiceOver moves to the page.
    private func closed() {
        dismissKeyboard()
        UIAccessibility.post(notification: .screenChanged, argument: nil)
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
        panelYield ? .detailOnly : ThreadColumns.visibility(sizeClass, width: width, open: !path.isEmpty)
    }
    /// What the thread's side panel may borrow: the list beside it, to step aside when the two
    /// don't fit together. Only beside the list; a compact window's tools open over the thread.
    private var panelRoom: PanelRoom? {
        guard layout == .beside else { return nil }
        let listShows = ThreadColumns.sideBySide(sizeClass, width: width) && visibility != .detailOnly
        return PanelRoom(window: width, list: panelYield ? yieldedList : listShows ? listColumn : 0, reclaimed: reclaimed,
                         dismissed: panelDismissed, yield: yieldList, place: $panelPlace, column: $panelColumn)
    }
    /// The inspector shows while the open thread's panel has a column; closing it from outside
    /// (the system, a gesture) hides the thread's panel.
    private var inspectorShown: Binding<Bool> {
        Binding(get: { panelColumn != nil }, set: { shown in if !shown, panelColumn != nil { panelDismissed += 1 } })
    }
    /// The list steps aside for the panel, or comes back once it no longer needs the room.
    private func yieldList(_ wants: Bool) {
        guard wants != panelYield else { return }
        if wants, visibility == .detailOnly { return }
        if wants { yieldedList = listColumn }
        withAnimation(motion) {
            panelYield = wants
            visibility = columns
        }
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
