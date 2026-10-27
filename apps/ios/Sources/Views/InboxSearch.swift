import SwiftUI

/// Message search across every paired machine: one `ConversationSearch` per machine, so each
/// machine's late replies only ever replace its own results. The hits read as one list, merged by
/// the daemons' relevance.
@MainActor @Observable final class InboxMessageSearch {
    private(set) var searches: [String: ConversationSearch] = [:]

    /// `only` limits the search to one machine (a project filter names one machine's project).
    func run(_ inbox: MachineInbox, text: String, kind: String, filters: [String: Any], only: String?) async {
        let sessions = inbox.sessions.filter { only == nil || $0.hostId == only }
        for session in inbox.sessions where !sessions.contains(where: { $0.hostId == session.hostId }) {
            await searches[session.hostId]?.search(model: session.client, text: "", kind: kind, threadId: nil)
        }
        for session in sessions where searches[session.hostId] == nil { searches[session.hostId] = ConversationSearch() }
        // Every machine searches at once; a newer query cancels them all.
        let runs = sessions.compactMap { session in
            searches[session.hostId].map { search in
                Task<Void, Never> { await search.search(model: session.client, text: text, kind: kind, threadId: nil, filters: filters) }
            }
        }
        await withTaskCancellationHandler {
            for run in runs { await run.value }
        } onCancel: {
            for run in runs { run.cancel() }
        }
    }
    func hits(_ hostId: String) -> [ConversationHit] { searches[hostId]?.hits ?? [] }
    /// Every machine's hits together, most relevant first.
    func merged(_ inbox: MachineInbox) -> [(machineId: String, hit: ConversationHit)] {
        inbox.sessions.flatMap { session in hits(session.hostId).map { (session.hostId, $0) } }
            .sorted { ($0.hit.score ?? 0, $0.hit.createdAt) > ($1.hit.score ?? 0, $1.hit.createdAt) }
    }
    var loading: Bool { searches.values.contains { $0.loading } }
    var settled: Bool { !searches.isEmpty && searches.values.allSatisfy { $0.loaded || $0.problem != nil || !$0.loading } }
}

/// The search's filters, as the web's search sheet offers them: what kind of hit, which
/// project, and how far back.
struct SearchScope: Equatable {
    var kind = "all"
    /// "machine/workspace", or empty for every project.
    var project = ""
    /// Past this many days, or 0 for any time.
    var days = 0

    static let kinds: [(id: String, label: String)] = [
        ("all", "All"), ("message", "Messages"), ("tool_call", "Commands"), ("artifact", "Files"), ("thread", "Threads"),
    ]
    static let ranges: [(days: Int, label: String)] = [(0, "Any time"), (1, "Past day"), (7, "Past week"), (30, "Past month")]
    var isDefault: Bool { self == SearchScope() }
}

/// What the search-everything sheet opens, as the inbox carries it out.
struct SearchActions {
    let open: (InboxKey) -> Void
    /// A command id from the shared catalog (`bridge/palette.ts`).
    let command: (String) -> Void
    /// Scope the list to one machine's project.
    let project: (String, String) -> Void
    /// A thread its machine's search found beyond the list (archived or older).
    let archived: (InboxKey) -> Void
}

/// Search everything (the web's command palette and search, ⌘K): before a query, recent
/// searches and every command; with one, the matching commands, projects and threads of every
/// paired machine, then their messages, filtered by kind, project and date. Results stay until
/// the next ones arrive and crossfade in; nothing blanks between keystrokes.
struct InboxSearchList: View {
    @Bindable var inbox: MachineInbox
    @Binding var query: String
    let includes: (InboxKey) -> Bool
    let threadOpen: Bool
    let actions: SearchActions
    @State private var messages = InboxMessageSearch()
    @State private var everything = SearchEverything()
    @State private var scope = SearchScope()
    @State private var recent = RecentSearches.read(.standard)
    @Environment(\.onSidebarGlass) private var onGlass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    private var text: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var projectChoices: [ProjectChoice] { inbox.projectChoices() }
    private var scopedMachine: String? { scope.project.isEmpty ? nil : String(scope.project.split(separator: "/", maxSplits: 1).first ?? "") }
    private var scopedWorkspace: String? { scope.project.isEmpty ? nil : scope.project.split(separator: "/", maxSplits: 1).last.map(String.init) }

