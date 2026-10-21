import SwiftUI

/// The single inbox (issue #560) across every paired machine: the shared sections merged by rank,
/// Done and Snoozed folded away below. Grouping and
/// wording come from each machine's runtime. A row and its thread belong to their machine.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for Settings › Machines; nil for the debug fixture.
    var machines: MachinesModel?
    /// Settings › Face ID; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var path: [String] = []
    /// The machine whose thread is open: the whole navigation stack routes to its runtime.
    @State private var openMachine: String?
    @State private var projectFilter = ""
    @State private var showingSearch = false
    @State private var showingSettings = false
    @State private var showSettled = false
    @State private var snoozing: InboxKey?
    @State private var archived: (key: InboxKey, title: String)?
    private static let settledKeys: Set<String> = ["done", "snoozed"]

    private var merged: MergedInbox { inbox.merged }
    private var sections: [MergedInbox.Section] {
        guard !projectFilter.isEmpty else { return merged.sections }
        return merged.sections.compactMap { section in
            let keys = section.rows.filter { inbox.row($0)?.workspaceId == projectFilter }
            return keys.isEmpty ? nil : MergedInbox.Section(key: section.key, label: section.label, rows: keys)
        }
    }
    private var open: [MergedInbox.Section] { sections.filter { !Self.settledKeys.contains($0.key) } }
    private var settled: [MergedInbox.Section] { sections.filter { Self.settledKeys.contains($0.key) } }
    private var current: ClientModel? { openMachine.flatMap(inbox.client) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                ForEach(inbox.sessions.filter { $0.client.connection != "ready" }) { session in
                    InboxConnectionBanner(connection: session.client.connection,
                                          machine: inbox.showsMachineNames ? inbox.name(session.hostId) : nil) { session.client.retry() }
                        .listRowSeparator(.hidden)
                }
                if !inbox.sessions.isEmpty && inbox.sessions.allSatisfy({ !$0.client.canOperate }) {
                    ViewOnlyNote(message: "View only")
                        .accessibilityHint("Pair with View and act to send, archive or snooze.")
                        .listRowSeparator(.hidden)
                        .listRowBackground(AceTheme.Colours.background)
                }
                ForEach(open) { section in
                    rows(section)
                }
                if !settled.isEmpty {
                    Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showSettled.toggle() } } label: {
                        HStack(spacing: AceTheme.Spacing.md) {
                            Text(settled.map { "\($0.label) (\($0.rows.count))" }.joined(separator: " · "))
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                            Image(systemName: "chevron.down").rotationEffect(.degrees(showSettled ? 180 : 0))
                                .foregroundStyle(AceTheme.Colours.decoration)
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("inbox.settled")
                    .accessibilityValue(showSettled ? "Expanded" : "Collapsed")
                    if showSettled {
                        ForEach(settled) { section in
                            rows(section)
                        }
                    }
                }
                if !merged.more.isEmpty {
                    Button("Show older threads") { for id in merged.more { inbox.client(id)?.loadOlderThreads() } }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .listRowSeparator(.hidden).accessibilityIdentifier("inbox.more")
                }
                emptyState.listRowSeparator(.hidden)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .refreshable { await refresh() }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
            .navigationDestination(for: String.self) { id in
                if let client = current, let thread = client.thread, thread.id == id {
                    // Child threads open on the same machine's client as their parent.
                    ThreadView(model: client, thread: thread) { child in client.open(child); path.append(child) }
                }
            }
            .sheet(isPresented: $showingSearch) { ConversationSearchSheet(inbox: inbox) }
            .sheet(isPresented: $showingSettings) { SettingsSheet(inbox: inbox, machines: machines, lock: lock) }
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .overlay(alignment: .bottom) { undoArchive }
            .newThreadEntry(inbox: inbox, projectFilter: $projectFilter) { key in openThread(key) }
            .aceNotifications(inbox: inbox) { key in openThread(key) }
            .onChange(of: path) { old, new in
                if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil }
                // Back from a child thread reopens its parent on that machine, under a new generation.
                else if new.count < old.count, let parent = new.last { current?.open(parent) }
            }
        }
        .tint(AceTheme.Colours.foreground)
        .task(id: scenePhase) {
            // Foreground reconciliation: renew every live activity's `staleDate` while
            // the navigation stack is mounted, including its thread destinations. Cancelled on
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

    /// The first machine with an error to show; each machine's error is its own.
    private var failing: MachineSession? { inbox.sessions.first { $0.client.error != nil } }

    @ViewBuilder private func rows(_ section: MergedInbox.Section) -> some View {
        if section.key == "unsent" {
            ForEach(section.rows, id: \.self) { key in
                if let entry = inbox.pending(key) {
                    let thread = InboxKey(machineId: key.machineId, id: entry.threadId)
                    Button { openThread(thread) } label: { InboxUnsentRow(entry: entry, thread: inbox.row(thread)) }
                        .buttonStyle(.plain).accessibilityIdentifier("unsent.\(key.id)")
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xxs, leading: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.xxs, trailing: AceTheme.Spacing.lg))
                }
            }
        } else {
            ForEach(section.rows, id: \.self) { key in
                if let row = inbox.row(key) { threadRow(row, key: key, section: section.key) }
            }
        }
    }
    private func threadRow(_ row: ThreadRow, key: InboxKey, section: String) -> some View {
        let snoozed = section == "snoozed"
        let client = inbox.client(key.machineId)
        // A view-only grant is per machine: only that machine's rows lose their actions.
        let canOperate = client?.canOperate ?? false
        return Button { openThread(key) } label: {
            InboxThreadRow(row: row, snoozed: snoozed, machine: inbox.showsMachineNames ? inbox.name(key.machineId) : nil)
        }
            .buttonStyle(.plain)
            .accessibilityIdentifier(inbox.showsMachineNames ? "thread.\(key.machineId).\(row.id)" : "thread.\(row.id)")
            // Colour means status only: the status word and dot carry it, never a broad
            // row wash (a Waiting row in Needs you must not read brown).
            .listRowBackground(AceTheme.Colours.background)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.xxs, leading: AceTheme.Spacing.lg, bottom: AceTheme.Spacing.xxs, trailing: AceTheme.Spacing.lg))
            // No rules between rows: quiet spacing from the row's own padding carries it.
            .listRowSeparator(.hidden)
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                if canOperate { Button("Archive", systemImage: "archivebox") { archive(row, key: key) }.tint(AceTheme.Colours.mutedForeground) }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: snoozed) {
                if !canOperate { EmptyView() }
                else if snoozed { Button("Wake", systemImage: "sun.max") { Task { _ = await client?.wake(row.id) } }.tint(AceTheme.Status.waiting) }
                else { Button("Snooze", systemImage: "moon.zzz") { snoozing = key }.tint(AceTheme.Status.waiting) }
            }
            .contextMenu {
                if !canOperate { EmptyView() }
                else if snoozed { Button("Wake", systemImage: "sun.max") { Task { _ = await client?.wake(row.id) } } }
                else {
                    Menu("Snooze", systemImage: "moon.zzz") {
                        ForEach(merged.snooze) { option in
                            Button(option.label) { Task { _ = await client?.snooze(row.id, preset: option.id) } }
                        }
                    }
                }
                if canOperate { Button("Archive", systemImage: "archivebox") { archive(row, key: key) } }
            }
    }
    @ViewBuilder private var emptyState: some View {
        if sections.isEmpty {
            if !inbox.anyLoaded || !inbox.allReady {
                if inbox.sessions.contains(where: { ["fatal", "offline", "reconnecting"].contains($0.client.connection) }) {
                    ContentUnavailableView {
                        Label(inbox.showsMachineNames ? "Can't reach your machines" : "Can't reach your machine", systemImage: "wifi.slash")
                    } description: { Text("Your threads appear once it's back.") } actions: {
                        Button("Retry") { for session in inbox.sessions { session.client.retry() } }
                    }
                } else {
                    ContentUnavailableView { Label { Text("Connecting to your machine…") } icon: { ProgressView() } }
                }
            } else {
                ContentUnavailableView("Your inbox is clear", systemImage: "tray", description: Text("Tasks from your machines appear here."))
            }
        }
    }
    @ViewBuilder private var undoArchive: some View {
        if let archived {
            HStack(spacing: AceTheme.Spacing.md) {
                Text("Archived “\(archived.title)”").lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                Button("Undo") {
                    self.archived = nil
                    Task { _ = await inbox.client(archived.key.machineId)?.unarchive(archived.key.id) }
                }.bold().frame(minHeight: AceTheme.Dimensions.touchTarget).accessibilityIdentifier("inbox.undoArchive")
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.md)
            .floatingGlass()
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.bottom, AceTheme.Spacing.md)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .task(id: archived.key) {
                try? await Task.sleep(for: .seconds(5))
                if self.archived?.key == archived.key { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { self.archived = nil } }
            }
        }
    }
    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        // The wordmark is decorative branding: hidden from VoiceOver, and with no shared
        // glass behind it where the OS supports it, so the machines control and the
        // trailing icons keep the emphasis.
        wordmarkItem
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings").accessibilityIdentifier("inbox.settings")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingSearch = true } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search conversations").accessibilityIdentifier("inbox.search")
        }
    }

    /// Decorative branding only. The glass hiding applies to the toolbar item itself
    /// (`sharedBackgroundVisibility` lives on `ToolbarContent`, not `View`) on iOS 26+;
    /// older systems render the same item without it.
    @ToolbarContentBuilder private var wordmarkItem: some ToolbarContent {
        if #available(iOS 26, *) {
            ToolbarItem(placement: .topBarLeading) { wordmarkText }
                .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { wordmarkText }
        }
    }
    private var wordmarkText: some View {
        Text("ace.").aceFont(AceTheme.Typography.wordmark, relativeTo: .title3).fixedSize(horizontal: true, vertical: false).foregroundStyle(AceTheme.Colours.foreground)
            .accessibilityHidden(true)
    }

    /// Opening routes to the row's machine; a thread already open elsewhere is closed first.
    private func openThread(_ key: InboxKey) {
        guard let client = inbox.client(key.machineId), client.inbox[key.id] != nil else { return }
        if let openMachine, openMachine != key.machineId { inbox.client(openMachine)?.back() }
        openMachine = key.machineId
        client.open(key.id); path = [key.id]
    }
    private func archive(_ row: ThreadRow, key: InboxKey) {
        Task {
            guard await inbox.client(key.machineId)?.archive(row.id) == true else { return }
            withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { archived = (key, row.title) }
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
