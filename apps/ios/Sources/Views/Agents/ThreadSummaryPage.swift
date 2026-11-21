import SwiftUI

/// The thread at a glance, as the web's Summary tab has it: Now (who needs the person, or how long
/// the work has run or took and what came of it), Since you looked, the agent tree's count opening
/// Agents, Results (pull requests, files changed and by whom, checks, other failed commands) and
/// the plan. A section with nothing in it is left out. The bridge follows the thread only while
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
        SummaryNowHeader(now: summary.now, open: summary.now.open.map { target in { open(target) } })
        if !summary.catchUp.isEmpty { catchUp(summary.catchUp) }
        if let agents = summary.agents {
            QuietSection("Agents") {
                linkRow(agents, identifier: "summary.agents", action: openAgents)
            }
        }
        if summary.hasResults { results(summary) }
        if let plan = summary.plan { SummaryPlanSection(plan: plan) }
        SummaryAutomationsLine(model: model, workspaceId: summary.workspaceId, workspacePath: summary.workspacePath)
    }

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
                        QuietRowText(title: pr.title, detail: pr.line)
                        if openPull != nil { RowCaret() }
                    }
                }
                .buttonStyle(.plain)
                .disabled(openPull == nil)
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

    private func linkRow(_ title: String, identifier: String, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            QuietSectionRow {
                QuietRowText(title: title)
                if action != nil { RowCaret() }
            }
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
        .accessibilityIdentifier(identifier)
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
                    AceIcon(todo.status == "completed" ? .checkSquare : .square, size: AceDesign.Size.glyphMeta, relativeTo: .footnote)
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

/// The project's schedules in one quiet line at the foot of the Summary, as the web's is ("2
/// automations in this project · next tonight 2:00 AM"), opening Automations. The bridge words it
/// (`automations.projectLine`); a project with none shows nothing, and a failed read says so with
/// a way to try again.
private struct SummaryAutomationsLine: View {
    let model: ClientModel
    let workspaceId: String
    let workspacePath: String?
    @State private var reply: Reply?
    /// Bumped by Retry: it restarts the one read loop instead of starting a second reader.
    @State private var attempt = 0
    @State private var opened = false
    private struct Reply: Decodable, Sendable, Equatable { let ok: Bool; let line: String?; let failed: String? }
    /// What a read that never reached the bridge says; the bridge words the same failure as
    /// `projectAutomationsReadFailed` in ui-core.
    private static let unreachable = Reply(ok: true, line: nil, failed: "Couldn't read automations. Try again")
    private struct ReadKey: Equatable { let workspaceId: String; let connection: String; let attempt: Int }

    var body: some View {
        // A stack, not a Group: a Group hands its modifiers to its children, and before the first
        // reply there are none, so the read below would never start.
        VStack(alignment: .leading, spacing: 0) {
            if let failed = reply?.failed {
                Button(failed) { attempt += 1 }
                    .buttonStyle(.plain)
                    .foregroundStyle(AceTheme.StatusText.failed)
                    .accessibilityIdentifier("summary.automations.retry")
            } else if let line = reply?.line {
                // It wraps: the end of the line may be the part that matters ("Automations are
                // off on this machine").
                Button(line) { opened = true }
                    .buttonStyle(.plain)
                    .foregroundStyle(AceDesign.Ink.subtle)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHint("Opens Automations")
                    .accessibilityIdentifier("summary.automations")
            }
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, AceDesign.Space.margin)
        // The only reader, scoped to the view: it stops when the Summary goes away. Again every
        // half minute and when the machine reconnects, as the thread's automation strip reads
        // ("in 1h" moves on, and a schedule may be made or run while the page is open), and
        // straight away on Retry.
        .task(id: ReadKey(workspaceId: workspaceId, connection: model.connection, attempt: attempt)) {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .sheet(isPresented: $opened) { NavigationStack { AutomationsView(model: model) } }
    }

    private func read() async {
        var request: [String: Any] = ["type": "automations.projectLine", "workspaceId": workspaceId, "zone": TimeZone.current.identifier]
        if let workspacePath { request["workspacePath"] = workspacePath }
        do {
            let next = try await model.service(request, as: Reply.self)
            if Task.isCancelled { return }
            reply = next.ok ? next : Self.unreachable
        } catch {
            // Leaving the page or a newer read cancels this one; that isn't a failure to show.
            if Task.isCancelled { return }
            reply = Self.unreachable
        }
    }
}
