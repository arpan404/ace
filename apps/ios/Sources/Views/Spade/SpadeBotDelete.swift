import SwiftUI

/// Delete bot…, as web's: always behind a confirm. A bot that made other bots asks the one question
/// web asks: stop its workers, or keep them going. Either way its bots stay as the person's own,
/// and the ace threads it started stop, which both answers say. A refusal says why in an alert;
/// Spade itself can't be deleted.
struct SpadeBotDelete: ViewModifier {
    let client: ClientModel
    let agent: String
    let name: String
    @Binding var asking: Bool
    /// It went: the profile and its chat close.
    let deleted: () -> Void
    @State private var question: SpadeProfileAccess.Delete?
    @State private var plain = false
    @State private var workers = false
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .onChange(of: asking) { _, now in
                guard now else { return }
                asking = false
                Task {
                    // Read fresh: a read that fails asks nothing, and Spade refuses a delete that should have.
                    let answer = await client.spadeDeleteAsk(agent)
                    question = answer.part
                    if answer.part?.asks == true { workers = true } else { plain = true }
                }
            }
            .alert("Delete \(name)?", isPresented: $plain) {
                Button("Delete bot", role: .destructive) { remove(nil) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This deletes \(name) and its whole conversation."
                    + (question?.aceStops == true ? " Its ace threads stop." : ""))
            }
            .confirmationDialog("Delete \(name)?", isPresented: $workers, titleVisibility: .visible) {
                Button("Stop its workers", role: .destructive) { remove("stop") }
                Button("Keep its workers going", role: .destructive) { remove("keep") }
                Button("Cancel", role: .cancel) {}
            } message: {
                if let question { Text("Stop: \(question.stop)\nKeep: \(question.keep)") }
            }
            .alert("Couldn't delete \(name)", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(problem ?? "")
            }
    }

    private func remove(_ workers: String?) {
        Task {
            let outcome = await client.spadeDelete(agent, workers: workers)
            if outcome.ok { deleted() } else { problem = outcome.message ?? "Try again." }
        }
    }
}
