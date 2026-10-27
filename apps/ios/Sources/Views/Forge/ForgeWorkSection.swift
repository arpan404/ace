import SwiftUI

/// Working on a pull request from its page: each linked thread with whether its checkout holds
/// the PR's head ("Check out" prepares one, sent once; then "Open thread"), and the PR's merge
/// conflicts and stack as rows that open pages of their own. With no linked thread, "Start a
/// thread" opens New thread. Nothing here shows for a closed or merged pull request.
struct ForgeWorkSection: View {
    let client: ClientModel
    let route: ForgeRoute
    let target: ForgePullTarget
    let push: (ForgeRoute) -> Void
    let openThread: (InboxKey) -> Void
    let startThread: (() -> Void)?
    /// The pull request's title, as New thread names it.
    let title: String
    @State private var work: ForgeWorkPage?
    @State private var stack: ForgeStackPage?
    @State private var writing: String?
    @State private var outcome: ForgeWorkOutcome?

    private var request: [String: Any] { ClientModel.forgeWorkRead(route) }
    private var stackRequest: [String: Any] { ClientModel.forgeStackRead(pushed(.stack), threadId: nil, method: "squash") }

    init(client: ClientModel, route: ForgeRoute, target: ForgePullTarget, push: @escaping (ForgeRoute) -> Void,
         openThread: @escaping (InboxKey) -> Void, startThread: (() -> Void)?, title: String = "") {
        self.client = client
        self.route = route
        self.target = target
        self.push = push
        self.openThread = openThread
        self.startThread = startThread
        self.title = title
        _work = State(initialValue: client.kept(ClientModel.forgeWorkRead(route), as: ForgeWorkPage.self))
    }

    var body: some View {
        Group {
            if let work, work.open { section(work) }
        }
        .animation(.smooth, value: work)
        .animation(.smooth, value: stack)
        .task(id: client.readGeneration(request)) { await load(fresh: false) }
        .task(id: client.readGeneration(stackRequest)) {
            stack = try? await client.forgeWorkRead(stackRequest, as: ForgeStackPage.self)
        }
        .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
    }

    @ViewBuilder private func section(_ work: ForgeWorkPage) -> some View {
        ForgeSection(title: "Work") {
            ForEach(work.threads, id: \.id) { thread in threadRow(thread, work) }
            if work.threads.isEmpty {
                HStack {
                    Text("No thread is working on this pull request.").meta()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    if let startThread, client.canOperate {
                        Button("Start a thread") { start(work) }.buttonStyle(.borderless)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .accessibilityIdentifier("forge.work.start")
                    }
                }
                .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 44)
            }
            if !work.threads.isEmpty {
                ForgeLinkRow(title: "Merge conflicts", detail: "Resolve in the thread's checkout", identifier: "forge.pull.conflicts") { push(pushed(.conflicts)) }
            }
            if let stack = stack?.stack {
                ForgeLinkRow(title: "Stack #\(stack.number)", detail: "\(stack.layers.count) layers → \(stack.trunk)", identifier: "forge.pull.stack") { push(pushed(.stack)) }
            }
        }
        if let blocked = work.blocked { Text(blocked).meta().padding(.horizontal, AceTheme.Spacing.lg) }
        ForgeOutcomeLine(outcome: outcome, identifier: "forge.work.outcome")
    }

    private func threadRow(_ thread: ForgeWorkPage.Thread, _ work: ForgeWorkPage) -> some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(thread.title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text(state(thread)).meta().contentTransition(.opacity)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if thread.checkout != "current", client.canOperate, work.blocked == nil {
                Button(thread.checkout == "older" ? "Update checkout" : "Check out") { checkOut(thread.id, work.headSha) }
                    .disabled(writing != nil)
                    .accessibilityIdentifier("forge.work.checkout")
            }
            if writing == thread.id { ProgressView().controlSize(.small).transition(.opacity) }
            Button("Open") { openThread(InboxKey(machineId: route.machineId, id: thread.id)) }
                .accessibilityIdentifier("forge.work.open")
        }
        .buttonStyle(.borderless)
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 52)
        .accessibilityIdentifier("forge.work.thread.\(thread.id)")
    }

    private func state(_ thread: ForgeWorkPage.Thread) -> String {
        switch thread.checkout {
        case "current": "Checked out\(thread.branch.map { " on \($0)" } ?? "")"
        case "older": "Holds an older head of this pull request"
        default: "Not checked out here"
        }
    }

    private func pushed(_ kind: ForgeRoute.Kind) -> ForgeRoute {
        ForgeRoute(kind: kind, machineId: route.machineId, project: route.project, number: route.number, repository: target.repository)
    }

    /// New thread on this pull request: a worktree of the head shown here, linked to it.
    private func start(_ work: ForgeWorkPage) {
        NewThreadDraftStore.standard().seed(
            machineId: route.machineId, projectId: route.project,
            pullRequest: NewThreadPull(repository: target.repository, number: target.number, headSha: work.headSha, title: title))
        startThread?()
    }

    private func checkOut(_ threadId: String, _ headSha: String) {
        guard writing == nil else { return }
        writing = threadId
        Task {
            outcome = await client.forgeWorkWrite(["type": "forge.worktree", "project": target.project, "number": target.number,
                                                    "repository": target.repository.json, "threadId": threadId, "headSha": headSha])
            await load(fresh: true)
            writing = nil
        }
    }

    private func load(fresh: Bool) async {
        do { work = try await client.forgeWorkRead(request, fresh: fresh, as: ForgeWorkPage.self) }
        catch {}
    }
}
