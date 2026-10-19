import SwiftUI

/// The thread header's Agents and Changes buttons and the sheets they open. ThreadView applies
/// it with one line, so the header and sheets stay out of the transcript's file.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    @State private var showingAgents = false
    @Binding var showingChanges: Bool
    @State private var showingTerminal = false
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingAgents = true } label: {
                        HStack(spacing: AceTheme.Spacing.xs) {
                            Image(systemName: "point.3.connected.trianglepath.dotted")
                            Text((metadata?.agents ?? 1).formatted())
                        }.accessibilityLabel("\(metadata?.agents ?? 1) agents")
                    }
                    .accessibilityIdentifier("thread.agents")
                    Button { showingChanges = true } label: { Label("Changes", systemImage: "plusminus") }
                        .accessibilityIdentifier("thread.changes")
                    Button { showingTerminal = true } label: { Label("Terminal", systemImage: "terminal") }
                        .accessibilityIdentifier("thread.terminal")
                }
            }
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
    func threadSheets(model: ClientModel, thread: ThreadModel, openThread: ((String) -> Void)? = nil, changes: Binding<Bool>) -> some View {
        modifier(ThreadSheetButtons(model: model, thread: thread, openThread: openThread, showingChanges: changes))
    }
}
