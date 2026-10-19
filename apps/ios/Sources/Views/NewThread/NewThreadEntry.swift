import SwiftUI

/// The inbox header's compose button and what follows a start: once the machine's receipt names
/// the new thread and its row arrives, the thread opens. Offline, the start waits in Unsent.
struct NewThreadEntry: ViewModifier {
    @Bindable var inbox: MachineInbox
    let open: (InboxKey) -> Void
    @State private var composing = false
    @State private var awaiting: (machineId: String, commandId: String)?

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom) {
                Button { composing = true } label: {
                    Label("Start a task", systemImage: "plus")
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .frame(maxWidth: .infinity, minHeight: AceTheme.Dimensions.touchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(AceTheme.Colours.foreground)
                .floatingGlass()
                .padding(.horizontal, AceTheme.Dimensions.composerInset)
                .padding(.bottom, AceTheme.Spacing.sm)
                .disabled(inbox.sessions.isEmpty)
                .accessibilityIdentifier("inbox.startTask")
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .disabled(inbox.sessions.isEmpty)
                        .accessibilityLabel("New thread")
                        .accessibilityIdentifier("inbox.compose")
                }
            }
            .sheet(isPresented: $composing) {
                NewThreadSheet(inbox: inbox) { machineId, commandId in awaiting = (machineId, commandId) }
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
    func newThreadEntry(inbox: MachineInbox, open: @escaping (InboxKey) -> Void) -> some View {
        modifier(NewThreadEntry(inbox: inbox, open: open))
    }
}
