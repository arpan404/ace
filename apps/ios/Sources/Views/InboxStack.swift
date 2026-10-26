import SwiftUI

/// What the inbox header's controls open.
struct InboxHeaderActions {
    let settings: () -> Void
    let machines: () -> Void
}

/// One tab's list and the page it opens (`InboxSplit`): the compact wordmark (or a connection
/// problem) and the glass Settings and Search buttons in the bar, the filter chips under it, the
/// list, and the thread it opens. Search is the system's own: the list turns into results while
/// there is a query. The Pulls tab holds the Pull requests and Issues lists (`Views/Forge`) and
/// their pages. Beside an open page the sidebar carries what the tab bar does on a phone: New
/// thread joins its bar and Threads and Pull requests sit at its foot.
struct InboxStack<Destination: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [InboxRoute]
    let pulls: Bool
    /// The tab showing, which the sidebar's foot switches in a regular window.
    @Binding var tab: InboxTab
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
    @Environment(\.horizontalSizeClass) private var sizeClass

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

    /// The scope takes all of a machine's threads: no project chip, and its tab or every machine.
    private func whole(_ machineId: String) -> Bool {
        project.isEmpty && (machine.isEmpty || machineId == machine)
    }

    var body: some View {
        // The list beside the open page in a regular window, a stack in a compact one.
        if pulls {
            InboxSplit(path: $path, empty: "No pull request open", showing: tab == .pulls) { root } page: { page($0) }
        } else {
            InboxSplit(path: $path, empty: "No thread open", showing: tab != .pulls) { root.inboxCommands(commands) } page: { page($0) }
        }
    }

    @ViewBuilder private var root: some View {
        Group {
            if pulls {
                ForgeHome(inbox: inbox, machine: $machine, project: $project, query: query, kind: $forgeKind,
                          // The list's row is the open page, in place of the one open before.
                          actions: ForgeTabActions(open: { path = [.forge($0)] }, openThread: forge.openThread, startThread: forge.startThread),
                          openMachines: header.machines)
            } else {
                // The list stays mounted under the results, so it keeps its place while the
                // person searches and is back where it was when they cancel.
                ZStack {
                    let results = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    InboxList(inbox: inbox, includes: includes, whole: whole, shelves: $shelves, actions: actions, compose: nil)
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
        .modifier(InboxSearchField(query: $query, searching: $searching,
                                   prompt: pulls ? (forgeKind == .pulls ? "Search pull requests" : forgeKind == .issues ? "Search issues" : "Search notifications") : "Search threads and messages"))
        .inboxFootBar { if ThreadColumns.sidebarHoldsTabs(sizeClass) { InboxPlaces(tab: $tab) } }
        // The bar's own title stays for Back buttons and VoiceOver; the leading title draws it.
        .navigationTitle(pulls ? "Pull requests" : "Threads")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbar }
    }

    private var filters: InboxFilters { InboxFilters(inbox: inbox, machine: $machine, project: $project) }

    @ViewBuilder private func page(_ route: InboxRoute) -> some View {
        switch route {
        case .thread(let key): destination(key)
        case .forge(let page): forgePage(page)
        }
    }

    /// The hardware keyboard's thread commands (`InboxCommands`). Next and previous read the
    /// list's order only when pressed, so the stack never redraws for rows it doesn't show.
    private var commands: InboxCommands {
        InboxCommands(
            newThread: inbox.canStartThreads ? forge.startThread : nil,
            search: { withAnimation(.smooth) { searching = true } },
            next: { step(1) }, previous: { step(-1) })
    }
    private func step(_ step: Int) {
        let order = ThreadColumns.order(inbox.merged.sections.map { section in
            MergedInbox.Section(key: section.key, label: section.label, rows: section.rows.filter(includes))
        }, shelves: shelves) { key in
            inbox.pending(key).map { InboxKey(machineId: key.machineId, id: $0.threadId) } ?? key
        }
        if let key = ThreadColumns.neighbour(of: ThreadColumns.selection(path), in: order, step: step) { actions.open(key) }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .principal) { Color.clear.frame(width: 1, height: 1).accessibilityHidden(true) }
        // The title, its menu and the scope or connection problem under it, with no glass. The
        // Pulls tab's title is its list's own, which knows its projects.
        if !pulls {
            if #available(iOS 26, *) {
                ToolbarItem(placement: .topBarLeading) { title }.sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) { title }
            }
        }
        ToolbarItem(placement: .topBarTrailing) { settings }
        // A phone gives each button its own glass; the sidebar groups its three into one, so a
        // narrow column (a window beside its controls) still shows them all.
        if #available(iOS 26, *), !ThreadColumns.sidebarHoldsTabs(sizeClass) { ToolbarSpacer(.fixed, placement: .topBarTrailing) }
        ToolbarItem(placement: .topBarTrailing) {
            Button { withAnimation(.smooth) { searching = true } } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search").accessibilityIdentifier("inbox.search")
        }
        // The phone's floating New thread button, in the Threads sidebar's own bar.
        if ThreadColumns.sidebarHoldsTabs(sizeClass), !pulls, inbox.canStartThreads {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: forge.startThread) { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New thread").accessibilityIdentifier("inbox.compose")
            }
        }
    }
    @ViewBuilder private func forgePage(_ route: ForgeRoute) -> some View {
        if let client = inbox.client(route.machineId) {
            switch route.kind {
            case .pull: ForgePullPageView(client: client, route: route, open: { path.append(.forge($0)) }, openThread: forge.openThread)
            case .timeline: ForgeTimelineView(client: client, route: route)
            case .file: ForgeFileView(client: client, route: route)
            case .files: ForgeFilesView(client: client, route: route, open: { path.append(.forge($0)) })
            case .issue:
                ForgeIssuePageView(client: client, route: route,
                                   actions: ForgeTabActions(open: { path.append(.forge($0)) }, openThread: forge.openThread, startThread: forge.startThread))
            }
        }
    }
    private var title: some View {
        InboxHeading(title: "Threads", scope: filters.subtitle, problem: InboxConnectionProblem.of(inbox),
                     openMachines: header.machines) { filters }
            .modifier(HeaderLead())
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

/// Steps the list's header in by `ThreadColumns.headerLead`, read where the header is drawn: the
/// split sets it on its list, under this stack.
struct HeaderLead: ViewModifier {
    @Environment(\.headerLead) private var lead
    func body(content: Content) -> some View { content.padding(.leading, lead) }
}
