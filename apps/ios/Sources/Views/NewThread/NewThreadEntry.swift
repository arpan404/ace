import SwiftUI

/// The New thread sheet and what follows a start: once the machine's receipt names the new
/// thread and its row arrives, the thread opens. Offline, the start waits in Unsent. The inbox's
/// compose button sets `composing`.
struct NewThreadEntry: ViewModifier {
    @Bindable var inbox: MachineInbox
    @Binding var composing: Bool
    /// The project the inbox is filtered to, which the sheet starts on.
    let project: String
    let open: (InboxKey) -> Void
    @State private var awaiting: (machineId: String, commandId: String)?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $composing) {
                NewThreadSheet(inbox: inbox, saved: { machineId, commandId in awaiting = (machineId, commandId) }, initialProject: project.isEmpty ? nil : project)
                    .presentationDetents([.large]).presentationDragIndicator(.visible)
            }
            .task(id: awaiting?.commandId) {
                guard let awaiting, let client = inbox.client(awaiting.machineId) else { return }
                // A minute covers a slow worktree; after that the row is in the inbox to tap.
                for _ in 0..<600 {
                    if let outcome = client.compose.started[awaiting.commandId] {
                        guard outcome.ok, let threadId = outcome.id else { break }
                        if client.inbox[threadId] != nil {
                            open(InboxKey(machineId: awaiting.machineId, id: threadId))
                            break
                        }
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                    if Task.isCancelled { return }
                }
                self.awaiting = nil
            }
    }
}

extension View {
    func newThreadEntry(inbox: MachineInbox, composing: Binding<Bool>, project: String, open: @escaping (InboxKey) -> Void) -> some View {
        modifier(NewThreadEntry(inbox: inbox, composing: composing, project: project, open: open))
    }
}

extension MachineInbox {
    /// Starting is impossible when every paired machine is view-only: the compose button stays
    /// out rather than opening a sheet whose Start can never enable.
    var canStartThreads: Bool { sessions.isEmpty || sessions.contains { $0.client.canOperate } }
}
