import SwiftUI

/// What the inbox lends the Pulls tab: open a thread (on the Threads tab) and open New thread.
struct ForgeInboxHooks {
    let openThread: (InboxKey) -> Void
    let startThread: () -> Void
}

/// What the second tab asks of the inbox: push a page on its stack, open a thread (on the
/// Threads tab), and open New thread with a draft already written.
struct ForgeTabActions {
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let startThread: () -> Void
}

/// The second tab's content: the web's Pull requests and Issues pages, one machine and project
/// at a time. A segmented switch picks the list; the project and Filters chips sit beside it in
/// the inbox's chip style; the system search field searches the list on show; a row pushes its
/// page. Each list keeps its own filters and its last answer while the other shows.
struct ForgeHome: View {
    @Bindable var inbox: MachineInbox
    /// The inbox's machine and project chips: the lists follow a chosen project.
    @Binding var machine: String
    @Binding var project: String
    let query: String
    @Binding var kind: ForgeKind
    let actions: ForgeTabActions
    @State private var projects: [ForgeProject] = []
    @State private var projectsFailed: String?
    @State private var pullsFilter = PullsFilter()
    @State private var issuesFilter = IssuesFilter()
    @State private var pulls = ForgeListModel<ForgePullList>()
    @State private var issues = ForgeListModel<ForgeIssueList>()
    @AppStorage(ForgeProjectChoice.key) private var remembered = ""

    /// The machine the lists read: the chip's, else the first that is connected.
    private var session: MachineSession? {
        inbox.sessions.first { $0.hostId == machine }
            ?? inbox.sessions.first { $0.client.connection == "ready" } ?? inbox.sessions.first
    }
    private var chosen: String? { ForgeProjectChoice.pick(chip: project, remembered: remembered, projects: projects) }

    var body: some View {
        content
            .inboxTopBar { chips }
            .task(id: "\(session?.hostId ?? "")|\(session?.client.connection ?? "")") { await loadProjects() }
            .task(id: listKey) { await load(fresh: false) }
    }

    private var listKey: String {
        let filter = kind == .pulls ? String(describing: pullsFilter) : String(describing: issuesFilter)
        return [session?.hostId ?? "", chosen ?? "", kind.rawValue, filter, query].joined(separator: "|")
    }

    @ViewBuilder private var content: some View {
        if let session, let chosen {
            switch kind {
            case .pulls:
                ForgePullsList(model: pulls, machineId: session.hostId, project: chosen,
                               open: actions.open, openThread: actions.openThread, refresh: { await load(fresh: true) }, more: { await more() })
            case .issues:
                ForgeIssuesList(model: issues, machineId: session.hostId, project: chosen,
                                open: actions.open, openThread: actions.openThread, refresh: { await load(fresh: true) }, more: { await more() })
            }
        } else if let projectsFailed {
            ForgeEmpty { EmptyState(icon: nil, title: "Couldn't load projects", line: projectsFailed, failed: true) { Button("Try again") { Task { await loadProjects() } } } }
        } else if session != nil, projects.isEmpty, session?.client.connection == "ready" {
            ForgeEmpty { EmptyState(icon: .gitPullRequest, title: "No projects yet", line: "Add a project with a GitHub remote to see its pull requests and issues.") { EmptyView() } }
        } else {
            ForgeEmpty { ProgressView().controlSize(.regular) }
        }
    }

    private var chips: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            Picker("List", selection: $kind) {
                ForEach(ForgeKind.allCases, id: \.self) { Text($0 == .pulls ? "Pulls" : "Issues").tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 170)
            .accessibilityIdentifier("forge.kind")
            if inbox.showsMachineNames {
                Menu {
                    Picker("Machine", selection: Binding(get: { session?.hostId ?? "" }, set: { machine = $0 })) {
                        ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                    }
                } label: { InboxChip(title: session.map { inbox.name($0.hostId) } ?? "Machine") }
                    .accessibilityIdentifier("forge.machine")
            }
            if projects.count > 1 {
                Menu {
                    Picker("Project", selection: Binding(get: { chosen ?? "" }, set: { choose($0) })) {
                        ForEach(projects) { Text($0.name).tag($0.id) }
                    }
                } label: { InboxChip(title: projects.first { $0.id == chosen }?.name ?? "Project") }
                    .accessibilityIdentifier("forge.project")
            }
            Spacer(minLength: AceTheme.Spacing.none)
            ForgeFiltersMenu(kind: kind, pulls: $pullsFilter, issues: $issuesFilter,
                             pullList: pulls.list, issueList: issues.list)
        }
        .padding(.horizontal, 18)
        .padding(.bottom, AceTheme.Spacing.xs)
    }

    private func choose(_ id: String) {
        remembered = id
        // A project the inbox chip names wins; picking another here moves the chip along.
        if !project.isEmpty { project = id }
        pullsFilter.author = nil; pullsFilter.labels = []
        issuesFilter.author = nil; issuesFilter.labels = []
    }

    private func loadProjects() async {
        guard let client = session?.client, client.connection == "ready" else { return }
        do { projects = try await client.forgeProjects(); projectsFailed = nil }
        catch is CancellationError {}
        catch { if projects.isEmpty { projectsFailed = error.localizedDescription } }
    }

    private func load(fresh: Bool) async {
        guard let client = session?.client, let chosen, client.connection == "ready" else { return }
        let (pullsFilter, issuesFilter, query) = (pullsFilter, issuesFilter, query)
        switch kind {
        case .pulls:
            await pulls.load(listKey, fresh: fresh) { screens, fresh in
                try await client.forgePulls(project: chosen, filter: pullsFilter, query: query, screens: screens, fresh: fresh)
            }
        case .issues:
            await issues.load(listKey, fresh: fresh) { screens, fresh in
                try await client.forgeIssues(project: chosen, filter: issuesFilter, query: query, screens: screens, fresh: fresh)
            }
        }
    }

    private func more() async {
        guard let client = session?.client, let chosen else { return }
        let (pullsFilter, issuesFilter, query) = (pullsFilter, issuesFilter, query)
        switch kind {
        case .pulls:
            await pulls.more { screens, fresh in
                try await client.forgePulls(project: chosen, filter: pullsFilter, query: query, screens: screens, fresh: fresh)
            }
        case .issues:
            await issues.more { screens, fresh in
                try await client.forgeIssues(project: chosen, filter: issuesFilter, query: query, screens: screens, fresh: fresh)
            }
        }
    }
}

/// A centred empty, error or loading state inside the scrolling page, so pull to refresh and the
/// top bar's edge effect still work.
struct ForgeEmpty<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        ScrollView { content().padding(.top, 120).frame(maxWidth: .infinity) }
            .background(AceTheme.Colours.background)
    }
}
