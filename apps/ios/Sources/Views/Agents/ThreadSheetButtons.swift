import SwiftUI

/// The thread header's Agents and Changes buttons and the sheets they open. ThreadView applies
/// it with one line, so the header and sheets stay out of the transcript's file.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    @State private var showingAgents = false
    @State private var showingChanges = false
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }

    func body(content: Content) -> some View {
        content
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingAgents = true } label: {
                        Label("\(metadata?.agents ?? 1) agents", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                    .accessibilityIdentifier("thread.agents")
                    Button { showingChanges = true } label: { Label("Changes", systemImage: "plusminus") }
                        .accessibilityIdentifier("thread.changes")
                }
            }
            .sheet(isPresented: $showingAgents) {
                AgentsSheet(model: model, thread: thread).presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingChanges) {
                ChangesSheet(model: model, title: metadata?.title ?? "").presentationDetents([.large]).presentationDragIndicator(.visible)
            }
    }
}

extension View {
    func threadSheets(model: ClientModel, thread: ThreadModel) -> some View {
        modifier(ThreadSheetButtons(model: model, thread: thread))
    }
}
