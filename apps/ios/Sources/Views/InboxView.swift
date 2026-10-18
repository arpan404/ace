import SwiftUI

/// The single inbox (issue #560) across every paired machine: the shared sections merged by rank,
/// Done and Snoozed folded away below. Swift filters by search text and draws; grouping and
/// wording come from each machine's runtime. A row and its thread belong to their machine.
struct InboxView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var inbox: MachineInbox
    /// Rename, remove and pairing for the Machines sheet; nil for the debug fixture.
    var machines: MachinesModel?
    var addMachine: () -> Void = {}
    /// Settings › App lock; nil where the app has no lock (the debug fixture).
    var lock: AppLock?
    @State private var path: [String] = []
    /// The machine whose thread is open: the whole navigation stack routes to its runtime.
    @State private var openMachine: String?
    @State private var search = ""
    @State private var showingSearch = false
    @State private var showingMachines = false
    @State private var showingSettings = false
    @State private var archiveMachine: String?
    @State private var showSettled = false
    @State private var snoozing: InboxKey?
    @State private var archived: (key: InboxKey, title: String)?
    private static let settledKeys: Set<String> = ["done", "snoozed"]

    private var merged: MergedInbox { inbox.merged }
    private var sections: [MergedInbox.Section] { merged.sections.compactMap(filtered) }
    private var open: [MergedInbox.Section] { sections.filter { !Self.settledKeys.contains($0.key) } }
    private var settled: [MergedInbox.Section] { sections.filter { Self.settledKeys.contains($0.key) } }
    private var current: ClientModel? { openMachine.flatMap(inbox.client) }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if showingSearch {
                    TextField("Search threads", text: $search).textFieldStyle(.plain).accessibilityIdentifier("inbox.search")
                }
                ForEach(inbox.sessions.filter { $0.client.connection != "ready" }) { session in
                    InboxConnectionBanner(connection: session.client.connection,
                                          machine: inbox.showsMachineNames ? inbox.name(session.hostId) : nil) { session.client.retry() }
                        .listRowSeparator(.hidden)
                }
                if !inbox.sessions.isEmpty && inbox.sessions.allSatisfy({ !$0.client.canOperate }) { ViewOnlyNote.inbox.listRowSeparator(.hidden) }
                ForEach(open) { section in
                    Section { rows(section) } header: { InboxSectionHeader(title: section.label, count: section.rows.count) }
                }
                if !settled.isEmpty {
                    Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showSettled.toggle() } } label: {
                        HStack(spacing: AceTheme.Spacing.md) {
                            Text(settled.map { "\($0.label) (\($0.rows.count))" }.joined(separator: " · "))
                            Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border)
                            Image(systemName: "chevron.down").rotationEffect(.degrees(showSettled ? 180 : 0))
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget)
                    .accessibilityIdentifier("inbox.settled")
                    .accessibilityValue(showSettled ? "Expanded" : "Collapsed")
                    if showSettled {
                        ForEach(settled) { section in
                            Section { rows(section) } header: { InboxSectionHeader(title: section.label, count: section.rows.count) }
                        }
                    }
                }
                if !merged.more.isEmpty && search.isEmpty {
                    Button("Show older threads") { for id in merged.more { inbox.client(id)?.loadOlderThreads() } }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .listRowSeparator(.hidden).accessibilityIdentifier("inbox.more")
                }
                emptyState.listRowSeparator(.hidden)
                if inbox.anyLoaded && search.isEmpty {
                    Button("Archived threads") { archiveMachine = inbox.sessions.first?.hostId }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minHeight: AceTheme.Dimensions.touchTarget)
                        .listRowSeparator(.hidden).accessibilityIdentifier("inbox.archive")
                }
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
            .sheet(isPresented: $showingMachines) {
                MachinesSheet(inbox: inbox, machines: machines) { showingMachines = false; addMachine() }
            }
            .sheet(isPresented: $showingSettings) {
                SettingsSheet(inbox: inbox, machines: machines, lock: lock,
                              openMachines: { showingMachines = true },
                              openArchive: { archiveMachine = inbox.sessions.first?.hostId })
            }
            .sheet(item: Binding(get: { archiveMachine.map(ArchiveTarget.init) }, set: { archiveMachine = $0?.id })) { target in
                ArchiveSheet(inbox: inbox, machineId: target.id)
            }
            .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }), presenting: snoozing) { key in
                ForEach(merged.snooze) { option in
                    Button(option.label) { Task { _ = await inbox.client(key.machineId)?.snooze(key.id, preset: option.id) } }
                }
            }
            .overlay(alignment: .bottom) { undoArchive }
            .aceNotifications(inbox: inbox) { key in openThread(key) }
            .onChange(of: path) { old, new in
                if !old.isEmpty && new.isEmpty { current?.back(); openMachine = nil }
                // Back from a child thread reopens its parent on that machine, under a new generation.
                else if new.count < old.count, let parent = new.last { current?.open(parent) }
            }
        }
        .tint(AceTheme.Colours.foreground)
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
            .listRowBackground(section == "needs-you" ? AceTheme.Colours.needsYouSurface : AceTheme.Colours.background)
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
            if !search.isEmpty && !merged.sections.isEmpty { ContentUnavailableView.search(text: search) }
            else if !inbox.anyLoaded {
                if inbox.sessions.allSatisfy({ ["fatal", "offline", "reconnecting"].contains($0.client.connection) }) && !inbox.sessions.isEmpty {
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
        ToolbarItemGroup(placement: .topBarLeading) {
            Text("ace.").aceFont(AceTheme.Typography.wordmark, relativeTo: .title3).fixedSize(horizontal: true, vertical: false).foregroundStyle(AceTheme.Colours.foreground)
            Button { showingMachines = true } label: {
                HStack(spacing: AceTheme.Spacing.xs) {
                    Circle().fill(inbox.allReady ? AceTheme.Status.done : AceTheme.Colours.decoration).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
                    Text(inbox.sessions.count == 1 ? "1 machine" : "\(inbox.sessions.count) machines").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                }.foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .accessibilityLabel("Machines")
            .accessibilityValue(inbox.allReady ? "All connected" : "Not all connected")
            .accessibilityIdentifier("inbox.machines")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings").accessibilityIdentifier("inbox.settings")
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { withAnimation(reduceMotion ? nil : AceTheme.Motion.spring) { showingSearch.toggle(); if !showingSearch { search = "" } } } label: { Image(systemName: "magnifyingglass") }
                .accessibilityLabel("Search threads")
        }
    }

    private func filtered(_ section: MergedInbox.Section) -> MergedInbox.Section? {
        guard !search.isEmpty else { return section }
        let rows = section.rows.filter { key in
            let pending = section.key == "unsent" ? inbox.pending(key) : nil
            let row = section.key == "unsent" ? pending.flatMap { inbox.row(InboxKey(machineId: key.machineId, id: $0.threadId)) } : inbox.row(key)
            let machine = inbox.showsMachineNames ? inbox.name(key.machineId) : ""
            return [row?.title ?? "", row?.project ?? "", pending?.text ?? "", machine].contains { $0.localizedCaseInsensitiveContains(search) }
        }
        return rows.isEmpty ? nil : MergedInbox.Section(key: section.key, label: section.label, rows: rows)
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

/// The machine the archive sheet opens on.
private struct ArchiveTarget: Identifiable { let id: String }
