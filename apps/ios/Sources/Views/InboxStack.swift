import SwiftUI

/// What the inbox header's controls open.
struct InboxHeaderActions {
    let settings: () -> Void
    let machines: () -> Void
}

/// One tab's navigation stack: the compact wordmark (or a connection problem) and the glass
/// Settings and Search buttons in the bar, the filter chips under it, the list, and the thread
/// it opens. Search is the system's own: the list turns into results while there is a query.
/// The Pulls tab holds the Pull requests and Issues lists (`Views/Forge`) and their pages.
struct InboxStack<Destination: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [InboxRoute]
    let pulls: Bool
    /// What the Pulls tab's pages ask of the inbox.
    let forge: ForgeInboxHooks
    @Binding var machine: String
    @Binding var project: String
    @Binding var shelves: InboxShelves
    let actions: InboxRowActions
    let header: InboxHeaderActions
    @ViewBuilder let destination: (InboxKey) -> Destination
    @State private var query = ""
    @State private var searching = false
    @State private var forgeKind = ForgeKind.pulls

    /// The tab and the chips: a row shows when its machine, project and pull request match.
    private func includes(_ key: InboxKey) -> Bool {
        if !machine.isEmpty && key.machineId != machine { return false }
        // Rows are read only for a project scope, so the list redraws for membership alone.
        if project.isEmpty { return true }
        guard let row = inbox.row(key) ?? inbox.pending(key).flatMap({ inbox.row(InboxKey(machineId: key.machineId, id: $0.threadId)) }) else {
            return project.isEmpty
        }
        return project.isEmpty || row.workspaceId == project
    }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if pulls {
                    ForgeHome(inbox: inbox, machine: $machine, project: $project, query: query, kind: $forgeKind,
                              actions: ForgeTabActions(open: { path.append(.forge($0)) }, openThread: forge.openThread, startThread: forge.startThread))
                } else {
                    // The list stays mounted under the results, so it keeps its place while the
                    // person searches and is back where it was when they cancel.
                    ZStack {
                        let results = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        InboxList(inbox: inbox, includes: includes, shelves: $shelves, actions: actions, compose: nil)
                            .refreshable { await refresh() }
                            .opacity(results ? 0 : 1)
                            .allowsHitTesting(!results)
                            .accessibilityHidden(results)
                        if results {
                            InboxSearchList(inbox: inbox, query: query, includes: includes, open: actions.open)
                        }
                    }
                }
            }
            .inboxTopBar { if !pulls { InboxFilters(inbox: inbox, machine: $machine, project: $project) } }
            .modifier(InboxSearchField(query: $query, searching: $searching,
                                       prompt: pulls ? (forgeKind == .pulls ? "Search pull requests" : "Search issues") : "Search threads and messages"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            // The root owns the tab bar: it hides as a page is pushed and returns as soon as the
            // path empties, while the page is still sliding away, rather than each page hiding it
            // and the bar popping back only once the pop has finished.
            .toolbarVisibility(path.isEmpty ? .automatic : .hidden, for: .tabBar)
            .navigationDestination(for: InboxRoute.self) { route in
                switch route {
                case .thread(let key): destination(key)
                case .forge(let page): forgePage(page)
                }
            }
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        // Decorative branding and the connection title share the leading slot, with no glass.
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { title }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { title }
        }
        ToolbarItem(placement: .topBarTrailing) { settings }
        if #available(iOS 26, *) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        ToolbarItem(placement: .topBarTrailing) {
            Button { withAnimation(.smooth) { searching = true } } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search").accessibilityIdentifier("inbox.search")
        }
    }
    @ViewBuilder private func forgePage(_ route: ForgeRoute) -> some View {
        if let client = inbox.client(route.machineId) {
            switch route.kind {
            case .pull: ForgePullPageView(client: client, route: route, openThread: forge.openThread)
            case .issue:
                ForgeIssuePageView(client: client, route: route,
                                   actions: ForgeTabActions(open: { path.append(.forge($0)) }, openThread: forge.openThread, startThread: forge.startThread))
            }
        }
    }
    private var title: some View {
        InboxTitle(problem: InboxConnectionProblem.of(inbox), openMachines: header.machines)
    }
    private var settings: some View {
        Button(action: header.settings) { Image(systemName: "gearshape") }
            .accessibilityLabel("Settings").accessibilityIdentifier("inbox.settings")
    }

    /// The list is live; a pull asks every machine that isn't ready to reconnect now.
    private func refresh() async {
        let waiting = inbox.sessions.filter { $0.client.connection != "ready" }
        guard !waiting.isEmpty else { return }
        for session in waiting { session.client.retry() }
        for _ in 0..<20 where waiting.contains(where: { $0.client.connection != "ready" }) { try? await Task.sleep(for: .milliseconds(100)) }
    }
}

/// The system search field, shown only once the Search button asks for it and gone again when
/// the person cancels, so the inbox opens on its rows rather than an empty field. The field hangs
/// off a carrier behind the list, so showing it never rebuilds the list.
private struct InboxSearchField: ViewModifier {
    @Binding var query: String
    @Binding var searching: Bool
    let prompt: String
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .background {
                if shown {
                    Color.clear
                        .searchable(text: $query, isPresented: $searching, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(prompt))
                        .accessibilityHidden(true)
                }
            }
            .onChange(of: searching) { _, now in
                // The field joins the bar in the same animation the system uses to focus it.
                if now { withAnimation(.smooth) { shown = true } } else { query = ""; shown = false }
            }
    }
}
