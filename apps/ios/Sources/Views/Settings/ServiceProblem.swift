import SwiftUI

struct ServiceProblem: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, ace: .warningCircle)
                .foregroundStyle(AceTheme.StatusText.failed)
                .font(AceDesign.Typeface.meta)
                .accessibilityIdentifier("service.problem")
        }
    }
}
