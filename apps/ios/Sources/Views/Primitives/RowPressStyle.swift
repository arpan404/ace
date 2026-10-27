import SwiftUI

/// A list row's press (DESIGN.md §3 list rows, §5 press): no dividers; while pressed the row takes
/// a soft fill, concentric with its container and never rounder than its 12pt padding. The row
/// that is open (`selected`) draws no box: its title steps up a weight instead (`openRowTitle`).
/// Rows stay flat: no shadow, no tint.
struct RowPressStyle: ButtonStyle {
    var selected = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .environment(\.rowIsOpen, selected)
            .aceConcentricBackground(
                AceTheme.Colours.fill.opacity(configuration.isPressed ? 1 : 0),
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

extension EnvironmentValues {
    /// The row is the page open beside or under the list (`RowPressStyle.selected`).
    @Entry var rowIsOpen = false
}

extension View {
    /// A row's title: semibold while its row is the open one, its own weight otherwise.
    func openRowTitle() -> some View { modifier(OpenRowTitle()) }
}

private struct OpenRowTitle: ViewModifier {
    @Environment(\.rowIsOpen) private var open
    func body(content: Content) -> some View { content.fontWeight(open ? .semibold : nil) }
}
