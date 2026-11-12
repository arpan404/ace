import SwiftUI

/// The Pull requests list: the web's groups (by next step, or by who it concerns) as quiet
/// headings over rows; a row opens its page, swipes to GitHub, and its menu copies the link or
/// opens the thread working on it. Ready rows can be picked for one verified merge, which the
/// strip at the foot starts and follows.
struct ForgePullsList: View {
    /// The page open beside the list, whose row reads as selected.
    @Environment(\.openForgeRow) private var openRow
    let client: ClientModel
    let model: ForgeListModel<ForgePullList>
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let refresh: () async -> Void
    let more: () async -> Void
    @State private var merge = ForgeMergeRunModel()

    /// The ready rows on show, in list order: the ones a verified merge can take.
    private var ready: [ForgeMergePick] { (model.list?.groups ?? []).flatMap { $0.rows.compactMap(\.mergePick) } }

    var body: some View {
        ForgeListFrame(loaded: model.list != nil, empty: model.list?.groups.isEmpty ?? true, emptyTitle: "No pull requests match",
                       icon: .gitPullRequest, failure: model.failure, stale: model.stale, hasMore: model.list?.more ?? false,
                       loading: model.loading, notes: model.list?.failed ?? [], refresh: refresh, more: more) {
            // Rows open where they were read, even while another project's rows load.
            if let scope = model.scope { ForEach(model.list?.groups ?? []) { group in
                ForgeGroupHeader(label: group.label, count: group.count).forgeRowChrome()
                ForEach(group.rows) { row in
                    // The full identity (provider, host, owner, name, number): a GitLab or Origin row opens
                    // its own read-only page, never a same-numbered review elsewhere.
                    let route = ForgeRoute(kind: .pull, machineId: scope.machineId, project: scope.project, number: row.number, repository: row.repository)
                    HStack(spacing: AceTheme.Spacing.none) {
                        Button { open(route) } label: { ForgePullRowView(row: row) }
                            .buttonStyle(RowPressStyle(selected: openRow == route))
                            .accessibilityAddTraits(openRow == route ? .isSelected : [])
                            .accessibilityIdentifier("forge.pull.\(row.number)")
                        if let pick = row.mergePick, client.canOperate {
                            ForgeMergePickButton(number: row.number, picked: merge.isPicked(pick), blocked: merge.blocked(pick)) {
                                merge.toggle(client, project: scope.project, pick)
                            }
                        }
                    }
                    .forgeRowChrome()
                    .forgeRowActions(url: row.url, host: row.host, thread: row.thread.map { InboxKey(machineId: scope.machineId, id: $0.id) }, openThread: openThread)
                }
            } }
        }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            if let scope = model.scope {
                ForgeMergeRunStrip(client: client, scope: scope, model: merge, ready: ready, open: open)
            }
        }
        // Read again as picks change, as the rows move, and whenever a Verify run moves.
        .task(id: mergeKey) {
            guard let scope = model.scope else { return }
            await merge.read(client, project: scope.project, ready: ready) { await refresh() }
        }
        .onChange(of: model.scope) { merge.clear() }
    }

    private var mergeKey: String {
        guard let scope = model.scope else { return "" }
        let request = ForgeMergeRunModel.request(project: scope.project, picked: merge.picks, ready: ready)
        // A ready row's new head reads the strip again: a pick made at the old one leaves.
        let rows = ready.map { "\($0.key)@\($0.headSha)" }
        return "\(scope.project)|\(merge.picks.map { "\($0.key)@\($0.headSha)" })|\(rows)|\(client.readGeneration(request))"
    }
}

/// The Issues list: assigned to you, opened by you, and the rest.
struct ForgeIssuesList: View {
    /// The page open beside the list, whose row reads as selected.
    @Environment(\.openForgeRow) private var openRow
    let model: ForgeListModel<ForgeIssueList>
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let refresh: () async -> Void
    let more: () async -> Void

