import SwiftUI

/// A settle or archive the person can take back from the toast.
struct InboxUndo: Equatable {
    enum Kind { case settled, archived }
    let key: InboxKey
    let kind: Kind
}

/// The single inbox (issue #560) across every paired machine: one task list, scoped to every
/// thread or to pull requests in review, to one machine or project. Grouping and wording come
/// from each machine's runtime. A row and its thread belong to their machine.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for Settings › Machines; nil for the debug fixture.
    var machines: MachinesModel?
    /// Settings › Face ID; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var path: [String] = []
    /// The machine whose thread is open: one open thread at a time.
    @State private var openMachine: String?
    @State private var scope = InboxScope()
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
        stack
            .sheet(isPresented: $showingSettings) {
                SettingsSheet(inbox: inbox, machines: machines, lock: lock, start: settingsStart)
            }
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(inbox.merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .newThreadEntry(inbox: inbox, composing: $composing, project: scope.project) { key in openThread(key) }
            .aceNotifications(inbox: inbox) { key in openThread(key) }
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

    private var stack: some View {
        InboxStack(inbox: inbox, path: $path, scope: $scope, shelves: $shelves, actions: actions,
                   chrome: InboxChromeActions(settings: { settingsStart = []; showingSettings = true },
                                              machines: { settingsStart = [.machines]; showingSettings = true },
                                              compose: inbox.canStartThreads ? { if !inbox.sessions.isEmpty { composing = true } } : nil)) { id in
            if let client = current, let thread = client.thread, thread.id == id {
                // Child threads open on the same machine's client as their parent.
                ThreadView(model: client, thread: thread) { child in client.open(child); path.append(child) }
            }
        }
        .onChange(of: path) { old, new in pathChanged(old: old, new: new) }
        .sensoryFeedback(.success, trigger: settles)
        .overlay(alignment: .bottom) { toast }
    }

    /// The first machine with an error to show; each machine's error is its own.
    private var failing: MachineSession? { inbox.sessions.first { $0.client.error != nil } }

    private var actions: InboxRowActions {
        InboxRowActions(
            open: { openThread($0) },
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

    /// One sentence and one text button (DESIGN.md toasts), above the bottom toolbar.
    @ViewBuilder private var toast: some View {
        if let undo, openMachine == nil {
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
                .frame(minHeight: 44)
                .accessibilityIdentifier(undo.kind == .settled ? "inbox.undoSettle" : "inbox.undoArchive")
            }
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.lg)
            .aceGlass(in: RoundedRectangle(cornerRadius: AceTheme.Radii.lg, style: .continuous))
            // Clear of the bottom toolbar.
            .padding(.bottom, 64)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .task(id: undo) {
                try? await Task.sleep(for: .seconds(5))
                if self.undo == undo { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { self.undo = nil } }
            }
        }
    }

    /// Opening routes to the row's machine; a thread open on another machine is closed first.
    private func openThread(_ key: InboxKey) {
        guard let client = inbox.client(key.machineId), client.inbox[key.id] != nil else { return }
        if let openMachine, openMachine != key.machineId { inbox.client(openMachine)?.back() }
        openMachine = key.machineId
        client.open(key.id)
        path = [key.id]
    }
    private func pathChanged(old: [String], new: [String]) {
        if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil }
        // Back from a child thread reopens its parent on that machine, under a new generation.
        else if new.count < old.count, let parent = new.last { current?.open(parent) }
    }
}
