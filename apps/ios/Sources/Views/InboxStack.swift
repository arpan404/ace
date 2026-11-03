import SwiftUI

/// What the inbox header's controls open.
struct InboxHeaderActions {
    let settings: () -> Void
    let machines: () -> Void
    /// Pairs a first computer; nil until the phone knows it has none (and in the debug fixture).
    var pair: (() -> Void)?
    /// Opens Settings at a page (search-everything's settings commands).
    var page: ([SettingsRoute]) -> Void = { _ in }
    /// Opens a thread the list doesn't hold (archived), read-only in Settings › Archive.
    var archived: (InboxKey) -> Void = { _ in }
    /// Opens Pull requests, from the header's own button.
    var pulls: () -> Void = {}
    /// Starts a chat, from the Chats tab's empty state.
    var newChat: () -> Void = {}
}

/// One tab's list and the page it opens (`InboxSplit`): the compact wordmark (or a connection
/// problem) and the glass Settings and Search buttons in the bar, the filter chips under it, the
/// list, and the thread it opens. Search is the system's own: the list turns into results while
/// there is a query. The Pulls tab holds the Pull requests and Issues lists (`Views/Forge`) and
/// their pages. Beside an open page, or as the drawer over one, the list carries what the tab bar
/// does: Threads and Pull requests sit at its foot, New thread in its bar or beside them.
struct InboxStack<Destination: View, Side: View>: View {
    @Bindable var inbox: MachineInbox
    @Binding var path: [InboxRoute]
    let pulls: Bool
    /// The tab showing, which the sidebar's foot switches in a regular window.
    @Binding var tab: InboxTab
    /// The list as a drawer over the open page in a compact window (`ThreadDrawer`).
    @Binding var drawer: ThreadDrawer
    /// What the Pulls tab's pages ask of the inbox.
    let forge: ForgeInboxHooks
    @Binding var machine: String
    @Binding var project: String
    /// Pull requests, Issues or Notifications on the Pulls tab; the inbox's, so a command can
    /// open Issues from the Threads tab.
    @Binding var forgeKind: ForgeKind
    /// The Threads tab open: Inbox, Snoozed or Settled (`ThreadsTabsBar`).
    @Binding var threadsTab: String
    /// A row to scroll to once it is in the list (`InboxList.reveal`).
    @Binding var reveal: InboxKey?
    let actions: InboxRowActions
    let header: InboxHeaderActions
    /// Delete, move and the bulk actions across machines.
    let organize: InboxOrganize
    @ViewBuilder let destination: (InboxKey) -> Destination
    /// Select mode: the threads picked for one action, and whether the list is picking.
    @State private var selection: Set<InboxKey> = []
    @State private var selecting = false
    /// The thread's side panel beside it on iPad.
    @ViewBuilder let side: (InboxKey, PanelPart) -> Side
    @State private var query = ""
    @State private var searching = false
    /// The open thread's own commands, left by its page (`ThreadKeysBox`).
    @Environment(\.threadKeysBox) private var threadKeysBox
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.aceReduceMotion) private var reduceMotion

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
            InboxSplit(path: $path, drawer: $drawer, empty: "No pull request open", showing: tab == .pulls) { root } page: { page($0) } side: { _, _ in EmptyView() }
        } else {
            InboxSplit(path: $path, drawer: $drawer, empty: "No thread open", showing: tab != .pulls, selecting: selecting) {
                root.inboxCommands(commands)
            } page: { page($0) } side: { side($0, $1) }
        }
    }

    /// The list, its search, its bar and, where it carries them, Threads and Pull requests at its
    /// foot and New thread in its bar (beside a thread) or at the foot beside them (as a drawer,
    /// where the bar has no room for it). The split view says where that is (`listHoldsTabs`).
    private var root: some View {
        HoldsTabs { holds, inDrawer in
            listed
                .inboxFootBar {
                    if holds { InboxPlaces(tab: $tab, compose: inDrawer && inbox.canStartThreads ? composeHere : nil) }
                }
                .modifier(ListTitle(pulls: pulls))
                .toolbar { toolbar(holdsTabs: holds, composeInBar: holds && !inDrawer) }
                // As a compact window's drawer the list is too narrow for the system's bar, which
                // folds the title and its buttons into one ⋯: the list draws its own header, and
                // the bar comes back only for search and Select, which live in it.
                .modifier(DrawerHeaderPlace(own: inDrawer && !pulls && !searching && !selecting) { drawerHeader })
                .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                    if selecting && !pulls {
                        InboxSelectionBar(inbox: inbox, selection: selection, organize: organize) { selecting = false; selection = [] }
                    }
                }
        }
    }

    @ViewBuilder private var listed: some View {
        Group {
            if pulls {
                ForgeHome(inbox: inbox, machine: $machine, project: $project, query: query, kind: $forgeKind,
                          // The list's row is the open page, in place of the one open before.
                          actions: ForgeTabActions(open: { route in pick { path = [.forge(route)] } }, openThread: { key in pick { forge.openThread(key) } },
                                                   startThread: forge.startThread),
                          openMachines: header.machines, pair: header.pair)
            } else {
                // The list stays mounted under the results, so it keeps its place while the
                // person searches and is back where it was when they cancel.
                ZStack {
                    if showsChats {
                        ChatsList(inbox: inbox, includes: includes, whole: whole, scope: project.isEmpty && machine.isEmpty ? nil : filters.subtitle,
                                  empty: openTab?.empty ?? "No chats yet",
                                  searching: !query.trimmingCharacters(in: .whitespaces).isEmpty,
                                  actions: ChatsActions(open: { key in picking.open(key) }, newChat: header.newChat, rename: actions.rename))
                    } else {
                    InboxList(inbox: inbox, includes: includes, whole: whole, tab: threadsTab, reveal: $reveal, actions: picking, compose: nil,
                              pair: header.pair, selection: selecting ? $selection : nil)
                        .refreshable { await refresh() }
                        .opacity(searching ? 0 : 1)
                        .allowsHitTesting(!searching)
                        .accessibilityHidden(searching)
                    }
                    if searching && !showsChats {
                        InboxSearchList(inbox: inbox, query: $query, includes: includes, threadOpen: ThreadColumns.selection(path) != nil,
                                        actions: searchActions)
                            .transition(.opacity)
                    }
                }
                // The list and search everything crossfade; nothing slides.
                .animation(AceDesign.Motion.arriving(reduceMotion), value: searching)
                // Inbox, Snoozed and Settled under the title, pinned as rows pass beneath them.
                .inboxTopBar {
                    if !searching { tabsBar }
                }
                // Chats asks each runtime for the chats matching the search, as it types.
                .onChange(of: query) { _, now in
                    if showsChats { for session in inbox.sessions { session.client.searchChats(now) } }
                }
            }
        }
        .modifier(InboxSearchField(query: $query, searching: $searching,
                                   prompt: pulls ? (forgeKind == .pulls ? "Search pull requests" : forgeKind == .issues ? "Search issues" : "Search notifications")
                                       : showsChats ? "Search chats" : "Search everything"))
    }

    /// A row picked in the list (`ThreadDrawer.pick`): the drawer closes, the search ends in a
    /// compact window, and the row's thread opens unless it is the one already showing. A tap
    /// taken as part of a row action does none of it.
    private var picking: InboxRowActions {
        InboxRowActions(open: { key in
                            guard actions.accepts() else { return }
                            let pick = withAnimation(drawerMotion) {
                                drawer.pick(key, open: ThreadColumns.selection(path), in: ThreadDrawer.layout(sizeClass, path: path))
                            }
                            if pick.endsSearch { searching = false }
                            if pick.opens { actions.open(key) }
                        },
                        accepts: actions.accepts, settle: actions.settle, unsettle: actions.unsettle,
                        snooze: actions.snooze, snoozeUntil: actions.snoozeUntil, wake: actions.wake,
                        archive: actions.archive, pin: actions.pin, rename: actions.rename, move: actions.move,
                        organizer: actions.organizer, select: { key in startSelecting(with: key) })
    }
    private func startSelecting(with key: InboxKey? = nil) {
        withAnimation(listMotion) {
            searching = false
            selection = key.map { [$0] } ?? []
            selecting = true
        }
    }
    /// Every thread the open tab shows, for Select all.
    private var selectable: [InboxKey] {
        inbox.merged.sections.filter { $0.key != "unsent" && $0.tab == threadsTab }.flatMap { $0.rows.filter(includes) }
    }
    /// The tab showing, once a runtime sends the tabs.
    private var openTab: MergedInbox.Tab? { inbox.merged.tabs.first { $0.id == threadsTab } }
    /// The Chats tab is open: the chats list in place of the threads.
    private var showsChats: Bool { openTab?.chats == true }
    /// Compose where the list carries it: a new chat on Chats, else a new thread.
    private var composeHere: () -> Void { showsChats ? header.newChat : forge.startThread }

    /// Inbox, Chats, Snoozed and Settled, once a runtime sends them. The Inbox's dot follows the
    /// scope: only a request the list would show lights it.
    @ViewBuilder private var tabsBar: some View {
        let tabs = inbox.merged.tabs
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
    /// What search everything's rows open.
    private var searchActions: SearchActions {
        SearchActions(open: { key in picking.open(key) }, command: runCommand,
                      project: { machineId, workspace in
                          withAnimation(listMotion) {
                              if inbox.showsMachineNames { machine = machineId }
                              project = workspace
                              searching = false
                          }
                      },
                      archived: { key in searching = false; header.archived(key) })
    }
    /// A command id from the shared catalog (`bridge/palette.ts`).
    private func runCommand(_ id: String) {
        let operable = inbox.sessions.first { $0.client.canOperate }?.hostId ?? inbox.sessions.first?.hostId
        switch id {
        case "new-thread": searching = false; forge.startThread()
        case "select": startSelecting()
        case "pulls", "issues":
            searching = false
            forgeKind = id == "issues" ? .issues : .pulls
            tab = .pulls
        case "settings": searching = false; header.settings()
        default:
            if id.hasPrefix("settings:") { searching = false; header.page(SettingsRoute.linked(String(id.dropFirst(9)))) }
            else if id.hasPrefix("tool:"), let tool = SettingsTool(rawValue: String(id.dropFirst(5))), let operable {
                searching = false; header.page([.tool(tool, machine: operable)])
            } else if id.hasPrefix("thread:"), let destination = ThreadDestination(command: String(id.dropFirst(7))) {
                searching = false; threadKeysBox?.keys?.open(destination)
            }
        }
    }
    /// A pull request, issue or thread picked from the Pulls list.
    private func pick(_ open: () -> Void) {
        let layout = ThreadDrawer.layout(sizeClass, path: path)
        withAnimation(drawerMotion) { drawer.close() }
        if layout != .beside { searching = false }
        open()
    }
    /// Select mode, search and scope changes: the system's smooth curve, a fade under Reduce Motion.
    private var listMotion: Animation { AceDesign.Motion.arriving(reduceMotion) }
    private var drawerMotion: Animation { AceDesign.Motion.arriving(reduceMotion) }

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
            search: { withAnimation(listMotion) { searching = true } },
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

    @ToolbarContentBuilder private func toolbar(holdsTabs: Bool, composeInBar: Bool) -> some ToolbarContent {
        if selecting && !pulls {
            selectToolbar
        } else {
            listToolbar(holdsTabs: holdsTabs, composeInBar: composeInBar)
        }
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
    @ToolbarContentBuilder private func listToolbar(holdsTabs: Bool, composeInBar: Bool) -> some ToolbarContent {
        // The title, its menu and the scope or connection problem under it, with no glass.
        if !pulls {
            if #available(iOS 26, *) {
                ToolbarItem(placement: .topBarLeading) { title }.sharedBackgroundVisibility(.hidden)
            } else {
                ToolbarItem(placement: .topBarLeading) { title }
            }
        }
        // One glass capsule (design language §5): More, Pull requests and Search.
        ToolbarItemGroup(placement: .topBarTrailing) {
            settings
            if !pulls {
                Button(action: header.pulls) { AceIcon(.gitPullRequest, size: AceDesign.Size.barIcon) }
                    .accessibilityLabel("Pull requests").accessibilityIdentifier("inbox.pulls")
            }
            Button { withAnimation(listMotion) { searching = true } } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search").accessibilityIdentifier("inbox.search")
            // The phone's floating New thread button, in the Threads sidebar's own bar.
            if composeInBar, !pulls, inbox.canStartThreads {
                Button(action: composeHere) { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(showsChats ? "New chat" : "New thread").accessibilityIdentifier("inbox.compose")
            }
        }
    }
    private func forgePage(_ route: ForgeRoute) -> some View {
        ForgePage(inbox: inbox, route: route, open: { path.append(.forge($0)) }, openThread: forge.openThread,
                  startThread: inbox.canStartThreads ? forge.startThread : nil)
    }
    /// "ace ⌄" with the scope under it; its menu holds the machines, projects and sort.
    private var title: some View {
        InboxHeading(title: "ace", scope: filters.subtitle, problem: InboxConnectionProblem.of(inbox),
                     openMachines: header.machines) { filters }
            // The bar's title stops growing at the largest standard size, so it keeps its place
            // beside the buttons; accessibility sizes read it from the title's own menu and VoiceOver.
            .dynamicTypeSize(...DynamicTypeSize.xxLarge)
            .modifier(HeaderLead())
    }
    /// The drawer's own header: the title and its menu, then More, Pull requests and Search on
    /// one glass capsule, each a full touch target.
    private var drawerHeader: some View {
        HStack(alignment: .center, spacing: AceDesign.Space.related) {
            title
            Spacer(minLength: AceDesign.Space.related)
            HStack(spacing: AceTheme.Spacing.none) {
                headerButton(label: "More", identifier: "inbox.settings", action: header.settings) { Image(systemName: "ellipsis") }
                headerButton(label: "Pull requests", identifier: "inbox.pulls", action: header.pulls) {
                    AceIcon(.gitPullRequest, size: AceDesign.Size.barIcon)
                }
                headerButton(label: "Search", identifier: "inbox.search") {
                    withAnimation(listMotion) { searching = true }
                } icon: { Image(systemName: "magnifyingglass") }
            }
            .aceGlass(in: AceShape.capsule, interactive: true)
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.row)
        .padding(.bottom, AceDesign.Space.related)
    }
    private func headerButton<Icon: View>(label: String, identifier: String, action: @escaping () -> Void,
                                          @ViewBuilder icon: () -> Icon) -> some View {
        Button(action: action) {
            icon()
                .font(.system(size: AceDesign.Size.barIcon))
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceDesign.Size.tap, height: AceDesign.Size.tap)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(identifier)
    }
    private var settings: some View {
        // More: Settings and each machine's tools.
        Button(action: header.settings) { Image(systemName: "ellipsis") }
            .accessibilityLabel("More").accessibilityIdentifier("inbox.settings")
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
    @Environment(\.aceReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .background {
                if shown {
                    Color.clear
                        .searchable(text: $query, isPresented: $searching, placement: .navigationBarDrawer(displayMode: .always), prompt: Text(prompt))
                        .accessibilityHidden(true)
                }
            }
            // A list built again (a fold, a window resize) shows the field the search still has.
            .onAppear { if searching { shown = true } }
            .onChange(of: searching) { _, now in
                // The field joins the bar in the same animation the system uses to focus it.
                if now { withAnimation(AceDesign.Motion.arriving(reduceMotion)) { shown = true } } else { query = ""; shown = false }
            }
    }
}

/// Reads whether the list carries the tabs, and whether it is the drawer over a compact
/// window's thread, where the split view sets them, under this stack.
private struct HoldsTabs<Content: View>: View {
    @Environment(\.listHoldsTabs) private var holds
    @Environment(\.listIsDrawer) private var inDrawer
    @ViewBuilder let content: (Bool, Bool) -> Content
    var body: some View { content(holds, inDrawer) }
}

/// Steps the list's header in by `ThreadColumns.headerLead`, read where the header is drawn: the
/// split sets it on its list, under this stack.
struct HeaderLead: ViewModifier {
    @Environment(\.headerLead) private var lead
    func body(content: Content) -> some View { content.padding(.leading, lead) }
}

/// The list's title. The home list's is drawn in the bar's leading slot ("ace ⌄", `InboxHeading`):
/// the bar keeps an inline title for Back buttons and VoiceOver and drops its own centred one,
/// which would leave the heading and its buttons half the width each. Pull requests keeps the
/// system's large title.
private struct ListTitle: ViewModifier {
    let pulls: Bool
    func body(content: Content) -> some View {
        if pulls {
            content.nativeTitle("Pull requests")
        } else {
            content
                .navigationTitle("ace")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar(removing: .title)
        }
    }
}

/// Hides the list's system bar and pins the drawer's own header in its place while `own` holds.
private struct DrawerHeaderPlace<Header: View>: ViewModifier {
    let own: Bool
    @ViewBuilder let header: () -> Header
    func body(content: Content) -> some View {
        content
            .toolbarVisibility(own ? .hidden : .automatic, for: .navigationBar)
            .inboxTopBar { if own { header() } }
    }
}
