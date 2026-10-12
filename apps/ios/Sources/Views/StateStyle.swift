import SwiftUI

/// Presentation of the daemon's canonical state. This never computes tree completion.
@MainActor enum StateStyle {
    static func marker(_ state: String) -> Color {
        switch state {
        case "needs_you": AceTheme.Status.needsYou
        case "working": AceTheme.Status.working
        case "waiting", "limited": AceTheme.Status.waiting
        case "done": AceTheme.Status.done
        case "failed": AceTheme.Status.failed
        case "unresponsive": AceTheme.Status.unresponsive
        default: AceTheme.Colours.decoration
        }
    }
    static func text(_ state: String) -> Color {
        switch state {
        case "needs_you": AceTheme.StatusText.needsYou
        case "working": AceTheme.StatusText.working
        case "waiting", "limited": AceTheme.StatusText.waiting
        case "done": AceTheme.StatusText.done
        case "failed": AceTheme.StatusText.failed
        case "unresponsive": AceTheme.StatusText.unresponsive
        default: AceTheme.Colours.mutedForeground
        }
    }
    static func label(_ state: String) -> String {
        switch state {
        case "needs_you": "Needs you"
        case "working": "Working"
        case "waiting": "Waiting"
        case "limited": "Rate limited"
        case "done": "Done"
        case "failed": "Failed"
        case "unresponsive": "Unresponsive"
        default: "New"
        }
    }
}
struct StateLabel: View {
    let state: String
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(StateStyle.marker(state)).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            Text(StateStyle.label(state)).font(.caption).foregroundStyle(StateStyle.text(state))
        }
        .accessibilityElement(children: .combine)
    }
}
extension View {
    @ViewBuilder func floatingGlass() -> some View {
        if #available(iOS 26, *) { self.glassEffect(.regular, in: Capsule()) }
        else { self.background(.regularMaterial, in: Capsule()).overlay(Capsule().stroke(AceTheme.Colours.separator.opacity(0.25), lineWidth: 0.5)) }
    }
}
