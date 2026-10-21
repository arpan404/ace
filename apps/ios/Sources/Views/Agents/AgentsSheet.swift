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
    @Environment(\.dismiss) private var dismiss
    private var sheet: AgentSheet? { model.sheets.agents }
    private var provider: String { thread.screen.controls?.provider ?? "" }

    var body: some View {
        NavigationStack {
            List {
                if let sheet {
                    Section {
                        ForEach(sheet.rows) { row in agentRow(row).listRowBackground(Color.clear) }
                    }
                    .listSectionSeparator(.hidden, edges: .top)
                    if sheet.hidden.agents > 0 {
                        Text(hiddenText(sheet.hidden)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("agents.hidden")
                            .listRowBackground(Color.clear)
                    }
                    if !sheet.tasks.isEmpty {
                        Section {
                            ForEach(sheet.tasks) { task in
                                TaskRowView(task: task, canStop: model.canOperate) { Task { _ = await model.stopTask(task.id) } }
                            }
                            if sheet.hiddenTasks > 0 {
                                Text("\(sheet.hiddenTasks) more on your computer").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                            }
                        } header: { InsetHeader("Running in background") }
                        .listRowBackground(Color.clear)
                    }
                    Group {
                        BudgetLine(totals: sheet.totals, context: sheet.context)
                        if !model.canOperate {
                            Text("View only: this phone can't stop agents.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("agents.readOnly")
                        }
                    }
                    .listRowSeparator(.hidden).listRowBackground(Color.clear)
                } else {
                    ProgressView("Loading agents…").frame(maxWidth: .infinity).listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AceTheme.Colours.background)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                if let row = sheet?.rows.first(where: { $0.id == id }) { AgentTranscriptView(row: row, provider: provider, thread: thread) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("agents.close")
                }
                if model.canOperate {
                    ToolbarItem(placement: .primaryAction) {
                        Button(role: .destructive) { request(.tree(agents: sheet?.totals.agents ?? 1)) } label: {
                            Text(stop.saving ? "Stopping…" : "Stop all")
                        }
                        .tint(AceTheme.StatusText.failed)
                        .disabled(!(sheet?.treeRunning ?? false) || stop.saving)
                        .accessibilityIdentifier("agents.stopAll")
                    }
                }
            }
            .confirmationDialog(stop.asking?.title ?? "", isPresented: Binding(get: { stop.asking != nil }, set: { if !$0 { stop.cancel() } }), titleVisibility: .visible) {
                Button("Stop", role: .destructive) { Task { await stop.confirm(send: send) } }.accessibilityIdentifier("agents.confirmStop")
                Button("Cancel", role: .cancel) { stop.cancel() }
            } message: { Text(stop.asking?.message ?? "") }
        }
        .tint(AceTheme.Colours.foreground)
        .onAppear { model.sheet(["kind": "agents", "open": true]) }
        .onDisappear { model.sheet(["kind": "agents", "open": false]) }
    }
    @ViewBuilder private func agentRow(_ row: AgentSheet.Row) -> some View {
        Group {
            if let child = row.childThreadId, let openThread {
                Button { dismiss(); openThread(child) } label: {
                    HStack {
                        AgentRowView(row: row, provider: provider)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(AceTheme.Colours.decoration)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else {
                NavigationLink(value: row.id) { AgentRowView(row: row, provider: provider) }
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
        let more = "\(hidden.agents) more \(hidden.agents == 1 ? "agent" : "agents") on your computer"
        return hidden.running > 0 ? "\(more) · \(hidden.running) still working" : more
    }
}