    var body: some View {
        List {
            if text.isEmpty { start } else { results }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .background(surface)
        .environment(\.defaultMinListRowHeight, 0)
        // New results crossfade in; under Reduce Motion they simply fade.
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : AceTheme.Motion.standardCurve, value: shape)
        .task(id: "\(text)|\(threadOpen)|\(scope.project)|\(inbox.sessions.map { "\($0.hostId):\($0.client.connection)" })") {
            let project = scopedMachine.flatMap { machine in scopedWorkspace.map { (machineId: machine, workspaceId: $0) } }
            await everything.run(inbox, query: text, threadOpen: threadOpen, project: project)
        }
        .task(id: "\(text)|\(scope.kind)|\(scope.project)|\(scope.days)|\(inbox.sessions.map { "\($0.hostId):\($0.client.connection)" })") {
            guard !text.isEmpty, scope.kind != "thread" else { return }
            var filters: [String: Any] = [:]
            if let scopedWorkspace { filters["workspaceId"] = scopedWorkspace }
            if scope.days > 0 { filters["after"] = (Date().timeIntervalSince1970 - Double(scope.days) * 86_400) * 1000 }
            await messages.run(inbox, text: text, kind: scope.kind == "all" ? "message" : scope.kind, filters: filters, only: scopedMachine)
        }
    }

    /// What the rows are, for the crossfade: ids only, never their text.
    private var shape: [String] {
        text.isEmpty ? ["start"] + recent + everything.commands.map(\.id)
            : everything.commands.map(\.id) + everything.projects.map(\.id) + everything.threads.map(\.id)
                + messages.merged(inbox).map(\.hit.id) + [scope.kind, scope.project, "\(scope.days)"]
    }

    // MARK: Before a query

