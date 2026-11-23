import SwiftUI

/// Runs with: the model and machine the bot runs with.
struct SpadeProfileRunsWith: View {
    let details: SpadeProfile.Details

    var body: some View {
        Section("Runs with") {
            LabeledContent("Model", value: details.model)
            LabeledContent("Machine", value: details.machine)
        }
    }
}
