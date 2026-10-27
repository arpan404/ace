import SwiftUI

/// The tabs of the home screen. `compose` is the detached New thread button, never a page.
enum InboxTab: Hashable { case threads, pulls, compose }

/// A settle or archive the person can take back from the toast.
struct InboxUndo: Equatable {
    enum Kind { case settled, archived }
    let key: InboxKey
    let kind: Kind
}

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
    @State private var undo: InboxUndo?
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
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(inbox.merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .newThreadEntry(inbox: inbox, composing: $composing, project: projectFilter) { key in openThread(key) }
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
        // Beside an open thread, or over it as the drawer, the toast sits under the list it acted
        // on, clear of the composer and the list's foot.
        .overlay(alignment: toastBesideList ? .bottomLeading : .bottom) { toast }
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
                   machine: $machineFilter, project: $projectFilter,
                   shelves: $shelves, reveal: $reveal, actions: actions,
                   header: InboxHeaderActions(settings: { settingsStart = []; showingSettings = true },
                                              machines: { settingsStart = [.machines]; showingSettings = true },
                                              pair: pair)) { key in
            // Each page keeps drawing its thread while it slides away; child threads open on the
            // same machine's client as their parent.
            if let client = inbox.client(key.machineId) {
                ThreadPage(client: client, id: key.id) { child in
                    client.open(child); path.wrappedValue.append(.thread(InboxKey(machineId: key.machineId, id: child)))
                }
                .environment(\.openPullRequest) { project, number, repository in
                    path.wrappedValue.append(.forge(ForgeRoute(kind: .pull, machineId: key.machineId, project: project, number: number, repository: repository)))
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
                command(key, .settled) { await $0.settle(row.id) }
            },
            unsettle: { row, key in
                acted()
                Task { if await inbox.client(key.machineId)?.unsettle(row.id) == true { reveal = key } }
            },
            snooze: { acted(); snoozing = $0 },
            snoozeUntil: { row, key, preset in acted(); Task { _ = await inbox.client(key.machineId)?.snooze(row.id, preset: preset) } },
            wake: { row, key in acted(); Task { _ = await inbox.client(key.machineId)?.wake(row.id) } },
            archive: { row, key in acted(); command(key, .archived) { await $0.archive(row.id) } },
            pin: { row, key, pinned in acted(); Task { _ = await inbox.client(key.machineId)?.pin(row.id, pinned) } },
            move: { key, section, index in acted(); Task { await inbox.move(key, in: section, to: index) } })
    }
    /// Runs an undoable inbox command; once this device admits it, the toast offers Undo.
    private func command(_ key: InboxKey, _ kind: InboxUndo.Kind, _ run: @escaping (ClientModel) async -> Bool) {
        Task {
            guard let client = inbox.client(key.machineId), await run(client) else { return }
            withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { undo = InboxUndo(key: key, kind: kind) }
        }
    }

    /// The list showing beside a page (regular) or over it as the open drawer, with Threads and
    /// Pull requests at its foot in place of the tab bar.
    private var toastBesideList: Bool {
        sizeClass == .regular || (tab == .pulls ? pullsDrawer : threadsDrawer).isOpen
    }

    @ViewBuilder private var toast: some View {
        if let undo, openTab == nil || toastBesideList {
            HStack(spacing: AceTheme.Spacing.md) {
                Text(undo.kind == .settled ? "Settled thread" : "Archived thread").lineLimit(1)
                Button("Undo") {
                    self.undo = nil
                    Task {
                        guard let client = inbox.client(undo.key.machineId) else { return }
                        let undone = undo.kind == .settled ? await client.unsettle(undo.key.id) : await client.unarchive(undo.key.id)
                        if undone { reveal = undo.key }
                    }
                }
                .fontWeight(.semibold)
                .frame(minHeight: AceTheme.Dimensions.touchTarget)
                .accessibilityIdentifier(undo.kind == .settled ? "inbox.undoSettle" : "inbox.undoArchive")
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
                try? await Task.sleep(for: .seconds(5))
                if self.undo == undo { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { self.undo = nil } }
            }
        }
    }

    /// Opening routes to the row's machine and shows the thread on the Threads tab, whichever tab
    /// asked (the Pulls tab keeps its page); a thread open on another machine is closed first.
    private func openThread(_ key: InboxKey) {
        guard let client = inbox.client(key.machineId), client.inbox[key.id] != nil else { return }
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
