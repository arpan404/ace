import SwiftUI

/// The Pull requests list: the web's groups (by next step, or by who it concerns) as quiet
/// headings over rows; a row opens its page, swipes to GitHub, and its menu copies the link or
/// opens the thread working on it.
struct ForgePullsList: View {
    let model: ForgeListModel<ForgePullList>
    let machineId: String
    let project: String
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let refresh: () async -> Void
    let more: () async -> Void

    var body: some View {
        ForgeListFrame(loaded: model.list != nil, empty: model.list?.groups.isEmpty ?? true, emptyTitle: "No pull requests match",
                       icon: .gitPullRequest, failure: model.failure, stale: model.stale, hasMore: model.list?.more ?? false,
                       loading: model.loading, refresh: refresh, more: more) {
            ForEach(model.list?.groups ?? []) { group in
                ForgeGroupHeader(label: group.label, count: group.count).forgeRowChrome()
                ForEach(group.rows) { row in
                    Button { open(ForgeRoute(kind: .pull, machineId: machineId, project: project, number: row.number)) } label: {
                        ForgePullRowView(row: row)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("forge.pull.\(row.number)")
                    .forgeRowChrome()
                    .forgeRowActions(url: row.url, thread: row.thread.map { InboxKey(machineId: machineId, id: $0.id) }, openThread: openThread)
                }
            }
        }
    }
}

/// The Issues list: assigned to you, opened by you, and the rest.
struct ForgeIssuesList: View {
    let model: ForgeListModel<ForgeIssueList>
    let machineId: String
    let project: String
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let refresh: () async -> Void
    let more: () async -> Void

    var body: some View {
        ForgeListFrame(loaded: model.list != nil, empty: model.list?.groups.isEmpty ?? true, emptyTitle: "No issues match",
                       icon: .record, failure: model.failure, stale: model.stale, hasMore: model.list?.more ?? false,
                       loading: model.loading, refresh: refresh, more: more) {
            ForEach(model.list?.groups ?? []) { group in
                if group.id != "all" { ForgeGroupHeader(label: group.label, count: group.count).forgeRowChrome() }
                ForEach(group.rows) { row in
                    Button { open(ForgeRoute(kind: .issue, machineId: machineId, project: project, number: row.number)) } label: {
                        ForgeIssueRowView(row: row)
                    }
                    .buttonStyle(.row)
                    .accessibilityIdentifier("forge.issue.\(row.number)")
                    .forgeRowChrome()
                    .forgeRowActions(url: row.url, thread: row.thread.map { InboxKey(machineId: machineId, id: $0.id) }, openThread: openThread)
                }
            }
        }
    }
}

/// The list around the rows: skeleton on the first read, the error state with Try again when
/// nothing could be read, the empty state, a dimmed list while a changed filter reads, a quiet
/// line when a refresh failed over rows already shown, Show more, and pull to refresh.
private struct ForgeListFrame<Rows: View>: View {
    let loaded: Bool
    let empty: Bool
    let emptyTitle: String
    let icon: AceIcon.Name
    let failure: String?
    let stale: Bool
    let hasMore: Bool
    let loading: Bool
    let refresh: () async -> Void
    let more: () async -> Void
    @ViewBuilder let rows: () -> Rows

    var body: some View {
        List {
            if !loaded, let failure {
                EmptyState(icon: nil, title: "Couldn't load from GitHub", line: failure, failed: true) {
                    Button("Try again") { Task { await refresh() } }
                }
                .padding(.top, 100)
                .forgeRowChrome()
            } else if !loaded {
                ForgeSkeleton().forgeRowChrome()
            } else if empty {
                EmptyState(icon: icon, title: emptyTitle) { EmptyView() }
                    .padding(.top, 100)
                    .forgeRowChrome()
            } else {
                if let failure {
                    Text(failure).meta().padding(.horizontal, AceTheme.Spacing.md).forgeRowChrome()
                }
                rows()
                if hasMore {
                    Button { Task { await more() } } label: {
                        HStack(spacing: AceTheme.Spacing.sm) {
                            Text("Show more").meta()
                            if loading { ProgressView().controlSize(.mini) }
                        }
                        .padding(.horizontal, AceTheme.Spacing.md)
                        .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
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
        .background(AceTheme.Colours.background)
        .environment(\.defaultMinListRowHeight, 0)
        .contentMargins(.vertical, AceTheme.Spacing.xs, for: .scrollContent)
        .opacity(stale ? 0.6 : 1)
        .animation(.easeOut(duration: 0.15), value: stale)
        .refreshable { await refresh() }
    }
}

/// Row-shaped pills while the first page reads (DESIGN.md: skeletons, never a page spinner).
private struct ForgeSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xl) {
            ForEach(0..<6, id: \.self) { index in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    pill(width: 120, height: 11)
                    pill(width: index.isMultiple(of: 2) ? 260 : 200, height: 15)
                    pill(width: 160, height: 11)
                }
            }
        }
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.vertical, AceTheme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
    }
    private func pill(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: AceTheme.Radii.xs, style: .continuous).fill(AceTheme.Colours.fill).frame(width: width, height: height)
    }
}

extension View {
    /// The lists' row chrome: the inbox's insets, no rules, the page colour behind.
    func forgeRowChrome() -> some View { inboxRowChrome() }

    /// A row's quick actions without opening it: GitHub on a swipe; in its menu, GitHub, the
    /// link, and the thread working on it.
    func forgeRowActions(url: String, thread: InboxKey?, openThread: @escaping (InboxKey) -> Void) -> some View {
        modifier(ForgeRowActions(url: url, thread: thread, openThread: openThread))
    }
}

private struct ForgeRowActions: ViewModifier {
    let url: String
    let thread: InboxKey?
    let openThread: (InboxKey) -> Void
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if let link = URL(string: url) {
                    Button("GitHub", ace: .arrowSquareOut) { openURL(link) }.tint(Color(uiColor: .systemGray2))
                }
            }
            .contextMenu {
                if let link = URL(string: url) {
                    Button("Open on GitHub", ace: .arrowSquareOut) { openURL(link) }
                    Button("Copy link", ace: .copy) { UIPasteboard.general.url = link }
                }
                if let thread { Button("Open thread", ace: .chats) { openThread(thread) } }
            }
    }
}
