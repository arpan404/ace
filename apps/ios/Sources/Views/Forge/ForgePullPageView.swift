import SwiftUI

/// One pull request as a page (the web's PR page, cardless): state, title and branches; the
/// merge gates; threads working on it; its description; reviewers, checks and files. The one
/// primary control sits at the bottom: merge, or turn auto-merge on, by the method last picked;
/// anything that can't merge says why in words. A merge is confirmed first and is never retried
/// on its own: the page reads GitHub again to show what happened.
struct ForgePullPageView: View {
    let client: ClientModel
    let route: ForgeRoute
    /// Pushes the Timeline or a changed file on this stack.
    let open: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    /// New thread, offered when no thread works on this pull request.
    var startThread: (() -> Void)?
    @AppStorage("ace.git.mergeMethod") private var savedMethod = ""
    @State private var page: ForgePullPage?
    @State private var failure: String?
    @State private var writing = false
    @State private var outcome: ForgeWrite?
    @State private var confirming: ForgeWriteTarget?
    /// A merge or squash shows its commit to edit before it goes.
    @State private var editingCommit: ForgeWriteTarget?
    /// Review writes from this page (reviewers), made once the page knows its repository.
    @State private var desk: ForgeReviewDesk?
    @State private var composing: ForgeCompose?
    @Environment(\.openURL) private var openURL

    private var method: String { savedMethod.isEmpty ? "squash" : savedMethod }
    private var request: [String: Any] { ClientModel.forgePullRead(project: route.project, number: route.number, repository: route.repository, method: method) }

