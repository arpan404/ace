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

    var body: some View {
        NavigationSplitView(columnVisibility: $visibility, preferredCompactColumn: compactColumn) {
            list()
                .environment(\.openThreadRow, ThreadColumns.selection(path))
                .environment(\.openForgeRow, path.first?.forge)
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
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // The columns follow the window's shape when it changes, and leave the person's own
        // sidebar toggle alone in between. Expanding from a stack, the split view picks its own
        // columns just after the change: while it settles, the window's columns win.
        .onChange(of: ColumnsChange(sizeClass: sizeClass, wanted: columns), initial: true) { _, change in
            visibility = change.wanted
            settling += 1
        }
        .onChange(of: visibility) { _, now in if settling > 0, now != columns { visibility = columns } }
        .task(id: settling) {
            guard settling > 0 else { return }
            try? await Task.sleep(for: .milliseconds(800))
            if !Task.isCancelled { settling = 0 }
        }
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
    /// The pull request or issue open beside the list.
    @Entry var openForgeRow: ForgeRoute?
    /// Closes the detail column's own thread; pages pushed over it go back instead.
    @Entry var closeOpenThread: CloseOpenThread?
}

struct CloseOpenThread {
    let id: String
    let close: () -> Void
}

