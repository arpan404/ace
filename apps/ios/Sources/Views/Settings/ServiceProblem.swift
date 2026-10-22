import SwiftUI

struct ServiceProblem: View {
    let message: String?
    var body: some View {
        if let message {
            Label(message, ace: .warningCircle)
                .foregroundStyle(AceTheme.StatusText.failed)
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .accessibilityIdentifier("service.problem")
        }
    }
}
