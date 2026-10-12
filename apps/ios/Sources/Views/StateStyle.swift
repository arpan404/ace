import SwiftUI

/// Presentation of the daemon's canonical state. This never computes tree completion.
enum StateStyle {
    static func color(_ state: String) -> Color {
        switch state {
        case "needs_you": .orange
        case "working": .blue
        case "waiting", "limited": .purple
        case "done": .green
        case "failed", "unresponsive": .red
        default: .secondary
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
            Circle().fill(StateStyle.color(state)).frame(width: 5, height: 5)
            Text(StateStyle.label(state)).font(.caption).foregroundStyle(StateStyle.color(state))
        }
        .accessibilityElement(children: .combine)
    }
}
extension View {
    @ViewBuilder func floatingGlass() -> some View {
        if #available(iOS 26, *) { self.glassEffect(.regular, in: Capsule()) }
        else { self.background(.regularMaterial, in: Capsule()).overlay(Capsule().stroke(.separator.opacity(0.25), lineWidth: 0.5)) }
    }
}
