import SwiftUI

/// The single inbox (issue #560) across every paired machine, in a system tab bar: Threads (Inbox,
/// Snoozed and Settled), Chats (plain chats with no project, ADR 0099), Search (the places outside
/// the lists and search everything) and compose: the tab bar's prominent button on iOS 27, a round
/// header button on Threads and Chats before it (`HomeTabs.composeTab`). Spade's tab waits behind
/// `HomeTabs.showsSpade`. Grouping and wording come from each machine's runtime. A row and its
/// thread belong to their machine.
struct InboxView: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for Settings › Machines; nil for the debug fixture.
    var machines: MachinesModel?
    /// Settings › Face ID; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var tab = InboxTab.threads
    @State private var threadsPath: [InboxRoute] = []
    @State private var chatsPath: [InboxRoute] = []
    /// Each list as a drawer over its open page in a narrow regular window (`ThreadDrawer`).
    @State private var threadsDrawer = ThreadDrawer()
    @State private var chatsDrawer = ThreadDrawer()
    /// The machine whose thread is open, and the tab it is open in: one open thread at a time.
    @State private var openMachine: String?
    @State private var openTab: InboxTab?
    @State private var machineFilter = ""
    @State private var projectFilter = ""
    /// The Threads tab's list: Inbox, Snoozed or Settled.
    @State private var threadsTab = "inbox"
    @State private var composing = false
    /// A place outside the lists, open over the home screen (`PlaceSheet`).
    @State private var place: PlaceSheet?
    @State private var placeSerial = 0
    @State private var pairing = false
    @State private var snoozing: InboxKey?
    /// Delete, move, bulk actions and the Undo toast, across machines.
    @State private var organize = InboxOrganize()
    /// The project New thread starts in, over the list's own filter.
    @State private var composeProject: String?
    /// `ace://` links waiting for the app to be ready (`PendingLinks`).
    @State private var links = PendingLinks()
    /// The open thread's commands, for Search (`ThreadKeysBox`).
    @State private var threadKeysBox = ThreadKeysBox()
    @State private var renamingRow: InboxKey?
    /// A row brought back by Undo or Unsettle, scrolled into view once it is in the list again:
    /// unsettling makes it the newest activity, so it returns far from where the person acted.
    @State private var reveal: InboxKey?
    @State private var settles = 0
    /// Search's field, kept while the person moves between tabs.
    @State private var searchQuery = ""
    /// Bumped by Search's Select threads: the Threads list starts picking.
    @State private var selectAsks = 0
    /// Holds off row taps just after a row action, so the row sliding into its place stays shut.
    @State private var rowTaps = RowTapGuard()
    /// The thread on screen when the app last ran: a relaunch opens it again, as the web reopens
    /// its URL, whether the system ended the app in the background or it was killed.
    @AppStorage("ace.inbox.openThread") private var lastPlace = ""
    @State private var placeRestored = false

    private var current: ClientModel? { openMachine.flatMap(inbox.client) }

    var body: some View {
        sheets
            // An outside app's sign-in opens over whatever the person is doing (ADR 0117).
            .outsideAccessPrompt(inbox)
            .modifier(InboxRename(inbox: inbox, key: $renamingRow))
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(inbox.merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .newThreadEntry(inbox: inbox, composing: $composing, project: composeProject ?? projectFilter) { key in openThread(key) }
            .onChange(of: composing) { _, now in if !now { composeProject = nil } }
            .organizeSheets(organize, inbox: inbox)
            // `ace://` links from other apps, Shortcuts and Copy link. One that arrives before the
            // machines are read or while the app is locked waits until it can open.
            .onOpenURL { url in links.add(url) }
            .task(id: LinkReadiness(links: links, unlocked: !(lock?.locked ?? false), machinesReady: machinesReady, noMachines: noMachines)) {
                // Taking them changes this task's id, which cancels it: they open in their own task.
                let urls = links.take(unlocked: !(lock?.locked ?? false), machinesReady: machinesReady, noMachines: noMachines)
                guard !urls.isEmpty else { return }
                Task { for url in urls { await openLink(url) } }
            }
            .environment(\.threadOrganizer, organizer)
            .environment(\.threadKeysBox, threadKeysBox)
            // A thread deleted for good closes where it was open.
            .onChange(of: organize.deleted) { _, deleted in
                if let key = InboxRoute.threads(threadsPath).first, deleted.contains(key) { threadsPath = [] }
                if let key = InboxRoute.threads(chatsPath).first, deleted.contains(key) { chatsPath = [] }
            }
            .aceNotifications(inbox: inbox) { key in openThread(key) }
            .task(id: scenePhase) {
                // Foreground reconciliation: renew every live activity's `staleDate` while
                // the inbox is mounted, including its thread destinations. Cancelled on
                // background or unmount; rows stay truthful and nothing ends here — `update`
                // only finishes a canonical done row while online.
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    for session in inbox.sessions {
                        session.client.liveActivity.update(row: { session.client.inbox[$0] }, hostId: session.hostId, online: session.client.connection == "ready")
                    }
                    try? await Task.sleep(for: .seconds(30))
                }
            }
            .alert("Request needs attention", isPresented: Binding(get: { failing != nil }, set: { if !$0 { failing?.client.error = nil } })) {
                Button("Dismiss") { failing?.client.error = nil }
            } message: {
                if let failing { Text(inbox.showsMachineNames ? "\(inbox.name(failing.hostId)): \(failing.client.error ?? "")" : failing.client.error ?? "") }
            }
    }

    /// The detached tab on iOS 27 (compose); before it, Search's own role takes the detached slot.
    private static var composeRole: TabRole {
        // `.prominent` exists only in the iOS 27 SDK (SwiftUI 8); CI builds with Xcode 26.
        #if canImport(SwiftUI, _version: 8.0)
        if #available(iOS 27, *) { return .prominent }
        #endif
        return .search
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab(value: InboxTab.threads) {
                stack(.threads, path: $threadsPath, drawer: $threadsDrawer)
            } label: { Label { Text(HomeTabs.title(.threads)) } icon: { HomeTabs.tabImage(.threads) } }
            .accessibilityIdentifier("tab.threads")
            Tab(value: InboxTab.chats) {
                stack(.chats, path: $chatsPath, drawer: $chatsDrawer)
            } label: { Label { Text(HomeTabs.title(.chats)) } icon: { HomeTabs.tabImage(.chats) } }
            .accessibilityIdentifier("tab.chats")
            // Spade, ace's cloud agent, keeps its slot between Chats and Search until it launches.
            if HomeTabs.showsSpade {
                Tab(HomeTabs.title(.spade), systemImage: HomeTabs.symbol(.spade), value: InboxTab.spade) {
                    SpadeSoonScreen().modifier(HomeTabBar(shown: sizeClass != .regular))
                }
            }
            if HomeTabs.composeTab {
                Tab(HomeTabs.title(.search), systemImage: HomeTabs.symbol(.search), value: InboxTab.search) { search }
                    .accessibilityIdentifier("tab.search")
                if inbox.canStartThreads {
                    Tab(tab == .chats ? "New chat" : "New thread", systemImage: HomeTabs.symbol(.compose), value: InboxTab.compose,
                        role: Self.composeRole) { Color.clear }
                }
            } else {
                Tab(value: InboxTab.search, role: .search) { search }
                    .accessibilityIdentifier("tab.search")
            }
        }
        .tint(AceTheme.Colours.foreground)
        .sensoryFeedback(AceDesign.Haptic.tab, trigger: tab)
        .onChange(of: tab) { old, new in
            // Coming back to a tab shows its page, never the drawer left out when it was left.
            if new != .compose { threadsDrawer.close(); chatsDrawer.close() }
            // The compose tab starts a chat from Chats, else a thread, and leaves the tab where it was.
            guard new == .compose else { return }
            tab = old == .compose ? .threads : old
            compose(chat: tab == .chats)
        }
        .onChange(of: threadsPath) { old, new in placeChanged(.threads, old: old, new: new) }
        .onChange(of: chatsPath) { old, new in placeChanged(.chats, old: old, new: new) }
        .task(id: restorable) {
            // Once the restored thread's row is back (from this phone's copy or its machine).
            guard !placeRestored, let key = InboxKey(place: lastPlace) else { placeRestored = true; return }
            guard restorable else { return }
            placeRestored = true
            // Cleared first and written back once it shows, so a thread that cannot open sends
            // the next launch to the inbox instead of into the same failure.
            lastPlace = ""
            if threadsPath.isEmpty && chatsPath.isEmpty { openThread(key) }
        }
        .environment(\.otherMachines, otherMachines)
        .sensoryFeedback(.success, trigger: settles)
        // Bulk actions, deletes, moves and Mark unread confirm with the same tap.
        .sensoryFeedback(.success, trigger: organize.feedback)
        // Beside an open thread, or over it as the drawer, the toast sits under the list it acted
        // on, clear of the composer and the list's foot.
        .overlay(alignment: toastBesideList ? .bottomLeading : .bottom) { toast }
        .animation(.default, value: organize.undo?.serial)
    }

    /// Search: the tab bar's own on a phone; beside it in a regular window, the sidebar's places
    /// at its foot so the person can go back to the lists.
    private var search: some View {
        SearchHome(inbox: inbox, openTitle: openTitle, actions: searchActions, query: $searchQuery)
            .inboxFootBar {
                if sizeClass == .regular { SidebarPlaces(tab: $tab, open: open, needsYou: needsYou) }
            }
            .modifier(HomeTabBar(shown: sizeClass != .regular))
    }

    private var sheets: some View {
        tabs
            .placeSheet($place, inbox: inbox, machines: machines, lock: lock,
                        places: MorePlaces(openThread: { openThread($0) }, startThread: { startThread() }))
            .sheet(isPresented: $pairing) {
                if let machines {
                    NavigationStack {
                        PairingView(machines: machines) { pairing = false }
                            .toolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button { pairing = false } label: { Image(systemName: "xmark") }
                                        .accessibilityLabel("Close").accessibilityIdentifier("pairing.close")
                                }
                            }
                    }
                    .tint(AceTheme.Colours.foreground)
                }
            }
    }

    /// The compose button: a new chat on Chats, else a new thread.
    private func compose(chat: Bool) {
        if chat { composeProject = NewThreadDraft.chat }
        startThread()
    }
    /// New thread needs a computer; with none paired it offers pairing instead.
    private func startThread() {
        if !inbox.sessions.isEmpty { composing = true } else { pair?() }
    }
    /// Add device, once the phone knows no computer is paired.
    private var pair: (() -> Void)? {
        guard let machines, machines.loaded, machines.machines.isEmpty else { return nil }
        return { pairing = true }
    }
    /// The machine whose tools a place opens: the first that can act, else the first paired.
    private var toolsMachine: String? {
        inbox.sessions.first { $0.client.canOperate }?.hostId ?? inbox.sessions.first?.hostId
    }
    private func present(_ sheet: PlaceSheet?) {
        guard let sheet else { return }
        place = sheet
    }
    private func nextSerial() -> Int { placeSerial += 1; return placeSerial }
    private func open(_ searchPlace: SearchPlace) {
        present(PlaceSheet.of(searchPlace, machine: toolsMachine, id: nextSerial()))
    }
    /// Whether something on Threads or Chats needs the person, for the iPad sidebar's dots: the
    /// daemon's own count, as the web rail's.
    private func needsYou(_ place: InboxTab) -> Bool {
        let tabs = inbox.merged.tabs
        switch place {
        case .threads: return (tabs.first { $0.id == "inbox" }?.needsYou ?? 0) > 0
        case .chats: return tabs.contains { $0.chats && $0.needsYou > 0 }
        default: return false
        }
    }

    /// Open from a transfer's line goes to that machine's thread.
    private var otherMachines: OtherMachines {
        OtherMachines(client: { inbox.client($0) }, open: { key in
            guard inbox.client(key.machineId)?.inbox[key.id] != nil else { return false }
            openThread(key)
            return true
        })
    }

    /// The thread to reopen is known to its machine. A machine that never lists it again (the
    /// thread was archived or the machine removed) leaves the person on the inbox.
    private var restorable: Bool {
        guard let key = InboxKey(place: lastPlace) else { return false }
        return inbox.client(key.machineId)?.inbox[key.id] != nil
    }
    /// The first machine with an error to show; each machine's error is its own.
    private var failing: MachineSession? { inbox.sessions.first { $0.client.error != nil } }

    private func path(_ place: InboxTab) -> Binding<[InboxRoute]> { place == .chats ? $chatsPath : $threadsPath }

    private func stack(_ list: InboxTab, path: Binding<[InboxRoute]>, drawer: Binding<ThreadDrawer>) -> some View {
        InboxStack(inbox: inbox, path: path, list: list, tab: $tab, drawer: drawer,
                   forge: ForgeInboxHooks(openThread: { openThread($0) },
                                          startThread: { startThread() }),
                   machine: $machineFilter, project: $projectFilter,
                   threadsTab: $threadsTab, reveal: $reveal, selectAsks: selectAsks, actions: actions,
                   header: InboxHeaderActions(settings: { open(.settings) },
                                              machines: { open(.machines) },
                                              pair: pair,
                                              search: { tab = .search },
                                              place: { open($0) },
                                              compose: { compose(chat: list == .chats) },
                                              page: { present(PlaceSheet(id: nextSerial(), root: .settings, start: [$0])) }),
                   organize: organize) { key in
            // Each page keeps drawing its thread while it slides away; child threads open on the
            // same machine's client as their parent.
            if let client = inbox.client(key.machineId) {
                ThreadPage(client: client, id: key.id) { child in
                    client.open(child); path.wrappedValue.append(.thread(InboxKey(machineId: key.machineId, id: child)))
                }
                .environment(\.openPullRequest) { project, number, repository in
                    path.wrappedValue.append(.forge(ForgeRoute(kind: .pull, machineId: key.machineId, project: project, number: number, repository: repository)))
                }
                // One page per thread on its machine: a stack that swaps its page in place for
                // another thread starts that page fresh, never with the last one's transcript,
                // open page, drafts or sheets.
                .id(key)
            }
        } side: { key, part in
            if let client = inbox.client(key.machineId) {
                ThreadSidePanel(model: client, threadId: key.id, part: part) { child in
                    client.open(child); path.wrappedValue.append(.thread(InboxKey(machineId: key.machineId, id: child)))
                }
            }
        }
    }

    // MARK: Search

    /// The open thread's title, which names its commands in Search.
    private var openTitle: String? {
        guard let openTab, let key = InboxRoute.threads(path(openTab).wrappedValue).last else { return nil }
        return inbox.row(key)?.title
    }
    private var searchActions: SearchActions {
        SearchActions(open: { openThread($0) }, command: runCommand,
                      project: { machineId, workspace in
                          if inbox.showsMachineNames { machineFilter = machineId }
                          projectFilter = workspace
                          threadsTab = "inbox"
                          tab = .threads
                      },
                      newThreadIn: { _, workspace in composeProject = workspace; startThread() },
                      archived: { openThread($0, listed: false) },
                      place: open,
                      pull: { route in present(PlaceSheet(id: nextSerial(), root: .forge(route))) })
    }
    /// A command id from the shared catalog (`bridge/palette.ts`).
    private func runCommand(_ id: String) {
        switch id {
        case "new-thread": compose(chat: false)
        case "new-chat": compose(chat: true)
        case "select":
            threadsPath = []
            tab = .threads
            selectAsks += 1
        case "pulls": open(.pulls)
        case "issues": open(.issues)
        default:
            if id.hasPrefix("thread:"), let destination = ThreadDestination(command: String(id.dropFirst(7))) {
                openOnThread(destination)
            } else {
                present(PlaceSheet.of(command: id, machine: toolsMachine, serial: nextSerial()))
            }
        }
    }
    /// One of the open thread's places (Changes, Agent tree…): back on its tab, once its page has
    /// left its commands again.
    private func openOnThread(_ destination: ThreadDestination) {
        guard let openTab else { return }
        tab = openTab
        Task<Void, Never> {
            for _ in 0..<40 {
                if let keys = threadKeysBox.keys { keys.open(destination); return }
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    // MARK: Rows
    private var actions: InboxRowActions {
        // Each row action first holds off row taps for a moment (`RowTapGuard`).
        let acted = { rowTaps.acted(at: ProcessInfo.processInfo.systemUptime) }
        return InboxRowActions(
            open: { key in if rowTaps.opens(at: ProcessInfo.processInfo.systemUptime) { openThread(key) } },
            accepts: { rowTaps.opens(at: ProcessInfo.processInfo.systemUptime) },
            settle: { row, key in
                acted()
                settles += 1
                // The coordinator keeps the snooze a settle clears, for an exact Undo.
                Task { await organize.run(.settle, [key], in: inbox) }
            },
            unsettle: { row, key in
                acted()
                Task { if await inbox.client(key.machineId)?.unsettle(row.id) == true { reveal = key } }
            },
            snooze: { acted(); snoozing = $0 },
            snoozeUntil: { row, key, preset in acted(); Task { _ = await inbox.client(key.machineId)?.snooze(row.id, preset: preset) } },
            wake: { row, key in acted(); Task { _ = await inbox.client(key.machineId)?.wake(row.id) } },
            archive: { _, key in acted(); Task { await organize.run(.archive, [key], in: inbox) } },
            pin: { row, key, pinned in acted(); Task { _ = await inbox.client(key.machineId)?.pin(row.id, pinned) } },
            rename: { key in acted(); renamingRow = key },
            move: { key, section, index in acted(); Task { await inbox.move(key, in: section, to: index) } },
            organizer: organizer,
            // Select mode belongs to each tab's list (`InboxStack`).
            select: { _ in })
    }
    /// A machine's runtime is up to read links: the machines are read and one has started.
    private var machinesReady: Bool {
        (machines?.loaded ?? true) && inbox.sessions.contains { $0.client.inboxLoaded || $0.client.connection == "ready" }
    }
    /// The phone's machines are read and none is paired.
    private var noMachines: Bool { (machines?.loaded ?? false) && inbox.sessions.isEmpty }
    private struct LinkReadiness: Equatable { let links: PendingLinks; let unlocked: Bool; let machinesReady: Bool; let noMachines: Bool }

    /// Opens what an `ace://` link names, read by the shared rules. A thread waits a moment for
    /// its machine's list after a cold launch; one no paired machine holds says so.
    private func openLink(_ url: URL) async {
        // The phone's own link, which the shared reader doesn't know: it needs no machine.
        if OpenedLink.withoutMachine(url)?.kind == "inbox" { showInbox(); return }
        guard let link = inbox.sessions.isEmpty ? OpenedLink.withoutMachine(url) : await inbox.readLink(url) else {
            if url.scheme?.lowercased() == AceLink.scheme, !inbox.sessions.isEmpty { organize.problem = "That ace link couldn't be read." }
            return
        }
        switch link.kind {
        case "thread":
            guard let id = link.threadId else { return }
            for _ in 0..<50 where inbox.machine(holding: id, named: link.machine) == nil { try? await Task.sleep(for: .milliseconds(200)) }
            guard let machine = inbox.machine(holding: id, named: link.machine), let client = inbox.client(machine) else {
                organize.problem = "That thread isn't on a paired machine, or it was archived."
                return
            }
            if let item = link.itemId { client.focusOnOpen = ThreadFocus(thread: id, item: item) }
            openThread(InboxKey(machineId: machine, id: id))
        case "settings":
            present(PlaceSheet(id: nextSerial(), root: .settings, start: SettingsRoute.linked(link.page)))
        case "new-thread":
            composeProject = link.project
            startThread()
        case "open-folder":
            organize.problem = "Folders open in ace on your computer."
        default: break
        }
    }
    /// `ace://inbox`: any open thread closes and Threads › Inbox shows, with nothing over it.
    private func showInbox() {
        place = nil
        withAnimation { threadsDrawer.close(); chatsDrawer.close() }
        threadsPath = []
        chatsPath = []
        threadsTab = "inbox"
        tab = .threads
    }
    private var organizer: ThreadOrganizer {
        ThreadOrganizer(perform: { key, id in perform(id, key) },
                        snooze: { key, preset in Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: preset) } },
                        wake: { key in Task { _ = await inbox.client(key.machineId)?.wake(key.id) } })
    }
    private func perform(_ id: String, _ key: InboxKey) {
        guard let client = inbox.client(key.machineId) else { return }
        let row = inbox.row(key)
        switch id {
        case "unread", "read": Task { if await client.markUnread(key.id, id == "unread") { organize.feedback += 1 } }
        case "pin", "unpin": if let row { actions.pin(row, key, id == "pin") }
        case "move": organize.moving = MoveAsk(machineId: key.machineId, keys: [key])
        case "settle": if let row { actions.settle(row, key) }
        case "unsettle": if let row { actions.unsettle(row, key) }
        case "auto-settle-off", "auto-settle-on": Task { _ = await client.setAutoSettle(key.id, id == "auto-settle-on") }
        case "archive": if let row { actions.archive(row, key) }
        case "restore": Task { _ = await client.unarchive(key.id) }
        case "delete": Task { await organize.askDelete([key], in: inbox) }
        case "rename": renamingRow = key
        case "copy-link": UIPasteboard.general.string = AceLink.thread(key.id, machine: client.hostId).absoluteString
        case "new-on-main":
            composeProject = row?.workspaceId
            startThread()
        default: break
        }
    }
    /// A list fills the window: Threads or Chats with no page open on it.
    private var onList: Bool {
        (tab == .threads && threadsPath.isEmpty) || (tab == .chats && chatsPath.isEmpty)
    }
    /// The list showing beside a page (regular) or over it as the open drawer.
    private var toastBesideList: Bool {
        sizeClass == .regular || (tab == .chats ? chatsDrawer : threadsDrawer).isOpen
    }

    @ViewBuilder private var toast: some View {
        if let undo = organize.undo, onList || toastBesideList {
            HStack(spacing: AceDesign.Space.row) {
                Text(undo.text).lineLimit(1)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier("inbox.toast")
                // While an Undo waits on a machine there is nothing to press; it says so.
                if !undo.busy {
                    Button("Undo") {
                        Task { if await organize.takeBack(undo, in: inbox) { reveal = undo.keys.first } }
                    }
                    .fontWeight(AceDesign.Typeface.strong)
                    .frame(minHeight: AceDesign.Size.tap)
                    .accessibilityIdentifier(undo.identifier)
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.leading, AceDesign.Space.margin).padding(.trailing, AceDesign.Space.margin)
            .aceGlass(in: AceShape.capsule)
            // Clear of the tab bar, or of the sidebar's Threads and Pull requests beside a page.
            .padding(.leading, toastBesideList ? AceDesign.Space.margin : AceTheme.Spacing.none)
            .padding(.bottom, toastBesideList ? AceDesign.Size.tap * 2 + AceDesign.Space.group : AceDesign.Space.aboveTabBar)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .task(id: undo) {
                // An Undo still waiting stays until its machines answer.
                guard !undo.busy else { return }
                try? await Task.sleep(for: .seconds(5))
                if organize.undo == undo { withAnimation { organize.undo = nil } }
            }
        }
    }

    /// Opening routes to the row's machine and shows the thread on its own tab: a chat on Chats,
    /// any other thread on Threads, whichever tab asked; a thread open on another machine or in
    /// the other tab is closed first. `listed` false opens a thread its machine's list doesn't
    /// hold (an archived search hit).
    private func openThread(_ key: InboxKey, listed: Bool = true) {
        guard let client = inbox.client(key.machineId), !listed || client.inbox[key.id] != nil else { return }
        // Shown from anywhere (a notification, a transfer, a row), the thread shows with its
        // drawer in. Already showing, it is not opened again: that would restart its session.
        withAnimation { threadsDrawer.close(); chatsDrawer.close() }
        let target: InboxTab = client.inbox[key.id]?.chat == true ? .chats : .threads
        tab = target
        if path(target).wrappedValue == [.thread(key)], openMachine == key.machineId { return }
        if let openMachine, openMachine != key.machineId { inbox.client(openMachine)?.back() }
        // One open thread at a time: the other tab's page closes without closing this one.
        if let openTab, openTab != target { path(openTab).wrappedValue = [] }
        openMachine = key.machineId
        openTab = target
        client.open(key.id)
        path(target).wrappedValue = [.thread(key)]
    }
    /// A tab's pages changed: the open thread follows, and the place to reopen is kept.
    private func placeChanged(_ place: InboxTab, old: [InboxRoute], new: [InboxRoute]) {
        // Only the tab holding the open thread drives it; clearing the other tab is silent. Its
        // pull request and issue pages are not threads: backing out of one closes nothing.
        guard openTab == place else { return }
        // Any navigation, the restore's own included, settles where the app is.
        placeRestored = true
        lastPlace = InboxRoute.threads(new).last?.place ?? ""
        let old = InboxRoute.threads(old), new = InboxRoute.threads(new)
        if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil; openTab = nil }
        // Back from a child thread reopens its parent on that machine, under a new generation.
        else if new.count < old.count, let parent = new.last { current?.open(parent.id) }
    }
}
