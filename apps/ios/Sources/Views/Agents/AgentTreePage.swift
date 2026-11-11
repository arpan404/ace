import SwiftUI

/// The thread's agents as an indented tree: one sentence over the whole tree from the daemon's
/// status ("Waiting on 2 agents. One needs you."), then each agent under the one that started it,
/// its background commands as quiet nodes under it. Below two levels a branch folds into "Show 12
/// more". An agent that needs the person answers from its node; tapping one opens its transcript.
/// Long-press stops an agent. The bridge follows the tree only while this page is on screen, a
/// page at a time; a view-only phone sees the tree with no answers or stops.
struct AgentTreePage: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Opens a native subagent's transcript (pushed on whichever stack shows this page).
    let openAgent: (SubagentRoute) -> Void
    /// Opens an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    /// The main agent's transcript is the thread itself: back to Chat.
    var openChat: (() -> Void)? = nil
    @State private var stop = StopConfirmation()
    @State private var expanded: Set<String> = []
    @State private var paging: String?
    @State private var reviewing: RequestSheetItem?
    @State private var questionDraft = QuestionDraftState()
    @State private var answered = 0
    private var sheet: AgentSheet? { model.sheets.agents }
    private var provider: String { thread.screen.controls?.provider ?? "" }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                if let sheet {
                    header(sheet)
                    tree(sheet)
                    footer(sheet)
                } else {
                    SkeletonRows(count: 3, label: "Loading agents")
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.bottom, AceDesign.Space.group)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(AceDesign.Surface.background)
        .animation(.default, value: sheet?.rows.count)
        .animation(.default, value: expanded)
        .onChange(of: sheet?.rows.count) { _, _ in if paging == "agents" { paging = nil } }
        .onChange(of: sheet?.tasks.count) { _, _ in if paging == "tasks" { paging = nil } }
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: answered)
        .confirmationDialog(stop.asking?.title ?? "", isPresented: asking, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await stop.confirm(send: send) } }.accessibilityIdentifier("agents.confirmStop")
            Button("Cancel", role: .cancel) { stop.cancel() }
        } message: { Text(stop.asking?.message ?? "") }
        .sheet(item: $reviewing) { item in
            if let request = thread.interactions[item.id], request.state == "pending" {
                RequestSheet(request: request, model: model, questionDraft: $questionDraft, openBrowser: {}) { reviewing = nil }
            }
        }
        .onAppear { model.sheet(["kind": "agents", "open": true]) }
        .onDisappear { model.sheet(["kind": "agents", "open": false]) }
        .accessibilityIdentifier("agents.page")
    }

    /// The sentence, with Stop all at its end while anything in the tree runs.
    private func header(_ sheet: AgentSheet) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Text(sheet.summary?.text ?? (sheet.treeRunning ? "Working" : "Finished"))
                .aceFont(AceDesign.TextRole.message, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("agents.summary")
            if model.canOperate && sheet.treeRunning {
                Button(stop.saving ? "Stopping…" : "Stop all") { request(.tree(agents: sheet.totals.agents)) }
                    .buttonStyle(.textAction())
                    .disabled(stop.saving)
                    .padding(.trailing, -AceDesign.Space.related)
                    .accessibilityIdentifier("agents.stopAll")
            }
        }
        .padding(.top, AceDesign.Space.related)
        .padding(.bottom, AceDesign.Space.row)
    }

    @ViewBuilder private func tree(_ sheet: AgentSheet) -> some View {
        ForEach(AgentTreeLayout.lines(rows: sheet.rows, tasks: sheet.tasks, expanded: expanded)) { line in
            Group {
                switch line {
                case .agent(let row, let level): node(row, level: level)
                case .task(let task, let level):
                    AgentTreeTask(task: task, level: level, canStop: model.canOperate) { Task { _ = await model.stopTask(task.id) } }
                case .more(let key, let count, let finished, let level):
                    Button { expanded.insert(key) } label: {
                        Text(finished ? "Show \(count) finished" : "Show \(count) more")
                            .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground)
                            .padding(.leading, CGFloat(level) * AgentTreeRails.indent + AceDesign.Size.lead + AceDesign.Space.related)
                            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("agents.expand.\(key)")
                }
            }
            .background { AgentTreeRails(level: line.level) }
        }
    }

    private func node(_ row: AgentSheet.Row, level: Int) -> some View {
        let request = (row.requests ?? []).lazy.compactMap { thread.interactions[$0] }.first { $0.state == "pending" }
        return Button { open(row) } label: {
            AgentTreeNode(row: row, level: level, provider: provider, request: request,
                          canAnswer: model.canOperate && request.map { model.approvalSubmissions[$0.id] == nil } == true,
                          answer: { request, option in answered += 1; model.approve(request, option: option) },
                          review: { reviewing = RequestSheetItem(id: $0.id) })
                .contentShape(Rectangle())
        }
        .buttonStyle(TranscriptRowButtonStyle())
        .accessibilityIdentifier("agents.row.\(row.id)")
        .accessibilityHint(row.depth == 0 ? "" : "Opens its transcript")
        .contextMenu {
            if model.canOperate && row.stoppable {
                Button(role: .destructive) { self.request(.agent(id: row.id, name: row.name, descendants: row.descendants)) } label: {
                    Label("Stop", systemImage: "stop.circle")
                }
            }
        }
    }

    @ViewBuilder private func footer(_ sheet: AgentSheet) -> some View {
        if sheet.hidden.agents > 0 {
            pageMore(title: "Show \(min(sheet.hidden.agents, 100)) more agents",
                     detail: sheet.hidden.running > 0 ? "\(sheet.hidden.running) still working" : nil, list: "agents")
                .accessibilityIdentifier("agents.more")
        }
        if sheet.hiddenTasks > 0 {
            pageMore(title: "Show \(min(sheet.hiddenTasks, 30)) more commands", detail: nil, list: "tasks")
                .accessibilityIdentifier("agents.tasks.more")
        }
        BudgetLine(totals: sheet.totals, context: sheet.context)
            .padding(.top, AceDesign.Space.group)
        if !model.canOperate {
            Text("View only: this phone can't answer or stop agents.")
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.top, AceDesign.Space.related)
                .accessibilityIdentifier("agents.readOnly")
        }
    }

    /// The bridge's next page of a long list: the words say how many come.
    private func pageMore(title: String, detail: String?, list: String) -> some View {
        Button {
            paging = list
            model.sheet(["kind": "agents.more", "list": list])
        } label: {
            Text([paging == list ? "Loading…" : title, detail].compactMap { $0 }.joined(separator: " · "))
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(paging == list)
    }

    private func open(_ row: AgentSheet.Row) {
        if let child = row.childThreadId, let openThread { openThread(child) }
        else if row.depth == 0 { openChat?() }
        else { openAgent(SubagentRoute(agentId: row.id, title: row.name)) }
    }
    private var asking: Binding<Bool> {
        Binding(get: { stop.asking != nil }, set: { shown in if !shown { stop.cancel() } })
    }
    private func request(_ target: StopConfirmation.Target) { Task { await stop.request(target, send: send) } }
    private func send(_ target: StopConfirmation.Target) async -> Bool { await model.interrupt(agentId: target.agentId) }
}
