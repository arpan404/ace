import SwiftUI

/// What the home lists' headers and feet open.
struct InboxHeaderActions {
    let settings: () -> Void
    let machines: () -> Void
    /// Pairs a first computer; nil until the phone knows it has none (and in the debug fixture).
    var pair: (() -> Void)?
    /// Shows Search (the hardware keyboard's Search everything).
    var search: () -> Void = {}
    /// One of the places outside the lists, from the iPad sidebar's foot.
    var place: (SearchPlace) -> Void = { _ in }
    /// New thread on Threads, New chat on Chats.
    var compose: () -> Void = {}
}

/// One home list and the page it opens (`InboxSplit`): Threads (Inbox, Snoozed and Settled under
/// the title) or Chats. A large title that collapses as the list scrolls, its menu choosing the
/// machine, project and sort, the scope or a connection problem under it, and the round compose
/// button where the tab bar doesn't hold it (`HomeTabs.composeTab`). Beside an open page the list
/// carries the places at its foot (`SidebarPlaces`), where a phone has the tab bar.
struct InboxStack<Destination: View, Side: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [InboxRoute]
    /// Which list this is: `.threads` or `.chats`.
    let list: InboxTab
    /// The tab showing, which the sidebar's foot switches in a regular window.
    @Binding var tab: InboxTab
    /// The list as a drawer over the open page in a narrow regular window (`ThreadDrawer`).
    @Binding var drawer: ThreadDrawer
    /// What forge pages pushed from a thread ask of the inbox.
    let forge: ForgeInboxHooks
    @Binding var machine: String
    @Binding var project: String
    /// The Threads list open: Inbox, Snoozed or Settled (`ThreadsTabsBar`).
    @Binding var threadsTab: String
    /// A row to scroll to once it is in the list (`InboxList.reveal`).
    @Binding var reveal: InboxKey?
    /// Bumped when Search asks the list to start picking threads.
    let selectAsks: Int
    let actions: InboxRowActions
    let header: InboxHeaderActions
    /// Delete, move and the bulk actions across machines.
    let organize: InboxOrganize
    @ViewBuilder let destination: (InboxKey) -> Destination
    /// The thread's side panel beside it on iPad.
    @ViewBuilder let side: (InboxKey, PanelPart) -> Side
    /// Select mode: the threads picked for one action, and whether the list is picking.
    @State private var selection: Set<InboxKey> = []
    @State private var selecting = false
    /// The connection problem once it has lasted a moment, so a blip never flashes in the title.
    @State private var problem: InboxConnectionProblem?
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.aceReduceMotion) private var reduceMotion

    /// The scope: a row shows when its machine and project match.
    private func includes(_ key: InboxKey) -> Bool {
        if !machine.isEmpty && key.machineId != machine { return false }
        // Rows are read only for a project scope, so the list redraws for membership alone.
        if project.isEmpty { return true }
        guard let row = inbox.row(key) ?? inbox.pending(key).flatMap({ inbox.row(InboxKey(machineId: key.machineId, id: $0.threadId)) }) else {
            return false
        }
        return row.workspaceId == project
    }

    /// The scope takes all of a machine's threads: no project chip, and its tab or every machine.
    private func whole(_ machineId: String) -> Bool {
        project.isEmpty && (machine.isEmpty || machineId == machine)
    }

    private var chats: Bool { list == .chats }

    var body: some View {
        InboxSplit(path: $path, drawer: $drawer, empty: chats ? "No chat open" : "No thread open", showing: tab == list, selecting: selecting) {
            root.inboxCommands(commands)
        } page: { page($0) } side: { side($0, $1) }
    }

    /// The list, its title and bar, and the places at its foot beside a page.
    private var root: some View {
        HoldsTabs { holds in
            listed
                .inboxFootBar {
                    if holds { SidebarPlaces(tab: $tab, open: header.place, needsYou: needsYou) }
                }
                .modifier(ListTitle(title: HomeTabs.title(list), subtitle: subtitle, selecting: selecting))
                .toolbar { if selecting { selectToolbar } else { listToolbar } }
                .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                    if selecting {
                        InboxSelectionBar(inbox: inbox, selection: selection, organize: organize) { selecting = false; selection = [] }
                    }
                }
                .task(id: InboxConnectionProblem.of(inbox)) {
                    let now = InboxConnectionProblem.of(inbox)
                    guard let now else { problem = nil; return }
                    // An already-visible problem updates at once; a new one waits out a brief blip.
                    if problem == nil { try? await Task.sleep(for: .milliseconds(800)) }
                    if !Task.isCancelled { problem = now }
                }
                .onChange(of: selectAsks) { if !chats { startSelecting() } }
        }
    }

    @ViewBuilder private var listed: some View {
        if chats {
            ChatsList(inbox: inbox, includes: includes, whole: whole, scope: machine.isEmpty ? nil : inbox.name(machine),
                      empty: chatsTab?.empty ?? "No chats yet", searching: false,
                      actions: ChatsActions(open: { key in picking.open(key) }, newChat: header.compose, rename: actions.rename))
        } else {
            InboxList(inbox: inbox, includes: includes, whole: whole, tab: threadsTab, reveal: $reveal, actions: picking, compose: nil,
                      pair: header.pair, selection: selecting ? $selection : nil)
                .refreshable { await refresh() }
                // Inbox, Snoozed and Settled under the title, pinned on the page colour: a glass
                // bar under a large title blurs the title.
                .safeAreaInset(edge: .top, spacing: AceTheme.Spacing.none) {
                    tabsBar.background(AceTheme.Colours.background, ignoresSafeAreaEdges: [])
                }
        }
    }

    /// The scope menu: the machine, project and sort, then Select.
    @ViewBuilder private var titleMenu: some View {
        if chats {
            Picker("Machine", selection: $machine) {
                Text("All machines").tag("")
                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
            }
        } else {
            filters
            Section {
                Button("Select threads", ace: .checkSquare) { startSelecting() }
                    .accessibilityIdentifier("inbox.select")
            }
        }
    }

    /// Under the title: what is wrong with the connection while it lasts, else the scope while it
    /// narrows the list. A list showing everything says nothing.
    private var subtitle: String? {
        let scoped = !project.isEmpty || !machine.isEmpty
        let scope = chats ? (machine.isEmpty ? nil : inbox.name(machine)) : (scoped ? filters.subtitle : nil)
        let parts = [scope, problem?.text].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A row picked in the list (`ThreadDrawer.pick`): the drawer closes and the row's thread
    /// opens unless it is the one already showing. A tap taken as part of a row action does none
    /// of it.
    private var picking: InboxRowActions {
        InboxRowActions(open: { key in
                            guard actions.accepts() else { return }
                            let pick = withAnimation(listMotion) {
                                drawer.pick(key, open: ThreadColumns.selection(path), in: ThreadDrawer.layout(sizeClass, path: path))
                            }
                            if pick.opens { actions.open(key) }
                        },
                        accepts: actions.accepts, settle: actions.settle, unsettle: actions.unsettle,
                        snooze: actions.snooze, snoozeUntil: actions.snoozeUntil, wake: actions.wake,
                        archive: actions.archive, pin: actions.pin, rename: actions.rename, move: actions.move,
                        organizer: actions.organizer, select: { key in startSelecting(with: key) })
    }
    private func startSelecting(with key: InboxKey? = nil) {
        withAnimation(listMotion) {
            selection = key.map { [$0] } ?? []
            selecting = true
        }
    }
    /// Every thread the open tab shows, for Select all.
    private var selectable: [InboxKey] {
        inbox.merged.sections.filter { $0.key != "unsent" && $0.tab == threadsTab }.flatMap { $0.rows.filter(includes) }
    }
    /// The runtimes' Chats tab: its words for the empty list.
    private var chatsTab: MergedInbox.Tab? { inbox.merged.tabs.first { $0.chats } }
    private func needsYou(_ place: InboxTab) -> Bool {
        switch place {
        case .threads: (inbox.merged.tabs.first { $0.id == "inbox" }?.needsYou ?? 0) > 0
        case .chats: inbox.merged.tabs.contains { $0.chats && $0.needsYou > 0 }
        default: false
        }
    }

    /// Inbox, Snoozed and Settled, once a runtime sends them: Chats is a tab of its own. The
    /// Inbox's dot follows the scope: only a request the list would show lights it.
    @ViewBuilder private var tabsBar: some View {
        let tabs = inbox.merged.tabs.filter { !$0.chats }
        if !tabs.isEmpty {
            // The daemon's own count of what needs the person, as the desktop's dot.
            let dot = (tabs.first { $0.id == "inbox" }?.needsYou ?? 0) > 0
            ThreadsTabsBar(tabs: tabs, selection: $threadsTab, dot: dot) { id in
                inbox.merged.sections.filter { $0.tab == id && $0.key != "unsent" }
                    .compactMap { $0.scoped(includes, whole: whole)?.count }.reduce(0, +)
            }
            .modifier(HeaderLead())
        }
    }
    private var listMotion: Animation { AceDesign.Motion.arriving(reduceMotion) }

    private var filters: InboxFilters { InboxFilters(inbox: inbox, machine: $machine, project: $project) }

    @ViewBuilder private func page(_ route: InboxRoute) -> some View {
        switch route {
        case .thread(let key): destination(key)
        case .forge(let page):
            ForgePage(inbox: inbox, route: page, open: { path.append(.forge($0)) }, openThread: forge.openThread,
                      startThread: inbox.canStartThreads ? forge.startThread : nil)
        }
    }

    /// The hardware keyboard's thread commands (`InboxCommands`). Next and previous read the
    /// list's order only when pressed, so the stack never redraws for rows it doesn't show.
    private var commands: InboxCommands {
        InboxCommands(
            newThread: inbox.canStartThreads ? forge.startThread : nil,
            search: header.search,
            select: { startSelecting() },
            settings: header.settings,
            next: { step(1) }, previous: { step(-1) }, nextNeedsYou: nextNeedsYou)
    }
    /// The next thread that needs the person after the open one, round to the first.
    private func nextNeedsYou() {
        let rows = inbox.merged.sections.first { $0.key == "needs-you" }?.rows.filter(includes) ?? []
        guard !rows.isEmpty else { return }
        let open = ThreadColumns.selection(path)
        let after = open.flatMap { rows.firstIndex(of: $0) }.map { $0 + 1 } ?? 0
        actions.open(rows[after < rows.count ? after : 0])
    }
    private func step(_ step: Int) {
        let order = ThreadColumns.order(inbox.merged.sections.map { section in
            MergedInbox.Section(key: section.key, label: section.label, rows: section.rows.filter(includes), tab: section.tab)
        }, tab: threadsTab) { key in
            inbox.pending(key).map { InboxKey(machineId: key.machineId, id: $0.threadId) } ?? key
        }
        if let key = ThreadColumns.neighbour(of: ThreadColumns.selection(path), in: order, step: step) { actions.open(key) }
    }

    /// Select mode's bar: Select all (or Deselect all), how many are picked, and Done.
    @ToolbarContentBuilder private var selectToolbar: some ToolbarContent {
        let all = selectable
        let everything = !all.isEmpty && all.allSatisfy(selection.contains)
        ToolbarItem(placement: .topBarLeading) {
            Button(everything ? "Deselect all" : "Select all") { selection = everything ? [] : Set(all) }
                .keyboardShortcut("a", modifiers: .command)
                .accessibilityIdentifier("select.all")
        }
        ToolbarItem(placement: .principal) {
            Text(selection.isEmpty ? "Select threads" : "\(selection.count) selected")
                .aceFont(AceTheme.Typography.body, relativeTo: .headline).fontWeight(AceDesign.Typeface.strong)
                .monospacedDigit()
                .accessibilityIdentifier("select.count")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button("Done") { withAnimation(listMotion) { selecting = false; selection = [] } }
                .fontWeight(AceDesign.Typeface.strong)
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityIdentifier("select.done")
        }
    }
    /// The scope menu and the round compose button on one glass capsule. Compose shows where the
    /// tab bar doesn't hold it: before iOS 27, and beside a page in a regular window, which has no
    /// tab bar. (The system's title menu draws no chevron by a large title, so it would go unseen.)
    @ToolbarContentBuilder private var listToolbar: some ToolbarContent {
        if !chats || inbox.showsMachineNames {
            ToolbarItem(placement: .topBarTrailing) {
                Menu { titleMenu } label: { Image(systemName: "line.3.horizontal.decrease") }
                    .accessibilityLabel(chats ? "Machine" : "Scope, sort and select")
                    .accessibilityIdentifier("inbox.projects")
            }
        }
        if inbox.canStartThreads && (sizeClass == .regular || !HomeTabs.composeTab) {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: header.compose) { Image(systemName: HomeTabs.symbol(.compose)) }
                    .accessibilityLabel(chats ? "New chat" : "New thread")
                    .accessibilityIdentifier("inbox.compose")
            }
        }
    }

    /// The list is live; a pull asks every machine that isn't ready to reconnect now.
    private func refresh() async {
        let waiting = inbox.sessions.filter { $0.client.connection != "ready" }
        guard !waiting.isEmpty else { return }
        for session in waiting { session.client.retry() }
        for _ in 0..<20 where waiting.contains(where: { $0.client.connection != "ready" }) { try? await Task.sleep(for: .milliseconds(100)) }
    }
}

/// Reads whether the list carries the places, where the split view sets it, under this stack.
private struct HoldsTabs<Content: View>: View {
    @Environment(\.listHoldsTabs) private var holds
    @ViewBuilder let content: (Bool) -> Content
    var body: some View { content(holds) }
}

/// Steps the list's header in by `ThreadColumns.headerLead`, read where the header is drawn: the
/// split sets it on its list, under this stack.
struct HeaderLead: ViewModifier {
    @Environment(\.headerLead) private var lead
    func body(content: Content) -> some View { content.padding(.leading, lead) }
}

/// The list's native title (`NativeTitle`): large, collapsing as the rows scroll, the scope or a
/// connection problem under it. Select mode keeps the bar's centre, where it counts the threads
/// picked.
private struct ListTitle: ViewModifier {
    let title: String
    let subtitle: String?
    let selecting: Bool
    func body(content: Content) -> some View {
        if selecting {
            content.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        } else {
            content.nativeTitle(title, subtitle: subtitle)
        }
    }
}
