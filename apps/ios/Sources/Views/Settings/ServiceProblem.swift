import SwiftUI

struct ServiceProblem: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, systemImage: "exclamationmark.circle")
                .foregroundStyle(AceTheme.StatusText.failed)
                .font(AceDesign.Typeface.meta)
                .accessibilityIdentifier("service.problem")
        }
    }
}
