import SwiftUI

extension View {
    /// Animates whatever changes with `value` using the system's smooth spring, or a short
    /// crossfade under Reduce Motion. Rows that arrive or leave fade; nothing pops.
    func smoothChange<V: Equatable>(_ value: V) -> some View { modifier(SmoothChange(value: value)) }
    /// A text button in a row, given the 44pt touch target its words alone don't have.
    func rowButtonTarget() -> some View {
        frame(minWidth: AceTheme.Dimensions.touchTarget, minHeight: AceTheme.Dimensions.touchTarget).contentShape(Rectangle())
    }
}

private struct SmoothChange<V: Equatable>: ViewModifier {
    let value: V
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.animation(reduceMotion ? .easeInOut(duration: AceTheme.Motion.standard) : .smooth, value: value)
    }
}
