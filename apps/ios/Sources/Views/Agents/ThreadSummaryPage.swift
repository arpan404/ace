import SwiftUI

/// The thread at a glance: Now (who needs the person, or how long the work has run or took and
/// what came of it, the model, and how many subagents are done), Since you looked, the agents by
/// what they need (`SummaryAgentsSection`), Results (pull requests with their state, files changed
/// and by whom, checks, other failed commands) and the plan. A section with nothing in it is left out. The bridge follows the thread only while
/// this is on screen and words every line (`bridge/thread-summary.ts`); this view only draws and
/// routes. Cardless, as inner pages are (design language §5).
struct ThreadSummaryPage: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Opens an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    /// Opens the agent tree; nil where it isn't one tap away.
    let openAgents: (() -> Void)?
    /// Opens the thread's changes on This thread, as the files count is the whole thread's; nil
    /// where the page can't.
    let openChanges: (() -> Void)?
    /// Opens a native subagent's transcript, where this page sits on a stack that can push it.
    var openAgent: ((SubagentRoute) -> Void)? = nil
    @Environment(\.openPullRequest) private var openPull
    @State private var showClosed = false
    private var summary: ThreadSummarySheet? { model.sheets.summary }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                if let summary { content(summary) } else { SkeletonRows(count: 4, label: "Loading summary") }
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
            .animation(.default, value: summary)
        }
        .background(AceDesign.Surface.background)
        .onAppear { model.sheet(["kind": "summary", "open": true]) }
        .onDisappear { model.sheet(["kind": "summary", "open": false]) }
        .accessibilityIdentifier("summary.page")
    }

    @ViewBuilder private func content(_ summary: ThreadSummarySheet) -> some View {
        // The asking agent's row below offers its way on, so Now doesn't repeat it.
        let asksListed = !(summary.agents?.asks.isEmpty ?? true)
        SummaryNowHeader(now: summary.now, open: asksListed ? nil : summary.now.open.map { target in { open(target) } })
        if !summary.catchUp.isEmpty { catchUp(summary.catchUp) }
        if let agents = summary.agents {
            SummaryAgentsSection(agents: agents, open: open, openTree: openAgents)
        }
        if summary.hasResults { results(summary) }
        if let plan = summary.plan { SummaryPlanSection(plan: plan) }
    }

    /// Since you looked says counts, not moments: the catch-up digest names no transcript item to
    /// scroll to, so its lines stay words.
    private func catchUp(_ lines: [ThreadSummarySheet.Line]) -> some View {
        QuietSection("Since you looked") {
            ForEach(lines) { line in
                QuietSectionRow {
                    Text(line.text).aceFont(AceDesign.TextRole.rowTitle)
                        .foregroundStyle(Self.ink(line.tone, rest: AceDesign.Ink.muted)).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            QuietSectionRow {
                Button("Clear") { model.sheet(["kind": "summary.clear"]) }
                    .buttonStyle(.textAction())
                    .accessibilityIdentifier("summary.catchUp.clear")
                Spacer(minLength: 0)
            }
        }
        .accessibilityIdentifier("summary.catchUp")
    }

    private func results(_ summary: ThreadSummarySheet) -> some View {
        QuietSection("Results") {
            ForEach(summary.prs) { pr in
                Button { openPull?(summary.workspaceId, pr.number, pr.repository) } label: {
                    QuietSectionRow {
                        AceIcon(.gitPullRequest, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                            .foregroundStyle(AceDesign.Ink.subtle)
                            .overlay(alignment: .bottomTrailing) { PullStateDot(state: pr.dot) }
                        QuietRowText(title: pr.title, detail: pr.line)
                        if openPull != nil { RowCaret() }
                    }
                }
                .buttonStyle(.plain)
                .disabled(openPull == nil)
                .accessibilityHint(openPull == nil ? "" : "Opens the pull request")
                .accessibilityIdentifier("summary.pr.\(pr.number)")
            }
            if let fold = summary.prFold {
                QuietSectionRow {
                    Button(fold) {
                        showClosed.toggle()
                        model.sheet(["kind": "summary.closed", "shown": showClosed])
                    }
                    .buttonStyle(.textAction())
                    .accessibilityIdentifier("summary.prs.closed")
                    Spacer(minLength: 0)
                }
            }
            if let files = summary.files { filesRow(files) }
            if !summary.checks.isEmpty { checksRow(summary.checks) }
            if let commands = summary.commands {
                QuietSectionRow {
                    AceIcon(.terminal, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.subtle)
                    (Text(commands.ran + ", ") + Text(commands.failed).foregroundStyle(AceTheme.StatusText.failed))
                        .aceFont(AceDesign.TextRole.rowTitle)
                        .foregroundStyle(AceDesign.Ink.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityIdentifier("summary.results")
    }

    private func filesRow(_ files: ThreadSummarySheet.Files) -> some View {
        Button { openChanges?() } label: {
            QuietSectionRow {
                AceIcon(.notePencil, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.subtle)
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    QuietRowText(title: files.title, detail: files.detail.isEmpty ? nil : files.detail)
                    ForEach(files.conflicts, id: \.self) { conflict in
                        Text(conflict).aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(AceTheme.StatusText.needsYou).lineLimit(2)
                    }
                }
                if openChanges != nil { RowCaret() }
            }
        }
        .buttonStyle(.plain)
        .disabled(openChanges == nil)
        .accessibilityHint(openChanges == nil ? "" : "Opens the changes")
        .accessibilityIdentifier("summary.files")
    }

    private func checksRow(_ checks: [ThreadSummarySheet.Check]) -> some View {
        QuietSectionRow {
            AceIcon(.listChecks, size: AceDesign.Size.glyphSmall, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.subtle)
            checks.enumerated().reduce(Text("")) { line, entry in
                let words = Text(entry.element.text)
                    .foregroundStyle(entry.element.failed ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                return entry.offset == 0 ? words : line + Text(" · ").foregroundStyle(AceDesign.Ink.subtle) + words
            }
            .aceFont(AceDesign.TextRole.rowTitle)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Checks: " + checks.map(\.text).joined(separator: ", "))
        .accessibilityIdentifier("summary.checks")
    }

    /// One agent of the tree: its own thread when it delegated to one, its transcript when it
    /// lives here, else the thread it lives in.
    private func open(_ agent: ThreadSummarySheet.Agent) {
        if let child = agent.childThreadId { openThread?(child) }
        else if agent.threadId == thread.id, let openAgent { openAgent(SubagentRoute(agentId: agent.agentId, title: agent.name)) }
        else if agent.threadId != thread.id { openThread?(agent.threadId) }
    }

    /// The asking agent: its own thread when it delegated to one, its transcript when it lives
    /// here, else the thread it lives in.
    private func open(_ target: ThreadSummarySheet.Now.Open) {
        if let child = target.childThreadId { openThread?(child) }
        else if target.threadId == thread.id, let openAgent { openAgent(SubagentRoute(agentId: target.agentId, title: target.name)) }
        else if target.threadId != thread.id { openThread?(target.threadId) }
    }

    /// Ink for a shared tone: the warning colour for a request, red for a failure.
    static func ink(_ tone: String, rest: Color) -> Color {
        switch tone {
        case "needs-you": AceTheme.StatusText.needsYou
        case "failed": AceTheme.StatusText.failed
        default: rest
        }
    }
}

/// Now: one short line in the header role, the time after its middle dot muted, then one grey
/// line; Open goes to the agent asking, when that isn't the thread's own main agent.
private struct SummaryNowHeader: View {
    let now: ThreadSummarySheet.Now
    let open: (() -> Void)?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            headline
                .aceFont(AceDesign.TextRole.header)
                .foregroundStyle(ThreadSummaryPage.ink(now.tone, rest: AceDesign.Ink.primary))
                .monospacedDigit()
                .accessibilityLabel("Thread status: \(now.speak)")
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("summary.now")
            if !now.sub.isEmpty {
                Text(now.sub).aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(2).monospacedDigit()
                    .accessibilityIdentifier("summary.now.sub")
            }
            if !now.model.isEmpty || now.progress != nil { SummaryRunLine(now: now) }
            if let open, let target = now.open {
                Button("Open", action: open)
                    .buttonStyle(.textAction(.prominent))
                    .accessibilityLabel("Open \(target.name)")
                    .accessibilityIdentifier("summary.now.open")
            }
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var headline: Text {
        guard let span = now.span else { return Text(now.say) }
        return Text(now.lead) + Text(" · \(span)").foregroundStyle(AceDesign.Ink.muted)
    }
}

/// The plan: how many items are done of how many, a thin line that fills as they are, then the
/// checklist, the item in progress in ink and settled ones in grey.
private struct SummaryPlanSection: View {
    let plan: ThreadSummarySheet.Plan
    var body: some View {
        QuietSection("Plan · \(plan.count)") {
            ProgressView(value: Double(plan.done), total: Double(max(plan.total, 1)))
                .tint(AceDesign.Ink.muted)
                .padding(.horizontal, AceDesign.Space.margin)
                .padding(.vertical, AceDesign.Space.tight)
                .accessibilityLabel("Plan progress")
                .accessibilityValue(plan.count)
            ForEach(plan.todos) { todo in
                QuietSectionRow {
                    Image(systemName: todo.status == "completed" ? "checkmark.square" : "square")
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.subtle)
                        .accessibilityHidden(true)
                    Text(todo.text)
                        .aceFont(AceDesign.TextRole.rowTitle)
                        .foregroundStyle(settled(todo) ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                        .strikethrough(todo.status == "cancelled")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("\(todo.text), \(todo.words)")
            }
        }
        .accessibilityIdentifier("summary.plan")
    }
    private func settled(_ todo: ThreadSummarySheet.Plan.Todo) -> Bool {
        todo.status == "completed" || todo.status == "cancelled"
    }
}

/// Under Now, quietly: the main agent's mark and model, and once there are subagents how many are
/// done of all of them, over a thin line that fills as they finish.
private struct SummaryRunLine: View {
    let now: ThreadSummarySheet.Now
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.tight + 1) {
                if !now.model.isEmpty {
                    ProviderMark(provider: now.provider, size: AceDesign.Size.rowMark)
                        .opacity(AceDesign.Ink.markOpacity)
                }
                Text([now.model, now.progress?.words ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                    .aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            if let progress = now.progress {
                ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                    .tint(AceDesign.Ink.muted)
                    .accessibilityHidden(true)
            }
        }
        .padding(.top, AceDesign.Space.tight)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("summary.now.run")
    }
}

/// A pull request's state as a small dot on its icon: open in green, merged in purple, failing
/// checks in red, draft and closed in grey, as forges colour them.
private struct PullStateDot: View {
    let state: String
    var body: some View {
        Circle().fill(colour)
            .frame(width: AceDesign.Size.dotSmall, height: AceDesign.Size.dotSmall)
            .overlay(Circle().stroke(AceDesign.Surface.background, lineWidth: AceDesign.Size.hairline))
            .offset(x: AceDesign.Size.hairline * 2, y: AceDesign.Size.hairline * 2)
            .accessibilityHidden(true)
    }
    private var colour: Color {
        switch state {
        case "open": AceDesign.Status.finished
        case "merged": AceDesign.Status.waiting
        case "failing": AceDesign.Status.failed
        default: AceDesign.Ink.subtle
        }
    }
}
