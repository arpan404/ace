import SwiftUI

/// Spending (ADR 0135), as web's: this month's spend with today's under it. Information only:
/// Spade has no spending limits (ADR 0166). Read with the bot's details as it shows.
struct SpadeProfileSpending: View {
    let client: ClientModel
    let agent: String
    @State private var spending: SpadeProfileEdits.Spending?
    @State private var read = false

    var body: some View {
        Section("Spending") {
            LabeledContent {
                Text(read ? spending?.month ?? "Not recorded" : "…").monospacedDigit()
            } label: {
                Text("This month")
                if let spending { Text("\(spending.today) today") }
            }
            .accessibilityIdentifier("spade.spending")
        }
        .task(id: agent) {
            let answer = await client.spadeDetails(agent)
            spending = answer.part?.spending
            read = true
        }
    }
}
