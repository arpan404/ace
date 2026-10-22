import SwiftUI

/// A list row's press (DESIGN.md §3 list rows, §5 press): no dividers; while pressed, or while
/// `selected`, the row takes a soft fill, concentric with its container and never
/// rounder than its 12pt padding. Rows
/// stay flat: no shadow, no tint.
struct RowPressStyle: ButtonStyle {
    var selected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceConcentricBackground(
                AceTheme.Colours.fill.opacity(configuration.isPressed || selected ? 1 : 0),
                minimum: AceShape.rowRadius
            )
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .animation(.easeOut(duration: AceTheme.Motion.fast), value: configuration.isPressed)
            .aceConcentricContentShape(minimum: AceShape.rowRadius)
    }
}

extension ButtonStyle where Self == RowPressStyle {
    static var row: RowPressStyle { RowPressStyle() }
}