    var body: some View {
        ForgeListFrame(loaded: model.list != nil, empty: model.list?.groups.isEmpty ?? true, emptyTitle: "No issues match",
                       icon: .record, failure: model.failure, stale: model.stale, hasMore: model.list?.more ?? false,
                       loading: model.loading, notes: model.list?.failed ?? [], refresh: refresh, more: more) {
            if let scope = model.scope { ForEach(model.list?.groups ?? []) { group in
                if group.id != "all" { ForgeGroupHeader(label: group.label, count: group.count).forgeRowChrome() }
                ForEach(group.rows) { row in
                    // The row's full identity, whatever its label says: an issue opens in its own repository.
                    let route = ForgeRoute(kind: .issue, machineId: scope.machineId, project: scope.project, number: row.number,
                                           repository: row.repository)
                    Button { open(route) } label: { ForgeIssueRowView(row: row) }
                        .buttonStyle(RowPressStyle(selected: openRow == route))
                        .accessibilityAddTraits(openRow == route ? .isSelected : [])
                    .accessibilityIdentifier("forge.issue.\(row.number)")
                    .forgeRowChrome()
                    .forgeRowActions(url: row.url, host: row.host, thread: row.thread.map { InboxKey(machineId: scope.machineId, id: $0.id) }, openThread: openThread)
                }
            } }
        }
    }
}

/// The list around the rows: skeleton on the first read, the error state with Try again when
/// nothing could be read, the empty state, a dimmed list while a changed filter reads, a quiet
/// line when a refresh failed over rows already shown (or one of several repositories couldn't be
/// read), Show more, and pull to refresh.
struct ForgeListFrame<Rows: View>: View {
    let loaded: Bool
    let empty: Bool
    let emptyTitle: String
    let icon: AceIcon.Name
    let failure: String?
    let stale: Bool
    let hasMore: Bool
    let loading: Bool
    /// Repositories that couldn't be read, said over the rows the others gave.
    var notes: [String] = []
    let refresh: () async -> Void
    let more: () async -> Void
    @ViewBuilder let rows: () -> Rows
    @Environment(\.onSidebarGlass) private var onGlass
    private var surface: Color { onGlass ? .clear : AceTheme.Colours.background }

    var body: some View {
        List {
            if !loaded, let failure {
                EmptyState(icon: nil, title: "Couldn't load from GitHub", line: failure, failed: true) {
                    Button("Try again") { Task { await refresh() } }
                }
                .padding(.top, AceDesign.Space.pageState)
                .forgeRowChrome()
            } else if !loaded {
                SkeletonRows(count: 6).forgeRowChrome()
            } else if empty {
                EmptyState(icon: icon, title: emptyTitle) { EmptyView() }
                    .padding(.top, AceDesign.Space.pageState)
                    .forgeRowChrome()
                ForEach(notes, id: \.self) { note in
                    Text(note).meta().padding(.horizontal, AceTheme.Spacing.rowInner).forgeRowChrome()
                }
            } else {
                if let failure {
                    Text(failure).meta().padding(.horizontal, AceTheme.Spacing.rowInner).forgeRowChrome()
                }
                ForEach(notes, id: \.self) { note in
                    Text(note).meta().padding(.horizontal, AceTheme.Spacing.rowInner).forgeRowChrome()
                }
                rows()
                if hasMore {
                    Button { Task { await more() } } label: {
                        HStack(spacing: AceTheme.Spacing.sm) {
                            Text("Show more").meta()
                            if loading { ProgressView().controlSize(.mini) }
                        }
                        .padding(.horizontal, AceTheme.Spacing.rowInner)
                        .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                    }
                    .buttonStyle(.row)
                    .disabled(loading)
                    .accessibilityIdentifier("forge.more")
                    .forgeRowChrome()
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(surface)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.vertical, AceTheme.Spacing.xs, for: .scrollContent)
        .opacity(stale ? AceDesign.Ink.settledOpacity : 1)
        .animation(.default, value: stale)
        .refreshable { await refresh() }
    }
}


extension View {
    /// The lists' row chrome: the inbox's insets, no rules, the page colour behind.
    func forgeRowChrome() -> some View { inboxRowChrome() }

    /// A row's quick actions without opening it: its host on a swipe; in its menu, its host, the
    /// link, and the thread working on it.
    func forgeRowActions(url: String, host: String?, thread: InboxKey?, openThread: @escaping (InboxKey) -> Void) -> some View {
        modifier(ForgeRowActions(url: url, host: host ?? "GitHub", thread: thread, openThread: openThread))
    }
}

private struct ForgeRowActions: ViewModifier {
    let url: String
    let host: String
    let thread: InboxKey?
    let openThread: (InboxKey) -> Void
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if let link = URL(string: url) {
                    Button(host, ace: .arrowSquareOut) { openURL(link) }.tint(Color(uiColor: .systemGray2))
                }
            }
            .contextMenu {
                if let link = URL(string: url) {
                    Button("Open on \(host)", ace: .arrowSquareOut) { openURL(link) }
                    Button("Copy link", ace: .copy) { UIPasteboard.general.url = link }
                }
                if let thread { Button("Open thread", ace: .chats) { openThread(thread) } }
            }
    }
}
