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
                .toolbar(removing: pinned ? .sidebarToggle : nil)
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
                .navigationDestination(for: InboxRoute.self) { page($0) }
            }
        }
        .navigationSplitViewStyle(.balanced)
        // Beside the list there is no tab bar at all, nor room kept for one.
        .toolbarVisibility(ThreadColumns.sidebarHoldsTabs(sizeClass) ? .hidden : .automatic, for: .tabBar)
        .background { TabBarPlace(hidden: ThreadColumns.sidebarHoldsTabs(sizeClass)).frame(width: 0, height: 0) }
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
        // Beside the thread the list stays: the split view's own late layout passes (a turn, the
        // tab bar leaving) never hide it. Too narrow for both, the person's toggle is theirs.
        .onChange(of: visibility) { _, now in
            if (settling > 0 || pinned), now != columns { visibility = columns }
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
    /// The list sits beside the thread and keeps its place there (`ThreadColumns.sideBySide`).
    private var pinned: Bool { ThreadColumns.sideBySide(sizeClass, width: width) }
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


