import SwiftUI

/// The thread's agents as one plain list: the main agent, its subagents (each opens its part of
/// the conversation, or its own thread), then background commands with Stop. The bridge follows
/// the tree only while this sheet is shown. Stop all and stopping an agent with subagents ask
/// first; a view-only phone sees the tree but no stop controls.
struct AgentsSheet: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread; its transcript lives there.
    var openThread: ((String) -> Void)? = nil
    @State private var stop = StopConfirmation()
    @State private var path: [SubagentRoute] = []
    /// A page asked for and not yet delivered, so its button says so and can't be pressed twice.
    @State private var paging: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.panelHost) private var panelHost
    private var sheet: AgentSheet? { model.sheets.agents }
    private var provider: String { thread.screen.controls?.provider ?? "" }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let sheet {
                    Section {
                        ForEach(sheet.rows) { row in agentRow(row).listRowBackground(Color.clear).listRowSeparator(.hidden) }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                    if sheet.hidden.agents > 0 {
                        MoreRow(title: "Show \(min(sheet.hidden.agents, 100)) more", detail: hiddenText(sheet.hidden),
                                loading: paging == "agents") { more("agents") }
                            .accessibilityIdentifier("agents.more")
                            .listRowBackground(Color.clear).listRowSeparator(.hidden)
                    }
                    if !sheet.tasks.isEmpty {
                        Section {
                            ForEach(sheet.tasks) { task in
                                TaskRowView(task: task, canStop: model.canOperate) { Task { _ = await model.stopTask(task.id) } }
                                    .listRowSeparator(.hidden)
                            }
                            if sheet.hiddenTasks > 0 {
                                MoreRow(title: "Show \(min(sheet.hiddenTasks, 30)) more", detail: "\(sheet.hiddenTasks) not shown yet",
                                        loading: paging == "tasks") { more("tasks") }
                                    .accessibilityIdentifier("agents.tasks.more")
                                    .listRowSeparator(.hidden)
                            }
                        } header: { InsetHeader("Running in background") }
                        .listRowBackground(Color.clear)
                    }
                    Group {
                        BudgetLine(totals: sheet.totals, context: sheet.context)
                        if !model.canOperate {
                            Text("View only: this phone can't stop agents.").font(AceDesign.Typeface.meta)
                                .foregroundStyle(AceDesign.Ink.muted).accessibilityIdentifier("agents.readOnly")
                        }
                    }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                } else {
                    SkeletonRows(count: 3, label: "Loading agents").listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceDesign.Surface.background)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: SubagentRoute.self) { route in
                SubagentView(route: route, model: model, thread: thread, push: { path.append($0) },
                             openThread: { child in dismiss(); openThread?(child) })
            }
            .animation(AceDesign.Motion.arriving(reduceMotion), value: sheet?.rows.count)
            .animation(AceDesign.Motion.arriving(reduceMotion), value: sheet?.tasks.count)
            .onChange(of: sheet?.rows.count) { _, _ in if paging == "agents" { paging = nil } }
            .onChange(of: sheet?.tasks.count) { _, _ in if paging == "tasks" { paging = nil } }
            .sheetEscape { dismiss() }
            .toolbar {
                if panelHost == nil {
                    ToolbarItem(placement: .cancellationAction) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                            .accessibilityLabel("Close").accessibilityIdentifier("agents.close")
                    }
                }
            }
            .screenBar {
                if model.canOperate {
                    Button(role: .destructive) { request(.tree(agents: sheet?.totals.agents ?? 1)) } label: {
                        Text(stop.saving ? "Stopping…" : "Stop all")
                    }
                    .tint(AceTheme.StatusText.failed)
                    .disabled(!(sheet?.treeRunning ?? false) || stop.saving)
                    .accessibilityIdentifier("agents.stopAll")
                }
            }
            .confirmationDialog(stop.asking?.title ?? "", isPresented: asking, titleVisibility: .visible) {
                Button("Stop", role: .destructive) { Task { await stop.confirm(send: send) } }.accessibilityIdentifier("agents.confirmStop")
                Button("Cancel", role: .cancel) { stop.cancel() }
            } message: { Text(stop.asking?.message ?? "") }
        }
        .tint(AceDesign.Ink.accent)
        .onAppear { model.sheet(["kind": "agents", "open": true]) }
        .onDisappear { model.sheet(["kind": "agents", "open": false]) }
    }
    /// Whether a stop is waiting for its confirmation; dismissing the dialog cancels it.
    private var asking: Binding<Bool> {
        Binding(get: { stop.asking != nil }, set: { shown in if !shown { stop.cancel() } })
    }
    @ViewBuilder private func agentRow(_ row: AgentSheet.Row) -> some View {
        Group {
            if let child = row.childThreadId, let openThread {
                Button { dismiss(); openThread(child) } label: {
                    HStack {
                        AgentRowView(row: row, provider: provider)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceDesign.Ink.faint)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else if row.depth == 0 {
                // The main agent's transcript is the thread itself.
                AgentRowView(row: row, provider: provider)
            } else {
                NavigationLink(value: SubagentRoute(agentId: row.id, title: row.name)) { AgentRowView(row: row, provider: provider) }
            }
        }
        .accessibilityIdentifier("agents.row.\(row.id)")
        .swipeActions(edge: .trailing) {
            if model.canOperate && row.stoppable {
                Button("Stop", role: .destructive) { request(.agent(id: row.id, name: row.name, descendants: row.descendants)) }
            }
        }
    }
    private func request(_ target: StopConfirmation.Target) { Task { await stop.request(target, send: send) } }
    private func send(_ target: StopConfirmation.Target) async -> Bool { await model.interrupt(agentId: target.agentId) }
    private func hiddenText(_ hidden: AgentSheet.Hidden) -> String {
        let more = "\(hidden.agents) \(hidden.agents == 1 ? "agent" : "agents") not shown yet"
        return hidden.running > 0 ? "\(more) · \(hidden.running) still working" : more
    }
    private func more(_ list: String) {
        paging = list
        model.sheet(["kind": "agents.more", "list": list])
    }
}

/// The next page of a long list: the words say how many come, the line under them what is left.
private struct MoreRow: View {
    let title: String
    let detail: String
    let loading: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(loading ? "Loading…" : title).font(AceDesign.Typeface.body).fontWeight(.semibold)
                    .foregroundStyle(AceDesign.Ink.primary)
                Text(detail).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(loading)
        .sensoryFeedback(.selection, trigger: loading)
    }
}
