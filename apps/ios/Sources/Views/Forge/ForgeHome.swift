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
    /// Opens Machines from the connection problem under the title.
    var openMachines: () -> Void = {}
    /// Opens pairing while no computer is paired; nil while that isn't known yet.
    var pair: (() -> Void)?
    @State private var features: ForgeFeatures?
    @State private var projects: [ForgeProject] = []
    @State private var projectsFailed: String?
    /// Each list's filters, kept by the page that shows this one so they outlive it.
    @Binding var filters: ForgeListFilters
    @State private var creating = false
    /// New issue's place, captured with the list that named its repository.
    @State private var creatingIssue: ForgeNewIssueTarget?
    @State private var pulls = ForgeListModel<ForgePullList>()
    @State private var issues = ForgeListModel<ForgeIssueList>()
    @AppStorage(ForgeProjectChoice.key) private var remembered = ""
    private var pullsFilter: PullsFilter {
        get { filters.pulls }
        nonmutating set { filters.pulls = newValue }
    }
    private var issuesFilter: IssuesFilter {
        get { filters.issues }
        nonmutating set { filters.issues = newValue }
    }
    private var notificationsFilter: NotificationsFilter { filters.notifications }

    /// Opens on the projects and lists this phone last saw on the machine, read again behind
    /// them, so coming back to Pulls never starts from a spinner.
    init(inbox: MachineInbox, machine: Binding<String>, project: Binding<String>, query: String, kind: Binding<ForgeKind>,
         filters: Binding<ForgeListFilters>, actions: ForgeTabActions, openMachines: @escaping () -> Void = {}, pair: (() -> Void)? = nil) {
        self.inbox = inbox
        self.openMachines = openMachines
        self.pair = pair
        _machine = machine
        _project = project
        self.query = query
        _kind = kind
        _filters = filters
        self.actions = actions
        guard let session = Self.session(inbox, machine.wrappedValue) else { return }
        let client = session.client
        let projects = client.kept(ClientModel.forgeProjectsRead, as: ForgeProjects.self)?.projects ?? []
        _projects = State(initialValue: projects)
        let remembered = UserDefaults.standard.string(forKey: ForgeProjectChoice.key) ?? ""
        guard let chosen = ForgeProjectChoice.pick(chip: project.wrappedValue, remembered: remembered, projects: projects) else { return }
        let (pullsFilter, issuesFilter) = (filters.wrappedValue.pulls, filters.wrappedValue.issues)
        let pulls = client.kept(ClientModel.forgePullsRead(project: chosen, filter: pullsFilter, query: query), as: ForgePullList.self)
        let issues = client.kept(ClientModel.forgeIssuesRead(project: chosen, filter: issuesFilter, query: query), as: ForgeIssueList.self)
        _pulls = State(initialValue: ForgeListModel(list: pulls, key: Self.listKey(session.hostId, chosen, .pulls, String(describing: pullsFilter), query),
                                                    scope: ForgeListScope(machineId: session.hostId, project: chosen)))
        _issues = State(initialValue: ForgeListModel(list: issues, key: Self.listKey(session.hostId, chosen, .issues, String(describing: issuesFilter), query),
                                                     scope: ForgeListScope(machineId: session.hostId, project: chosen)))
    }

    /// The machine the lists read: the chip's, else the first that is connected.
    private var session: MachineSession? { Self.session(inbox, machine) }
    private static func session(_ inbox: MachineInbox, _ machine: String) -> MachineSession? {
        inbox.sessions.first { $0.hostId == machine }
            ?? inbox.sessions.first { $0.client.connection == "ready" } ?? inbox.sessions.first
    }
    private var chosen: String? { ForgeProjectChoice.pick(chip: project, remembered: remembered, projects: projects) }

    var body: some View {
        content
            // The chips pinned under the title, in the navigation bar's own region.
            .pinnedTopBar(resetOn: shownList) { chips }
            // The system's large title (Pulls, Issues or Inbox), the project under it and the
            // machine and project pickers in its menu.
            .nativeTitle(headingTitle, subtitle: InboxConnectionProblem.of(inbox)?.text ?? projects.first { $0.id == chosen }?.name,
                         hasMenu: inbox.showsMachineNames || projects.count > 1) { titleMenu }
            .task(id: "\(session?.hostId ?? "")|\(session?.client.connection ?? "")") { await loadProjects() }
            .task(id: "\(listKey)|\(listGeneration)|\(features?.issues == true)|\(features?.inbox == true)") { await load(fresh: false) }
            .task(id: "\(session?.hostId ?? "")|\(chosen ?? "")|\(listGeneration)") {
                features = nil
                guard let client = session?.client, let chosen else { return }
                features = try? await client.read(["type": "forge.features", "project": chosen], as: ForgeFeatures.self)
                if kind == .issues && features?.issues == false || kind == .inbox && features?.inbox == false { kind = .pulls }
            }
            .sheet(item: $creatingIssue) { target in
                if let client = inbox.client(target.scope.machineId) {
                    ForgeNewIssueSheet(client: client, project: target.scope.project, repository: target.repository) { number in
                        actions.open(ForgeRoute(kind: .issue, machineId: target.scope.machineId, project: target.scope.project,
                                                number: number, repository: target.repository))
                    }
                }
            }
            .sheet(isPresented: $creating) {
                if let session, let chosen {
                    ForgeNewPullSheet(client: session.client, project: chosen) { number in
                        actions.open(ForgeRoute(kind: .pull, machineId: session.hostId, project: chosen, number: number))
                    }
                }
            }
    }

    /// The list on the page: another machine, project or list, or another Inbox filter (the
    /// notifications read again from the top), puts the pinned bar's edge away.
    private var shownList: String {
        let base = "\(session?.hostId ?? "")|\(chosen ?? "")|\(kind)"
        return kind == .inbox ? "\(base)|\(notificationsFilter)" : base
    }

    private var listKey: String {
        let filter = kind == .pulls ? String(describing: pullsFilter) : String(describing: issuesFilter)
        return Self.listKey(session?.hostId ?? "", chosen ?? "", kind, filter, query)
    }
    private static func listKey(_ machine: String, _ project: String, _ kind: ForgeKind, _ filter: String, _ query: String) -> String {
        [machine, project, kind.rawValue, filter, query].joined(separator: "|")
    }
    /// Moves when the daemon says pull requests changed; the list on screen is read again.
    private var listGeneration: Int {
        guard let client = session?.client, let chosen else { return 0 }
        return client.readGeneration(kind == .pulls
            ? ClientModel.forgePullsRead(project: chosen, filter: pullsFilter, query: query)
            : ClientModel.forgeIssuesRead(project: chosen, filter: issuesFilter, query: query))
    }

    @ViewBuilder private var content: some View {
        if let session, let chosen {
            switch kind {
            case .pulls:
                ForgePullsList(client: session.client, model: pulls,
                               open: actions.open, openThread: actions.openThread, refresh: { await load(fresh: true) }, more: { await more() })
            case .issues:
                ForgeIssuesList(model: issues, connection: session.client.connection, reconnect: { session.client.retry() },
                                open: actions.open, openThread: actions.openThread, refresh: { await load(fresh: true) }, more: { await more() })
            case .inbox:
                ForgeNotificationsList(client: session.client, machineId: session.hostId, project: chosen, filter: notificationsFilter, query: query, open: actions.open)
                    .id("\(session.hostId)|\(chosen)|\(notificationsFilter)")
            }
        } else if inbox.sessions.isEmpty, let pair {
            ForgeEmpty { NoComputerPaired(pair: pair) }
        } else if let projectsFailed {
            ForgeEmpty { EmptyState(icon: nil, title: "Couldn't load projects", line: projectsFailed, failed: true) { Button("Try again") { Task { await loadProjects() } } } }
        } else if let session, ForgeListState.unreachable(session.client.connection) {
            // Projects read nothing while the machine is out: say so rather than wait on a skeleton.
            ForgeEmpty { ForgeUnreachable(noun: "Pull requests") { session.client.retry() } }
        } else if session != nil, projects.isEmpty, session?.client.connection == "ready" {
            ForgeEmpty { EmptyState(icon: .gitPullRequest, title: "No projects yet", line: "Add a project with a Git remote to see its pull requests and issues.") { EmptyView() } }
        } else {
            SkeletonRows(label: "Loading pull requests")
        }
    }

    /// The title's menu: the machine (several only) and the project the lists follow.
    @ViewBuilder private var titleMenu: some View {
        if inbox.showsMachineNames {
            Picker("Machine", selection: Binding(get: { session?.hostId ?? "" }, set: { machine = $0 })) {
                ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
            }
        }
        Picker("Project", selection: Binding(get: { chosen ?? "" }, set: { choose($0) })) {
            ForEach(projects) { Text($0.name).tag($0.id) }
        }
    }

    /// Where New issue opens: only from a list read for the machine and project now chosen (a list
    /// kept from the last project while the next one loads names another repository).
    private var newIssueTarget: ForgeNewIssueTarget? {
        guard let scope = issues.scope, let repository = issues.list?.createOn,
              scope.machineId == session?.hostId, scope.project == chosen else { return nil }
        return ForgeNewIssueTarget(scope: scope, repository: repository)
    }

    /// The heading names the list showing, as the tab bar and the switch below it do.
    private var headingTitle: String {
        switch kind {
        case .pulls: "Pulls"
        case .issues: "Issues"
        case .inbox: "Inbox"
        }
    }

    private var kinds: [GlassSwitch<ForgeKind>.Choice] {
        var choices: [GlassSwitch<ForgeKind>.Choice] = [.init(value: .pulls, title: "Pull requests", identifier: "forge.kind.pulls", short: "Pulls")]
        if features?.issues == true { choices.append(.init(value: .issues, title: "Issues", identifier: "forge.kind.issues")) }
        if features?.inbox == true { choices.append(.init(value: .inbox, title: "Inbox", identifier: "forge.kind.inbox")) }
        return choices
    }

    /// The list switch, then New pull request or New issue and the state filter beside it, on one
    /// row while every word fits whole. Narrower, the switch says Pulls; narrower still (a phone
    /// with Issues and Inbox, or large text), the switch takes a row of its own over the actions,
    /// each row scrolling rather than cutting a word short.
    private var chips: some View {
        ViewThatFits(in: .horizontal) {
            chipsRow(kinds)
            chipsRow(shortKinds)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                chipsScroller { GlassSwitch(selection: $kind, choices: shortKinds) }
                chipsScroller { HStack(spacing: AceTheme.Spacing.sm) { chipActions } }
            }
        }
        .padding(.bottom, AceTheme.Spacing.xs)
    }

    /// Each choice by its short name where it has one ("Pulls" for Pull requests).
    private var shortKinds: [GlassSwitch<ForgeKind>.Choice] {
        kinds.map { .init(value: $0.value, title: $0.short ?? $0.title, identifier: $0.identifier) }
    }

    private func chipsRow(_ choices: [GlassSwitch<ForgeKind>.Choice]) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            GlassSwitch(selection: $kind, choices: choices)
            chipActions
            // The switch hugs its tabs; the row keeps to the leading edge.
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
    }

    /// A row that scrolls sideways only when its words are wider than the page.
    private func chipsScroller<Row: View>(@ViewBuilder _ row: () -> Row) -> some View {
        ScrollView(.horizontal) {
            row().padding(.horizontal, AceTheme.Spacing.lg)
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    /// New pull request or New issue, where the person can make one, then the list's filter.
    @ViewBuilder private var chipActions: some View {
        if kind == .pulls, session?.client.canOperate == true, chosen != nil, features?.create == true {
            Button("New pull request") { creating = true }
                .buttonStyle(.secondaryAction).controlSize(.small)
                .accessibilityLabel("New pull request")
                .accessibilityIdentifier("forge.newpr")
        }
        if kind == .issues, session?.client.canOperate == true, let target = newIssueTarget {
            Button("New issue") { creatingIssue = target }
                .buttonStyle(.secondaryAction).controlSize(.small)
                .accessibilityIdentifier("forge.newissue")
        }
        if kind == .inbox {
            ForgeNotificationsFilterMenu(filter: $filters.notifications, reasons: notificationReasons)
        } else {
            ForgeFiltersMenu(kind: kind, pulls: $filters.pulls, issues: $filters.issues,
                             pullList: pulls.list, issueList: issues.list)
        }
    }

    /// The reasons the inbox last named, for its filter.
    private var notificationReasons: [ForgeNotifications.Reason] {
        guard let client = session?.client, let chosen else { return [] }
        return client.kept(ClientModel.forgeNotificationsRead(project: chosen, filter: notificationsFilter), as: ForgeNotifications.self)?.reasons ?? []
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
        if kind == .issues && features?.issues != true || kind == .inbox && features?.inbox != true { return }
        let (pullsFilter, issuesFilter, query) = (pullsFilter, issuesFilter, query)
        let scope = ForgeListScope(machineId: session?.hostId ?? "", project: chosen)
        switch kind {
        case .pulls:
            let kept = client.kept(ClientModel.forgePullsRead(project: chosen, filter: pullsFilter, query: query), as: ForgePullList.self)
            await pulls.load(listKey, scope: scope, fresh: fresh, kept: kept) { screens, fresh in
                try await client.forgePulls(project: chosen, filter: pullsFilter, query: query, screens: screens, fresh: fresh)
            }
        case .issues:
            let kept = client.kept(ClientModel.forgeIssuesRead(project: chosen, filter: issuesFilter, query: query), as: ForgeIssueList.self)
            await issues.load(listKey, scope: scope, fresh: fresh, kept: kept) { screens, fresh in
                try await client.forgeIssues(project: chosen, filter: issuesFilter, query: query, screens: screens, fresh: fresh)
            }
        case .inbox:
            // The inbox reads itself (`ForgeNotificationsList`).
            break
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
        case .inbox:
            break
        }
    }
}

/// A centred empty, error or loading state inside the scrolling page, so pull to refresh and the
/// top bar's edge effect still work.
struct ForgeEmpty<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }
    var body: some View {
        ScrollView { content().padding(.top, AceDesign.Space.pageState).frame(maxWidth: .infinity) }
            .background(surface)
    }
}
