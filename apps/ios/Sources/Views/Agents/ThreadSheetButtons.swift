import SwiftUI

/// The sheets the thread header's Agents and Changes buttons and its ⋯ menu open. ThreadView
/// applies it with one line, so the header and sheets stay out of the transcript's file.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    @Binding var showingAgents: Bool
    @Binding var showingChanges: Bool
    @Binding var showingTerminal: Bool
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingAgents) {
                AgentsSheet(model: model, thread: thread, openThread: openThread).adaptiveSheetDetents().presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingChanges) {
                ChangesSheet(model: model, title: metadata?.title ?? "").presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingTerminal) {
                NavigationStack { TerminalView(model: model, threadId: thread.id) }.presentationDetents([.large]).presentationDragIndicator(.visible)
            }
    }
}

extension View {
    func threadSheets(model: ClientModel, thread: ThreadModel, openThread: ((String) -> Void)? = nil, agents: Binding<Bool>, changes: Binding<Bool>, terminal: Binding<Bool>) -> some View {
        modifier(ThreadSheetButtons(model: model, thread: thread, openThread: openThread, showingAgents: agents, showingChanges: changes, showingTerminal: terminal))
    }
}