    @ViewBuilder private var start: some View {
        if !recent.isEmpty {
            Section {
                ForEach(recent, id: \.self) { entry in
                    Button { query = entry } label: { plainRow(entry, icon: .clockCounterClockwise) }
                        .buttonStyle(.row)
                        .accessibilityIdentifier("search.recent.\(entry)")
                        .swipeActions { Button("Remove", role: .destructive) { forget(entry) } }
                        .inboxRowChrome()
                }
            } header: {
                HStack {
                    header("Recent")
                    Spacer()
                    Button("Clear") { withAnimation { recent = []; UserDefaults.standard.set([String](), forKey: RecentSearches.key) } }
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget)
                        .accessibilityIdentifier("search.recent.clear")
                }
            }
        }
        commandSection(everything.commands, title: "Commands")
    }

    // MARK: With a query

    @ViewBuilder private var results: some View {
        filterChips.inboxRowChrome().selectionDisabled()
        if scope.kind == "all", scope.isDefault || scope.project.isEmpty {
            commandSection(Array(everything.commands.prefix(5)), title: "Commands")
        }
        if scope.kind == "all", scope.project.isEmpty, !everything.projects.isEmpty {
            Section {
                ForEach(everything.projects) { found in
                    Button { remember(); actions.project(found.machineId, found.project.id) } label: {
                        plainRow(found.project.name, icon: .folderSimple,
                                 detail: inbox.showsMachineNames ? inbox.name(found.machineId) : "Project")
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("search.project.\(found.project.id)")
                    .inboxRowChrome()
                }
            } header: { header("Projects") }
        }
        if scope.kind == "all" || scope.kind == "thread" {
            let threads = foundThreads
            if !threads.isEmpty {
                Section {
                    ForEach(threads) { found in threadRow(found) }
                } header: { header("Threads") }
            }
        }
        if scope.kind != "thread" {
            let hits = messages.merged(inbox)
            if !hits.isEmpty {
                Section {
                    ForEach(hits, id: \.hit.id) { found in
                        // The thread opens at the hit, in its own history window.
                        Button {
                            remember()
                            if let itemId = found.hit.itemId { inbox.client(found.machineId)?.focusOnOpen = ThreadFocus(thread: found.hit.threadId, item: itemId) }
                            openFound(InboxKey(machineId: found.machineId, id: found.hit.threadId))
                        } label: { MessageHitLabel(hit: found.hit, machine: inbox.showsMachineNames ? inbox.name(found.machineId) : nil) }
                        .buttonStyle(.row)
                        .accessibilityIdentifier("search.hit.\(found.hit.id)")
                        .inboxRowChrome()
                    }
                } header: { header(SearchScope.kinds.first { $0.id == scope.kind && scope.kind != "all" }?.label ?? "Messages") }
            }
        }
        if messages.loading && messages.merged(inbox).isEmpty && foundThreads.isEmpty {
            ProgressView().frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                .accessibilityLabel("Searching")
                .listRowSeparator(.hidden).listRowBackground(surface)
        } else if !messages.loading && foundThreads.isEmpty && everything.commands.isEmpty && everything.projects.isEmpty
                    && messages.merged(inbox).isEmpty {
            ContentUnavailableView.search(text: text)
                .listRowSeparator(.hidden).listRowBackground(surface)
        }
    }

    /// Threads the machines found, within the project and the list's scope.
    private var foundThreads: [FoundThread] {
        everything.threads.filter { found in
            let key = InboxKey(machineId: found.machineId, id: found.thread.id)
            // The machines filtered by project before ranking; this holds while a new answer loads.
            if let scopedMachine, found.machineId != scopedMachine { return false }
            if let scopedWorkspace, found.thread.workspaceId != scopedWorkspace { return false }
            if scope.days > 0, found.thread.at < (Date().timeIntervalSince1970 - Double(scope.days) * 86_400) * 1000 { return false }
            return !found.thread.listed || includes(key)
        }
    }

    @ViewBuilder private func threadRow(_ found: FoundThread) -> some View {
        let key = InboxKey(machineId: found.machineId, id: found.thread.id)
        Button { remember(); openFound(key) } label: {
            if let row = inbox.row(key), found.thread.listed {
                InboxThreadRow(row: row, snoozed: false, machine: inbox.mark(found.machineId),
                               project: inbox.projectLook(key, workspace: row.workspaceId))
            } else {
                plainRow(found.thread.title, icon: .archive, detail: "Archived")
            }
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("search.thread.\(found.thread.id)")
        .inboxRowChrome()
    }

    @ViewBuilder private func commandSection(_ commands: [PaletteAnswer.Command], title: String) -> some View {
        if !commands.isEmpty {
            Section {
                ForEach(commands) { command in
                    Button { remember(); actions.command(command.id) } label: {
                        plainRow(command.label, icon: nil, detail: command.detail)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("search.command.\(command.id)")
                    .inboxRowChrome()
                }
            } header: { header(title) }
        }
    }

    /// Kind, project and date, as glass chips under the field; each shows its current choice.
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Menu {
                    Picker("Show", selection: $scope.kind) { ForEach(SearchScope.kinds, id: \.id) { Text($0.label).tag($0.id) } }
                } label: { InboxChip(title: SearchScope.kinds.first { $0.id == scope.kind }?.label ?? "All") }
                .accessibilityIdentifier("search.filter.kind")
                Menu {
                    Picker("Project", selection: $scope.project) {
                        Text("All projects").tag("")
                        ForEach(projectChoices, id: \.id) { Text($0.name).tag($0.id) }
                    }
                } label: { InboxChip(title: projectChoices.first { $0.id == scope.project }?.name ?? "All projects") }
                .accessibilityIdentifier("search.filter.project")
                Menu {
                    Picker("Date", selection: $scope.days) { ForEach(SearchScope.ranges, id: \.days) { Text($0.label).tag($0.days) } }
                } label: { InboxChip(title: SearchScope.ranges.first { $0.days == scope.days }?.label ?? "Any time") }
                .accessibilityIdentifier("search.filter.date")
            }
            .padding(.horizontal, AceTheme.Spacing.sm)
            .padding(.vertical, AceTheme.Spacing.xs)
        }
    }

    private func openFound(_ key: InboxKey) {
        if inbox.row(key) != nil { actions.open(key) } else { actions.archived(key) }
    }
    private func remember() {
        recent = RecentSearches.adding(text, to: recent)
        UserDefaults.standard.set(recent, forKey: RecentSearches.key)
    }
    private func forget(_ entry: String) {
        recent.removeAll { $0 == entry }
        UserDefaults.standard.set(recent, forKey: RecentSearches.key)
    }

    private func plainRow(_ title: String, icon: AceIcon.Name?, detail: String? = nil) -> some View {
        HStack(spacing: AceTheme.Spacing.md) {
            if let icon { AceIcon(icon, size: 16, relativeTo: .body).foregroundStyle(AceTheme.Colours.faintForeground) }
            Text(title).aceFont(InboxRowType.title, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            Spacer(minLength: AceTheme.Spacing.sm)
            if let detail { Text(detail).meta(AceTheme.Colours.subtleForeground) }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func header(_ title: String) -> some View {
        Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).textCase(nil)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
    }
}

private struct MessageHitLabel: View {
    let hit: ConversationHit
    var machine: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(hit.threadTitle).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceTheme.Spacing.sm)
                if let machine { Text(machine).meta(AceTheme.Colours.subtleForeground) }
            }
            Text(hit.excerpt).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
