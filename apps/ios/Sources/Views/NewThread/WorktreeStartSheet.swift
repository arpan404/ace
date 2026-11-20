import SwiftUI

/// The worktree card of the start `inbox.startCard` names, as a sheet: shown by New thread's wait
/// after Send and again from the start's Unsent row, for as long as the outbox holds the start.
/// Swiping it away leaves the start to go on. Once the worktree is made (after Retry, Continue or
/// Don't use worktree too) the thread opens; Back to New thread takes the words back, forgets the
/// start on the daemon and drops its Unsent row.
struct WorktreeStartSheet: ViewModifier {
    @Bindable var inbox: MachineInbox
    let open: (InboxKey) -> Void
    /// Opens New thread on a draft, once this sheet has gone.
    let back: (NewThreadDraft) -> Void
    @State private var returning: NewThreadDraft?
    func body(content: Content) -> some View {
        content.sheet(isPresented: Binding(get: { inbox.startCard != nil }, set: { if !$0 { inbox.startCard = nil } }),
                      onDismiss: {
                          if let draft = returning { returning = nil; back(draft) }
                      }) {
            if let key = inbox.startCard {
                WorktreeStartPage(inbox: inbox, key: key, open: open) { draft in
                    returning = draft
                    inbox.startCard = nil
                }
                .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
        }
    }
}

private struct WorktreeStartPage: View {
    @Bindable var inbox: MachineInbox
    let key: InboxKey
    let open: (InboxKey) -> Void
    let back: (NewThreadDraft) -> Void
    private var client: ClientModel? { inbox.client(key.machineId) }
    private var read: WorktreeStartRead? { client?.compose.worktrees[key.id] }
    /// Back is on its way: the card waits for both the phone and the daemon to take it.
    @State private var backing = false
    /// Why Back didn't happen; the card and its Unsent row stay.
    @State private var backProblem = ""
    /// Confirm before asking the daemon to retire a stale Git lock on the project's repository.
    @State private var confirmingLock = false
    var body: some View {
        NavigationStack {
            Group {
                if let card = read?.card {
                    let canClear = client?.canOperate == true && card.locked && !(card.workspaceId ?? "").isEmpty
                    WorktreeStartView(card: card, act: act,
                                      clearLock: canClear ? { confirmingLock = true } : nil,
                                      back: card.canReturn == true ? { goBack(card) } : nil,
                                      backing: backing, backProblem: backProblem)
                } else {
                    // Made, or refused for the message's own reason: the sheet goes either way.
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("New thread").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // Puts the card away; the start goes on and its Unsent row opens it again.
                ToolbarItem(placement: .cancellationAction) {
                    Button { inbox.startCard = nil } label: { AceIcon(.x) }
                        .accessibilityLabel("Close")
                        .accessibilityIdentifier("worktree.close")
                }
            }
        }
        .staleLockConfirmation(isPresented: $confirmingLock, confirmId: "worktree.clearLock.confirm") {
            clearLock()
        }
        .onChange(of: read?.card?.locked) { _, locked in
            if locked != true { confirmingLock = false }
        }
        // The thread made in it opens once the thread list has it.
        .task(id: read?.made) {
            guard let made = read?.made, let client else { return }
            for _ in 0..<100 {
                if client.inbox[made] != nil {
                    inbox.startCard = nil
                    open(InboxKey(machineId: key.machineId, id: made))
                    return
                }
                try? await Task.sleep(for: .milliseconds(100))
                if Task.isCancelled { return }
            }
        }
        // Taken back, the card goes once Back has handed the words over (`goBack`).
        .onChange(of: read?.card == nil && read?.made == nil && read?.returned != true) { _, gone in
            if gone { inbox.startCard = nil }
        }
    }
    private func act(_ action: String) {
        client?.composeAction(["kind": "worktree", "commandId": key.id, "action": action])
    }
    private func clearLock() {
        guard let client else { return }
        backProblem = ""
        Task {
            let refused = await client.worktreeClearLock(key.id)
            if let refused, read?.card?.refused.isEmpty != false { backProblem = refused }
        }
    }
    /// The words go back to New thread only once this phone has saved that the start's Unsent
    /// row is dealt with and the daemon has forgotten the start; otherwise the card says why.
    private func goBack(_ card: WorktreeStartCard) {
        guard let client, !backing else { return }
        backing = true
        backProblem = ""
        let draft = card.returnedDraft(machineId: key.machineId)
        Task {
            let refused = await client.worktreeBack(key.id)
            backing = false
            if let refused { backProblem = refused } else { back(draft) }
        }
    }
}
