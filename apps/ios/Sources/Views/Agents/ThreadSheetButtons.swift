import SwiftUI

/// The thread header's Agents and Changes buttons and the sheets they open. ThreadView applies
/// it with one line, so the header and sheets stay out of the transcript's file.
struct ThreadSheetButtons: ViewModifier {
    @Bindable var model: ClientModel
    @Bindable var thread: ThreadModel
    /// Pushes an agent that runs as its own ace thread.
    let openThread: ((String) -> Void)?
    @State private var showingAgents = false
    @State private var workDestination: String?
    @Binding var showingWork: Bool
    @Binding var showingChanges: Bool
    @Binding var showingTerminal: Bool
    private var metadata: ThreadRow? { thread.metadata ?? model.inbox[thread.id] }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingWork, onDismiss: {
                if workDestination == "agents" { showingAgents = true }
                if workDestination == "changes" { showingChanges = true }
                workDestination = nil
            }) {
                NavigationStack {
                    Form {
                        Section("Workspace") {
                            LabeledContent("Machine", value: metadata?.machine ?? "")
                            LabeledContent("Project", value: metadata?.project ?? "")
                        }
                        Section("Branch") {
                            Text(metadata?.branch ?? "")
                            Button("Changes", systemImage: "plusminus") { workDestination = "changes"; showingWork = false }
                        }
                        Section("Agents") {
                            if let status = metadata?.status { StateLabel(status: status) }
                            Button("View agents", systemImage: "point.3.connected.trianglepath.dotted") { workDestination = "agents"; showingWork = false }
                                .accessibilityIdentifier("thread.agents")
                        }
                    }
                    .navigationTitle("Work").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingWork = false } } }
                }.adaptiveSheetDetents().presentationDragIndicator(.visible)
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
    func threadSheets(model: ClientModel, thread: ThreadModel, openThread: ((String) -> Void)? = nil, work: Binding<Bool>, changes: Binding<Bool>, terminal: Binding<Bool>) -> some View {
        modifier(ThreadSheetButtons(model: model, thread: thread, openThread: openThread, showingWork: work, showingChanges: changes, showingTerminal: terminal))
    }
}
