import SwiftUI

/// The Search tab (the web's command palette and search, in place of a More tab). Before a query:
/// the places outside the thread lists as capsules, the last searches and the latest threads.
/// With one: actions, threads, pull requests, projects and messages of every paired machine
/// (`InboxSearchList`). On iOS 26 its field is the tab bar's own detached search.
struct SearchHome: View {
    @Bindable var inbox: MachineInbox
    /// A thread is open on Threads or Chats: its own commands are offered, named by its title.
    let openTitle: String?
    let actions: SearchActions
    @Binding var query: String
    @State private var openPulls: Int?
    private var text: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Group {
                if text.isEmpty {
                    SearchStart(inbox: inbox, openPulls: openPulls, actions: actions, query: $query)
                } else {
                    InboxSearchList(inbox: inbox, query: $query, includes: { _ in true }, openTitle: openTitle, actions: actions)
                }
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, placement: .automatic, prompt: Text("Threads, pull requests, settings"))
        }
        .task(id: inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }) {
            openPulls = await OpenPullCount.read(inbox, kept: true)
            openPulls = await OpenPullCount.read(inbox, kept: false) ?? openPulls
        }
    }
}

/// Search before anything is typed: things to act on, not an explanation. The places, the last
/// searches and the latest threads, each a row that does something.
private struct SearchStart: View {
    let inbox: MachineInbox
    let openPulls: Int?
    let actions: SearchActions
    @Binding var query: String
    @State private var recent = RecentSearches.read(.standard)

    var body: some View {
        List {
            Section {
                SearchPlaceCapsules(places: SearchPlace.offered(paired: !inbox.sessions.isEmpty), openPulls: openPulls,
                                    open: actions.place)
                    .listRowInsets(EdgeInsets(top: AceDesign.Space.related, leading: AceDesign.Space.margin,
                                              bottom: AceDesign.Space.related, trailing: AceDesign.Space.margin))
                    .listRowBackground(AceTheme.Colours.background)
                    .listRowSeparator(.hidden)
            } header: { SearchHeader("Places") }
            if !recent.isEmpty {
                Section {
                    ForEach(recent, id: \.self) { entry in
                        Button { query = entry } label: { SearchPlainRow(title: entry, icon: .clockCounterClockwise) }
                            .buttonStyle(.row)
                            .accessibilityIdentifier("search.recent.\(entry)")
                            .swipeActions { Button("Remove", role: .destructive) { forget(entry) } }
                            .inboxRowChrome()
                    }
                } header: {
                    HStack {
                        SearchHeader("Recent searches")
                        Spacer()
                        Button("Clear") { withAnimation { recent = []; UserDefaults.standard.set([String](), forKey: RecentSearches.key) } }
                            .buttonStyle(.textAction())
                            .frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap)
                            .contentShape(Rectangle())
                            .accessibilityIdentifier("search.recent.clear")
                    }
                }
            }
            let latest = RecentThreads.latest(inbox)
            if !latest.isEmpty {
                Section {
                    ForEach(latest, id: \.self) { key in
                        if let row = inbox.row(key) {
                            Button { actions.open(key) } label: {
                                InboxThreadRow(row: row, snoozed: row.snoozedUntil != nil, machine: inbox.mark(key.machineId),
                                               project: inbox.projectLook(key, workspace: row.workspaceId))
                            }
                            .buttonStyle(.row)
                            .accessibilityIdentifier("search.latest.\(key.id)")
                            .inboxRowChrome()
                        }
                    }
                } header: { SearchHeader("Recent threads") }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.immediately)
        .environment(\.defaultMinListRowHeight, 0)
    }

    private func forget(_ entry: String) {
        recent.removeAll { $0 == entry }
        UserDefaults.standard.set(recent, forKey: RecentSearches.key)
    }
}

/// The threads most recently active on any paired machine, newest first, never archived.
enum RecentThreads {
    static let count = 5
    @MainActor static func latest(_ inbox: MachineInbox) -> [InboxKey] {
        inbox.sessions.flatMap { session in
            session.client.inbox.values.compactMap { row -> (InboxKey, Double)? in
                guard row.archivedAt == nil else { return nil }
                return (InboxKey(machineId: session.hostId, id: row.id), row.activityAt ?? row.updatedAt)
            }
        }
        .sorted { $0.1 > $1.1 }
        .prefix(count)
        .map(\.0)
    }
}

/// How many pull requests are open in the project Pull requests opens on (the one chosen there
/// last, else the machine's first): the last count this phone read, or a fresh read.
enum OpenPullCount {
    @MainActor static func read(_ inbox: MachineInbox, kept: Bool) async -> Int? {
        guard let session = inbox.sessions.first(where: { $0.client.connection == "ready" }) ?? inbox.sessions.first else { return nil }
        let client = session.client
        let remembered = UserDefaults.standard.string(forKey: ForgeProjectChoice.key)
        if kept {
            let projects = client.kept(ClientModel.forgeProjectsRead, as: ForgeProjects.self)?.projects ?? []
            guard let chosen = ForgeProjectChoice.pick(chip: "", remembered: remembered, projects: projects) else { return nil }
            return client.kept(ClientModel.forgePullsRead(project: chosen, filter: PullsFilter(), query: ""), as: ForgePullList.self)?.counts?.open
        }
        guard session.client.connection == "ready",
              let projects = try? await client.forgeProjects(),
              let chosen = ForgeProjectChoice.pick(chip: "", remembered: remembered, projects: projects),
              let list = try? await client.forgePulls(project: chosen, filter: PullsFilter(), query: "", screens: 1, fresh: false) else { return nil }
        return list.counts?.open
    }
}

/// A group's quiet label in Search.
struct SearchHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).textCase(nil)
            .foregroundStyle(AceTheme.Colours.subtleForeground)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A one-line row in Search: an optional faint glyph, the title, and a quiet hint at the right
/// saying where it goes ("Settings", the open thread's title).
struct SearchPlainRow: View {
    let title: String
    var icon: AceIcon.Name? = nil
    var detail: String? = nil
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            if let icon { AceIcon(icon, size: AceDesign.Size.icon, relativeTo: .body).foregroundStyle(AceTheme.Colours.faintForeground) }
            Text(title).aceFont(InboxRowType.title, relativeTo: .callout).foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            if let detail { Text(detail).meta(AceTheme.Colours.subtleForeground).lineLimit(1) }
        }
        .padding(.horizontal, AceTheme.Spacing.rowInner)
        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
        .contentShape(Rectangle())
    }
}
