import SwiftUI

/// The sheets the thread header's ⋯ menu opens: the agent tree, Changes and Terminal. ThreadView
/// applies it with one line, so the header and sheets stay out of the transcript's file.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    @Binding var showingAgents: Bool
    @Binding var showingChanges: Bool
    @Binding var showingTerminal: Bool
    @Binding var showingLogs: Bool
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingAgents) {
                AgentsSheet(model: model, thread: thread, openThread: openThread).adaptiveSheetDetents().presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingChanges) {
                ChangesSheet(model: model, title: metadata?.title ?? "").presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingLogs) {
                NavigationStack {
                    LogsView(model: model)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { showingLogs = false } } }
                }
                .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingTerminal) {
                NavigationStack { TerminalView(model: model, threadId: thread.id) }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
    }
}

extension View {
    func threadSheets(model: ClientModel, thread: ThreadModel, openThread: ((String) -> Void)? = nil, agents: Binding<Bool>, changes: Binding<Bool>, terminal: Binding<Bool>, logs: Binding<Bool>) -> some View {
        modifier(ThreadSheetButtons(model: model, thread: thread, openThread: openThread, showingAgents: agents, showingChanges: changes, showingTerminal: terminal, showingLogs: logs))
    }
}
