import SwiftUI

/// Checkpoints (ADR 0167), as web's: copies of the bot's workspace, newest first, each with
/// Restore behind a confirm. Spade keeps how the workspace is now as a checkpoint first, and
/// refuses while the bot works or a restore runs; that refusal stays as one line under the list.
/// None, no section.
struct SpadeProfileCheckpoints: View {
    let client: ClientModel
    let agent: String
    let name: String
    @State private var checkpoints: [SpadeProfileEdits.Checkpoint] = []
    @State private var confirming: SpadeProfileEdits.Checkpoint?
    @State private var restoring = false
    @State private var refusal: String?

    var body: some View {
        Group {
            if !checkpoints.isEmpty {
                Section {
                    ForEach(checkpoints) { checkpoint in
                        HStack {
                            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                                Text(SpadeProfileWork.time(checkpoint.at)).aceFont(AceDesign.TextRole.rowTitle)
                                Text(checkpoint.reason).aceFont(AceDesign.TextRole.meta)
                                    .foregroundStyle(AceDesign.Ink.subtle)
                            }
                            Spacer(minLength: AceDesign.Space.related)
                            Button("Restore") { confirming = checkpoint }
                                .aceFont(AceDesign.TextRole.action).buttonStyle(.borderless).disabled(restoring)
                                .accessibilityIdentifier("spade.checkpoint.restore")
                        }
                    }
                } header: {
                    Text("Checkpoints")
                } footer: {
                    if let refusal { Text(refusal).foregroundStyle(AceTheme.StatusText.failed) }
                }
            }
        }
        .task(id: agent) { await load() }
        .confirmationDialog("Restore \(name)'s workspace?", isPresented: Binding(
            get: { confirming != nil }, set: { if !$0 { confirming = nil } }
        ), titleVisibility: .visible, presenting: confirming) { checkpoint in
            Button("Restore") { restore(checkpoint) }
            Button("Cancel", role: .cancel) {}
        } message: { checkpoint in
            Text("Its files go back to how they were at \(SpadeProfileWork.time(checkpoint.at)). How they are now is kept as a checkpoint first.")
        }
    }

    private func restore(_ checkpoint: SpadeProfileEdits.Checkpoint) {
        restoring = true
        refusal = nil
        Task {
            let outcome = await client.spadeRestore(agent, checkpoint: checkpoint.id)
            restoring = false
            if !outcome.ok { refusal = outcome.problem ?? "Try again." }
            await load()
        }
    }

    private func load() async {
        let answer = await client.spadeCheckpoints(agent)
        if answer.ok, let fresh = answer.part { checkpoints = fresh }
    }
}
