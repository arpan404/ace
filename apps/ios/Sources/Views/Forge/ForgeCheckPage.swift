import SwiftUI

/// One check as a page (the web's check detail, full screen): its state, what its app reported,
/// its annotations, its steps (a tap jumps the log to one) and its log, read a page at a time
/// and opened at the failure. Re-run failed, Re-run all and Cancel run are words; cancelling is
/// red and asked first. "Fix with agent" puts the failure in a linked thread's composer for the
/// person to send. A write is sent once; the page then reads GitHub again.
struct ForgeCheckPageView: View {
    let client: ClientModel
    let route: ForgeRoute
    let openThread: (InboxKey) -> Void
    /// Opens New thread, already drafted; nil where threads can't start.
    var startThread: (() -> Void)?
    @State private var page: ForgeCheckPage?
    @State private var failure: String?
    @State private var writing: String?
    @State private var outcome: ForgeWorkOutcome?
    @State private var cancelling = false
    @State private var jump: Int?
    @Environment(\.threadDrafts) private var drafts
    @Environment(\.openURL) private var openURL

    private var request: [String: Any] { ClientModel.forgeCheckRead(route, checkId: route.checkId ?? "") }

    init(client: ClientModel, route: ForgeRoute, openThread: @escaping (InboxKey) -> Void, startThread: (() -> Void)? = nil) {
        self.startThread = startThread
        self.client = client
        self.route = route
        self.openThread = openThread
        _page = State(initialValue: client.kept(ClientModel.forgeCheckRead(route, checkId: route.checkId ?? ""), as: ForgeCheckPage.self))
    }

