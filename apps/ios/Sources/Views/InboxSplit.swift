import SwiftUI

/// The Threads tab's list and open thread as one split view (`ThreadColumns`). A regular window
/// (iPad, the unfolded iPhone Duo) keeps the list beside the thread; a compact one (iPhone, the
/// folded Duo, a narrow iPad window) collapses it into a stack. The system moves the same views
/// between the two, so a resize or a fold keeps the thread, its scroll place, the draft and any
/// open sheet. Pages pushed from the thread open on the detail column's own stack.
struct InboxSplit<Sidebar: View, Page: View>: View {
    @Binding var path: [InboxRoute]
    /// What the detail column says while nothing is open.
    let empty: String
    /// This tab is the one showing; only it places the window's tab bar.
    let showing: Bool
    @ViewBuilder let list: () -> Sidebar
    @ViewBuilder let page: (InboxRoute) -> Page
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var visibility = NavigationSplitViewVisibility.all
    @State private var width: CGFloat = 0
    /// Counts the window's changes still settling; zero once the split view has settled.
    @State private var settling = 0
    /// The split view said the list is on top; it is, once the list itself appears.
    @State private var listReported = false
    /// The width of the window's controls in its top-leading corner; zero without them.
    @State private var windowControls: CGFloat = 0

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: compactColumn) {
            list()
                // The thread's bar carries the sidebar button, where the list it hides was.
                .toolbar(removing: .sidebarToggle)
                // Room for the wordmark beside the window's controls and its three buttons.
                .navigationSplitViewColumnWidth(min: ThreadColumns.listWidth.min, ideal: ThreadColumns.listWidth.ideal, max: ThreadColumns.listWidth.max)
                .environment(\.openThreadRow, ThreadColumns.selection(path))
                .environment(\.openForgeRow, path.first?.forge)
                .environment(\.onSidebarGlass, onSidebarGlass)
                .environment(\.headerLead, ThreadColumns.headerLead(sizeClass, windowControls: windowControls))
                // Going back to the list in a compact window closes the thread, as popping it did.
                .onAppear {
                    if ThreadColumns.backToList(sizeClass, reported: listReported) { path = [] }
                    listReported = false
                }
                // As a stack, the tab bar hides once a page is pushed; beside the list the
                // sidebar's foot takes its place.
                .toolbarVisibility(ThreadColumns.showsTabBar(sizeClass, path: path) ? .automatic : .hidden, for: .tabBar)
                .background { SidebarPlain().frame(width: 0, height: 0) }
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
                .toolbar {
                    if sizeClass == .regular {
                        ToolbarItem(placement: .topBarLeading) { SidebarButton(visibility: $visibility) }
                    }
                }
                .navigationDestination(for: InboxRoute.self) { page($0) }
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Beside the list there is no tab bar at all, nor room kept for one.
        .toolbarVisibility(ThreadColumns.sidebarHoldsTabs(sizeClass) ? .hidden : .automatic, for: .tabBar)
        // The tab bar controller itself follows the same rule, or its first layout keeps room for it.
        .background {
            if showing { TabBarPlace(hidden: !ThreadColumns.showsTabBar(sizeClass, path: path)).frame(width: 0, height: 0) }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onGeometryChange(for: CGFloat.self) { proxy in
            if #available(iOS 26, *) { proxy.containerCornerInsets.topLeading.width } else { 0 }
        } action: { windowControls = $0 }
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
    /// The split view reports the list on top whenever a compact window pops a page, the
    /// browser over a thread included: the report only arms `backToList`.
    private var compactColumn: Binding<NavigationSplitViewColumn> {
        Binding(get: { ThreadColumns.compactColumn(path) }, set: { column in
            if column == .sidebar, sizeClass == .compact { listReported = true }
        })
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