    /// Opens on the page this phone last saw for this pull request, read again behind it.
    init(client: ClientModel, route: ForgeRoute, open: @escaping (ForgeRoute) -> Void, openThread: @escaping (InboxKey) -> Void,
         startThread: (() -> Void)? = nil) {
        self.client = client
        self.route = route
        self.open = open
        self.openThread = openThread
        self.startThread = startThread
        let saved = UserDefaults.standard.string(forKey: "ace.git.mergeMethod") ?? ""
        let method = saved.isEmpty ? "squash" : saved
        let kept = client.kept(ClientModel.forgePullRead(project: route.project, number: route.number, repository: route.repository, method: method), as: ForgePullPage.self)
        _page = State(initialValue: kept)
        _desk = State(initialValue: kept.map { ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: $0.number, repository: $0.repository)) })
    }

    var body: some View {
        ScrollView {
            if let page { content(page) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't load this pull request", line: failure, failed: true) {
                    Button("Try again") { Task { await load() } }
                }
                .padding(.top, 120)
            } else {
                ProgressView().padding(.top, 120).frame(maxWidth: .infinity)
            }
        }
        .background(AceTheme.Colours.background)
        .refreshable { await load() }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) { if let page { bar(page) } }
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
                        .accessibilityLabel("More").accessibilityIdentifier("forge.pull.more")
                }
            }
        }
        .task(id: "\(method)|\(client.readGeneration(request))") { await load() }
        .sheet(isPresented: Binding(get: { editingCommit != nil }, set: { if !$0 { editingCommit = nil } })) {
            if let target = editingCommit, let page {
                ForgeMergeCommitSheet(target: target, title: "#\(page.number) \(page.title)") { edited in
                    editingCommit = nil
                    Task { await write(edited) }
                }
            }
        }
        .sheet(item: $composing) { compose in
            if let desk { ForgeWriteSheet(compose: compose, desk: desk) }
        }
        .confirmationDialog(confirming?.action.label ?? "", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                            titleVisibility: .visible, presenting: confirming) { target in
            Button(target.action.label) { Task { await write(target) } }
        } message: { _ in
            if let page { Text(verbatim: "#\(page.number) \(page.title)") }
        }
        // A refresh that moves the head or the method ends the question asked against the old one.
        .onChange(of: "\(page?.headSha ?? "")|\(method)") {
            if let target = confirming, !target.matches(page, method: method) { confirming = nil }
            if let target = editingCommit, !target.matches(page, method: method) { editingCommit = nil }
        }
    }

    @ViewBuilder private func content(_ page: ForgePullPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            header(page)
            if !page.gates.isEmpty { ForgeSection(title: nil) { ForEach(page.gates, id: \.self) { gate in gateRow(gate) } } }
            if !page.blockers.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                    ForEach(page.blockers, id: \.self) { Text($0).meta(AceTone.failed.text) }
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
            }
            ForgeThreadsSection(threads: page.threads, machineId: route.machineId, openThread: openThread)
            if !page.bodyBlocks.isEmpty, let desk {
                ForgeRichView(blocks: page.bodyBlocks, scope: desk.scope, tick: descriptionTicker(page, desk))
                    .padding(.horizontal, AceTheme.Spacing.lg)
                if let message = desk.message {
                    Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                        .padding(.horizontal, AceTheme.Spacing.lg)
                }
            }
            ForgeSection(title: nil) {
                ForgeLinkRow(title: "Timeline", detail: page.conversation, identifier: "forge.pull.timeline") {
                    open(ForgeRoute(kind: .timeline, machineId: route.machineId, project: route.project, number: route.number, repository: route.repository))
                }
            }
            if let desk { ForgeReviewersSection(desk: desk, compose: { composing = $0 }) }
            if let desk { ForgeManageSection(desk: desk, route: route, open: open) }
            ForgeWorkSection(client: client, route: route, target: target(page), push: open, openThread: openThread, startThread: startThread)
            ForgeChecksSection(client: client, route: route, target: target(page), shown: page.checks, open: open)
            ForgeSection(title: nil) {
                ForgeLinkRow(title: "Files changed", detail: page.changedFiles == 1 ? "1 file" : "\(page.changedFiles) files", identifier: "forge.pull.files") {
                    open(ForgeRoute(kind: .files, machineId: route.machineId, project: route.project, number: route.number, repository: route.repository))
                }
            }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    private func target(_ page: ForgePullPage) -> ForgePullTarget {
        ForgePullTarget(project: route.project, number: page.number, repository: page.repository)
    }

    private func header(_ page: ForgePullPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            HStack(spacing: AceTheme.Spacing.sm) {
                ForgePullGlyph(state: page.state, merged: page.merged, size: 16)
                Text(page.state.word).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTone(page.state.tone).text)
                Text("\(page.repository.owner)/\(page.repository.name)").meta()
                Spacer(minLength: AceTheme.Spacing.none)
                if let updated = page.updatedAt {
                    TimelineView(.everyMinute) { context in
                        Text(ActivityTime.age(since: Date(timeIntervalSince1970: updated / 1000), now: context.date)).monospacedDigit().meta()
                    }
                }
            }
            Text(page.title).aceFont(AceTheme.Typography.title, relativeTo: .title3)
                .foregroundStyle(AceTheme.Colours.foreground)
                .textSelection(.enabled)
            Text("\(page.author) · \(page.commits == 1 ? "1 commit" : "\(page.commits) commits")").meta()
            Text("\(page.headBranch) → \(page.baseBranch)").aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).truncationMode(.middle)
            if let additions = page.additions, let deletions = page.deletions {
                ForgeDiffStat(additions: additions, deletions: deletions)
            }
            ForgeLabels(labels: page.labels, limit: 8)
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .accessibilityIdentifier("forge.pull.header")
    }

    private func gateRow(_ gate: ForgePullPage.Gate) -> some View {
        ForgeLine(leading: gate.label, trailing: gate.detail.map { "\(gate.value) · \($0)" } ?? gate.value, tone: gate.tone)
    }

    /// The bottom strip: the outcome of the last write, then the one control, or its words.
    @ViewBuilder private func bar(_ page: ForgePullPage) -> some View {
        VStack(spacing: AceTheme.Spacing.sm) {
            if let outcome {
                Text(outcome.message).meta(outcome.ok ? AceTheme.Colours.mutedForeground : AceTone.failed.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.outcome")
            }
            if let action = page.action {
                HStack(spacing: AceTheme.Spacing.sm) {
                    Button { ask(action, page) } label: {
                        HStack {
                            if writing { ProgressView().controlSize(.small) }
                            Text(action.label).fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(AceTheme.Colours.foreground)
                    .foregroundStyle(AceTheme.Colours.background)
                    .disabled(writing || action.disabled != nil || !client.canOperate)
                    .accessibilityIdentifier("forge.pull.primary")
                    if page.methods.count > 1 {
                        Menu {
                            Picker("Merge method", selection: Binding(get: { method }, set: { savedMethod = $0 })) {
                                ForEach(page.methods, id: \.self) { Text($0.label).tag($0.method) }
                            }
                        } label: {
                            Image(ace: .caretDown).frame(width: 44, height: 44)
                                .aceGlass(in: AceShape.capsule, interactive: true)
                                .contentShape(AceShape.capsule)
                        }
                            .accessibilityLabel("Merge method").accessibilityIdentifier("forge.pull.method")
                    }
                }
                if let reason = action.disabled { Text(reason).meta().frame(maxWidth: .infinity, alignment: .leading) }
            } else if !page.primary.isEmpty {
                Text(page.primary).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.primary")
            }
            if let secondary = page.secondary {
                Button(secondary.label) { Task { await write(ForgeWriteTarget(action: secondary, project: route.project, page: page, method: method)) } }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(AceTheme.Colours.foreground)
                    .disabled(writing || secondary.disabled != nil || !client.canOperate)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("forge.pull.secondary")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.lg)
        .padding(.vertical, AceTheme.Spacing.sm)
        .background(AceTheme.Colours.background)
    }

    /// Merge and auto-merge by merge or squash open their commit to edit; the rest confirm.
    private func ask(_ action: ForgePullPage.Action, _ page: ForgePullPage) {
        var target = ForgeWriteTarget(action: action, project: route.project, page: page, method: method)
        if action.kind != "disable-auto-merge", let commit = page.commit {
            target.commit = commit
            editingCommit = target
        } else {
            confirming = target
        }
    }

    /// The description's boxes tick only where GitHub lets this account edit it.
    private func descriptionTicker(_ page: ForgePullPage, _ desk: ForgeReviewDesk) -> ((Int, Bool) -> Void)? {
        guard page.tasks, client.canOperate else { return nil }
        return { offset, checked in Task { await desk.tick(on: ["kind": "pull"], offset: offset, checked: checked) } }
    }

    private func load() async {
        do {
            let read = try await client.forgePull(project: route.project, number: route.number, repository: route.repository, method: method)
            if desk == nil { desk = ForgeReviewDesk(client: client, target: ForgePullTarget(project: route.project, number: read.number, repository: read.repository)) }
            page = read
            failure = nil
        }
        catch is CancellationError {}
        catch { failure = error.localizedDescription }
    }

    private func write(_ target: ForgeWriteTarget) async {
        guard !writing else { return }
        writing = true
        outcome = await client.forgeWrite(target)
        // What GitHub did is read, never assumed.
        await load()
        writing = false
    }
}