    var body: some View {
        ScrollView {
            if let page { content(page).transition(.opacity) }
            else if let failure {
                EmptyState(icon: nil, title: "Couldn't read this check", line: failure, failed: true) {
                    Button("Try again") { Task { await load(fresh: true) } }
                }
                .padding(.top, 120)
            } else {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    ForEach(0..<5, id: \.self) { _ in Text(verbatim: "Reading the check").meta().redacted(reason: .placeholder) }
                }
                .padding(AceTheme.Spacing.lg).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .animation(AceMotion.smooth, value: page)
        .background(AceTheme.Colours.background)
        .refreshable { await load(fresh: true) }
        .navigationTitle(page?.name ?? "Check")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let link = page?.url.flatMap(URL.init(string:)) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Open on GitHub", ace: .arrowSquareOut) { openURL(link) }
                        Button("Copy link", ace: .copy) { UIPasteboard.general.url = link }
                    } label: { Image(ace: .dotsThree) }
                        .accessibilityLabel("More").accessibilityIdentifier("forge.check.more")
                }
            }
        }
        .task(id: client.readGeneration(request)) { await load(fresh: false) }
        .sensoryFeedback(.success, trigger: outcome) { _, now in now?.ok == true }
        .confirmationDialog("Cancel this run?", isPresented: $cancelling, titleVisibility: .visible) {
            Button("Cancel run", role: .destructive) { write(["kind": "cancel", "runId": page?.workflow?.runId ?? 0, "attempt": page?.workflow?.attempt ?? 0], key: "cancel") }
        } message: { Text("GitHub stops every job of the workflow run. You can re-run it later.") }
    }

    @ViewBuilder private func content(_ page: ForgeCheckPage) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                Text(page.word).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .foregroundStyle(page.tone == "idle" ? AceTheme.Colours.mutedForeground : AceTone(page.tone).text)
                    .contentTransition(.opacity)
                    .accessibilityIdentifier("forge.check.state")
                Text(page.name).aceFont(AceTheme.Typography.title, relativeTo: .title3).foregroundStyle(AceTheme.Colours.foreground)
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
            actions(page)
            ForgeOutcomeLine(outcome: outcome, identifier: "forge.check.outcome")
            output(page.output)
            if !page.annotations.isEmpty {
                ForgeSection(title: "Annotations") {
                    ForEach(page.annotations, id: \.self) { annotation in annotationRow(annotation) }
                    if page.annotationsMore { Text("More annotations are on GitHub.").meta().padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: 36) }
                }
            }
            if page.log != nil, page.steps.count > 1 {
                ForgeSection(title: "Steps") {
                    ForEach(page.steps, id: \.self) { step in
                        Button { jump = step.line } label: { ForgeLine(leading: step.name, trailing: step.word, tone: step.tone) }
                            .buttonStyle(.row).disabled(step.line == nil)
                    }
                }
            }
            if let log = page.log, let id = page.checkRunId {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                    Text("Log").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).padding(.horizontal, AceTheme.Spacing.lg)
                        .accessibilityAddTraits(.isHeader)
                    if log.truncated { Text("Older lines are on GitHub.").meta().padding(.horizontal, AceTheme.Spacing.lg) }
                    ForgeLogView(client: client, name: page.name, request: logRequest(id, page), total: log.lines, focus: log.focus,
                                 errors: Set(log.errors), jump: jump, live: !page.finished)
                }
            }
            if let note = page.note { Text(note).meta().padding(.horizontal, AceTheme.Spacing.lg) }
        }
        .padding(.vertical, AceTheme.Spacing.md)
    }

    @ViewBuilder private func actions(_ page: ForgeCheckPage) -> some View {
        let controls = page.controls
        if client.canOperate, page.workflow != nil || page.fix != nil {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if controls.rerunFailed, let workflow = page.workflow {
                    ForgeTextAction(label: "Re-run failed jobs", busy: writing == "failed", identifier: "forge.check.rerun-failed") {
                        write(["kind": "rerun", "runId": workflow.runId, "attempt": workflow.attempt, "jobs": "failed"], key: "failed")
                    }
                }
                if controls.rerunAll, let workflow = page.workflow {
                    ForgeTextAction(label: "Re-run all jobs", busy: writing == "all", identifier: "forge.check.rerun-all") {
                        write(["kind": "rerun", "runId": workflow.runId, "attempt": workflow.attempt, "jobs": "all"], key: "all")
                    }
                }
                if controls.cancel, page.workflow != nil {
                    ForgeTextAction(label: "Cancel run", destructive: true, busy: writing == "cancel", identifier: "forge.check.cancel") { cancelling = true }
                }
                if let fix = page.fix {
                    ForgeTextAction(label: "Fix with agent", reason: fix.threadId == nil && (fix.pullRequest == nil || startThread == nil) ? "Link a thread to this pull request to hand it the failure." : nil,
                                    identifier: "forge.check.fix") { handOff(fix) }
                }
            }
        }
    }

    @ViewBuilder private func output(_ output: ForgeCheckPage.Output) -> some View {
        if output.title != nil || output.summary != nil || output.text != nil {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                if let title = output.title { Text(title).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).foregroundStyle(AceTheme.Colours.foreground) }
                ForEach([output.summary, output.text].compactMap { $0 }, id: \.self) { text in
                    Text(LocalizedStringKey(text)).aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
                }
            }
            .padding(.horizontal, AceTheme.Spacing.lg)
        }
    }

    private func annotationRow(_ annotation: ForgeCheckPage.Annotation) -> some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(spacing: AceTheme.Spacing.sm) {
                Text(annotation.level).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(annotation.tone == "idle" ? AceTheme.Colours.mutedForeground : AceTone(annotation.tone).text)
                if let place = annotation.where {
                    Text(place).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1).truncationMode(.head)
                }
            }
            if let title = annotation.title { Text(title).meta() }
            Text(annotation.message).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground).textSelection(.enabled)
        }
        .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
        .accessibilityElement(children: .combine)
    }

    private func logRequest(_ id: Int, _ page: ForgeCheckPage) -> [String: Any] {
        var payload: [String: Any] = ["type": "forge.pull.check.log", "project": route.project, "checkRunId": id, "finished": page.finished]
        if let jobId = page.jobId { payload["jobId"] = jobId }
        if let repository = route.repository { payload["repository"] = repository.json }
        return payload
    }

    private func handOff(_ fix: ForgeCheckPage.Fix) {
        guard let threadId = fix.threadId else {
            // No thread works on it yet: a new one starts on the PR with the request written in.
            guard let pull = fix.pullRequest, let startThread else { return }
            NewThreadDraftStore.standard().seed(
                machineId: route.machineId, projectId: route.project,
                pullRequest: NewThreadPull(repository: pull.repository, number: pull.number, headSha: pull.headSha, title: pull.title),
                text: fix.request)
            startThread()
            return
        }
        if client.handOff(fix.request, to: threadId, drafts: drafts) { openThread(InboxKey(machineId: route.machineId, id: threadId)) }
        else { outcome = ForgeWorkOutcome(ok: false, message: "Couldn't add the request. Open the thread and try again.", uncertain: false) }
    }

    private func write(_ action: [String: Any], key: String) {
        guard writing == nil, let repository = route.repository else { return }
        writing = key
        Task {
            outcome = await client.forgeWorkWrite(["type": "forge.checks.write", "project": route.project, "number": route.number,
                                                    "repository": repository.json, "action": action])
            // What GitHub did is read, never assumed.
            await load(fresh: true)
            writing = nil
        }
    }

    private func load(fresh: Bool) async {
        do {
            page = try await client.forgeWorkRead(request, fresh: fresh, as: ForgeCheckPage.self)
            failure = nil
        }
        catch is CancellationError {}
        catch { if page == nil { failure = error.localizedDescription } }
    }
}
