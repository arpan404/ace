import SwiftUI

/// The tabs of the home screen. `compose` is the detached New thread button, never a page.
enum InboxTab: Hashable { case threads, pulls, compose }

/// The single inbox (issue #560) across every paired machine, in a system tab bar: Threads,
/// Pulls (the web's Pull requests and Issues lists) and the detached New thread button. Grouping
/// and wording come from each machine's runtime. A row and its thread belong to their machine.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for Settings › Machines; nil for the debug fixture.
    var machines: MachinesModel?
    /// Settings › Face ID; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var tab = InboxTab.threads
    @State private var threadsPath: [InboxRoute] = []
    @State private var pullsPath: [InboxRoute] = []
    /// Each tab's list as a drawer over its open page in a compact window (`ThreadDrawer`).
    @State private var threadsDrawer = ThreadDrawer()
    @State private var pullsDrawer = ThreadDrawer()
    /// The machine whose thread is open, and the tab it is open in: one open thread at a time.
    @State private var openMachine: String?
    @State private var openTab: InboxTab?
    @State private var machineFilter = ""
    @State private var projectFilter = ""
    @State private var shelves = InboxShelves()
    @State private var composing = false
    @State private var showingSettings = false
    @State private var pairing = false
    /// Where Settings opens: its root, or Machines from the connection title.
    @State private var settingsStart: [SettingsRoute] = []
    @State private var snoozing: InboxKey?
    /// Delete, move, bulk actions and the Undo toast, across machines.
    @State private var organize = InboxOrganize()
    /// The project New thread from default branch starts in, over the list's own filter.
    @State private var composeProject: String?
    /// The Pulls tab's list: Pull requests, Issues or Notifications.
    @State private var forgeKind = ForgeKind.pulls
    /// `ace://` links waiting for the app to be ready (`PendingLinks`).
    @State private var links = PendingLinks()
    /// The open thread's commands, for search everything (`ThreadKeysBox`).
    @State private var threadKeysBox = ThreadKeysBox()
    @State private var renamingRow: InboxKey?
    /// A row brought back by Undo or Unsettle, scrolled into view once it is in the list again:
    /// unsettling makes it the newest activity, so it returns far from where the person acted.
    @State private var reveal: InboxKey?
    @State private var settles = 0
    /// Holds off row taps just after a row action, so the row sliding into its place stays shut.
    @State private var rowTaps = RowTapGuard()
    /// The thread on screen when the app last ran: a relaunch opens it again, as the web reopens
    /// its URL, whether the system ended the app in the background or it was killed.
    @AppStorage("ace.inbox.openThread") private var lastPlace = ""
    @State private var placeRestored = false

    private var current: ClientModel? { openMachine.flatMap(inbox.client) }

    var body: some View {
        sheets
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
                Button("OK") { failing?.client.error = nil }
            } message: {
                if let failing { Text(inbox.showsMachineNames ? "\(inbox.name(failing.hostId)): \(failing.client.error ?? "")" : failing.client.error ?? "") }
            }
    }

    /// The tab role the system draws as its own round button at the bar's trailing end, apart from
    /// Threads and Pulls: iOS 27's prominent tab; before it, the search tab.
    private static var detachedRole: TabRole {
        if #available(iOS 27, *) { return .prominent }
        return .search
    }

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Threads", systemImage: "text.bubble", value: InboxTab.threads) { stack(.threads, path: $threadsPath) }
            Tab("Pulls", image: "tab-pulls", value: InboxTab.pulls) { stack(.pulls, path: $pullsPath) }
            if inbox.canStartThreads {
                Tab("New thread", systemImage: "square.and.pencil", value: InboxTab.compose, role: Self.detachedRole) { Color.clear }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .onChange(of: tab) { old, new in
            // Coming back to a tab shows its page, never the drawer left out when it was left.
            if new != .compose { threadsDrawer.close(); pullsDrawer.close() }
            // The compose button opens the New thread sheet and leaves the tab where it was.
            guard new == .compose else { return }
            tab = old == .compose ? .threads : old
            startThread()
        }
        .onChange(of: threadsPath) { old, new in
            pathChanged(.threads, old: old, new: new)
            // Any navigation, the restore's own included, settles where the app is.
            placeRestored = true
            lastPlace = InboxRoute.threads(new).last?.place ?? ""
        }
        .task(id: restorable) {
            // Once the restored thread's row is back (from this phone's copy or its machine).
            guard !placeRestored, let key = InboxKey(place: lastPlace) else { placeRestored = true; return }
            guard restorable else { return }
            placeRestored = true
            // Cleared first and written back once it shows, so a thread that cannot open sends
            // the next launch to the inbox instead of into the same failure.
            lastPlace = ""
            if threadsPath.isEmpty { openThread(key) }
        }
        .onChange(of: pullsPath) { old, new in pathChanged(.pulls, old: old, new: new) }
        .environment(\.otherMachines, otherMachines)
        .sensoryFeedback(.success, trigger: settles)
        // Bulk actions, deletes, moves and Mark unread confirm with the same tap.
        .sensoryFeedback(.success, trigger: organize.feedback)
        // Beside an open thread, or over it as the drawer, the toast sits under the list it acted
        // on, clear of the composer and the list's foot.
        .overlay(alignment: toastBesideList ? .bottomLeading : .bottom) { toast }
        .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: organize.undo?.serial)
    }

    private var sheets: some View {
        tabs
        .sheet(isPresented: $showingSettings) {
            SettingsSheet(inbox: inbox, machines: machines, lock: lock, start: settingsStart)
                .environment(\.otherMachines, OtherMachines(client: { inbox.client($0) }))
        }
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
    /// New thread needs a computer; with none paired it offers pairing instead.
    private func startThread() {
        if !inbox.sessions.isEmpty { composing = true } else { pair?() }
    }
    /// Add device, once the phone knows no computer is paired.
    private var pair: (() -> Void)? {
        guard let machines, machines.loaded, machines.machines.isEmpty else { return nil }
        return { pairing = true }
    }

    /// Open from a transfer's line goes to that machine's thread on the Threads tab.
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

    private func stack(_ tab: InboxTab, path: Binding<[InboxRoute]>) -> some View {
        InboxStack(inbox: inbox, path: path, pulls: tab == .pulls, tab: self.$tab, drawer: tab == .pulls ? $pullsDrawer : $threadsDrawer,
                   forge: ForgeInboxHooks(openThread: { openThread($0) },
                                          startThread: { startThread() }),
                   machine: $machineFilter, project: $projectFilter, forgeKind: $forgeKind,
                   shelves: $shelves, reveal: $reveal, actions: actions,
                   header: InboxHeaderActions(settings: { settingsStart = []; showingSettings = true },
                                              machines: { settingsStart = [.machines]; showingSettings = true },
                                              pair: pair,
                                              page: { route in settingsStart = route; showingSettings = true },
                                              // A search result off the list (archived) opens like a
                                              // row: the open page and its client move together.
                                              archived: { key in openThread(key, listed: false) }),
                   organize: organize) { key in
            // Each page keeps drawing its thread while it slides away; child threads open on the
            // same machine's client as their parent.
            if let client = inbox.client(key.machineId) {
                ThreadPage(client: client, id: key.id) { child in
                    client.open(child); path.wrappedValue.append(.thread(InboxKey(machineId: key.machineId, id: child)))
                }
            }
        }
    }

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
            settingsStart = SettingsRoute.linked(link.page)
            showingSettings = true
        case "new-thread":
            composeProject = link.project
            startThread()
        case "open-folder":
            organize.problem = "Folders open in ace on your computer."
        default: break
        }
    }
    /// A thread's shared menu ids run here, for its row's menu and the open thread's ⋯ alike.
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
        case "copy-link": UIPasteboard.general.string = AceLink.thread(key.id, machine: client.hostId).absoluteString
        case "new-on-main":
            composeProject = row?.workspaceId
            startThread()
        default: break
        }
    }
    /// The list showing beside a page (regular) or over it as the open drawer, with Threads and
    /// Pull requests at its foot in place of the tab bar.
    private var toastBesideList: Bool {
        sizeClass == .regular || (tab == .pulls ? pullsDrawer : threadsDrawer).isOpen
    }

    @ViewBuilder private var toast: some View {
        if let undo = organize.undo, openTab == nil || toastBesideList {
            HStack(spacing: AceTheme.Spacing.md) {
                Text(undo.text).lineLimit(1)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("inbox.toast")
                // While an Undo waits on a machine there is nothing to press; it says so.
                if !undo.busy {
                    Button("Undo") {
                        Task { if await organize.takeBack(undo, in: inbox) { reveal = undo.keys.first } }
                    }
                    .fontWeight(.semibold)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier(undo.identifier)
                }
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.leading, AceTheme.Spacing.xl).padding(.trailing, AceTheme.Spacing.lg)
            .aceGlass(in: AceShape.capsule)
            // Clear of the tab bar, or of the sidebar's Threads and Pull requests beside a page.
            .padding(.leading, toastBesideList ? AceTheme.Spacing.xl : AceTheme.Spacing.none)
            .padding(.bottom, toastBesideList ? AceTheme.Dimensions.touchTarget * 2 + AceTheme.Spacing.xxl : 76)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .task(id: undo) {
                // An Undo still waiting stays until its machines answer.
                guard !undo.busy else { return }
                try? await Task.sleep(for: .seconds(5))
                if organize.undo == undo { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { organize.undo = nil } }
            }
        }
    }

    /// Opening routes to the row's machine and shows the thread on the Threads tab, whichever tab
    /// asked (the Pulls tab keeps its page); a thread open on another machine is closed first.
    /// `listed` false opens a thread its machine's list doesn't hold (an archived search hit).
    private func openThread(_ key: InboxKey, listed: Bool = true) {
        guard let client = inbox.client(key.machineId), !listed || client.inbox[key.id] != nil else { return }
        // Shown from anywhere (a notification, a transfer, a row), the thread shows with its
        // drawer in. Already showing, it is not opened again: that would restart its session.
        withAnimation(reduceMotion ? AceTheme.Motion.standardCurve : AceTheme.Motion.spring) { threadsDrawer.close() }
        tab = .threads
        if threadsPath == [.thread(key)], openMachine == key.machineId { return }
        if let openMachine, openMachine != key.machineId { inbox.client(openMachine)?.back() }
        openMachine = key.machineId
        openTab = .threads
        client.open(key.id)
        // Threads open on the Threads tab; the Pulls tab keeps its pull request or issue page.
        threadsPath = [.thread(key)]
    }
    private func pathChanged(_ tab: InboxTab, old: [InboxRoute], new: [InboxRoute]) {
        // Only the tab holding the open thread drives it; clearing the other tab is silent. Its
        // pull request and issue pages are not threads: backing out of one closes nothing.
        guard openTab == tab else { return }
        let old = InboxRoute.threads(old), new = InboxRoute.threads(new)
        if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil; openTab = nil }
        // Back from a child thread reopens its parent on that machine, under a new generation.
        else if new.count < old.count, let parent = new.last { current?.open(parent.id) }
    }
}
