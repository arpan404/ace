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
/// Pulls (threads whose pull request is in review) and the detached New thread button. Grouping
/// and wording come from each machine's runtime. A row and its thread belong to their machine.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for Settings › Machines; nil for the debug fixture.
    var machines: MachinesModel?
    /// Settings › Face ID; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var tab = InboxTab.threads
    @State private var threadsPath: [String] = []
    @State private var pullsPath: [String] = []
    /// The machine whose thread is open, and the tab it is open in: one open thread at a time.
    @State private var openMachine: String?
    @State private var openTab: InboxTab?
    @State private var machineFilter = ""
    @State private var projectFilter = ""
    @State private var shelves = InboxShelves()
    @State private var composing = false
    @State private var showingSettings = false
    /// Where Settings opens: its root, or Machines from the connection title.
    @State private var settingsStart: [SettingsRoute] = []
    @State private var snoozing: InboxKey?
    @State private var undo: InboxUndo?
    @State private var settles = 0

    private var current: ClientModel? { openMachine.flatMap(inbox.client) }

    var body: some View {
        sheets
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(inbox.merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .newThreadEntry(inbox: inbox, composing: $composing, project: projectFilter) { key in openThread(key, in: .threads) }
            .aceNotifications(inbox: inbox) { key in openThread(key, in: .threads) }
            .task(id: scenePhase) {
                // Foreground reconciliation: renew every live activity's `staleDate` while
                // the inbox is mounted, including its thread destinations. Cancelled on
                // background or unmount; rows stay truthful and nothing ends here — `update`
                // only finishes a canonical done row while online.
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    for session in inbox.sessions {
                        session.client.liveActivity.update(rows: session.client.inbox, hostId: session.hostId, online: session.client.connection == "ready")
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

    private var tabs: some View {
        TabView(selection: $tab) {
            Tab("Threads", systemImage: "text.bubble", value: InboxTab.threads) { stack(.threads, path: $threadsPath) }
            Tab("Pulls", image: "tab-pulls", value: InboxTab.pulls) { stack(.pulls, path: $pullsPath) }
            if inbox.canStartThreads {
                Tab("New thread", systemImage: "square.and.pencil", value: InboxTab.compose, role: .search) { Color.clear }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .onChange(of: tab) { old, new in
            // The compose button opens the New thread sheet and leaves the tab where it was.
            guard new == .compose else { return }
            tab = old == .compose ? .threads : old
            if !inbox.sessions.isEmpty { composing = true }
        }
        .onChange(of: threadsPath) { old, new in pathChanged(.threads, old: old, new: new) }
        .onChange(of: pullsPath) { old, new in pathChanged(.pulls, old: old, new: new) }
        .sensoryFeedback(.success, trigger: settles)
        .overlay(alignment: .bottom) { toast }
    }

    private var sheets: some View {
        tabs
        .sheet(isPresented: $showingSettings) {
            SettingsSheet(inbox: inbox, machines: machines, lock: lock, start: settingsStart)
        }
    }

    /// The first machine with an error to show; each machine's error is its own.
    private var failing: MachineSession? { inbox.sessions.first { $0.client.error != nil } }

    private func stack(_ tab: InboxTab, path: Binding<[String]>) -> some View {
        InboxStack(inbox: inbox, path: path, pulls: tab == .pulls, machine: $machineFilter, project: $projectFilter,
                   shelves: $shelves, actions: actions(in: tab),
                   header: InboxHeaderActions(settings: { settingsStart = []; showingSettings = true },
                                              machines: { settingsStart = [.machines]; showingSettings = true })) { id in
            if let client = current, openTab == tab, let thread = client.thread, thread.id == id {
                // Child threads open on the same machine's client as their parent.
                ThreadView(model: client, thread: thread) { child in client.open(child); path.wrappedValue.append(child) }
            }
        }
    }

    private func actions(in tab: InboxTab) -> InboxRowActions {
        InboxRowActions(
            open: { openThread($0, in: tab) },
            settle: { row, key in
                settles += 1
                command(key, .settled) { await $0.settle(row.id) }
            },
            unsettle: { row, key in Task { _ = await inbox.client(key.machineId)?.unsettle(row.id) } },
            snooze: { snoozing = $0 },
            snoozeUntil: { row, key, preset in Task { _ = await inbox.client(key.machineId)?.snooze(row.id, preset: preset) } },
            wake: { row, key in Task { _ = await inbox.client(key.machineId)?.wake(row.id) } },
            archive: { row, key in command(key, .archived) { await $0.archive(row.id) } })
    }
    /// Runs an undoable inbox command; once this device admits it, the toast offers Undo.
    private func command(_ key: InboxKey, _ kind: InboxUndo.Kind, _ run: @escaping (ClientModel) async -> Bool) {
        Task {
            guard let client = inbox.client(key.machineId), await run(client) else { return }
            withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { undo = InboxUndo(key: key, kind: kind) }
        }
    }

    @ViewBuilder private var toast: some View {
        if let undo, openTab == nil {
            HStack(spacing: AceTheme.Spacing.md) {
                Text(undo.kind == .settled ? "Settled thread" : "Archived thread").lineLimit(1)
                Button("Undo") {
                    self.undo = nil
                    Task {
                        guard let client = inbox.client(undo.key.machineId) else { return }
                        _ = undo.kind == .settled ? await client.unsettle(undo.key.id) : await client.unarchive(undo.key.id)
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
            // Clear of the tab bar.
            .padding(.bottom, 76)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .task(id: undo) {
                try? await Task.sleep(for: .seconds(5))
                if self.undo == undo { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { self.undo = nil } }
            }
        }
    }

    /// Opening routes to the row's machine and shows the thread in `tab`; a thread open on
    /// another machine, or in the other tab, is closed first.
    private func openThread(_ key: InboxKey, in tab: InboxTab) {
        guard let client = inbox.client(key.machineId), client.inbox[key.id] != nil else { return }
        if let openMachine, openMachine != key.machineId { inbox.client(openMachine)?.back() }
        openMachine = key.machineId
        openTab = tab
        self.tab = tab
        client.open(key.id)
        if tab == .pulls { threadsPath = []; pullsPath = [key.id] } else { pullsPath = []; threadsPath = [key.id] }
    }
    private func pathChanged(_ tab: InboxTab, old: [String], new: [String]) {
        // Only the tab holding the open thread drives it; clearing the other tab is silent.
        guard openTab == tab else { return }
        if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil; openTab = nil }
        // Back from a child thread reopens its parent on that machine, under a new generation.
        else if new.count < old.count, let parent = new.last { current?.open(parent) }
    }
}
