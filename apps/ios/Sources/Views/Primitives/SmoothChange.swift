import SwiftUI

extension View {
    /// Animates whatever changes with `value` using the system's spring. Rows that arrive or
    /// leave fade; nothing pops.
    func smoothChange<V: Equatable>(_ value: V) -> some View { modifier(SmoothChange(value: value)) }
    /// A text button in a row, given the 44pt touch target its words alone don't have.
    func rowButtonTarget() -> some View {
        frame(minWidth: AceDesign.Size.tap, minHeight: AceDesign.Size.tap).contentShape(Rectangle())
    }
}

private struct SmoothChange<V: Equatable>: ViewModifier {
    let value: V
    func body(content: Content) -> some View {
        content.animation(.default, value: value)
    }
}
