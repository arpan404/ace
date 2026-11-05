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

/// What Search's rows open, as the inbox carries them out.
struct SearchActions {
    let open: (InboxKey) -> Void
    /// A command id from the shared catalog (`bridge/palette.ts`).
    let command: (String) -> Void
    /// Scope the Threads list to one machine's project.
    let project: (String, String) -> Void
    /// New thread in one machine's project.
    let newThreadIn: (String, String) -> Void
    /// A thread its machine's search found beyond the list (archived or older).
    let archived: (InboxKey) -> Void
    /// One of the places outside the thread lists.
    let place: (SearchPlace) -> Void
    /// A pull request's page.
    let pull: (ForgeRoute) -> Void
}

/// Search with a query (the web's command palette and search, ⌘K): the matching actions, threads,
/// pull requests and projects of every paired machine, then their messages, filtered by kind,
/// project and date. Each action says where it goes at its right, as the web's ranked list does.
/// Results stay until the next ones arrive and replace them in place, as Mail's do; nothing
/// blanks or animates between keystrokes.
struct InboxSearchList: View {
    @Bindable var inbox: MachineInbox
    @Binding var query: String
    let includes: (InboxKey) -> Bool
    /// The thread open on Threads or Chats, whose commands are offered under its title.
    let openTitle: String?
    let actions: SearchActions
    @State private var messages = InboxMessageSearch()
    @State private var everything = SearchEverything()
    @State private var pulls = SearchPulls()
    @State private var scope = SearchScope()
    private var text: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var projectChoices: [ProjectChoice] { inbox.projectChoices() }
    private var scopedMachine: String? { scope.project.isEmpty ? nil : String(scope.project.split(separator: "/", maxSplits: 1).first ?? "") }
    private var scopedWorkspace: String? { scope.project.isEmpty ? nil : scope.project.split(separator: "/", maxSplits: 1).last.map(String.init) }
    private var connections: String { inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }.joined(separator: ",") }

    var body: some View {
        List { results }
            // Kind, project and date stay pinned under the field while the results scroll.
            .pinnedTopBar { filterChips }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .scrollDismissesKeyboard(.immediately)
            .environment(\.defaultMinListRowHeight, 0)
            .task(id: "\(text)|\(openTitle != nil)|\(scope.project)|\(connections)") {
                let project = scopedMachine.flatMap { machine in scopedWorkspace.map { (machineId: machine, workspaceId: $0) } }
                await everything.run(inbox, query: text, threadOpen: openTitle != nil, project: project)
            }
            .task(id: "\(text)|\(scope.kind)|\(scope.project)|\(connections)") {
                guard scope.kind == "all", scope.project.isEmpty else { return }
                await pulls.run(inbox, query: text)
            }
            .task(id: "\(text)|\(scope.kind)|\(scope.project)|\(scope.days)|\(connections)") {
                guard !text.isEmpty, scope.kind != "thread" else { return }
                var filters: [String: Any] = [:]
                if let scopedWorkspace { filters["workspaceId"] = scopedWorkspace }
                if scope.days > 0 { filters["after"] = (Date().timeIntervalSince1970 - Double(scope.days) * 86_400) * 1000 }
                await messages.run(inbox, text: text, kind: scope.kind == "all" ? "message" : scope.kind, filters: filters, only: scopedMachine)
            }
    }

    private var everyKind: Bool { scope.kind == "all" && scope.project.isEmpty }

    @ViewBuilder private var results: some View {
        if everyKind { actionSection }
        if scope.kind == "all" || scope.kind == "thread" {
            let threads = foundThreads
            if !threads.isEmpty {
                Section {
                    ForEach(threads) { found in threadRow(found) }
                } header: { SearchHeader("Threads") }
            }
        }
        if everyKind, !pulls.found.isEmpty {
            Section {
                ForEach(pulls.found) { found in
                    Button { remember(); actions.pull(found.route) } label: { ForgePullRowView(row: found.row) }
                        .buttonStyle(.row)
                        .accessibilityIdentifier("search.pull.\(found.row.number)")
                        .inboxRowChrome()
                }
            } header: { SearchHeader("Pull requests") }
        }
        if everyKind, !everything.projects.isEmpty {
            Section {
                ForEach(everything.projects) { found in
                    Button { remember(); actions.project(found.machineId, found.project.id) } label: {
                        SearchPlainRow(title: found.project.name, icon: .folderSimple,
                                       detail: inbox.showsMachineNames ? inbox.name(found.machineId) : nil)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("search.project.\(found.project.id)")
                    .inboxRowChrome()
                }
            } header: { SearchHeader("Projects") }
        }
        if scope.kind != "thread" { messageSection }
        if messages.loading && messages.merged(inbox).isEmpty && foundThreads.isEmpty {
            ProgressView().frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
                .accessibilityLabel("Searching")
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
        } else if !messages.loading && foundThreads.isEmpty && everything.commands.isEmpty && everything.projects.isEmpty
                    && pulls.found.isEmpty && messages.merged(inbox).isEmpty {
            EmptyState.search(text)
                .listRowSeparator(.hidden).listRowBackground(Color.clear)
        }
    }

    /// The best commands, then New thread in the best matching project, each with where it goes.
    @ViewBuilder private var actionSection: some View {
        let commands = Array(everything.commands.prefix(5))
        let project = everything.projects.first
        if !commands.isEmpty || project != nil {
            Section {
                ForEach(commands) { command in
                    Button { remember(); actions.command(command.id) } label: {
                        SearchPlainRow(title: command.label, detail: hint(command))
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("search.command.\(command.id)")
                    .inboxRowChrome()
                }
                if let project, inbox.canStartThreads {
                    Button { remember(); actions.newThreadIn(project.machineId, project.project.id) } label: {
                        SearchPlainRow(title: "New thread in \(project.project.name)", detail: "New thread")
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("search.newThreadIn.\(project.project.id)")
                    .inboxRowChrome()
                }
            } header: { SearchHeader("Actions") }
        }
    }

    /// The open thread's commands name it; the rest say where they go.
    private func hint(_ command: PaletteAnswer.Command) -> String? {
        command.id.hasPrefix("thread:") ? openTitle ?? command.detail : command.detail
    }

    @ViewBuilder private var messageSection: some View {
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
            } header: { SearchHeader(SearchScope.kinds.first { $0.id == scope.kind && scope.kind != "all" }?.label ?? "Messages") }
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
                InboxThreadRow(row: row, snoozed: row.snoozedUntil != nil, machine: inbox.mark(found.machineId),
                               project: inbox.projectLook(key, workspace: row.workspaceId))
            } else {
                SearchPlainRow(title: found.thread.title, icon: .archive, detail: "Archived")
            }
        }
        .buttonStyle(.row)
        .accessibilityIdentifier("search.thread.\(found.thread.id)")
        .inboxRowChrome()
    }

    /// Kind, project and date, as chips under the field; each shows its current choice.
    private var filterChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.related) {
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
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.tight)
        }
        // The chips' glass draws past the row; clipped, it leaves a box behind them.
        .scrollClipDisabled()
    }

    private func openFound(_ key: InboxKey) {
        if inbox.row(key) != nil { actions.open(key) } else { actions.archived(key) }
    }
    private func remember() {
        UserDefaults.standard.set(RecentSearches.adding(text, to: RecentSearches.read(.standard)), forKey: RecentSearches.key)
    }
}

private struct MessageHitLabel: View {
    let hit: ConversationHit
    var machine: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(spacing: AceDesign.Space.related) {
                Text(hit.threadTitle).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Spacer(minLength: AceDesign.Space.related)
                if let machine { Text(machine).meta(AceTheme.Colours.subtleForeground) }
            }
            Text(hit.excerpt).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(2)
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .padding(.vertical, AceDesign.Space.row)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
