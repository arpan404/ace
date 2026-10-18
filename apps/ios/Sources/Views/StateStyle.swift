import SwiftUI

/// Colours for the shared status token keys (`@ace/ui-core/mobile`). Words and grouping arrive
/// ready-made from the bridge; this never labels a state or computes tree completion.
@MainActor enum StateStyle {
    static func marker(_ token: String) -> Color {
        switch token {
        case "needsYou": AceTheme.Status.needsYou
        case "working": AceTheme.Status.working
        case "waiting": AceTheme.Status.waiting
        case "done": AceTheme.Status.done
        case "failed": AceTheme.Status.failed
        case "unresponsive": AceTheme.Status.unresponsive
        default: AceTheme.Colours.decoration
        }
    }
    static func text(_ token: String) -> Color {
        switch token {
        case "needsYou": AceTheme.StatusText.needsYou
        case "working": AceTheme.StatusText.working
        case "waiting": AceTheme.StatusText.waiting
        case "done": AceTheme.StatusText.done
        case "failed": AceTheme.StatusText.failed
        case "unresponsive": AceTheme.StatusText.unresponsive
        default: AceTheme.Colours.mutedForeground
        }
    }
}
struct StateLabel: View {
    let status: StatusDisplay
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Circle().fill(StateStyle.marker(status.token)).frame(width: AceTheme.Dimensions.statusDot, height: AceTheme.Dimensions.statusDot)
            Text(status.label).aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(StateStyle.text(status.token))
        }
        .accessibilityElement(children: .combine)
    }
}
extension View {
    @ViewBuilder func floatingGlass() -> some View {
        let shape = RoundedRectangle(cornerRadius: AceTheme.Radii.composer)
        if #available(iOS 26, *) { self.glassEffect(.regular, in: shape) }
        else { self.background(.regularMaterial, in: shape).overlay(shape.stroke(AceTheme.Colours.separator, lineWidth: AceTheme.Dimensions.border)) }
    }
}
