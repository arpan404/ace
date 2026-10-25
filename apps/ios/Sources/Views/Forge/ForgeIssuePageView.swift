import SwiftUI

/// One issue as a page (the web's issue page, cardless): state, title and people; the threads
/// working on it; its body; the first page of its conversation. "Start thread" opens New thread
/// on this machine and project with the issue written into the first message and linked, as the
/// web's New thread from an issue does; nothing is sent until the person sends it.
struct ForgeIssuePageView: View {
    let client: ClientModel
    let route: ForgeRoute
    let actions: ForgeTabActions
    @State private var page: ForgeIssuePage?
    @State private var failure: String?
    @Environment(\.openURL) private var openURL
    private var request: [String: Any] { ClientModel.forgeIssueRead(project: route.project, number: route.number, repository: route.repository) }

    /// Opens on the page this phone last saw for this issue, read again behind it.
    init(client: ClientModel, route: ForgeRoute, actions: ForgeTabActions) {
        self.client = client
        self.route = route
        self.actions = actions
        _page = State(initialValue: client.kept(ClientModel.forgeIssueRead(project: route.project, number: route.number, repository: route.repository), as: ForgeIssuePage.self))
    }

    var body: some View {
        ScrollView {
            if let page { content(page) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't load this issue", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            if let page, client.canOperate {
                Button { start(page) } label: {
                    Text("Start thread").fontWeight(.semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(AceTheme.Colours.foreground)
                .foregroundStyle(AceTheme.Colours.background)
                .padding(.horizontal, AceTheme.Spacing.lg)
                .padding(.vertical, AceTheme.Spacing.sm)
                .background(AceTheme.Colours.background)
                .accessibilityIdentifier("forge.issue.start")
            }
        }
        .navigationTitle(Text(verbatim: "#\(route.number)"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let page, let link = URL(string: page.url) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Open on GitHub", ace: .arrowSquareOut) { openURL(link) }
                        ShareLink(item: link) { Label("Share", ace: .export) }
                        Button("Copy link", ace: .copy) { UIPasteboard.general.url = link }
                    } label: { Image(ace: .dotsThree) }
                        .accessibilityLabel("More").accessibilityIdentifier("forge.issue.more")
                }
            }
        }
        .task(id: client.readGeneration(request)) { await load() }
    }

    @ViewBuilder private func content(_ page: ForgeIssuePage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    ForgeIssueGlyph(state: page.state)
                    Text(page.state.word).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .foregroundStyle(AceTone(page.state.tone).text)
                    Text("\(page.repository.owner)/\(page.repository.name)").meta()
                    Spacer(minLength: AceTheme.Spacing.none)
                    age(page.updatedAt)
                }
                Text(page.title).aceFont(AceTheme.Typography.title, relativeTo: .title3)
                    .foregroundStyle(AceTheme.Colours.foreground)
                    .textSelection(.enabled)
                Text(people(page)).meta()
                ForgeLabels(labels: page.labels, limit: 8)
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            .accessibilityIdentifier("forge.issue.header")
            ForgeThreadsSection(threads: page.threads, machineId: route.machineId, openThread: actions.openThread)
            if !page.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                MarkdownView(text: page.body).padding(.horizontal, AceTheme.Spacing.lg)
            }
            if !page.events.isEmpty {
                ForgeSection(title: "Conversation") {
                    ForEach(page.events) { event in eventRow(event) }
                }
            }
            if page.moreEvents, let link = URL(string: page.url) {
                Button("More on GitHub") { openURL(link) }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .padding(.horizontal, AceTheme.Spacing.lg)
            }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    private func people(_ page: ForgeIssuePage) -> String {
        var parts = ["Opened by \(page.author)"]
        if !page.assignees.isEmpty { parts.append("assigned to \(page.assignees.joined(separator: ", "))") }
        if let milestone = page.milestone { parts.append(milestone) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func eventRow(_ event: ForgeIssuePage.Event) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(event.actor).fontWeight(.medium).foregroundStyle(AceTheme.Colours.foreground)
                if !event.comment { Text(event.event) }
                Spacer(minLength: AceTheme.Spacing.sm)
                age(event.at)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            if let body = event.body, event.comment { MarkdownView(text: body) }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm)
    }

    @ViewBuilder private func age(_ at: Double?) -> some View {
        if let at {
            TimelineView(.everyMinute) { context in
                Text(ActivityTime.age(since: Date(timeIntervalSince1970: at / 1000), now: context.date)).monospacedDigit().meta()
            }
        }
    }

    private func load() async {
        do { page = try await client.forgeIssue(project: route.project, number: route.number, repository: route.repository); failure = nil }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }

    private func start(_ page: ForgeIssuePage) {
        NewThreadDraftStore.standard().seed(
            machineId: route.machineId, projectId: route.project, text: page.start.text,
            issue: NewThreadIssue(repository: page.start.issue.repository, number: page.start.issue.number, title: page.title))
        actions.startThread()
    }
}
