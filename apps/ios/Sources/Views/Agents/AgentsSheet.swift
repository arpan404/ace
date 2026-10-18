import SwiftUI

/// The whole agent tree for the open thread, with usage and background work. The bridge follows
/// the tree only while this sheet is shown. Stop all and stopping an agent with subagents ask
/// first; a view-only phone sees the tree but no stop controls.
struct AgentsSheet: View {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    @State private var stop = StopConfirmation()
    @Environment(\.dismiss) private var dismiss
    private var sheet: AgentSheet? { model.sheets.agents }

    var body: some View {
        NavigationStack {
            List {
                if let sheet {
                    Section {
                        ForEach(sheet.rows) { row in
                            NavigationLink(value: row.id) { AgentRowView(row: row) }
                                .accessibilityIdentifier("agents.row.\(row.id)")
                                .swipeActions(edge: .trailing) {
                                    if model.canOperate && row.stoppable {
                                        Button("Stop", role: .destructive) { request(.agent(id: row.id, name: row.name, descendants: row.descendants)) }
                                    }
                                }
                        }
                        if sheet.hidden.agents > 0 {
                            Text(hiddenText(sheet.hidden)).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("agents.hidden")
                        }
                    }
                    if sheet.totals.tokens != nil || sheet.context != nil { Section("Budget") { BudgetView(totals: sheet.totals, context: sheet.context) } }
                    if !sheet.tasks.isEmpty {
                        Section("Running in background") {
                            ForEach(sheet.tasks) { task in
                                TaskRowView(task: task, canStop: model.canOperate) { Task { _ = await model.stopTask(task.id) } }
                            }
                            if sheet.hiddenTasks > 0 {
                                Text("\(sheet.hiddenTasks) more on your computer").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                            }
                        }
                    }
                    if !model.canOperate {
                        Text("View only: this phone can't stop agents.").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                            .foregroundStyle(AceTheme.Colours.mutedForeground).accessibilityIdentifier("agents.readOnly")
                    }
                } else {
                    ProgressView("Loading agents…").frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                if let row = sheet?.rows.first(where: { $0.id == id }) { AgentTranscriptView(row: row, thread: thread) }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if model.canOperate {
                    ToolbarItem(placement: .primaryAction) {
                        Button(role: .destructive) { request(.tree(agents: sheet?.totals.agents ?? 1)) } label: {
                            Label(stop.saving ? "Stopping…" : "Stop all", systemImage: "stop.circle")
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
        .onAppear { model.sheet(["kind": "agents", "open": true]) }
        .onDisappear { model.sheet(["kind": "agents", "open": false]) }
    }
    private func request(_ target: StopConfirmation.Target) { Task { await stop.request(target, send: send) } }
    private func send(_ target: StopConfirmation.Target) async -> Bool { await model.interrupt(agentId: target.agentId) }
    private func hiddenText(_ hidden: AgentSheet.Hidden) -> String {
        let more = "\(hidden.agents) more \(hidden.agents == 1 ? "agent" : "agents") on your computer"
        return hidden.running > 0 ? "\(more) · \(hidden.running) still working" : more
    }
}
